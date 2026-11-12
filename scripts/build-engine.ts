/**
 * Bundle the engine with Rolldown (ADR 13) into `packages/engine/dist/`: `engine.js` (the `qx` command, with
 * `qx serve`), `sql-child.js` and `sql-watchdog.js` (the `qx sql` child and its watchdog thread), ESM with no
 * imports but the runtimes' built-ins and their own driver chunks; and `web/`, the viewer's files. Fails if an
 * output imports anything else, so the bundle runs with no node_modules.
 */
import { chmodSync, cpSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { build } from "rolldown";
import { parseAst } from "rolldown/parseAst";

const engine = join(import.meta.dirname, "..", "packages", "engine");
const dist = join(engine, "dist");

const ENTRIES = {
  engine: "src/cli/qx.ts",
  "sql-child": "src/cli/sql-child.ts",
  "sql-watchdog": "src/cli/sql-watchdog.ts",
} as const;

/** Built-ins stay imports: the store picks `node:sqlite` or `bun:sqlite` at run time (ADR 3). */
const BUILT_IN = /^(node|bun):/;

rmSync(dist, { recursive: true, force: true });
for (const [name, input] of Object.entries(ENTRIES)) {
  // One build per entry. Its only split points are the store's two drivers, loaded with import() by runtime:
  // each is a chunk of its own, so that the other runtime's SQLite module is never loaded (Bun resolves every
  // import() of a file when it loads the file, so `node:sqlite` must not be in a file that Bun loads).
  const { output } = await build({
    input: { [name]: join(engine, input) },
    platform: "node",
    external: [BUILT_IN],
    logLevel: "warn",
    output: { dir: dist, format: "esm", entryFileNames: "[name].js", chunkFileNames: `${name}-[name].js` },
  });
  for (const chunk of output) {
    const file = join(dist, chunk.fileName);
    const imports = importsOf(readFileSync(file, "utf8"));
    const own = new Set(output.map((c) => `./${c.fileName}`));
    const foreign = imports.filter((s) => !BUILT_IN.test(s) && !own.has(s));
    if (foreign.length > 0)
      throw new Error(`${chunk.fileName} imports ${foreign.join(", ")}: it must be self-contained`);
    console.log(`dist/${chunk.fileName}  ${(statSync(file).size / 1024).toFixed(0)} KiB`);
  }
}
chmodSync(join(dist, "engine.js"), 0o755);
cpSync(join(engine, "static"), join(dist, "web"), { recursive: true });
console.log("dist/web/");

/** Every specifier a module imports, statically or with `import()`. */
function importsOf(code: string): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const n = node as { type?: string; source?: { value?: unknown } };
    if ((n.type === "ImportDeclaration" || n.type === "ImportExpression" || n.type?.startsWith("Export")) && n.source) {
      out.push(typeof n.source.value === "string" ? n.source.value : "<not a literal>");
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(parseAst(code));
  return out;
}
