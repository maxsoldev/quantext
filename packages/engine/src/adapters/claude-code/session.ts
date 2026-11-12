/** Map the rows of one transcript to its Session. */
import type { Session } from "@quantext/shared";
import { str } from "./json.ts";
import type { Row } from "./rows.ts";

export const HARNESS = "claude-code";

/** The Session of a transcript: id, version, cwd and the span of its timestamps. */
export function sessionOf(rows: readonly Row[], id: string): Session {
  const session: Session = { id, harness: HARNESS };
  const version = firstString(rows, "version");
  if (version !== undefined) session.harnessVersion = version;
  const cwd = firstString(rows, "cwd");
  if (cwd !== undefined) Object.assign(session, { project: cwd, cwd });
  const times = rows
    .map((row) => str(row.data.timestamp))
    .filter((ts): ts is string => ts !== undefined)
    .sort();
  if (times.length > 0) Object.assign(session, { started: times[0], ended: times[times.length - 1] });
  return session;
}

/** The session id that the rows carry. */
export function sessionIdOf(rows: readonly Row[]): string | undefined {
  return firstString(rows, "sessionId");
}

function firstString(rows: readonly Row[], key: string): string | undefined {
  for (const row of rows) {
    const value = str(row.data[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}
