/**
 * The no-egress guard's rules on modules and processes (egress.ts runs them on each AST node): network
 * modules, node:http clients and servers, child processes against the policy's commands, Bun's network APIs,
 * native bindings, and, in the mod's TypeScript, the parts of Claude Code's `$` that reach the network.
 */
import { builtinModules } from "node:module";
import type { CommandRule, EgressPolicy } from "./egress.ts";
import type { Index, Node, Parsed, Vals } from "./resolve.ts";
import { isMember, resolve, resolvePair, unwrap } from "./resolve.ts";

/** Modules that open sockets or load other code; `module` because createRequire loads any of them. */
const NETWORK_MODULES = new Set(["net", "tls", "dgram", "dns", "https", "http2", "cluster", "inspector", "module"]);
const BUILTINS = new Set(builtinModules);
/** The one package a shipped file may import: Claude Code's mod API, provided by the host. */
const HOST_PACKAGES = new Set(["claude-code"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const PROCESS_SPAWN = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);
const PROCESS_FORBIDDEN = new Set(["exec", "execSync", "fork"]);
/** Flags that make the runtime evaluate code instead of a shipped file. */
const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader"]);
const BUN_FORBIDDEN = new Set([
  ...["connect", "listen", "udpSocket", "serve", "fetch", "dns", "spawn", "spawnSync", "$"],
  ...["s3", "S3Client", "sql", "SQL", "redis", "RedisClient"],
]);
/** Parts of the mod's `$` that send data off the machine (telemetry, MCP, model, audio URLs, credentials). */
const MOD_FORBIDDEN = new Set(["telemetry", "mcp", "audio", "model", "agent"]);

type Imported = { module: string; name: string };

/** What each local name imports, for `import` declarations (namespace and default imports as "*"). */
export function importsOf(program: Node): Map<string, Imported> {
  const out = new Map<string, Imported>();
  for (const node of program.body as Node[]) {
    if (node.type !== "ImportDeclaration" || node.importKind === "type") continue;
    const module = baseModule(String(node.source.value));
    for (const s of node.specifiers as Node[]) {
      const name = s.type === "ImportSpecifier" ? (s.imported.name ?? s.imported.value) : "*";
      out.set(s.local.name, { module, name });
    }
  }
  return out;
}

function baseModule(spec: string): string {
  return spec.replace(/^node:/, "").split("/")[0] ?? spec;
}

/** Run every rule of this file on `node`. `servers` collects the names bound to createServer(). */
export function checkNode(
  node: Node,
  p: Parsed,
  ctx: Index,
  policy: EgressPolicy,
  imports: Map<string, Imported>,
  servers: Set<string>,
): void {
  if (node.type === "ImportDeclaration") checkModule(node.source, p, isTypeOnly(node));
  if ((node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") && node.source) {
    checkModule(node.source, p, node.exportKind === "type");
  }
  if (node.type === "ImportExpression") checkModule(node.source, p, false);
  if (node.type === "CallExpression") checkCall(node, p, ctx, policy, imports, servers);
  if (node.type === "MemberExpression") checkMember(node, p);
  if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern" && isMod(p) && isDollar(node.init)) {
    p.add(node.start, "mod-api", "destructuring $ hides which parts of it are used");
  }
}

function isTypeOnly(node: Node): boolean {
  if (node.importKind === "type") return true;
  const specs = node.specifiers as Node[];
  return specs.length > 0 && specs.every((s) => s.importKind === "type");
}

function checkModule(source: Node, p: Parsed, typeOnly: boolean): void {
  const s = unwrap(source);
  if (s.type !== "Literal" || typeof s.value !== "string") {
    p.add(source.start, "dynamic", "a module name that is not a literal cannot be checked");
    return;
  }
  const spec = s.value;
  if (spec.startsWith(".") || spec.startsWith("/") || typeOnly) return;
  const base = baseModule(spec);
  if (NETWORK_MODULES.has(base) && (spec.startsWith("node:") || BUILTINS.has(base))) {
    p.add(source.start, "module", `${spec} reaches the network or loads other modules`);
  } else if (!spec.startsWith("node:") && !spec.startsWith("bun:") && !BUILTINS.has(spec) && !HOST_PACKAGES.has(spec)) {
    p.add(source.start, "package", `${spec} is a package import; shipped code must be bundled`);
  }
}

function checkCall(
  node: Node,
  p: Parsed,
  ctx: Index,
  policy: EgressPolicy,
  imports: Map<string, Imported>,
  servers: Set<string>,
): void {
  const callee = unwrap(node.callee);
  const args = node.arguments as Node[];
  if (callee.type === "Identifier" && callee.name === "require") {
    checkModule(args[0] ?? node, p, false);
    return;
  }
  if (isMember(callee, "process", "getBuiltinModule")) {
    checkModule(args[0] ?? node, p, false);
    return;
  }
  const target = importedCallee(callee, imports);
  if (target?.module === "http" && (target.name === "request" || target.name === "get")) {
    if (!httpTargetIsLocal(args[0], p, ctx))
      p.add(node.start, "http-client", "node:http request to a host not shown to be loopback");
  }
  if (target?.module === "http" && target.name === "createServer") {
    const parent = ctx.parents.get(node);
    if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") servers.add(parent.id.name);
  }
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.name === "listen") {
    const object = unwrap(callee.object);
    if (object.type === "Identifier" && servers.has(object.name) && !listensOnLoopback(args, p, ctx)) {
      p.add(node.start, "listen", "the server must listen on 127.0.0.1");
    }
  }
  if (target?.module === "child_process" && PROCESS_FORBIDDEN.has(target.name)) {
    p.add(node.start, "process", `child_process.${target.name} is not allowed (a shell, or a second runtime)`);
  }
  if (target?.module === "child_process" && PROCESS_SPAWN.has(target.name)) checkSpawn(node, args, p, ctx, policy);
  if (isMod(p) && callee.type === "MemberExpression" && isMember(callee.object, "$", "process")) {
    const argv = args[0] === undefined ? undefined : resolve(args[0], p, ctx);
    const problem = argvProblem(argvsOf(argv), policy.commands);
    if (problem !== undefined) p.add(node.start, "process", problem);
  }
}

function importedCallee(callee: Node, imports: Map<string, Imported>): Imported | undefined {
  if (callee.type === "Identifier") return imports.get(callee.name);
  if (callee.type !== "MemberExpression" || callee.computed) return undefined;
  const object = unwrap(callee.object);
  const ns = object.type === "Identifier" ? imports.get(object.name) : undefined;
  return ns?.name === "*" ? { module: ns.module, name: callee.property.name } : undefined;
}

/** node:http's first argument: options whose host is loopback (or absent: localhost), or a loopback URL. */
function httpTargetIsLocal(arg: Node | undefined, p: Parsed, ctx: Index): boolean {
  if (arg === undefined) return false;
  const a = unwrap(arg);
  if (a.type === "ObjectExpression") {
    const host = propertyOf(a, "host") ?? propertyOf(a, "hostname");
    return host === undefined || isLoopbackHost(resolve(host, p, ctx));
  }
  const vals = resolve(a, p, ctx);
  return (
    vals?.every((v) => typeof v === "object" && "s" in v && /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(v.s)) ??
    false
  );
}

function listensOnLoopback(args: Node[], p: Parsed, ctx: Index): boolean {
  return args.some((arg) => {
    const a = unwrap(arg);
    const host = a.type === "ObjectExpression" ? propertyOf(a, "host") : a;
    return host !== undefined && isLoopbackHost(resolve(host, p, ctx));
  });
}

function isLoopbackHost(vals: Vals): boolean {
  return vals?.every((v) => typeof v === "object" && "s" in v && v.exact && LOOPBACK_HOSTS.has(v.s)) ?? false;
}

function propertyOf(object: Node, key: string): Node | undefined {
  for (const prop of object.properties as Node[]) {
    if (prop.type !== "Property" || prop.computed) continue;
    if ((prop.key.name ?? prop.key.value) === key) return prop.value;
  }
  return undefined;
}

function checkSpawn(node: Node, args: Node[], p: Parsed, ctx: Index, policy: EgressPolicy): void {
  const options = args.find((a, i) => i > 0 && unwrap(a).type === "ObjectExpression");
  const shell = options === undefined ? undefined : propertyOf(unwrap(options), "shell");
  if (shell !== undefined && !(unwrap(shell).type === "Literal" && unwrap(shell).value === false)) {
    p.add(node.start, "process", "a child process with a shell is not allowed");
    return;
  }
  const list = args[1] !== undefined && unwrap(args[1]).type !== "ObjectExpression" ? args[1] : undefined;
  const pairs: [Vals, Vals][] =
    args[0] === undefined
      ? [[undefined, undefined]]
      : list === undefined
        ? [[resolve(args[0], p, ctx), [{ items: [], open: false }]]]
        : resolvePair(args[0], list, p, ctx);
  const argvs: Argv[] = [];
  for (const [command, rest] of pairs) {
    for (const r of rest ?? [undefined]) {
      if (r !== undefined && (typeof r !== "object" || !("items" in r)))
        argvs.push({ positions: [command], open: true });
      else
        argvs.push(
          r === undefined ? { positions: [command], open: true } : { positions: [command, ...r.items], open: r.open },
        );
    }
  }
  const problem = argvProblem(argvs, policy.commands);
  if (problem !== undefined) p.add(node.start, "process", problem);
}

type Argv = { positions: Vals[]; open: boolean };

/** One argv per possible array value; a value that is no array cannot be checked. */
function argvsOf(vals: Vals): Argv[] {
  if (vals === undefined) return [{ positions: [undefined], open: true }];
  return vals.map((v) =>
    typeof v === "object" && "items" in v
      ? { positions: v.items, open: v.open }
      : { positions: [undefined], open: true },
  );
}

/** Why an argv is not allowed, or undefined when every possible one matches a command rule. */
export function argvProblem(argvs: Argv[], rules: CommandRule[]): string | undefined {
  for (const { positions, open } of argvs) {
    const [first, ...rest] = positions;
    if (first === undefined) return "a command that cannot be followed to its name";
    for (const v of first) {
      if (v === "undefined") continue; // no command: the call throws, nothing runs
      if (v === "execPath") {
        if (rest.some((vals) => vals?.some((x) => typeof x === "object" && "s" in x && EVAL_FLAGS.has(x.s)))) {
          return "the runtime is asked to evaluate code";
        }
        continue;
      }
      if (typeof v !== "object" || !("s" in v) || !v.exact) return "a command whose name is not known";
      const named = rules.filter((r) => matches(r.argv[0] ?? null, [v]));
      if (named.length === 0) return `${v.s} is not an allowed command`;
      const ok = named.some(
        (r) =>
          !open && r.argv.length === positions.length && rest.every((vals, i) => matches(r.argv[i + 1] ?? null, vals)),
      );
      if (!ok) return `${v.s} with arguments that no command rule allows`;
    }
  }
  return undefined;
}

function matches(pattern: string | readonly string[] | null, vals: Vals): boolean {
  if (pattern === null) return true;
  const allowed = typeof pattern === "string" ? [pattern] : pattern;
  // `undefined` is skipped: the code checks for it before it runs the command (the guard is not flow-sensitive).
  return (
    vals?.every((v) => v === "undefined" || (typeof v === "object" && "s" in v && v.exact && allowed.includes(v.s))) ??
    false
  );
}

function checkMember(node: Node, p: Parsed): void {
  if (node.computed) return;
  const object = unwrap(node.object);
  const name = node.property.name as string;
  const isBun = (object.type === "Identifier" && object.name === "Bun") || isMember(object, "globalThis", "Bun");
  if (isBun && BUN_FORBIDDEN.has(name)) p.add(node.start, "bun", `Bun.${name} reaches the network or runs a process`);
  if (
    ["binding", "_linkedBinding", "dlopen"].includes(name) &&
    object.type === "Identifier" &&
    object.name === "process"
  ) {
    p.add(node.start, "native", `process.${name} loads native code`);
  }
  if (!isMod(p)) return;
  if (isDollar(object) && MOD_FORBIDDEN.has(name)) p.add(node.start, "mod-api", `$.${name} reaches the network`);
  if (isMember(object, "$", "http") && name !== "fetch") p.add(node.start, "mod-api", `$.http.${name} is not allowed`);
  if (isMember(object, "$", "session") && name === "authorize")
    p.add(node.start, "mod-api", "$.session.authorize hands out credentials");
}

/** The mod is the plugin's TypeScript; in a minified bundle `$` is just a short name. */
function isMod(p: Parsed): boolean {
  return /\.[mc]?tsx?$/.test(p.path);
}

function isDollar(node: Node | null | undefined): boolean {
  return node != null && unwrap(node).type === "Identifier" && unwrap(node).name === "$";
}
