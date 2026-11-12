/**
 * `/quantext view`: find the engine by `~/.quantext/engine.json` and `/health`, start the bundled one when none
 * runs, and open the viewer. The engine is started only here, never by itself (ARCHITECTURE "Starting the
 * engine"). Each step's outcome reaches the person as a toast.
 */
import type { EngineInterface } from "claude-code";
import type { EngineAddress } from "./engine-file.ts";
import { engineUrl, parseEngineFile, parseEngineVersion, parseHealth, printable } from "./engine-file.ts";
import { INSTALL_HINT, MIN_BUN, MIN_NODE, meetsVersion } from "./runtime.ts";

/** How long one `/health` may take: a local engine answers in milliseconds. */
export const HEALTH_TIMEOUT_MS = 1_000;
/** How long a started engine has to answer, and how often it is asked. */
export const START_TIMEOUT_MS = 10_000;
export const START_POLL_MS = 250;

/**
 * Starts the engine detached, with every path passed as an argument (`$0` the runtime, `$1` the engine, `$2`
 * the log, `$3` the data folder) and none written into the script. umask 077 and chmod 700: the folder, the log
 * and the store are the user's alone. It runs from the data folder, so Bun loads no project bunfig.toml or .env.
 */
export const START_SCRIPT =
  'umask 077; mkdir -p "$3" && chmod 700 "$3" && cd "$3" && nohup "$0" "$1" serve --live while-viewer >>"$2" 2>&1 </dev/null &';

/** How much of a failed start's stderr a toast shows. */
const STDERR_SHOWN = 200;

type Found = { kind: "same"; url: string } | { kind: "other"; version: string; pid: number } | { kind: "none" };

/**
 * What a command run gave, or undefined when it could not start (not on PATH). It runs in `cwd`, never the
 * session's folder: a cloned repo's bunfig.toml or .env must not reach `bun --version` or the engine.
 */
async function tryRun($: EngineInterface, argv: string[], cwd: string) {
  try {
    return await $.process.run(argv, { cwd, timeoutMs: 5_000 });
  } catch (error) {
    $.ui.log(`quantext: ${argv[0]} did not run: ${String(error)}`, { to: "debug" });
    return undefined;
  }
}

/** `engine.json`'s address, or undefined when there is none or it is not one. */
async function readEngineFile($: EngineInterface, dataDir: string): Promise<EngineAddress | undefined> {
  let text: string;
  try {
    text = (await $.fs.read(`${dataDir}/engine.json`)) as string;
  } catch (error) {
    $.ui.log(`quantext: no engine.json: ${String(error)}`, { to: "debug" }); // the usual case: no engine runs
    return undefined;
  }
  return parseEngineFile(text);
}

/** `/health` of the address, or undefined when it does not answer within HEALTH_TIMEOUT_MS. */
async function askHealth($: EngineInterface, port: number) {
  const timeout = $.clock.sleep(HEALTH_TIMEOUT_MS).then(() => undefined);
  const answer = $.http.fetch(`${engineUrl(port)}health`).then(
    (r) => (r.ok ? parseHealth(r.text) : undefined),
    (error: unknown) => {
      $.ui.log(`quantext: /health on port ${port}: ${String(error)}`, { to: "debug" });
      return undefined;
    },
  );
  return Promise.race([answer, timeout]);
}

/** The engine `engine.json` names, if it answers as that process; `other` when it is another version. */
async function findEngine($: EngineInterface, dataDir: string, version: string): Promise<Found> {
  const file = await readEngineFile($, dataDir);
  if (file === undefined) return { kind: "none" };
  const health = await askHealth($, file.port);
  if (health === undefined || health.pid !== file.pid) return { kind: "none" }; // stale file, or a hung engine
  if (health.version !== version) return { kind: "other", version: health.version, pid: health.pid };
  return { kind: "same", url: engineUrl(file.port) };
}

/** `node` when it is 22.18 or later, else `bun` when it is 1.3.3 or later, else undefined. */
async function findRuntime($: EngineInterface, cwd: string): Promise<string | undefined> {
  const node = await tryRun($, ["node", "--version"], cwd);
  if (node?.exitCode === 0 && meetsVersion(node.stdout, MIN_NODE)) return "node";
  const bun = await tryRun($, ["bun", "--version"], cwd);
  if (bun?.exitCode === 0 && meetsVersion(bun.stdout, MIN_BUN)) return "bun";
  return undefined;
}

/** Opens `url` in the browser (`open` on macOS, `xdg-open` on Linux, by argv); false where it cannot. */
async function openUrl($: EngineInterface, url: string, cwd: string): Promise<boolean> {
  const os = (await tryRun($, ["uname", "-s"], cwd))?.stdout.trim();
  const opener = os === "Darwin" ? "open" : os === "Linux" ? "xdg-open" : undefined;
  if (opener === undefined) return false;
  const r = await tryRun($, [opener, url], cwd);
  return r?.exitCode === 0;
}

/** Runs `/quantext view` to its end, every outcome a toast. */
export async function openViewer($: EngineInterface): Promise<void> {
  const home = await $.env.get("HOME");
  if (home === undefined || home === "") {
    $.ui.toast("quantext: HOME is not set, so the engine's folder (~/.quantext) cannot be found.");
    return;
  }
  const dataDir = `${home}/.quantext`;
  const engineDir = `${$.plugin.root}/engine`;
  const version = await bundledVersion($, engineDir);
  if (version === undefined) {
    $.ui.toast("quantext: this plugin has no bundled engine (engine/); reinstall it.");
    return;
  }

  let found = await findEngine($, dataDir, version);
  if (found.kind === "none") {
    const runtime = await findRuntime($, engineDir);
    if (runtime === undefined) {
      $.ui.toast(INSTALL_HINT);
      return;
    }
    $.ui.toast("quantext: starting the engine…");
    const log = `${dataDir}/engine.log`;
    const argv = ["sh", "-c", START_SCRIPT, runtime, `${engineDir}/engine.js`, log, dataDir];
    const started = await tryRun($, argv, engineDir);
    if (started?.exitCode !== 0) {
      const why = printable(started?.stderr.trim() ?? "").slice(0, STDERR_SHOWN) || "sh did not run";
      $.ui.toast(`quantext: the engine could not be started (${why}).`);
      return;
    }
    found = await waitForEngine($, dataDir, version);
    if (found.kind === "none") {
      $.ui.toast(`quantext: the engine did not answer within ${START_TIMEOUT_MS / 1000} s; see ${log}`);
      return;
    }
  }
  if (found.kind === "other") {
    $.ui.toast(
      `quantext: an engine of version ${found.version} (pid ${found.pid}) runs; this plugin brings ${version}. ` +
        `Stop it (kill ${found.pid}), then run /quantext view again.`,
    );
    return;
  }
  const opened = await openUrl($, found.url, engineDir);
  $.ui.toast(`quantext: the viewer is at ${found.url}${opened ? "" : " (open it in a browser)"}`);
}

/** The bundled engine's version, or undefined when the plugin has no engine. */
async function bundledVersion($: EngineInterface, engineDir: string): Promise<string | undefined> {
  if (!(await $.fs.exists(`${engineDir}/engine.js`))) return undefined;
  try {
    return parseEngineVersion((await $.fs.read(`${engineDir}/package.json`)) as string);
  } catch (error) {
    $.ui.log(`quantext: no engine/package.json: ${String(error)}`, { to: "debug" });
    return undefined;
  }
}

/** Asks for the started engine until it answers or START_TIMEOUT_MS has passed. */
async function waitForEngine($: EngineInterface, dataDir: string, version: string): Promise<Found> {
  const until = (await $.clock.now()) + START_TIMEOUT_MS;
  while ((await $.clock.now()) < until) {
    await $.clock.sleep(START_POLL_MS);
    const found = await findEngine($, dataDir, version);
    if (found.kind !== "none") return found;
  }
  return { kind: "none" };
}
