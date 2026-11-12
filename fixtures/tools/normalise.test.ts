import { describe, expect, test } from "vitest";
import { normaliseSession } from "./normalise.ts";

const ROOT = "/private/tmp/qxrec.Ab12";
const REPLACE = [[`${ROOT}/repo`, "/fixture/repo"]] as const;
const jsonl = (...rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const rowsOf = (text: string | undefined) =>
  (text ?? "")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

// Hashes are literals from `printf '%s' '<key-sorted JSON>' | shasum -a 256`, not from the code under test.
const HASH_X = "4df15c38b8085060d347df44ed3a3aadb3eb6bd77f36d54e614019cbb87cbcc9"; // {"content":"x","role":"user"}
const HASH_SEE = "ea74a326c3e6cc97f0ef3460f54b098dfd9c0d50e0fdaf3d399e7e4f8ac9f75f"; // content "see /fixture/repo/a.txt"
const HASH_SEE_RECORDED = "dfac3364cb440e35bbcd648dfb18b158487531125468725a5f1b6a64fee627e3"; // before normalisation
const HASH_SHAPE = "965e2766e1f7f43dd1da892ff399ad114239ae33d15edcf68e88a3b16cd11775"; // system "cwd /fixture/repo"

describe("normaliseSession", () => {
  test("replaces paths in every string value and key, and keeps other lines byte for byte", () => {
    const untouched = '{"type":"queue-operation", "operation":"enqueue"}';
    const changed = jsonl({ type: "attachment", cwd: `${ROOT}/repo`, files: { [`${ROOT}/repo/a.txt`]: 1 } });
    const { files } = normaliseSession({ "s.jsonl": `${untouched}\n${changed}` }, REPLACE);
    expect(files["s.jsonl"]).toBe(
      `${untouched}\n${jsonl({ type: "attachment", cwd: "/fixture/repo", files: { "/fixture/repo/a.txt": 1 } })}`,
    );
  });

  test("applies replacements in the given order", () => {
    const { files } = normaliseSession({ "s.jsonl": jsonl({ a: `${ROOT}/repo/x ${ROOT}/home` }) }, [
      [`${ROOT}/repo`, "/fixture/repo"],
      [ROOT, "/fixture"],
    ]);
    expect(rowsOf(files["s.jsonl"])).toEqual([{ a: "/fixture/repo/x /fixture/home" }]);
  });

  test("rehashes a changed blob and points the tails that used it to the new hash", () => {
    const oldMessage = { role: "user", content: `see ${ROOT}/repo/a.txt` };
    const input = jsonl(
      { type: "api-request-blob", hash: "old-blob", message: oldMessage },
      { type: "api-request-blob", hash: HASH_X, message: { role: "user", content: "x" } },
      { type: "api-request", keep: 0, tail: ["old-blob", HASH_X] },
    );
    const { files } = normaliseSession({ "s.jsonl": input }, REPLACE);
    const [blob, , request] = rowsOf(files["s.jsonl"]);
    expect(blob.hash).toBe(HASH_SEE);
    expect(request.tail).toEqual([HASH_SEE, HASH_X]);
  });

  test("remaps tail hashes that point at user and assistant rows (hash of role and content)", () => {
    const content = `see ${ROOT}/repo/a.txt`;
    const input = jsonl(
      { type: "user", uuid: "u1", message: { role: "user", content } },
      { type: "api-request", keep: 0, tail: [HASH_SEE_RECORDED] },
    );
    const { files, unresolvedTailHashes } = normaliseSession({ "s.jsonl": input }, REPLACE);
    expect(rowsOf(files["s.jsonl"])[1].tail).toEqual([HASH_SEE]);
    expect(unresolvedTailHashes).toBe(0);
  });

  test("rehashes a changed shape and the requests that use it", () => {
    const shape = { system: [{ type: "text", text: `cwd ${ROOT}/repo` }], tools: [] };
    const input = jsonl(
      { type: "api-request-shape", shapeHash: "old-shape", shape },
      { type: "api-request", shapeHash: "old-shape", keep: 0, tail: [] },
    );
    const [shapeRow, request] = rowsOf(normaliseSession({ "s.jsonl": input }, REPLACE).files["s.jsonl"]);
    expect(shapeRow.shapeHash).toBe(HASH_SHAPE);
    expect(request.shapeHash).toBe(HASH_SHAPE);
  });

  test("maps hashes across the files of one session (main and subagent)", () => {
    const files = {
      "main.jsonl": jsonl({
        type: "api-request-blob",
        hash: "old",
        message: { role: "user", content: `see ${ROOT}/repo/a.txt` },
      }),
      "main/subagents/agent-1.jsonl": jsonl({ type: "api-request", keep: 0, tail: ["old"] }),
    };
    const out = normaliseSession(files, REPLACE).files;
    expect(rowsOf(out["main/subagents/agent-1.jsonl"])[0].tail).toEqual([HASH_SEE]);
  });

  test("counts tail hashes that match no message, and leaves them as recorded", () => {
    const input = jsonl({ type: "api-request", keep: 0, tail: ["nowhere"] });
    const result = normaliseSession({ "s.jsonl": input }, REPLACE);
    expect(result.unresolvedTailHashes).toBe(1);
    expect(rowsOf(result.files["s.jsonl"])[0].tail).toEqual(["nowhere"]);
  });

  test("replaces paths in plain JSON files and leaves the rest of their text alone", () => {
    const { files } = normaliseSession({ "agent.meta.json": `{"cwd": "${ROOT}/repo"}\n` }, REPLACE);
    expect(files["agent.meta.json"]).toBe('{"cwd": "/fixture/repo"}\n');
  });

  test("fails on a line that is not JSON", () => {
    expect(() => normaliseSession({ "s.jsonl": "{nope\n" }, REPLACE)).toThrow(/s\.jsonl:1/);
  });
});
