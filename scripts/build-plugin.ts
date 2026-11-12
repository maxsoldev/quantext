/**
 * Build the Claude Code plugin into `dist/plugin/` (ADR 27): the mod as written (Claude Code loads its
 * TypeScript itself), the bundled engine from `pnpm build` in `engine/` with the viewer in `engine/web/`, and a
 * manifest versioned from the root package.json. The repo-root `.claude-plugin/marketplace.json` points here.
 * Fails when a file the plugin needs is missing. Usage: build-plugin.ts (runs build-engine.ts first).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..");
const mod = join(repo, "packages", "mod");
const engineDist = join(repo, "packages", "engine", "dist");
const out = join(repo, "dist", "plugin");

const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const { version } = json(join(repo, "package.json"));
const engineVersion = json(join(repo, "packages", "engine", "package.json")).version;
if (typeof version !== "string" || typeof engineVersion !== "string") throw new Error("a package.json has no version");

execFileSync(process.execPath, [join(import.meta.dirname, "build-engine.ts")], { stdio: "inherit" });

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, ".claude-plugin"), { recursive: true });
const manifest = { ...json(join(mod, ".claude-plugin", "plugin.json")), version };
writeFileSync(join(out, ".claude-plugin", "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
for (const dir of ["hooks", "src", "types"]) cpSync(join(mod, dir), join(out, dir), { recursive: true });
cpSync(join(repo, "LICENSE"), join(out, "LICENSE"));
// The licences of the production dependencies, which the engine and the viewer bundle (SECURITY.md).
const noticesScript = join(import.meta.dirname, "check-supply-chain.ts");
execFileSync(process.execPath, [noticesScript, "--notices", join(out, "THIRD_PARTY_NOTICES.md")], { stdio: "inherit" });

// The engine without its source maps; package.json makes its .js files ES modules and names its version,
// which the mod compares with the running engine's /health.
cpSync(engineDist, join(out, "engine"), { recursive: true, filter: (src) => !src.endsWith(".map") });
const enginePackage = { name: "quantext-engine", private: true, type: "module", version: engineVersion };
writeFileSync(join(out, "engine", "package.json"), `${JSON.stringify(enginePackage, null, 2)}\n`);

const required = [
  ".claude-plugin/plugin.json",
  "hooks/hooks.json",
  "src/register.ts",
  "types/index.d.ts",
  "engine/package.json",
  "engine/engine.js",
  "engine/sql-child.js",
  "engine/sql-watchdog.js",
  "engine/query-worker.js",
  "engine/web/index.html",
  "THIRD_PARTY_NOTICES.md",
];
const missing = required.filter((path) => !existsSync(join(out, path)));
if (missing.length > 0) throw new Error(`dist/plugin lacks ${missing.join(", ")}`);
// Every chunk of the engine (the store's driver chunks among them) goes along: it imports them by name.
for (const name of readdirSync(engineDist).filter((n) => n.endsWith(".js"))) {
  if (!existsSync(join(out, "engine", name))) throw new Error(`dist/plugin/engine lacks ${name}`);
}
if (!readdirSync(join(out, "engine")).some((n) => n.endsWith("-node-driver.js"))) throw new Error("no driver chunks");
console.log(`dist/plugin/  quantext ${version} (engine ${engineVersion})`);
