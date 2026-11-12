/** An engine API on a free port over the ingested fixtures, and a raw HTTP client that can set any header. */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { CallsEvent } from "@quantext/shared";
import { claudeCodeCodec } from "../../src/adapters/claude-code/index.ts";
import type { Api, ApiOptions } from "../../src/api/index.ts";
import { createApi } from "../../src/api/index.ts";
import type { Query } from "../../src/query/index.ts";
import { createQuery } from "../../src/query/index.ts";
import { ingested } from "../query/corpus.ts";
import { onCleanup, tempDir } from "../store/temp.ts";

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  bytes: Buffer;
  json<T = Record<string, unknown>>(): T;
}

/** A GET (or `method`) with the right Host unless `headers` sets another; `host: null` sends none. */
export function get(
  port: number,
  path: string,
  headers: Record<string, string | null> = {},
  method = "GET",
): Promise<Reply> {
  const sent: Record<string, string> = { host: `127.0.0.1:${port}` };
  for (const [k, v] of Object.entries(headers)) {
    if (v === null) delete sent[k];
    else sent[k] = v;
  }
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: sent, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const body = bytes.toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          bytes,
          json: <T>() => JSON.parse(body) as T,
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

export interface Engine {
  api: Api;
  port: number;
  query: Query;
  /** The data folder and the transcript root of the ingested fixtures. */
  dataDir: string;
  root: string;
  staticDir: string;
  /** What the API reported as failed (500s, events not sent). */
  errors: unknown[];
}

/** A viewer folder: a page, a hashed asset, a dot file, and a symbolic link to a file outside. */
export function viewerDir(): string {
  const dir = tempDir("qx-web-");
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><title>Quantext</title><script src="/assets/app-1.js"></script>',
  );
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app-1.js"), "console.log(1);\n");
  writeFileSync(join(dir, "assets", "style.css"), "body{}\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  const outside = tempDir("qx-outside-");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
  symlinkSync(outside, join(dir, "linkdir"));
  return dir;
}

/** The fixtures ingested, a query over them, and an API listening on a free port; closed after the test. */
export async function engine(
  names: string[] = ["basic-tools", "image"],
  options: Partial<Omit<ApiOptions, "query">> = {},
): Promise<Engine> {
  const { db, dataDir, root } = await ingested(names);
  const query = createQuery({ db, codec: claudeCodeCodec });
  const staticDir = options.staticDir ?? viewerDir();
  const errors: unknown[] = [];
  const api = createApi({
    query,
    staticDir,
    info: {
      version: "0.0.0-test",
      pid: process.pid,
      startedAt: "2026-11-12T00:00:00.000Z",
      dataDir,
    },
    onError: (error) => errors.push(error),
    ...options,
  });
  const port = await api.listen(0);
  onCleanup(() => api.close());
  return { api, port, query, dataDir, root, staticDir, errors };
}

/** An ingest event as the store would number it. */
export const callsEvent = (log: number, sessionId: string, cursor: number, index = 99): CallsEvent => ({
  kind: "calls",
  logId: log,
  cursor,
  sessionId,
  added: [`call-${cursor}-${index}`],
  addedIndexes: [index],
  updated: [],
});
