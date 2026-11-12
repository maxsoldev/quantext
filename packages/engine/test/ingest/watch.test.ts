import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCodeCodec } from "../../src/adapters/claude-code/index.ts";
import type { CallsEvent, ChangeSource, Ingest, IngestSummary } from "../../src/ingest/index.ts";
import { createIngest, fsChanges, watchTranscripts } from "../../src/ingest/index.ts";
import { openStore } from "../../src/store/index.ts";
import { normal } from "../store/graph.ts";
import { onCleanup, tempDir } from "../store/temp.ts";
import { expectedGraph, layout, writeText } from "./corpus.ts";

/** A change source driven by the test: `fire` reports a change as fs.watch would. */
function manualChanges(): ChangeSource & { fire(path?: string): void; closed: boolean } {
  let listener: ((path?: string) => void) | undefined;
  const source = {
    closed: false,
    start(onChange: (path?: string) => void) {
      listener = onChange;
      return {
        close: () => {
          source.closed = true;
        },
      };
    },
    fire: (path?: string) => listener?.(path),
  };
  return source;
}

const EMPTY: IngestSummary = { logs: 0, files: 0, bytes: 0, callsAdded: 0, errors: [], stopped: false };

/** An Ingest that records what it was asked to read, and can be held inside a read. */
function recordingIngest() {
  const asked: (string[] | "all")[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let release: (() => void) | undefined;
  let held: Promise<void> | undefined;
  const ingest: Ingest = {
    ingestAll: async (run) => {
      asked.push("all");
      signals.push(run?.signal);
      await held;
      return EMPTY;
    },
    ingestPaths: async (paths, run) => {
      asked.push([...paths]);
      signals.push(run?.signal);
      await held;
      return EMPTY;
    },
    onCalls: () => () => undefined,
  };
  return {
    ingest,
    asked,
    signals,
    hold() {
      held = new Promise((resolve) => {
        release = resolve;
      });
    },
    release: () => release?.(),
  };
}

async function realSetup() {
  const root = tempDir("qx-root-");
  const store = await openStore({ dataDir: tempDir("qx-data-") });
  onCleanup(() => store.close());
  const ingest = createIngest({ store, root });
  const events: CallsEvent[] = [];
  ingest.onCalls((e) => events.push(e));
  return { root, store, ingest, events };
}

describe("the watcher", () => {
  test("reads a transcript that grew once a change is reported, and tells which Calls it added", async () => {
    const { root, store, ingest, events } = await realSetup();
    const files = layout(root, "basic-tools");
    const text = readFileSync(files.source);
    const half = text.subarray(0, text.indexOf("\n", text.length / 2) + 1);
    writeText(files.main, half);
    await ingest.ingestAll();
    const before = events.flatMap((e) => e.added).length;
    const changes = manualChanges();
    const watcher = watchTranscripts({ ingest, root, changes, debounceMs: 1 });
    onCleanup(() => watcher.stop());
    writeText(files.main, text);
    changes.fire(files.main);
    await watcher.flush();
    const graph = normal(store.log(files.main, "claude-code", claudeCodeCodec).graph());
    expect(graph).toEqual(expectedGraph(text));
    expect(events.flatMap((e) => e.added).length - before).toBeGreaterThan(0);
    expect(events.flatMap((e) => e.added).length).toBe(graph.calls.length);
  });

  test("reads the logs of the changed files once for many changes in its debounce window", async () => {
    const fake = recordingIngest();
    const changes = manualChanges();
    const watcher = watchTranscripts({ ingest: fake.ingest, root: "/r", changes, debounceMs: 60_000 });
    onCleanup(() => watcher.stop());
    for (let i = 0; i < 50; i++) changes.fire("/r/projects/p/a.jsonl");
    changes.fire("/r/projects/p/a/subagents/agent-1.jsonl");
    await watcher.flush();
    expect(fake.asked).toEqual([["/r/projects/p/a.jsonl", "/r/projects/p/a/subagents/agent-1.jsonl"]]);
  });

  test("ignores changes to files that are not transcripts or meta files", async () => {
    const fake = recordingIngest();
    const changes = manualChanges();
    const watcher = watchTranscripts({ ingest: fake.ingest, root: "/r", changes, debounceMs: 60_000 });
    onCleanup(() => watcher.stop());
    changes.fire("/r/projects/p/a/tool-results/out.txt");
    changes.fire("/r/projects/p/a/image.png");
    await watcher.flush();
    expect(fake.asked).toEqual([]);
  });

  test("reads everything again for a change it cannot place (a folder, or no file name)", async () => {
    const fake = recordingIngest();
    const changes = manualChanges();
    const watcher = watchTranscripts({ ingest: fake.ingest, root: "/r", changes, debounceMs: 60_000 });
    onCleanup(() => watcher.stop());
    changes.fire("/r/projects/p/a.jsonl");
    changes.fire("/r/projects/new-project");
    await watcher.flush();
    changes.fire(undefined);
    await watcher.flush();
    expect(fake.asked).toEqual(["all", "all"]);
  });

  test("keeps changes that come during a read for the next read", async () => {
    const fake = recordingIngest();
    const changes = manualChanges();
    const watcher = watchTranscripts({ ingest: fake.ingest, root: "/r", changes, debounceMs: 60_000 });
    onCleanup(() => watcher.stop());
    fake.hold();
    changes.fire("/r/projects/p/a.jsonl");
    const first = watcher.flush();
    changes.fire("/r/projects/p/b.jsonl");
    fake.release();
    await first;
    await watcher.flush();
    expect(fake.asked).toEqual([["/r/projects/p/a.jsonl"], ["/r/projects/p/b.jsonl"]]);
  });

  test("stops cleanly: closes its change source, stops the read in progress and waits for it, then reads nothing more", async () => {
    const fake = recordingIngest();
    const changes = manualChanges();
    const watcher = watchTranscripts({ ingest: fake.ingest, root: "/r", changes, debounceMs: 60_000 });
    fake.hold();
    changes.fire("/r/projects/p/a.jsonl");
    void watcher.flush();
    let stopped = false;
    const stopping = watcher.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(fake.signals[0]?.aborted).toBe(true);
    fake.release();
    await stopping;
    expect(changes.closed).toBe(true);
    changes.fire("/r/projects/p/b.jsonl");
    await watcher.flush();
    expect(fake.asked).toEqual([["/r/projects/p/a.jsonl"]]);
  });

  test("passes a failed read to its error handler and goes on", async () => {
    const errors: unknown[] = [];
    const fake = recordingIngest();
    let fail = true;
    const ingest: Ingest = {
      ...fake.ingest,
      ingestPaths: async (paths) => {
        if (fail) {
          fail = false;
          throw new Error("disk gone");
        }
        return fake.ingest.ingestPaths(paths);
      },
    };
    const changes = manualChanges();
    const watcher = watchTranscripts({
      ingest,
      root: "/r",
      changes,
      debounceMs: 60_000,
      onError: (e) => errors.push(e),
    });
    onCleanup(() => watcher.stop());
    changes.fire("/r/projects/p/a.jsonl");
    await watcher.flush();
    changes.fire("/r/projects/p/a.jsonl");
    await watcher.flush();
    expect(errors.map((e) => (e as Error).message)).toEqual(["disk gone"]);
    expect(fake.asked).toEqual([["/r/projects/p/a.jsonl"]]);
  });
});

describe("the file system change source", () => {
  /** Wait until `check` is true, polling; fail after `ms`. */
  async function until(check: () => boolean, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  test("picks up an append to a transcript", { timeout: 20_000 }, async () => {
    const { root, ingest, events } = await realSetup();
    const files = layout(root, "basic-tools");
    const text = readFileSync(files.source);
    const half = text.subarray(0, text.indexOf("\n", text.length / 2) + 1);
    writeText(files.main, half);
    await ingest.ingestAll();
    const before = events.length;
    const watcher = watchTranscripts({ ingest, root, changes: fsChanges(root, { pollMs: 200 }), debounceMs: 10 });
    onCleanup(() => watcher.stop());
    writeText(files.main, text);
    await until(() => events.length > before);
    expect(events.length).toBeGreaterThan(before);
  });

  test("polls when there is no projects folder to watch yet, and finds the first transcript", {
    timeout: 20_000,
  }, async () => {
    const { root, ingest, events } = await realSetup();
    const watcher = watchTranscripts({ ingest, root, changes: fsChanges(root, { pollMs: 20 }), debounceMs: 1 });
    onCleanup(() => watcher.stop());
    const files = layout(root, "basic-tools");
    writeText(files.main, readFileSync(files.source));
    await until(() => events.length > 0);
    expect(events[0]?.log).toBe(join(root, "projects", "-fixture-basic-tools", files.main.split("/").pop() ?? ""));
  });
});
