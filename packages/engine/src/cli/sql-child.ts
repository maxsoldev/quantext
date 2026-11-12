/**
 * `qx sql` runs each statement in this process, so that a statement that never ends can be killed (neither SQLite
 * module can interrupt one) and never runs in the engine. Reads `{ dataDir, sql, limit }` as JSON on stdin and
 * writes `{ result }` or `{ error, rejected }` as JSON on stdout. Its first argument is the time limit in ms: a
 * watchdog thread kills this process then, or when the parent is gone.
 */
import "./quiet.ts";
import { Worker } from "node:worker_threads";
import { installViews, runSql, SqlRejectedError } from "../query/index.ts";
import { openReader } from "../store/index.ts";

const limitMs = Number(process.argv[2] ?? 30_000);
/** `.ts` in the repo, `.js` in the bundle (`dist/sql-watchdog.js`). */
const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
const watchdog = new Worker(new URL(`./sql-watchdog.${ext}`, import.meta.url), {
  workerData: { parent: process.ppid, deadline: Date.now() + limitMs },
});
watchdog.unref();

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
  const message = error instanceof Error ? error.message : String(error);
  reply = {
    error: message,
    // SQLite's authorizer denied it: a rejected statement, like one the text check refuses.
    rejected: error instanceof SqlRejectedError || /not authorized/i.test(message),
  };
}
process.stdout.write(JSON.stringify(reply));
