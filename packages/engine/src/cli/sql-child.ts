/**
 * `qx sql` runs each statement in this process, so that a statement that never ends can be killed (neither SQLite
 * module can interrupt one) and never runs in the engine. Reads `{ dataDir, sql, limit }` as JSON on stdin and
 * writes `{ result }` or `{ error, rejected }` as JSON on stdout.
 */
import "./quiet.ts";
import { installViews, runSql, SqlRejectedError } from "../query/index.ts";
import { openReader } from "../store/index.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const { dataDir, sql, limit } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
  dataDir: string;
  sql: string;
  limit: number;
};
let reply: object;
try {
  const db = await openReader(dataDir, { setup: installViews, readsOnly: true });
  try {
    reply = { result: runSql(db, sql, { limit }) };
  } finally {
    db.close();
  }
} catch (error) {
  reply = {
    error: error instanceof Error ? error.message : String(error),
    rejected: error instanceof SqlRejectedError,
  };
}
process.stdout.write(JSON.stringify(reply));
