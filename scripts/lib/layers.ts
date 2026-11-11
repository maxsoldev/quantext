import { posix } from "node:path";
import { parseAst } from "rolldown/parseAst";

export interface SourceFile {
  /** Repo-relative path with `/` separators. */
  path: string;
  text: string;
}

export interface Violation {
  file: string;
  line: number;
  specifier: string;
  reason: string;
}

interface ImportRef {
  /** `null` for a dynamic `import()` whose argument is not a string literal. */
  specifier: string | null;
  typeOnly: boolean;
  offset: number;
}

/**
 * Engine layers, bottom to top, and the layers each one may import. Mirrors docs/ARCHITECTURE.md "Layers".
 * core is a shared kernel: every layer may import it, and it imports nothing outside itself.
 * cli is the composition root: it may import every layer below it.
 */
const ENGINE_LAYERS: Record<string, readonly string[]> = {
  core: [],
  adapters: ["core"],
  store: ["core"],
  ingest: ["core", "adapters", "store"],
  query: ["core", "store"],
  api: ["core", "query"],
  cli: ["core", "adapters", "store", "ingest", "query", "api"],
};

/** Workspace packages and which other workspace packages each one may import. */
const PACKAGE_DEPS: Record<string, readonly string[]> = {
  shared: [],
  engine: ["shared"],
  web: ["shared"],
  mod: ["shared"],
};

/** The only bare specifier the Claude Code mod sandbox resolves. */
const MOD_SANDBOX_MODULE = "claude-code";

const ENGINE_SRC = "packages/engine/src/";
const WORKSPACE_SCOPE = "@quantext/";

/** Top-level statements that are erased at build time, so allowed in shared. */
const TYPE_ONLY_STATEMENTS = new Set(["TSInterfaceDeclaration", "TSTypeAliasDeclaration"]);

/** Check every import in `files` against the layer rules and return each breach. */
export function findLayerViolations(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const pkg = packageOf(file.path);
    if (pkg === undefined) continue;
    const report = (offset: number, specifier: string, reason: string) =>
      violations.push({ file: file.path, line: lineAt(file.text, offset), specifier, reason });
    if (!(pkg in PACKAGE_DEPS)) {
      report(0, "", `package ${pkg} has no layer rules; add it to scripts/lib/layers.ts`);
      continue;
    }
    const program = parse(file.path, file.text);
    if (typeof program === "string") {
      report(0, "", `cannot parse: ${program}`);
      continue;
    }

    const fromLayer = engineLayer(file.path);
    if (fromLayer !== undefined && !(fromLayer in ENGINE_LAYERS)) {
      report(0, "", `file is outside the engine layers (${Object.keys(ENGINE_LAYERS).join(", ")})`);
      continue;
    }
    if (pkg === "shared") {
      for (const statement of program.body) {
        if (!isTypeOnlyStatement(statement)) report(statement.start, "", "shared may contain only types");
      }
    }
    for (const ref of importsOf(program.body)) {
      const reason = checkImport(file.path, pkg, fromLayer, ref);
      if (reason !== undefined) report(ref.offset, ref.specifier ?? "", reason);
    }
  }
  return violations;
}

function checkImport(path: string, pkg: string, fromLayer: string | undefined, ref: ImportRef): string | undefined {
  const { specifier, typeOnly } = ref;
  if (specifier === null) return "dynamic import with a non-literal specifier cannot be checked";
  if (specifier.startsWith(".")) {
    const target = posix.normalize(posix.join(posix.dirname(path), specifier));
    if (packageOf(target) !== pkg)
      return "a relative import may not leave its package; import @quantext/<name> instead";
    return fromLayer === undefined ? undefined : checkEngineImport(fromLayer, target);
  }
  if (fromLayer === "core") return "core imports nothing outside core (no built-ins, no packages)";
  if (specifier.startsWith(WORKSPACE_SCOPE)) {
    const [name = ""] = specifier.slice(WORKSPACE_SCOPE.length).split("/");
    if (!PACKAGE_DEPS[pkg]?.includes(name)) return `${pkg} may not import @quantext/${name}`;
    if (name === "shared" && !typeOnly) return "import only types from @quantext/shared (use `import type`)";
    return undefined;
  }
  if (pkg === "mod" && specifier !== MOD_SANDBOX_MODULE) {
    return "the mod sandbox accepts only relative imports, claude-code, and types from @quantext/shared";
  }
  return undefined;
}

function checkEngineImport(fromLayer: string, target: string): string | undefined {
  const toLayer = engineLayer(target);
  if (toLayer === undefined || toLayer === fromLayer) return undefined;
  if (!(toLayer in ENGINE_LAYERS)) return "import target is outside the engine layers";
  return ENGINE_LAYERS[fromLayer]?.includes(toLayer) ? undefined : `${fromLayer} may not import ${toLayer}`;
}

function isTypeOnlyStatement(statement: object): boolean {
  const node = statement as { type: string } & Record<string, unknown>;
  if (TYPE_ONLY_STATEMENTS.has(node.type)) return true;
  if (node.type === "ImportDeclaration") return node.importKind === "type";
  if (node.type === "ExportAllDeclaration") return node.exportKind === "type";
  if (node.type !== "ExportNamedDeclaration") return false;
  if (node.exportKind === "type") return true;
  const declaration = node.declaration as { type: string } | null;
  if (declaration) return TYPE_ONLY_STATEMENTS.has(declaration.type);
  return (node.specifiers as unknown[]).length === 0 && node.source === null; // `export {}`
}

/** The AST of `text`, or the parser's message when it does not parse. The extension of `path` picks the syntax. */
function parse(path: string, text: string): ReturnType<typeof parseAst> | string {
  const ext = posix.extname(path);
  const lang = ext === ".tsx" ? "tsx" : ext === ".jsx" ? "jsx" : /^\.[mc]?js$/.test(ext) ? "js" : "ts";
  try {
    return parseAst(text, { lang });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function packageOf(path: string): string | undefined {
  const [top, name] = path.split("/");
  return top === "packages" && name !== undefined ? name : undefined;
}

function engineLayer(path: string): string | undefined {
  if (!path.startsWith(ENGINE_SRC)) return undefined;
  const [first] = path.slice(ENGINE_SRC.length).split("/");
  return first;
}

/** Every static import, re-export, dynamic `import()` and `import("x").T` type in `text`. */
function importsOf(body: unknown): ImportRef[] {
  const refs: ImportRef[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const source = n.source as { value?: unknown; start: number } | null | undefined;
    switch (n.type) {
      case "ImportDeclaration":
        if (source) refs.push(ref(source, n.importKind === "type"));
        break;
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (source) refs.push(ref(source, n.exportKind === "type"));
        break;
      case "ImportExpression":
        if (source) refs.push(ref(source, false));
        break;
      case "TSImportType":
        if (source) refs.push(ref(source, true));
        break;
    }
    for (const value of Object.values(n)) visit(value);
  };
  visit(body);
  return refs;
}

function ref(source: { type?: unknown; value?: unknown; start: number }, typeOnly: boolean): ImportRef {
  const literal = source.type === "Literal" && typeof source.value === "string";
  return { specifier: literal ? (source.value as string) : null, typeOnly, offset: source.start };
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}
