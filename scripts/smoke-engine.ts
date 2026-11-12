/**
 * Smoke test of the bundled engine (`pnpm build` first): on each runtime, start `dist/engine.js serve` on a free
 * port over a copy of half a fixture session, read /health and a Session, open the event stream, append the rest
 * of the session and wait for its `calls` event, run `qx sql` beside it, check that a second start reuses the
 * engine, then SIGTERM it: exit 0 and no engine.json. Usage: smoke-engine.ts [--runtime node|bun]...
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const repo = join(import.meta.dirname, "..");
const ENGINE = join(repo, "packages", "engine", "dist", "engine.js");
const FIXTURE = join(repo, "fixtures", "claude-code", "2.1.322", "basic-tools");
const TIMEOUT_MS = 20_000;

const { values } = parseArgs({ options: { runtime: { type: "string", multiple: true } } });
const runtimes = values.runtime ?? ["node", "bun"];
assert.ok(existsSync(ENGINE), "no dist/engine.js: run pnpm build first");

for (const runtime of runtimes) {
  const started = performance.now();
  await smoke(runtime === "node" ? process.execPath : runtime);
  console.log(`engine smoke test passed on ${runtime} in ${Math.round(performance.now() - started)} ms`);
}

async function smoke(runtime: string): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "qx-smoke-"));
  const root = join(work, "root");
  const dataDir = join(work, "data");
  const name = readdirSync(FIXTURE).find((n) => n.endsWith(".jsonl")) ?? "";
  const transcript = join(root, "projects", "-fixture-basic-tools", name);
  mkdirSync(join(transcript, ".."), { recursive: true });
  const lines = readFileSync(join(FIXTURE, name), "utf8").split(/(?<=\n)/);
  const half = Math.floor(lines.length / 2);
  writeFileSync(transcript, lines.slice(0, half).join(""));
  const args = ["serve", "--root", root, "--data-dir", dataDir, "--port", "0", "--live", "always"];
  const engine = run(runtime, args);
  try {
    const file = await until(() => {
      const path = join(dataDir, "engine.json");
      return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { port: number; pid: number }) : undefined;
    }, "engine.json");
    assert.equal(file.pid, engine.child.pid);
    const health = JSON.parse(await get(file.port, "/health")) as { ok: boolean; pid: number; apiVersion: number };
    assert.deepEqual([health.ok, health.pid, health.apiVersion], [true, engine.child.pid, 1]);

    const session = await until(async () => {
      const page = JSON.parse(await get(file.port, "/api/v1/sessions")) as { items: { log: number; id: string }[] };
      return page.items[0];
    }, "the catch-up ingest");
    const detail = JSON.parse(await get(file.port, `/api/v1/sessions/${session.log}/${session.id}`)) as {
      session: { calls: number };
    };
    assert.ok(detail.session.calls > 0);

    const event = await sse(file.port, () => appendFileSync(transcript, lines.slice(half).join("")));
    assert.match(event, /^event: calls$/m);
    assert.ok(event.includes(`"id":"${session.id}"`));

    const sql = await run(runtime, ["sql", "SELECT count(*) AS n FROM calls", "--data-dir", dataDir, "--json"]).done;
    assert.equal(sql.code, 0, sql.err);
    const n = (JSON.parse(sql.out) as { rows: { n: number }[] }).rows[0]?.n ?? 0;
    assert.ok(n > detail.session.calls, `qx sql counts ${n} calls, the half session had ${detail.session.calls}`);

    const second = await run(runtime, args).done;
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /^quantext engine already runs at http:\/\/127\.0\.0\.1:\d+\/ \(pid \d+\)\n$/);

    engine.child.kill("SIGTERM");
    const exit = await engine.done;
    assert.equal(exit.code, 0, exit.err);
    assert.ok(!existsSync(join(dataDir, "engine.json")), "engine.json is still there");
    assert.match(exit.out, /quantext engine stopping \(stopped\)/);
  } catch (error) {
    engine.child.kill("SIGKILL");
    const exit = await engine.done;
    console.error(`engine stdout:\n${exit.out}\nengine stderr:\n${exit.err}`);
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

interface Exit {
  code: number | null;
  out: string;
  err: string;
}

function run(runtime: string, args: string[]): { child: ChildProcess; done: Promise<Exit> } {
  const child = spawn(runtime, [ENGINE, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
  child.stderr?.on("data", (d: Buffer) => (err += d.toString("utf8")));
  const done = new Promise<Exit>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${runtime} ${args.join(" ")} ran over ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS * 2);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
  return { child, done };
}

/** Poll until `probe` gives a value. */
async function until<T>(probe: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> {
  const end = Date.now() + TIMEOUT_MS;
  while (Date.now() < end) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function get(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString("utf8")));
      res.on("end", () =>
        res.statusCode === 200 ? resolve(body) : reject(new Error(`${path}: ${res.statusCode} ${body}`)),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

/** Open the event stream, run `act` once it is ready, and give the first `calls` frame. */
function sse(port: number, act: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/v1/events", agent: false }, (res) => {
      let text = "";
      let acted = false;
      res.on("data", (d: Buffer) => {
        text += d.toString("utf8");
        if (!acted && /^event: ready$/m.test(text)) {
          acted = true;
          act();
        }
        const frame = text.split("\n\n").find((f) => /^event: calls$/m.test(f));
        if (frame !== undefined) {
          clearTimeout(timer);
          req.destroy();
          resolve(frame);
        }
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("no calls event on the stream"));
    }, TIMEOUT_MS);
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}
