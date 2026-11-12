/**
 * The no-egress guard's allowlist (SECURITY.md, "The no-egress guard"). Every entry has a reason. Change it
 * only in a reviewed commit that says why; the guard (`pnpm egress`) fails on anything not listed here.
 */
import type { EgressPolicy } from "./egress.ts";

/** The mod's start script (packages/mod/src/viewer.ts START_SCRIPT), repeated here so a change is reviewed twice. */
const START_SCRIPT = 'umask 077; mkdir -p "$3" && nohup "$0" "$1" serve --live while-viewer >>"$2" 2>&1 </dev/null &';

export const POLICY: EgressPolicy = {
  documentationUrls: [
    {
      prefix: "https://platform.claude.com/docs/en/about-claude/pricing",
      reason: "the source of the price table, cited",
    },
    { prefix: "https://nodejs.org", reason: "install hint in a toast when no runtime is found" },
    { prefix: "https://bun.sh", reason: "install hint in a toast when no runtime is found" },
  ],
  commands: [
    { argv: ["open", null], reason: "opens the viewer's URL in the browser on macOS" },
    { argv: ["xdg-open", null], reason: "opens the viewer's URL in the browser on Linux" },
    { argv: ["rundll32", "url.dll,FileProtocolHandler", null], reason: "opens the viewer's URL on Windows" },
    { argv: [["node", "bun"], "--version"], reason: "the mod finds a runtime for the engine" },
    { argv: ["uname", "-s"], reason: "the mod picks open or xdg-open" },
    {
      argv: ["sh", "-c", START_SCRIPT, ["node", "bun"], null, null, null],
      reason: "the mod starts the bundled engine detached (ARCHITECTURE, Starting the engine)",
    },
  ],
};
