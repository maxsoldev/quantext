/**
 * Live ingest: a change source reports changed paths, the watcher gathers them for a short window and asks ingest
 * to read the logs they belong to. One read runs at a time; changes that come during a read go to the next one.
 */
import type { FSWatcher } from "node:fs";
import { watch } from "node:fs";
import { join } from "node:path";
import type { Ingest } from "./ingest.ts";

/** Reports changes under the transcript folder: a path, or undefined when it cannot say which. */
export interface ChangeSource {
  start(onChange: (path?: string) => void): { close(): void };
}

export interface WatchOptions {
  ingest: Ingest;
  /** The Claude Code config folder, as given to ingest. */
  root: string;
  /** Where changes come from; the default is `fsChanges(root)`. */
  changes?: ChangeSource;
  /** How long to gather changes before a read starts (default 100 ms). */
  debounceMs?: number;
  /** Gets a read that failed; the watcher goes on. The default writes it to stderr. */
  onError?: (error: unknown) => void;
}

export interface Watcher {
  /** Start a read of what changed so far now, and wait until it is written. */
  flush(): Promise<void>;
  /** Stop watching: close the change source and wait for the read in progress. */
  stop(): Promise<void>;
}

const isTranscriptFile = (path: string) => path.endsWith(".jsonl") || path.endsWith(".meta.json");

export function watchTranscripts(options: WatchOptions): Watcher {
  const { ingest } = options;
  const debounceMs = options.debounceMs ?? 100;
  const onError = options.onError ?? ((error: unknown) => console.error("quantext: live ingest failed:", error));
  let paths = new Set<string>();
  let everything = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();

  /** Take the changes gathered so far, and read them after the read in progress. */
  const read = (): Promise<void> => {
    if (!everything && paths.size === 0) return running;
    const asked = [...paths];
    const all = everything;
    paths = new Set();
    everything = false;
    running = running.then(async () => {
      try {
        if (all) await ingest.ingestAll();
        else await ingest.ingestPaths(asked);
      } catch (error) {
        onError(error);
      }
    });
    return running;
  };
  const onChange = (path?: string) => {
    if (stopped) return;
    if (path !== undefined && isTranscriptFile(path)) paths.add(path);
    else everything = true;
    timer ??= setTimeout(() => {
      timer = undefined;
      void read();
    }, debounceMs);
  };
  const source = (options.changes ?? fsChanges(options.root)).start(onChange);
  return {
    flush() {
      clearTimeout(timer);
      timer = undefined;
      return read();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      source.close();
      await running;
    },
  };
}

export interface FsChangesOptions {
  /** How often to poll while the folder cannot be watched (default 2 s). */
  pollMs?: number;
  /** A slow poll that also runs while watching, for events the platform drops (default 30 s; 0 for none). */
  safetyPollMs?: number;
}

/**
 * Changes under `<root>/projects` from `fs.watch` (recursive). While the folder cannot be watched (it does not
 * exist yet, or the platform refuses), poll instead, and try to watch again on each poll.
 */
export function fsChanges(root: string, options: FsChangesOptions = {}): ChangeSource {
  const pollMs = options.pollMs ?? 2000;
  const safetyPollMs = options.safetyPollMs ?? 30_000;
  const projects = join(root, "projects");
  return {
    start(onChange) {
      let watcher: FSWatcher | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;
      const startPolling = () => {
        poll ??= setInterval(() => {
          onChange(undefined);
          if (tryWatch()) {
            clearInterval(poll);
            poll = undefined;
          }
        }, pollMs);
      };
      const tryWatch = (): boolean => {
        try {
          watcher = watch(projects, { recursive: true }, (_event, name) =>
            onChange(name === null ? undefined : join(projects, String(name))),
          );
        } catch {
          return false; // not watchable now (most often: no projects folder yet); polling covers it
        }
        watcher.on("error", () => {
          watcher?.close();
          watcher = undefined;
          onChange(undefined);
          startPolling();
        });
        onChange(undefined); // read what changed before the watch began
        return true;
      };
      if (!tryWatch()) startPolling();
      const safety = safetyPollMs > 0 ? setInterval(() => onChange(undefined), safetyPollMs) : undefined;
      return {
        close() {
          watcher?.close();
          clearInterval(poll);
          clearInterval(safety);
        },
      };
    },
  };
}
