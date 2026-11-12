/** `qx` end to end on a temporary data folder, ingested from the fixtures with `qx ingest`. */
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { CliIo } from "../../src/cli/index.ts";
import { EXIT, main } from "../../src/cli/index.ts";
import { openStore } from "../../src/store/index.ts";
import { scenarios } from "../fixtures.ts";
import { copyScenario } from "../ingest/corpus.ts";
import { onCleanup, tempDir } from "../store/temp.ts";

const QX = join(import.meta.dirname, "../../src/cli/qx.ts");

/** The pid of the first child of `pid`, once it has one. */
async function childOf(pid: number): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const found = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")[0];
    if (found !== undefined && found !== "") return Number(found);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`process ${pid} started no child`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH: no such process
  }
}

/** Whether this runtime's SQLite lets a program deny statements (`node:sqlite` from Node 24). */
function authorizerSupported(): boolean {
  if (process.versions.bun !== undefined) return false;
  const run = spawnSync(process.execPath, [
    "-e",
    "process.exit(typeof require('node:sqlite').DatabaseSync.prototype.setAuthorizer === 'function' ? 0 : 1)",
  ]);
  return run.status === 0;
}
const COMPACTION = "00000000-0000-4000-8000-000000000005";

async function qx(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = { stdout: (t) => (out += t), stderr: (t) => (err += t), env: {}, home: tempDir("qx-home-") };
  const code = await main(argv, io);
  return { code, out, err };
}

/** A data folder with every fixture ingested by `qx ingest`. */
async function ingested(): Promise<string[]> {
  const root = tempDir("qx-root-");
  for (const { name } of scenarios()) copyScenario(root, name);
  const dataDir = tempDir("qx-data-");
  const run = await qx("ingest", "--root", root, "--data-dir", dataDir);
  expect(run).toMatchObject({ code: EXIT.ok, err: "" });
  expect(run.out).toMatch(/^7 logs, 9 files with new bytes, \d+ bytes read, 30 calls added, in \d+ ms\n$/);
  return ["--data-dir", dataDir];
}

describe("qx", () => {
  test("lists the sessions as a table, and as the query layer's JSON", async () => {
    const data = await ingested();
    const human = await qx("sessions", ...data, "--limit", "2", "--sort", "calls");
    expect(human.code).toBe(EXIT.ok);
    const lines = human.out.split("\n");
    expect(lines[0]).toMatch(/^SESSION +ENDED +CALLS +COST +MAX CTX +CACHE +FLAGS +TITLE \/ PROJECT$/);
    expect(lines[1]).toMatch(/^00000000-0000-4000-8000-000000000001 +2026-11-12 00:26 +8 +\$0\.2098 +27,783 +85%/);
    expect(human.out).toContain("1-2 of 7 sessions");
    const page = JSON.parse((await qx("sessions", ...data, "--json")).out);
    expect(page.total).toBe(7);
    expect(Object.keys(page.items[0]).sort()).toEqual(
      [
        "log",
        "id",
        "harness",
        "harnessVersion",
        "project",
        "cwd",
        "started",
        "ended",
        "models",
        "calls",
        "tokens",
        "cost",
        "unpricedCalls",
        "maxContextTokens",
        "cacheHitRate",
        "requestLog",
        "issues",
        "live",
      ].sort(),
    );
  });

  test("shows a session, and the context at a Call with its change", async () => {
    const data = await ingested();
    const session = await qx("session", ...data, COMPACTION);
    expect(session.out).toMatch(/COMPACTION +TRIGGER +BEFORE +AFTER/);
    expect(session.out).toMatch(/manual +16,778 +2,865/);
    const call = await qx("call", ...data, COMPACTION, "4", "--diff");
    expect(call.code).toBe(EXIT.ok);
    expect(call.out).toMatch(/^call 4 of 00000000-0000-4000-8000-000000000005 \(lane /);
    expect(call.out).toMatch(/\n +13 +messages +summary +738 +estimate/);
    expect(call.out).toContain(
      "against call 2: 7 added, 7 removed, 1 moved, first change at position 13; cache read lost 3,812",
    );
    const json = JSON.parse(
      (await qx("call", ...data, COMPACTION, "1", "--lane", "eu.anthropic.claude-opus-5-5|sdk", "--json")).out,
    );
    expect(json).toMatchObject({ call: { index: 1 }, rebuilt: true });
  });

  test("answers SQL over the views, read-only, with a row cap", async () => {
    const data = await ingested();
    const top = await qx(
      "sql",
      ...data,
      "SELECT tool, calls, lifetime_tokens FROM v_tool_outputs ORDER BY lifetime_cost_usd DESC LIMIT 1",
    );
    expect(top.out).toMatch(/^tool +calls +lifetime_tokens\nRead +5 +49,?535/);
    const capped = JSON.parse((await qx("sql", ...data, "SELECT idx FROM calls", "--limit", "2", "--json")).out);
    expect(capped).toMatchObject({ columns: ["idx"], truncated: true });
    expect(capped.rows).toHaveLength(2);
    const write = await qx("sql", ...data, "DELETE FROM calls");
    expect(write).toMatchObject({ code: EXIT.usage, out: "" });
    expect(write.err).toContain("not DELETE");
    expect((await qx("sql", ...data, "SELECT nope FROM calls")).code).toBe(EXIT.failed);
  });

  test("stops a query that runs too long, in its own process, with a clear message", { timeout: 20_000 }, async () => {
    const data = await ingested();
    const forever = "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r) SELECT count(*) FROM r";
    const started = Date.now();
    const run = await qx("sql", ...data, "--timeout", "1", forever);
    expect(run.code).toBe(EXIT.failed);
    expect(run.err).toContain("ran longer than 1 s and was stopped");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test.skipIf(!authorizerSupported())("lets SQLite deny anything but reads where the runtime can", async () => {
    const data = await ingested();
    // Passes the text check, but names the database's files: a pragma outside the schema ones is denied.
    const run = await qx("sql", ...data, "SELECT * FROM pragma_database_list");
    expect(run.code).toBe(EXIT.failed);
    expect(run.err).toMatch(/not authorized/i);
  });

  test("lets an agent discover the schema through pragma reads, on every runtime", async () => {
    const data = await ingested();
    for (const sql of [
      "SELECT name FROM pragma_table_list WHERE schema = 'main' ORDER BY name",
      "SELECT name FROM pragma_table_info('calls')",
      "SELECT name FROM pragma_index_list('calls')",
    ]) {
      const run = await qx("sql", ...data, sql, "--json");
      expect(run.err).toBe("");
      expect(JSON.parse(run.out).rows.length).toBeGreaterThan(0);
    }
  });

  test.skipIf(process.platform === "win32")(
    "takes its SQL process along when it is killed",
    { timeout: 30_000 },
    async () => {
      const data = await ingested();
      const forever = "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r) SELECT count(*) FROM r";
      const parent = spawn(process.execPath, [QX, "sql", ...data, "--timeout", "20", forever], { stdio: "ignore" });
      const child = await childOf(parent.pid ?? 0);
      parent.kill("SIGKILL");
      const started = Date.now();
      while (alive(child) && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 50));
      expect(alive(child)).toBe(false);
    },
  );

  test("lists one Session's tool outputs and Blocks by lifetime cost", async () => {
    const data = await ingested();
    const outputs = await qx("outputs", ...data, "00000000-0000-4000-8000-000000000001", "--limit", "1");
    expect(outputs.code).toBe(EXIT.ok);
    expect(outputs.out).toMatch(
      /^TOOL +CALL +TOKENS +CALLS +LIFETIME +COST +INPUT\nRead +2 +9,907 +5 +49,535 +\$0\.0632/,
    );
    const blocks = JSON.parse((await qx("blocks", ...data, "00000000-0000-4000-8000-000000000001", "--json")).out);
    expect(blocks.items.length).toBeGreaterThan(10);
    expect(blocks.items[0].costUsd.total).toBeGreaterThanOrEqual(blocks.items[1].costUsd.total);
  });

  test("reads while an engine holds the writer lock", async () => {
    const data = await ingested();
    const store = await openStore({ dataDir: data[1] ?? "" });
    onCleanup(() => store.close());
    expect((await qx("report", ...data)).out).toContain("unknown records: none");
    expect((await qx("ingest", ...data, "--root", tempDir())).code).toBe(EXIT.failed);
  });

  test("says what is wrong, with its exit code", async () => {
    const data = await ingested();
    expect(await qx("--version")).toMatchObject({
      code: EXIT.ok,
      out: expect.stringMatching(/^qx \d+\.\d+\.\d+ \(store schema \d+\)\n$/),
    });
    expect((await qx("--help")).out).toContain("Usage:");
    expect((await qx()).code).toBe(EXIT.usage);
    expect((await qx("frobnicate", ...data)).code).toBe(EXIT.usage);
    expect((await qx("sessions", ...data, "--limit", "many")).code).toBe(EXIT.usage);
    expect((await qx("sessions", ...data, "--no-such-flag")).code).toBe(EXIT.usage);
    expect((await qx("session", ...data, "ffff")).code).toBe(EXIT.notFound);
    expect((await qx("session", ...data, "0000")).code).toBe(EXIT.usage); // names more than one
    expect((await qx("call", ...data, COMPACTION, "99")).code).toBe(EXIT.notFound);
    const none = await qx("sessions", "--data-dir", join(tempDir(), "none"));
    expect(none.code).toBe(EXIT.failed);
    expect(none.err).toContain("qx ingest");
  });

  test("hides local paths and other projects in demo mode", async () => {
    const data = await ingested();
    const shown = await qx("sessions", ...data, "--demo-project", "/fixture-0000000000000000/repo", "--json");
    const page = JSON.parse(shown.out);
    expect(page.redacted).toBe(true);
    expect(page.items[0].project).toBe("repo");
    expect(JSON.parse((await qx("sessions", ...data, "--demo-project", "repo", "--json")).out).total).toBe(0);
    const sql = await qx("sql", ...data, "--demo", "SELECT 1");
    expect(sql.code).toBe(EXIT.usage);
    expect(sql.err).toContain("demo mode");
  });

  test("hides the data folder in its errors in demo mode", async () => {
    const home = tempDir("qx-home-");
    let err = "";
    const io: CliIo = { stdout: () => undefined, stderr: (t) => (err += t), env: {}, home, user: "someone" };
    expect(await main(["sessions", "--demo", "--data-dir", join(home, "data")], io)).toBe(EXIT.failed);
    expect(err).not.toContain(home);
    expect(err).toContain("~/data");
  });

  test("runs as a program: the entry file, with its exit code and no warnings", () => {
    const run = spawnSync(process.execPath, [QX, "--version"], { encoding: "utf8" });
    expect(run).toMatchObject({ status: 0, stderr: "" });
    expect(run.stdout).toMatch(/^qx /);
    expect(spawnSync(process.execPath, [QX, "nope"], { encoding: "utf8" }).status).toBe(EXIT.usage);
  });
});
