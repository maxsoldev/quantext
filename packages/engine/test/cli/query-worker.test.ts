/** The query worker: answers as the query layer does, shares identical requests, bounds its queue and its time. */
import type { Items, SessionKey } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { claudeCodeCodec } from "../../src/adapters/claude-code/index.ts";
import { createQueryWorker } from "../../src/cli/query-worker-pool.ts";
import { createQuery } from "../../src/query/index.ts";
import { ingested } from "../query/corpus.ts";
import { onCleanup } from "../store/temp.ts";

async function setup(limits: Parameters<typeof createQueryWorker>[1] = {}) {
  const { db, dataDir } = await ingested(["basic-tools"]);
  const query = createQuery({ db, codec: claudeCodeCodec });
  const key = query.listSessions().items[0] as SessionKey;
  const worker = createQueryWorker({ dataDir }, limits);
  onCleanup(() => worker.close());
  return { query, key, worker };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string; status?: number }) => `${e.status} ${e.code}`,
  );

describe("the query worker", () => {
  test("answers as the query layer, and shares one computation between identical requests", async () => {
    const { query, key, worker } = await setup();
    const one = worker.run("blockLifetimes", key, { limit: 3 });
    const two = worker.run("blockLifetimes", key, { limit: 3 });
    expect(two).toBe(one);
    expect(await one).toEqual(query.blockLifetimes(key, { limit: 3 }));
    const outputs = (await worker.run("toolOutputs", key, { limit: 2 })) as Items<unknown>;
    expect(outputs).toEqual(query.toolOutputs(key, { limit: 2 }));
  });

  test("refuses more than its queue holds, with 503 busy", async () => {
    const { key, worker } = await setup({ maxPending: 2 });
    const runs = [1, 2, 3].map((limit) => code(worker.run("blockLifetimes", key, { limit })));
    expect(await Promise.all(runs)).toEqual(["ok", "ok", "503 busy"]);
  });

  test("stops a request over its time limit with 503 timeout", async () => {
    const { key, worker } = await setup({ timeoutMs: 1 });
    expect(await code(worker.run("blockLifetimes", key, {}))).toBe("503 timeout");
  });

  test("fails what waits with 503 stopping when it closes", async () => {
    const { key, worker } = await setup();
    const waiting = code(worker.run("toolOutputs", key, {}));
    await worker.close();
    expect(await waiting).toBe("503 stopping");
    expect(await code(worker.run("toolOutputs", key, {}))).toBe("503 stopping");
  });
});
