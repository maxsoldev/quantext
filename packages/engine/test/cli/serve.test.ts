/**
 * `qx serve` in-process: the engine serves, streams a new Call, reuses a running engine, replaces a stale engine
 * file, refuses another version, stops after its idle time (an injected clock) and shuts down cleanly.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { EngineFile, Health } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import type { CliIo } from "../../src/cli/index.ts";
import { EXIT, main } from "../../src/cli/index.ts";
import { openStore } from "../../src/store/index.ts";
import { get } from "../api/client.ts";
import { layout, writeText } from "../ingest/corpus.ts";
import { onCleanup, tempDir } from "../store/temp.ts";

const ID = "00000000-0000-4000-8000-000000000001";

interface Run {
  /** The exit code, once `qx serve` returns. */
  done: Promise<number>;
  out: () => string;
  err: () => string;
  opened: string[];
  stop(): void;
  /** Move the injected clock on. */
  advance(ms: number): void;
}

/** Start `qx serve` with these arguments, a clock of its own and a stop signal. */
function start(argv: string[], hooks: Partial<NonNullable<CliIo["serve"]>> = {}): Run {
  let out = "";
  let err = "";
  let clock = Date.parse("2026-11-12T00:00:00Z");
  const controller = new AbortController();
  const opened: string[] = [];
  const io: CliIo = {
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    env: {},
    home: tempDir("qx-home-"),
    serve: {
      signal: controller.signal,
      now: () => clock,
      idleCheckMs: 5,
      openUrl: (url) => opened.push(url),
      defaultPort: 0,
      lockWaitMs: 300,
      ...hooks,
    },
  };
  const done = main(["serve", ...argv], io);
  onCleanup(async () => {
    controller.abort();
    await done;
  });
  return {
    done,
    out: () => out,
    err: () => err,
    opened,
    stop: () => controller.abort(),
    advance: (ms) => {
      clock += ms;
    },
  };
}

/** A transcript root with the first half of the basic-tools fixture, and a way to append the rest. */
function halfSession(): { root: string; appendRest(): void } {
  const root = tempDir("qx-root-");
  const files = layout(root, "basic-tools");
  const lines = readFileSync(files.source, "utf8").split(/(?<=\n)/);
  const half = Math.floor(lines.length / 2);
  writeText(files.main, lines.slice(0, half).join(""));
  return { root, appendRest: () => appendFileSync(files.main, lines.slice(half).join("")) };
}

/** The engine file once it is written (5 s at most). */
async function engineFile(dataDir: string, other?: number): Promise<EngineFile> {
  const path = join(dataDir, "engine.json");
  for (let i = 0; i < 500; i++) {
    if (existsSync(path)) {
      const file = JSON.parse(readFileSync(path, "utf8")) as EngineFile;
      if (file.port !== other) return file;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no engine.json");
}

/** Open the event stream and wait for a frame whose text matches. */
async function sse(port: number, match: RegExp, act: () => void): Promise<string> {
  const { request } = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/v1/events", agent: false }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => {
        const first = text === "";
        text += chunk.toString("utf8");
        if (first) act();
        const found = text.split("\n\n").find((f) => match.test(f));
        if (found !== undefined) {
          req.destroy();
          resolve(found);
        }
      });
    });
    req.on("error", reject);
    setTimeout(() => {
      req.destroy();
      reject(new Error("no such event"));
    }, 5000);
    req.end();
  });
}

describe("qx serve", () => {
  test("serves the API, and a Call written to a transcript reaches the event stream", async () => {
    const { root, appendRest } = halfSession();
    const dataDir = tempDir("qx-data-");
    const run = start(["--root", root, "--data-dir", dataDir]);
    const file = await engineFile(dataDir);
    expect(file).toMatchObject({
      apiVersion: 1,
      version: "0.0.0",
      pid: process.pid,
      url: `http://127.0.0.1:${file.port}/`,
    });
    expect(run.out()).toContain(`quantext engine at ${file.url} (pid ${process.pid})`);
    const health = (await get(file.port, "/health")).json<Health>();
    expect(health).toMatchObject({ ok: true, version: "0.0.0", pid: process.pid, demo: false, dataDir });
    // Wait for the catch-up: the half session is there.
    let calls = 0;
    for (let i = 0; i < 200 && calls === 0; i++) {
      const page = (await get(file.port, "/api/v1/sessions")).json<{ items: { calls: number }[] }>();
      calls = page.items[0]?.calls ?? 0;
      if (calls === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(calls).toBeGreaterThan(0);
    const frame = await sse(file.port, /^id: .*\nevent: calls\n/m, appendRest);
    expect(frame).toContain(`"id":"${ID}"`);
    run.stop();
    expect(await run.done).toBe(EXIT.ok);
    expect(existsSync(join(dataDir, "engine.json"))).toBe(false);
  });

  test("a second start reuses the running engine, and opens it with --open", async () => {
    const { root } = halfSession();
    const dataDir = tempDir("qx-data-");
    const first = start(["--root", root, "--data-dir", dataDir]);
    const file = await engineFile(dataDir);
    const second = start(["--root", root, "--data-dir", dataDir, "--open"]);
    expect(await second.done).toBe(EXIT.ok);
    expect(second.out()).toBe(`quantext engine already runs at ${file.url} (pid ${process.pid})\n`);
    expect(second.opened).toEqual([file.url]);
    expect(first.opened).toEqual([]);
    expect(existsSync(join(dataDir, "engine.json"))).toBe(true); // still the first engine's
    first.stop();
    expect(await first.done).toBe(EXIT.ok);
  });

  test("replaces a stale engine file: a port where nothing answers", async () => {
    const { root } = halfSession();
    const dataDir = tempDir("qx-data-");
    const stale: EngineFile = {
      apiVersion: 1,
      version: "0.0.0",
      pid: 999_999,
      port: 9,
      url: "http://127.0.0.1:9/",
      startedAt: "2026-01-01T00:00:00Z",
    };
    writeFileSync(join(dataDir, "engine.json"), JSON.stringify(stale));
    const run = start(["--root", root, "--data-dir", dataDir]);
    const file = await engineFile(dataDir, 9);
    expect(file.pid).toBe(process.pid);
    run.stop();
    expect(await run.done).toBe(EXIT.ok);
  });

  test("says so when an engine of another version runs", async () => {
    const dataDir = tempDir("qx-data-");
    const other = createServer((_req, res) => {
      const health: Health = { apiVersion: 1, ok: true, version: "9.9.9", pid: 4242, startedAt: "", demo: false };
      res.end(JSON.stringify(health));
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    onCleanup(() => new Promise<void>((r) => other.close(() => r())));
    const address = other.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const file: EngineFile = {
      apiVersion: 1,
      version: "9.9.9",
      pid: 4242,
      port,
      url: `http://127.0.0.1:${port}/`,
      startedAt: "",
    };
    writeFileSync(join(dataDir, "engine.json"), JSON.stringify(file));
    const run = start(["--root", tempDir("qx-root-"), "--data-dir", dataDir]);
    expect(await run.done).toBe(EXIT.failed);
    expect(run.err()).toBe(
      `qx: an engine of version 9.9.9 (pid 4242) runs at http://127.0.0.1:${port}/; this is version 0.0.0. ` +
        "Stop it first (kill 4242).\n",
    );
  });

  test("fails when the store is locked and no engine answers", async () => {
    const dataDir = tempDir("qx-data-");
    const store = await openStore({ dataDir });
    onCleanup(() => store.close());
    const run = start(["--root", tempDir("qx-root-"), "--data-dir", dataDir], { now: Date.now });
    expect(await run.done).toBe(EXIT.failed);
    expect(run.err()).toMatch(/^qx: another engine \(pid \d+\) writes this store: /);
  });

  test("takes the default port, else a free one", async () => {
    const taken = createServer();
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
    onCleanup(() => new Promise<void>((r) => taken.close(() => r())));
    const address = taken.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const dataDir = tempDir("qx-data-");
    const run = start(["--root", tempDir("qx-root-"), "--data-dir", dataDir], { defaultPort: port });
    const file = await engineFile(dataDir);
    expect(file.port).not.toBe(port);
    run.stop();
    await run.done;
    // An explicit --port is that port or nothing.
    const fixed = start(["--root", tempDir("qx-root-"), "--data-dir", tempDir("qx-data-"), "--port", String(port)]);
    expect(await fixed.done).toBe(EXIT.failed);
    expect(fixed.err()).toBe(`qx: port ${port} is in use (--port)\n`);
  });

  test("stops after its idle time with no viewer, and not while a stream is open", async () => {
    const dataDir = tempDir("qx-data-");
    const run = start(["--root", tempDir("qx-root-"), "--data-dir", dataDir, "--idle-minutes", "2"]);
    const file = await engineFile(dataDir);
    const { request } = await import("node:http");
    const stream = await new Promise<{ destroy(): void }>((resolve) => {
      const req = request({ host: "127.0.0.1", port: file.port, path: "/api/v1/events", agent: false }, () =>
        resolve(req),
      );
      req.end();
    });
    run.advance(3 * 60_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(dataDir, "engine.json"))).toBe(true); // a viewer is connected
    stream.destroy();
    await new Promise((r) => setTimeout(r, 50));
    run.advance(60_000); // one minute after the viewer left: not yet
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(dataDir, "engine.json"))).toBe(true);
    run.advance(60_000);
    expect(await run.done).toBe(EXIT.ok);
    expect(run.out()).toContain("quantext engine stopping (idle for 2 min)");
    expect(existsSync(join(dataDir, "engine.json"))).toBe(false);
  });

  test("with --live always, never stops for idle time", async () => {
    const dataDir = tempDir("qx-data-");
    const run = start(["--root", tempDir("qx-root-"), "--data-dir", dataDir, "--live", "always"]);
    await engineFile(dataDir);
    run.advance(24 * 60 * 60_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(dataDir, "engine.json"))).toBe(true);
    run.stop();
    expect(await run.done).toBe(EXIT.ok);
  });

  test("shuts down cleanly: the port closes, the lock is released, the engine file is gone", async () => {
    const { root } = halfSession();
    const dataDir = tempDir("qx-data-");
    const run = start(["--root", root, "--data-dir", dataDir]);
    const file = await engineFile(dataDir);
    run.stop();
    expect(await run.done).toBe(EXIT.ok);
    expect(existsSync(join(dataDir, "engine.json"))).toBe(false);
    await expect(get(file.port, "/health")).rejects.toThrow();
    const store = await openStore({ dataDir });
    store.close();
  });

  test("refuses wrong options", async () => {
    for (const [argv, message] of [
      [["--live", "sometimes"], "--live must be while-viewer or always, not sometimes"],
      [["--idle-minutes", "0"], "--idle-minutes must be at least 1"],
      [["--port", "70000"], "--port must be from 0 to 65535"],
      [["extra"], "usage: qx serve"],
    ] as const) {
      const run = start([...argv, "--data-dir", tempDir("qx-data-")]);
      expect(await run.done).toBe(EXIT.usage);
      expect(run.err()).toContain(message);
    }
  });
});
