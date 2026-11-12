/** Where Claude Code keeps its transcripts. */
import { join } from "node:path";

/** `CLAUDE_CONFIG_DIR` when set, else `~/.claude`, as Claude Code itself decides. */
export function claudeConfigDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir !== undefined && dir !== "" ? dir : join(home, ".claude");
}
