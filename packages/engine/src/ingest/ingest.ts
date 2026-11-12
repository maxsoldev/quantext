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
export const DEFAULT_RESTORE_BYTES = 64 * 1024 * 1024;

/** Logs whose parser stays in memory between passes (live sessions); others are restored from their snapshot. */
const MAX_WARM_LOGS = 8;

/** A log's parser kept between passes, and the bytes it has read since it was restored. */
interface Warm {
  parser?: ClaudeCodeParser;
  sinceRestore: number;
}

interface Limits {
  batchBytes: number;
  restoreBytes: number;
}

export interface IngestOptions {
  store: Store;
  /** The Claude Code config folder (`~/.claude`, or `CLAUDE_CONFIG_DIR`): transcripts are under `projects/`. */
  root: string;
  /** About this many bytes are read, parsed and written per transaction. */
  batchBytes?: number;
  /**
   * After this many bytes of one log, the parser is made again from its snapshot and the store, so that a long
   * file does not keep its whole content in memory. Each log's pass also starts from the snapshot.
   */
  restoreBytes?: number;
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
  /** The stop signal ended the pass early; what was read is written, the next pass goes on from there. */
  stopped: boolean;
}

export interface RunOptions {
  /** Stop after the batch in progress: every batch written is complete, so the next pass goes on from there. */
  signal?: AbortSignal;
}

export interface Ingest {
  /** Find every log under the root and read what is new in it. */
  ingestAll(run?: RunOptions): Promise<IngestSummary>;
  /** Read what is new in the logs of these files (a transcript or meta file, main or subagent). */
  ingestPaths(paths: readonly string[], run?: RunOptions): Promise<IngestSummary>;
  /**
   * Listen for Calls added or updated, after each write. A listener that throws is reported in the summary's
   * errors and does not stop ingest. Returns a function that stops listening.
   */
  onCalls(listener: (event: CallsEvent) => void): () => void;
}

export function createIngest(options: IngestOptions): Ingest {
  const { store, root } = options;
  const limits: Limits = {
    batchBytes: options.batchBytes ?? DEFAULT_BATCH_BYTES,
    restoreBytes: options.restoreBytes ?? DEFAULT_RESTORE_BYTES,
  };
  const listeners = new Set<(event: CallsEvent) => void>();
  /** The parsers of the logs read last, oldest first: a live log is read on without a restore. */
  const warmParsers = new Map<string, Warm>();
  let queue: Promise<unknown> = Promise.resolve();
  /** One pass at a time: two passes over one log would read its new bytes twice. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined); // the caller gets the failure; the queue goes on
    return next;
  };
  /** Tell the listeners; one that throws is reported in the summary (once per pass), and the others still run. */
  const emit = (log: string, result: WriteResult, summary: IngestSummary) => {
    for (const { sessionId, added, updated } of result.calls) {
      if (added.length === 0 && updated.length === 0) continue;
      const event = { log, sessionId, added, updated };
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          const failure = { path: log, error: `a Calls listener failed: ${describe(error)}` };
          if (!summary.errors.some((e) => e.path === failure.path && e.error === failure.error)) {
            summary.errors.push(failure);
          }
        }
      }
    }
  };
  const pass = async (logs: LogFiles[], errors: PathError[], signal?: AbortSignal): Promise<IngestSummary> => {
    const summary: IngestSummary = {
      logs: logs.length,
      files: 0,
      bytes: 0,
      callsAdded: 0,
      errors: [...errors],
      stopped: false,
    };
    for (const files of logs) {
      const log = store.log(files.main, HARNESS, claudeCodeRecords);
      try {
        if (signal?.aborted) {
          summary.stopped = true;
          break;
        }
        const warm = warmParsers.get(files.main) ?? { sinceRestore: 0 };
        warmParsers.delete(files.main); // a failed pass drops it: its parser may be ahead of the store
        await ingestLog(log, files, limits, summary, (result) => emit(files.main, result, summary), signal, warm);
        if (warm.parser !== undefined) warmParsers.set(files.main, warm);
        for (const old of warmParsers.keys()) {
          if (warmParsers.size <= MAX_WARM_LOGS) break;
          warmParsers.delete(old);
        }
      } catch (error) {
        summary.errors.push({ path: files.main, error: `ingest failed: ${describe(error)}` });
        markFailed(log, files.main, describe(error));
      }
    }
    return summary;
  };
  return {
    ingestAll: (run = {}) =>
      serial(async () => {
        const found = await discoverLogs(root);
        return pass(found.logs, found.errors, run.signal);
      }),
    ingestPaths: (paths, run = {}) =>
      serial(async () => {
        const logs: LogFiles[] = [];
        const errors: PathError[] = [];
        for (const main of new Set(paths.map(logOf))) {
          const found = await logFiles(main);
          logs.push(found.files);
          errors.push(...found.errors);
        }
        return pass(logs, errors, run.signal);
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
  limits: Limits,
  summary: IngestSummary,
  emit: (result: WriteResult) => void,
  signal: AbortSignal | undefined,
  warm: Warm,
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
      delete warm.parser;
      warm.sinceRestore = 0;
    }
    let snapshot = log.snapshot() as ParserState | undefined;
    const parserNow = () => (warm.parser ??= createClaudeCodeParser(snapshot, { lookup: log.lookup }));
    /**
     * Write one delta with its mark and snapshot. After `restoreBytes` of input, drop the parser: the next one is
     * restored from the snapshot and the store, so the memory of a long file stays bounded.
     */
    const write = (delta: ReturnType<ClaudeCodeParser["push"]> | undefined, mark: FileMark, bytes = 0) => {
      if (delta !== undefined && warm.parser !== undefined) snapshot = warm.parser.snapshot();
      const result = log.write({
        deltas: delta === undefined ? [] : [delta],
        files: [mark],
        ...(delta === undefined || snapshot === undefined ? {} : { snapshot: snapshot as unknown as JsonValue }),
      });
      warm.sinceRestore += bytes;
      if (warm.sinceRestore >= limits.restoreBytes) {
        delete warm.parser;
        warm.sinceRestore = 0;
      }
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
      let print = old?.fingerprint;
      let read = false;
      for await (const piece of completeLines(entry.handle, offset, stat.size, limits.batchBytes)) {
        if (signal?.aborted) break;
        const delta = parserNow().push(piece.text, entry.transcript);
        const bytes = piece.end - offset;
        summary.bytes += bytes;
        offset = piece.end;
        read = true;
        print = await fingerprint(entry.handle, offset);
        // Until the read reaches the end, the mark says the file ends here: a restart reads on from it.
        write(delta, { ...mark(offset, print), size: offset }, bytes);
      }
      if (read) summary.files++;
      if (signal?.aborted) {
        summary.stopped = true;
        return;
      }
      write(undefined, mark(offset, print));
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
