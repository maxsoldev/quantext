/**
 * The possible values of an expression, for the no-egress guard (egress.ts). It follows literals, templates,
 * `+`, conditionals, `??`/`||`, constants and later assignments in scope, array destructuring, the returns of a
 * function called by name (in any file), and a parameter through every call site of its function. A value it
 * cannot follow is `undefined` (unknown): the guard treats that as a finding, never as safe.
 */

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes have many shapes; each use checks `type` first.
export type Node = { type: string; start: number; end: number; [key: string]: any };

/** A string (`exact` false: only its start is known), an array by position, `undefined`, or process.execPath. */
export type Val = { s: string; exact: boolean } | { items: Vals[]; open: boolean } | "undefined" | "execPath";
/** Every value an expression may have, or undefined when that is not known. */
export type Vals = Val[] | undefined;

export interface Parsed {
  path: string;
  text: string;
  program: Node;
  add: (offset: number, rule: string, detail: string) => void;
}

interface Site {
  node: Node;
  p: Parsed;
}

export interface Index {
  parents: Map<Node, Node>;
  files: Map<Node, Parsed>;
  functions: Map<string, Site[]>;
  calls: Map<string, Site[]>;
}

const MAX_DEPTH = 12;
const MAX_VALUES = 64;
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const WRAPPERS = new Set([
  "AwaitExpression",
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

/** The child nodes of `node`, in source order. */
export function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || value === null || typeof value !== "object") continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== null && typeof item === "object" && typeof item.type === "string") out.push(item as Node);
    }
  }
  return out;
}

/** 1-based line of `offset` in `text`. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** The name a call or `new` calls: `f(…)` and `a.b.f(…)` both give "f". */
export function calleeName(node: Node): string | undefined {
  const callee = unwrap(node.callee as Node);
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed) return callee.property.name;
  return undefined;
}

/** Parents, functions by name and calls by callee name, over every file (so a helper in one file is followed). */
export function index(files: Parsed[]): Index {
  const ctx: Index = { parents: new Map(), files: new Map(), functions: new Map(), calls: new Map() };
  const push = (map: Map<string, Site[]>, name: string, site: Site) => map.set(name, [...(map.get(name) ?? []), site]);
  for (const p of files) {
    const walk = (node: Node) => {
      ctx.files.set(node, p);
      const name = functionName(node, ctx);
      if (name !== undefined) push(ctx.functions, name, { node, p });
      if (node.type === "CallExpression" && unwrap(node.callee).type === "Identifier") {
        push(ctx.calls, unwrap(node.callee).name, { node, p });
      }
      for (const child of children(node)) {
        ctx.parents.set(child, node);
        walk(child);
      }
    };
    walk(p.program);
  }
  return ctx;
}

function functionName(fn: Node, ctx: Index): string | undefined {
  if (!FUNCTIONS.has(fn.type)) return undefined;
  if (fn.id?.type === "Identifier") return fn.id.name;
  const parent = ctx.parents.get(fn);
  if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
  if (parent?.type === "AssignmentExpression" && parent.left.type === "Identifier") return parent.left.name;
  return undefined;
}

function unwrap(node: Node): Node {
  let n = node;
  while (WRAPPERS.has(n.type)) n = n.expression;
  return n;
}

/** Every value `expr` may have; see the module comment. */
export function resolve(expr: Node, p: Parsed, ctx: Index, depth = 0): Vals {
  if (depth > MAX_DEPTH) return undefined;
  const next = (e: Node, q = p) => resolve(e, q, ctx, depth + 1);
  const node = unwrap(expr);
  switch (node.type) {
    case "Literal":
      if (typeof node.value === "string" || typeof node.value === "number")
        return [{ s: String(node.value), exact: true }];
      return node.value === null ? ["undefined"] : undefined;
    case "TemplateLiteral": {
      const parts: (string | Node)[] = [];
      node.quasis.forEach((q: Node, i: number) => {
        parts.push(String(q.value.cooked ?? ""));
        if (i < node.expressions.length) parts.push(node.expressions[i]);
      });
      return concat(parts.map((part) => (typeof part === "string" ? [{ s: part, exact: true }] : next(part))));
    }
    case "BinaryExpression":
      return node.operator === "+" ? concat([next(node.left), next(node.right)]) : undefined;
    case "ConditionalExpression":
      return union(next(node.consequent), next(node.alternate));
    case "LogicalExpression":
      return union(next(node.left), next(node.right));
    case "SequenceExpression":
      return next(node.expressions.at(-1));
    case "ArrayExpression": {
      const items: Vals[] = [];
      for (const el of node.elements as (Node | null)[]) {
        if (el?.type === "SpreadElement") return [{ items, open: true }];
        items.push(el === null ? ["undefined"] : next(el));
      }
      return [{ items, open: false }];
    }
    case "MemberExpression":
      return isMember(node, "process", "execPath") ? ["execPath"] : undefined;
    case "Identifier":
      return node.name === "undefined" ? ["undefined"] : binding(node, p, ctx, depth);
    case "CallExpression": {
      const callee = unwrap(node.callee);
      if (callee.type !== "Identifier") return undefined;
      const fns = ctx.functions.get(callee.name) ?? [];
      if (fns.length === 0) return undefined;
      let out: Vals = [];
      for (const fn of fns)
        for (const r of returnsOf(fn.node)) out = union(out, r === null ? ["undefined"] : next(r, fn.p));
      return out;
    }
    default:
      return undefined;
  }
}

export function isMember(node: Node, object: string, property: string): boolean {
  const n = unwrap(node);
  return (
    n.type === "MemberExpression" &&
    !n.computed &&
    unwrap(n.object).type === "Identifier" &&
    unwrap(n.object).name === object &&
    n.property.name === property
  );
}

function union(a: Vals, b: Vals): Vals {
  if (a === undefined || b === undefined) return undefined;
  const out = [...a, ...b];
  return out.length > MAX_VALUES ? undefined : out;
}

/** Strings joined part by part; after the first part that is not an exact string, only the start is known. */
function concat(parts: Vals[]): Vals {
  let acc: { s: string; exact: boolean }[] = [{ s: "", exact: true }];
  for (const part of parts) {
    const next: { s: string; exact: boolean }[] = [];
    for (const a of acc) {
      if (!a.exact) next.push(a);
      else if (part === undefined) next.push({ s: a.s, exact: false });
      else {
        for (const v of part) {
          if (v === "undefined") next.push({ s: `${a.s}undefined`, exact: true });
          else if (typeof v === "object" && "s" in v) next.push({ s: a.s + v.s, exact: v.exact });
          else next.push({ s: a.s, exact: false });
        }
      }
    }
    if (next.length > MAX_VALUES) return undefined;
    acc = next;
  }
  return acc;
}

/** The expressions a function may return (`null` for a bare `return` or none), not those of nested functions. */
function returnsOf(fn: Node): (Node | null)[] {
  if (fn.type === "ArrowFunctionExpression" && fn.expression) return [fn.body];
  const out: (Node | null)[] = [];
  const walk = (node: Node) => {
    if (node.type === "ReturnStatement") out.push(node.argument ?? null);
    for (const child of children(node)) if (!FUNCTIONS.has(child.type)) walk(child);
  };
  walk(fn.body);
  return out.length > 0 ? out : [null];
}

/** The values of identifier `id`: a parameter of an enclosing function, or a declaration or assignment in scope. */
function binding(id: Node, p: Parsed, ctx: Index, depth: number): Vals {
  for (let scope = ctx.parents.get(id); scope !== undefined; scope = ctx.parents.get(scope)) {
    if (FUNCTIONS.has(scope.type)) {
      const i = (scope.params as Node[]).findIndex((param) => paramName(param) === id.name);
      if (i !== -1) return parameter(scope, i, ctx, depth);
    }
    if (!FUNCTIONS.has(scope.type) && scope.type !== "Program") continue;
    const found = declarations(FUNCTIONS.has(scope.type) ? scope.body : scope, id.name);
    if (found.length === 0) continue;
    let out: Vals = [];
    for (const d of found) out = union(out, d === null ? undefined : declaredValues(d, p, ctx, depth));
    return out;
  }
  return undefined;
}

type Declared = { init: Node | "undefined"; at?: number };

function declaredValues(d: Declared, p: Parsed, ctx: Index, depth: number): Vals {
  if (d.init === "undefined") return ["undefined"];
  const vals = resolve(d.init, p, ctx, depth + 1);
  if (d.at === undefined || vals === undefined) return vals;
  let out: Vals = [];
  for (const v of vals) {
    if (typeof v !== "object" || !("items" in v)) return undefined;
    const item = d.at < v.items.length ? v.items[d.at] : v.open ? undefined : (["undefined"] as Vals);
    out = union(out, item);
  }
  return out;
}

function paramName(param: Node): string | undefined {
  if (param.type === "Identifier") return param.name;
  if (param.type === "AssignmentPattern" && param.left.type === "Identifier") return param.left.name;
  return undefined;
}

/** What `name` is declared or assigned to in `scope`, outside nested functions; null for a binding not followed. */
function declarations(scope: Node, name: string): (Declared | null)[] {
  const out: (Declared | null)[] = [];
  const walk = (node: Node, parent?: Node) => {
    if (node.type === "VariableDeclarator") {
      const loop = parent !== undefined && /^For(In|Of)Statement$/.test(parent.type);
      const init: Node | "undefined" = node.init ?? "undefined";
      if (node.id.type === "Identifier" && node.id.name === name) out.push(loop ? null : { init });
      if (node.id.type === "ArrayPattern") {
        (node.id.elements as (Node | null)[]).forEach((el, at) => {
          if (el !== null && paramName(el) === name) out.push(loop || el.type !== "Identifier" ? null : { init, at });
        });
      }
      if (node.id.type === "ObjectPattern" && node.id.properties.some((pr: Node) => pr.value?.name === name))
        out.push(null);
    }
    if (node.type === "AssignmentExpression" && node.left.type === "Identifier" && node.left.name === name) {
      out.push(node.operator === "=" ? { init: node.right } : null);
    }
    if (node.type === "CatchClause" && node.param?.name === name) out.push(null);
    for (const child of children(node)) {
      if (!FUNCTIONS.has(child.type)) walk(child, node.type === "VariableDeclaration" ? parent : node);
    }
  };
  walk(scope);
  return out;
}

/** The values of parameter `i` of `fn`: the union over every call of the function by its name, in any file. */
function parameter(fn: Node, i: number, ctx: Index, depth: number): Vals {
  const name = functionName(fn, ctx);
  const calls = name === undefined ? [] : (ctx.calls.get(name) ?? []);
  if (calls.length === 0) return undefined;
  let out: Vals = [];
  for (const { node, p } of calls) {
    const args = node.arguments as Node[];
    if (args.slice(0, i + 1).some((a) => a.type === "SpreadElement")) return undefined;
    out = union(out, args[i] === undefined ? ["undefined"] : resolve(args[i], p, ctx, depth + 1));
  }
  const param = fn.params[i] as Node;
  if (param.type === "AssignmentPattern")
    out = union(out, resolve(param.right, ctx.files.get(fn) as Parsed, ctx, depth + 1));
  return out;
}
