/**
 * A network tripwire for the runtime no-egress test (smoke-engine.ts). Preloaded into the engine and its
 * children (Node: NODE_OPTIONS=--import=<this>, Bun: BUN_OPTIONS=--preload=<this>), it appends each attempt to
 * reach a host that is not loopback to the file QX_EGRESS_LOG, then throws, so nothing is sent. It wraps the
 * socket, DNS and fetch entry points in JavaScript; native code could pass it by (the static guard covers that).
 */

import dgram from "node:dgram";
import dns from "node:dns";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const LOG = process.env.QX_EGRESS_LOG ?? "";
const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost", "::ffff:127.0.0.1"]);

type Fn = (...args: unknown[]) => unknown;

/** Record and refuse `target` unless it is loopback (or a local socket path). */
function check(kind: string, host: unknown, port?: unknown): void {
  if (host === undefined || host === null || (typeof host === "string" && LOOPBACK.has(host.toLowerCase()))) return;
  const target = `${String(host)}${port === undefined ? "" : `:${String(port)}`}`;
  appendFileSync(LOG, `${JSON.stringify({ kind, target, pid: process.pid })}\n`);
  throw new Error(`egress trap: ${kind} to ${target} refused`);
}

/** Replace `obj[name]` with a function that runs `before` on the arguments first. */
function wrap(obj: object | undefined, name: string, before: (args: unknown[]) => void): void {
  const target = obj as Record<string, Fn> | undefined;
  const original = target?.[name];
  if (target === undefined || typeof original !== "function") return;
  try {
    target[name] = function (this: unknown, ...args: unknown[]) {
      before(args);
      return original.apply(this, args);
    };
  } catch (error) {
    // A read-only binding (some Bun globals) stays as it is; say so, since the test then covers less.
    console.error(`egress trap: cannot wrap ${name}: ${String(error)}`);
  }
}

function connectTarget(args: unknown[]): [unknown, unknown] {
  const [first, second] = args;
  if (Array.isArray(first)) return connectTarget(first); // net's internal normalized arguments
  if (typeof first === "object" && first !== null) {
    const o = first as { host?: unknown; hostname?: unknown; port?: unknown; path?: unknown };
    if (o.path !== undefined) return [undefined, undefined]; // a Unix socket or pipe: local
    return [o.host ?? o.hostname ?? "localhost", o.port];
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return [undefined, undefined]; // a socket path
  return [typeof second === "string" ? second : "localhost", first];
}

function urlHost(input: unknown): string | undefined {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: string })?.url;
  if (raw === undefined) return undefined;
  try {
    return new URL(raw).hostname;
  } catch {
    return undefined; // a relative URL: fetch throws on it in a server runtime, so nothing is sent
  }
}

if (LOG !== "") {
  wrap(net.Socket.prototype, "connect", (args) => check("net.connect", ...connectTarget(args)));
  wrap(tls, "connect", (args) => check("tls.connect", ...connectTarget(args)));
  wrap(dgram.Socket.prototype, "send", (args) =>
    check(
      "dgram.send",
      args.find((a) => typeof a === "string"),
    ),
  );
  wrap(dgram.Socket.prototype, "connect", (args) => check("dgram.connect", args[1]));
  for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveTxt"]) {
    wrap(dns, name, (args) => check(`dns.${name}`, args[0]));
    wrap(dns.promises, name, (args) => check(`dns.promises.${name}`, args[0]));
  }
  syncBuiltinESMExports();
  // fetch refuses with a rejected promise, as a failed request does, so the caller goes on and the log is read.
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    check("fetch", urlHost(args[0]));
    return realFetch(...args);
  }, realFetch);
  const bun = (globalThis as { Bun?: object }).Bun;
  wrap(bun, "connect", (args) => check("Bun.connect", ...connectTarget(args)));
  wrap(bun, "udpSocket", () => check("Bun.udpSocket", "any"));
  const WS = (globalThis as { WebSocket?: new (...a: unknown[]) => object }).WebSocket;
  if (WS !== undefined) {
    (globalThis as { WebSocket?: unknown }).WebSocket = class extends WS {
      constructor(...args: unknown[]) {
        check("WebSocket", urlHost(args[0]));
        super(...args);
      }
    };
  }
}
