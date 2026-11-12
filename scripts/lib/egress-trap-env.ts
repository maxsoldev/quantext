import { join } from "node:path";

const TRAP = join(import.meta.dirname, "egress-trap.ts");

/**
 * The environment that preloads the network tripwire (egress-trap.ts) into a runtime and every child it
 * starts, logging to `log`. `runtime` is the one that will run: this one by default.
 */
export function trapEnv(
  log: string,
  runtime: "node" | "bun" = process.versions.bun ? "bun" : "node",
): NodeJS.ProcessEnv {
  const preload = runtime === "bun" ? { BUN_OPTIONS: `--preload=${TRAP}` } : { NODE_OPTIONS: `--import=${TRAP}` };
  return { ...preload, QX_EGRESS_LOG: log };
}
