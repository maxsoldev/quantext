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

type Access = "any" | "types";

/** Engine layers, bottom to top, and what each one may import. Mirrors docs/ARCHITECTURE.md "Layers". */
const ENGINE_LAYERS: Record<string, Record<string, Access>> = {
  core: {},
  adapters: { core: "types" },
  store: { core: "types" },
  ingest: { core: "any", adapters: "any", store: "any" },
  query: { core: "any", store: "any" },
  api: { core: "any", query: "any" },
  cli: { core: "any", store: "any", ingest: "any", query: "any", api: "any" },
};

/** Workspace packages and which other workspace packages each one may import. */
const PACKAGE_DEPS: Record<string, readonly string[]> = {
  shared: [],
  engine: ["shared"],
  web: ["shared"],
  mod: ["shared"],
};

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
    const program = parse(file.text);
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
    return fromLayer === undefined ? undefined : checkEngineImport(fromLayer, target, typeOnly);
  }
  if (specifier.startsWith(WORKSPACE_SCOPE)) {
    const [name = ""] = specifier.slice(WORKSPACE_SCOPE.length).split("/");
    if (!PACKAGE_DEPS[pkg]?.includes(name)) return `${pkg} may not import @quantext/${name}`;
    if (name === "shared" && !typeOnly) return "import only types from @quantext/shared (use `import type`)";
    return undefined;
  }
  if (pkg === "mod") return "mod runs in the mod sandbox and may import only types from @quantext/shared";
  return undefined;
}

function checkEngineImport(fromLayer: string, target: string, typeOnly: boolean): string | undefined {
  const toLayer = engineLayer(target);
  if (toLayer === undefined || toLayer === fromLayer) return undefined;
  if (!(toLayer in ENGINE_LAYERS)) return "import target is outside the engine layers";
  const access = ENGINE_LAYERS[fromLayer]?.[toLayer];
  if (access === undefined) return `${fromLayer} may not import ${toLayer}`;
  if (access === "types" && !typeOnly)
    return `${fromLayer} may import only types from ${toLayer} (use \`import type\`)`;
  return undefined;
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

/** The AST of `text`, or the parser's message when the text is not valid TypeScript. */
function parse(text: string): ReturnType<typeof parseAst> | string {
  try {
    return parseAst(text, { lang: "ts" });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function packageOf(path: string): string | undefined {
  const [top, name] = path.split("/");
  return top === "packages" && name !== undefined && name in PACKAGE_DEPS ? name : undefined;
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
