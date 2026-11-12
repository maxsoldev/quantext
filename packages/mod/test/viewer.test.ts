import { expect, test } from "claude-code/testing";
import { parseEngineFile } from "../src/engine-file.ts";
import { command } from "./kit.ts";
import { DATA, engineFile, health, world } from "./viewer-world.ts";

const HEALTH = "http://127.0.0.1:4747/health";
const URL = "http://127.0.0.1:4747/";

test("/quantext view opens a running engine of the same version and starts nothing", async ($, on) => {
  const w = world(on, { files: { [`${DATA}/engine.json`]: engineFile() }, http: { [HEALTH]: health() } });
  const r = await $.command.run(command("quantext", "view"));
  expect(r.text).toBe("quantext: opening the viewer…");
  await w.settle();
  expect(w.fetched).toEqual([HEALTH]);
  expect(w.argvs).toEqual([
    ["uname", "-s"],
    ["open", URL],
  ]);
  expect(w.toasts).toEqual([`quantext: the viewer is at ${URL}`]);
});

test("the address is built from the port alone: a url in engine.json reaches no request and no command", async ($, on) => {
  const evil = "http://evil.example/'; rm -rf ~; '";
  const file = engineFile({ port: 5001, url: evil });
  const w = world(on, {
    files: { [`${DATA}/engine.json`]: file },
    http: { "http://127.0.0.1:5001/health": health() },
  });
  await $.command.run(command("quantext", "view"));
  await w.settle();
  expect(w.fetched).toEqual(["http://127.0.0.1:5001/health"]);
  expect(w.argvs.at(-1)).toEqual(["open", "http://127.0.0.1:5001/"]);
  expect(JSON.stringify([w.fetched, w.argvs, w.toasts])).not.toContain("evil");
});

test("engine.json is checked field by field", () => {
  const ok = { apiVersion: 1, version: "0.4.0", pid: 7, port: 4747 };
  const text = (fields: Record<string, unknown>) => JSON.stringify({ ...ok, ...fields });
  expect(parseEngineFile(text({ url: "http://evil/" }))).toEqual({ version: "0.4.0", pid: 7, port: 4747 });
  expect(parseEngineFile(text({ port: 1 }))?.port).toBe(1);
  expect(parseEngineFile(text({ port: 65_535 }))?.port).toBe(65_535);
  for (const bad of [
    { port: 0 },
    { port: 65_536 },
    { port: "4747" },
    { port: 47.5 },
    { port: -1 },
    { pid: 0 },
    { pid: "7" },
    { pid: 1.5 },
    { pid: undefined },
    { version: "" },
    { version: "0.4.0\u001b[2J" },
    { version: "v 1" },
    { version: "x".repeat(65) },
    { apiVersion: 2 },
    { apiVersion: undefined },
  ]) {
    expect(parseEngineFile(text(bad))).toBeUndefined();
  }
  for (const notOne of ["", "{", "null", "[]", '"x"', "4747"]) expect(parseEngineFile(notOne)).toBeUndefined();
});

test("with no engine running it starts the bundled one detached with node, by argv alone, then opens it", async ($, on) => {
  const w = world(on, { versions: { node: "v24.14.0" }, afterStart: { [HEALTH]: health() } });
  await $.command.run(command("quantext", "view"));
  await w.settle();
  const root = w.root();
  expect(w.argvs).toEqual([
    ["node", "--version"],
    [
      "sh",
      "-c",
      'umask 077; mkdir -p "$3" && chmod 700 "$3" && cd "$3" && nohup "$0" "$1" serve --live while-viewer >>"$2" 2>&1 </dev/null &',
      "node",
      `${root}/engine/engine.js`,
      `${DATA}/engine.log`,
      DATA,
    ],
    ["uname", "-s"],
    ["open", URL],
  ]);
  expect(w.toasts).toEqual(["quantext: starting the engine…", `quantext: the viewer is at ${URL}`]);
});

test("no command runs in the session's folder, so its bunfig.toml and .env reach nothing", async ($, on) => {
  const w = world(on, { versions: { node: "v22.17.1", bun: "1.3.3" }, afterStart: { [HEALTH]: health() } });
  await $.command.run(command("quantext", "view"));
  await w.settle();
  expect(w.argvs.map((a) => a[0])).toEqual(["node", "bun", "sh", "uname", "open"]);
  expect(w.cwds).toEqual(Array(5).fill(`${w.root()}/engine`));
});

test("a failed start shows its stderr printable and cut short", async ($, on) => {
  const w = world(on, { versions: { node: "v24.14.0" }, shFails: `\u001b[2Jno${"x".repeat(500)}` });
  await $.command.run(command("quantext", "view"));
  await w.settle();
  const shown = w.toasts.at(-1) ?? "";
  expect(shown).toContain("could not be started (?[2Jno");
  expect(shown).not.toContain("\u001b");
  expect(shown.length).toBeLessThan(300);
});

test("a node older than 22.18 is passed over for bun", async ($, on) => {
  const w = world(on, { versions: { node: "v22.17.1", bun: "1.3.3" }, afterStart: { [HEALTH]: health() } });
  await $.command.run(command("quantext", "view"));
  await w.settle();
  expect(w.argvs.slice(0, 2).map((a) => a.slice(0, 2))).toEqual([
    ["node", "--version"],
    ["bun", "--version"],
  ]);
  expect(w.argvs[2]?.[3]).toBe("bun");
});

test("with neither node 22.18 nor bun 1.3.3 it says how to install one and starts nothing", async ($, on) => {
  const w = world(on, { versions: { node: "v20.11.0", bun: "1.1.0" } });
  await $.command.run(command("quantext", "view"));
  await w.settle();
  expect(w.argvs.map((a) => a[0])).toEqual(["node", "bun"]);
  expect(w.toasts).toEqual([
    "quantext: the viewer needs Node.js 22.18 or later, or Bun 1.3.3 or later, on PATH. " +
      "Install one (https://nodejs.org or https://bun.sh), then run /quantext view again.",
  ]);
});

test("an engine that does not answer within 10 s is reported with its log, and nothing is opened", async ($, on) => {
  const w = world(on, { versions: { node: "v22.18.0" } });
  await $.command.run(command("quantext", "view"));
  await w.settle();
  expect(w.argvs.map((a) => a[0])).toEqual(["node", "sh"]);
  expect(w.toasts.at(-1)).toBe(`quantext: the engine did not answer within 10 s; see ${DATA}/engine.log`);
});

test("an engine that hangs, or answers with another pid, counts as not running", async ($, on) => {
  const w = world(on, {
    files: { [`${DATA}/engine.json`]: engineFile() },
    http: { [HEALTH]: "hang" },
    versions: { node: "v24.0.0" },
    afterStart: { [HEALTH]: health({ pid: 9999 }) },
  });
  await $.command.run(command("quantext", "view"));
  // the hung /health is given up after a second, then the engine is started
  await w.clock.advance(1_100);
  expect(w.argvs.map((a) => a[0])).toEqual(["node", "sh"]);
  await w.settle();
  expect(w.toasts.at(-1)).toContain("did not answer within 10 s");
});

test("an engine of another version is named with its pid to stop, and nothing is started", async ($, on) => {
  const w = world(on, {
    files: { [`${DATA}/engine.json`]: engineFile({ version: "0.3.9" }) },
    http: { [HEALTH]: health({ version: "0.3.9\u001b[31m" }) },
    versions: { node: "v24.0.0" },
  });
  await $.command.run(command("quantext", "view"));
  await w.settle();
  expect(w.argvs).toEqual([]);
  expect(w.toasts).toEqual([
    "quantext: an engine of version 0.3.9?[31m (pid 4242) runs; this plugin brings 0.4.0. " +
      "Stop it (kill 4242), then run /quantext view again.",
  ]);
});

test("on Linux it opens the viewer with xdg-open; elsewhere it only shows the address", async ($, on) => {
  const w = world(on, { files: { [`${DATA}/engine.json`]: engineFile() }, http: { [HEALTH]: health() }, os: "Linux" });
  await $.command.run(command("quantext", "view"));
  await w.settle();
  expect(w.argvs.at(-1)).toEqual(["xdg-open", URL]);
});

test("on another OS it shows the address and opens nothing", async ($, on) => {
  const w = world(on, {
    files: { [`${DATA}/engine.json`]: engineFile() },
    http: { [HEALTH]: health() },
    os: "FreeBSD",
  });
  await $.command.run(command("quantext", "view"));
  await w.settle();
  expect(w.argvs).toEqual([["uname", "-s"]]);
  expect(w.toasts).toEqual([`quantext: the viewer is at ${URL} (open it in a browser)`]);
});

test("a plugin without its bundled engine says so", async ($, on) => {
  const w = world(on, { noEngine: true, versions: { node: "v24.0.0" } });
  await $.command.run(command("quantext", "view"));
  await w.settle();
  expect(w.argvs).toEqual([]);
  expect(w.toasts).toEqual(["quantext: this plugin has no bundled engine (engine/); reinstall it."]);
});

test("/quantext alone, or with other words, answers its usage", async ($, on) => {
  const w = world(on);
  expect((await $.command.run(command("quantext"))).text).toBe("Usage: /quantext view");
  expect((await $.command.run(command("quantext", "open now"))).text).toBe("Usage: /quantext view");
  await w.settle();
  expect(w.argvs).toEqual([]);
});

test("without HOME it says where it looked", async ($, on) => {
  const w = world(on, { noHome: true });
  await $.command.run(command("quantext", "view"));
  await w.settle();
  expect(w.toasts).toEqual(["quantext: HOME is not set, so the engine's folder (~/.quantext) cannot be found."]);
});
