/**
 * Ingest: read what is new in the transcripts under a Claude Code config folder and write it to the store, the
 * one writer. Each log (a main transcript and its subagents) has one parser, restored from its snapshot and the
 * store's ContentLookup; each batch of complete lines is one transaction with the new snapshot and read position.
 */
import type { FileHandle } from "node:fs/promises";
import { open, readFile } from "node:fs/promises";
import type { JsonValue } from "@quantext/shared";
import type { ClaudeCodeParser, ParserState } from "../adapters/claude-code/index.ts";
import { claudeCodeRecords, createClaudeCodeParser } from "../adapters/claude-code/index.ts";
import type { FileMark, LogStore, Store, WriteResult } from "../store/index.ts";
import type { LogFiles, PathError } from "./discover.ts";
import { describe, discoverLogs, logFiles, logOf } from "./discover.ts";
import type { FileStat } from "./files.ts";
import { completeLines, fingerprint, statOf } from "./files.ts";

const HARNESS = "claude-code";
export const DEFAULT_BATCH_BYTES = 4 * 1024 * 1024;

export interface IngestOptions {
  store: Store;
  /** The Claude Code config folder (`~/.claude`, or `CLAUDE_CONFIG_DIR`): transcripts are under `projects/`. */
  root: string;
  /** About this many bytes are read, parsed and written per transaction. */
  batchBytes?: number;
}

/** Calls that one write added or updated in one Session of a log (the main transcript's path). */
export interface CallsEvent {
  log: string;
  sessionId: string;
  added: string[];
  updated: string[];
}

export interface IngestSummary {
  /** Logs looked at, files with new bytes, and the bytes read. */
  logs: number;
  files: number;
  bytes: number;
  callsAdded: number;
  /** Files and folders that could not be read, and logs whose ingest failed; also kept in the store's report. */
  errors: PathError[];
}

export interface Ingest {
  /** Find every log under the root and read what is new in it. */
  ingestAll(): Promise<IngestSummary>;
  /** Read what is new in the logs of these files (a transcript or meta file, main or subagent). */
  ingestPaths(paths: readonly string[]): Promise<IngestSummary>;
  /** Listen for Calls added or updated, after each write. Returns a function that stops listening. */
  onCalls(listener: (event: CallsEvent) => void): () => void;
}

export function createIngest(options: IngestOptions): Ingest {
  const { store, root } = options;
  const batchBytes = options.batchBytes ?? DEFAULT_BATCH_BYTES;
  const listeners = new Set<(event: CallsEvent) => void>();
  let queue: Promise<unknown> = Promise.resolve();
  /** One pass at a time: two passes over one log would read its new bytes twice. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined); // the caller gets the failure; the queue goes on
    return next;
  };
  const emit = (log: string, result: WriteResult) => {
    for (const { sessionId, added, updated } of result.calls) {
      if (added.length === 0 && updated.length === 0) continue;
      const event = { log, sessionId, added, updated };
      // A listener runs after the write, outside ingest: its failure does not stop ingest, and is not hidden.
      for (const listener of listeners) queueMicrotask(() => listener(event));
    }
  };
  const pass = async (logs: LogFiles[], errors: PathError[]): Promise<IngestSummary> => {
    const summary: IngestSummary = { logs: logs.length, files: 0, bytes: 0, callsAdded: 0, errors: [...errors] };
    for (const files of logs) {
      const log = store.log(files.main, HARNESS, claudeCodeRecords);
      try {
        await ingestLog(log, files, batchBytes, summary, (result) => emit(files.main, result));
      } catch (error) {
        summary.errors.push({ path: files.main, error: `ingest failed: ${describe(error)}` });
        markFailed(log, files.main, describe(error));
      }
    }
    return summary;
  };
  return {
    ingestAll: () =>
      serial(async () => {
        const found = await discoverLogs(root);
        return pass(found.logs, found.errors);
      }),
    ingestPaths: (paths) =>
      serial(async () => {
        const logs: LogFiles[] = [];
        const errors: PathError[] = [];
        for (const main of new Set(paths.map(logOf))) {
          const found = await logFiles(main);
          logs.push(found.files);
          errors.push(...found.errors);
        }
        return pass(logs, errors);
      }),
    onCalls(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

interface Entry {
  path: string;
  transcript: string;
  kind: FileMark["kind"];
  handle?: FileHandle;
  stat?: FileStat;
  error?: string;
}

async function ingestLog(
  log: LogStore,
  files: LogFiles,
  batchBytes: number,
  summary: IngestSummary,
  emit: (result: WriteResult) => void,
): Promise<void> {
  const entries: Entry[] = [{ path: files.main, transcript: "main", kind: "transcript" }];
  for (const agent of files.subagents) {
    if (agent.meta !== undefined) entries.push({ path: agent.meta, transcript: agent.name, kind: "meta" });
    entries.push({ path: agent.path, transcript: agent.name, kind: "transcript" });
  }
  try {
    for (const entry of entries) await openEntry(entry);
    let marks = new Map(log.files().map((m) => [m.path, m]));
    if (await anyReplaced(entries, marks)) {
      log.reset();
      marks = new Map();
    }
    let snapshot = log.snapshot() as ParserState | undefined;
    let parser: ClaudeCodeParser | undefined;
    const parserNow = () => (parser ??= createClaudeCodeParser(snapshot, { lookup: log.lookup }));
    /** Write one delta with its mark and snapshot; then drop the parser, so its memory stays bounded by a batch. */
    const write = (delta: ReturnType<ClaudeCodeParser["push"]> | undefined, mark: FileMark) => {
      if (delta !== undefined && parser !== undefined) snapshot = parser.snapshot();
      const result = log.write({
        deltas: delta === undefined ? [] : [delta],
        files: [mark],
        ...(delta === undefined || snapshot === undefined ? {} : { snapshot: snapshot as unknown as JsonValue }),
      });
      parser = undefined;
      marks.set(mark.path, mark);
      summary.callsAdded += result.calls.reduce((n, c) => n + c.added.length, 0);
      emit(result);
    };
    for (const entry of entries) {
      const old = marks.get(entry.path);
      if (entry.handle === undefined || entry.stat === undefined) {
        const error = entry.error ?? "not readable";
        summary.errors.push({ path: entry.path, error });
        if (old?.error !== error) write(undefined, { ...base(entry, old), error });
        continue;
      }
      const stat = entry.stat;
      const mark = (offset: number, print?: string): FileMark => {
        const m: FileMark = {
          ...base(entry, old),
          fileId: stat.fileId,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          offset,
        };
        if (print !== undefined) m.fingerprint = print;
        return m;
      };
      if (old !== undefined && old.error === undefined && unchanged(old, stat)) continue;
      if (entry.kind === "meta") {
        if (old !== undefined && old.error === undefined) continue;
        const text = await readFile(entry.handle, "utf8");
        write(parserNow().pushMeta(entry.transcript, text), mark(stat.size));
        summary.files++;
        summary.bytes += stat.size;
        continue;
      }
      let offset = old?.offset ?? 0;
      let read = false;
      for await (const piece of completeLines(entry.handle, offset, stat.size, batchBytes)) {
        const delta = parserNow().push(piece.text, entry.transcript);
        summary.bytes += piece.end - offset;
        offset = piece.end;
        read = true;
        write(delta, mark(offset, await fingerprint(entry.handle, offset)));
      }
      if (read) summary.files++;
      else write(undefined, mark(offset, old?.fingerprint));
    }
  } finally {
    for (const entry of entries) await entry.handle?.close();
  }
}

async function openEntry(entry: Entry): Promise<void> {
  try {
    entry.handle = await open(entry.path, "r");
    entry.stat = await statOf(entry.handle);
  } catch (error) {
    entry.error = describe(error);
  }
}

/** A file of the log was replaced, cut below its read position, or rewritten: the log must be read again. */
async function anyReplaced(entries: readonly Entry[], marks: ReadonlyMap<string, FileMark>): Promise<boolean> {
  for (const { path, handle, stat, kind } of entries) {
    const old = marks.get(path);
    if (handle === undefined || stat === undefined || old?.fileId === undefined || unchanged(old, stat)) continue;
    if (old.fileId !== stat.fileId || stat.size < old.offset) return true;
    if (kind === "meta" && stat.size !== old.size) return true;
    if (kind === "transcript" && old.offset > 0 && (await fingerprint(handle, old.offset)) !== old.fingerprint) {
      return true;
    }
  }
  return false;
}

function unchanged(mark: FileMark, stat: FileStat): boolean {
  return mark.fileId === stat.fileId && mark.size === stat.size && mark.mtimeMs === stat.mtimeMs;
}

/** The mark of an entry, keeping what an earlier mark knew, without the error. */
function base(entry: Entry, old: FileMark | undefined): FileMark {
  const { error: _, ...rest } = old ?? { size: 0, offset: 0 };
  return { ...rest, path: entry.path, transcript: entry.transcript, kind: entry.kind };
}

/** Keep the failure of a log's ingest in the store's report, on its main transcript. */
function markFailed(log: LogStore, path: string, error: string): void {
  const old = log.files().find((m) => m.path === path);
  log.write({
    deltas: [],
    files: [
      {
        ...(old ?? { path, transcript: "main", kind: "transcript", size: 0, offset: 0 }),
        error: `ingest failed: ${error}`,
      },
    ],
  });
}
