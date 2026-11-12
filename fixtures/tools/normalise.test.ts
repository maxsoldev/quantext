import { describe, expect, test } from "vitest";
import { normaliseSession, replacementsFor } from "./normalise.ts";

const ROOT = "/private/tmp/qxrec.Ab12";
const P = "/fixture-00000000000000"; // the placeholder: as long as ROOT
const REPLACE = [[ROOT, P]] as const;
const jsonl = (...rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const rowsOf = (text: string | undefined) =>
  (text ?? "")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

// Hashes are literals from `printf '%s' '<key-sorted JSON>' | shasum -a 256`, not from the code under test.
const HASH_X = "4df15c38b8085060d347df44ed3a3aadb3eb6bd77f36d54e614019cbb87cbcc9"; // {"content":"x","role":"user"}
const HASH_SEE = "02c9f35bc93fe66408186eb6b7b151924832b6a22ae6d4a5aab7770dc6f6e56e"; // content "see P/repo/a.txt"
const HASH_SEE_RECORDED = "dfac3364cb440e35bbcd648dfb18b158487531125468725a5f1b6a64fee627e3"; // before normalisation
const HASH_SHAPE = "99a1492628fede6bee2ec2133d17db1410569410e7df281c49d5f84e54d27c2c"; // system "cwd P/repo"

describe("normaliseSession", () => {
  test("replaces paths in every string value and key, and keeps other lines byte for byte", () => {
    const untouched = '{"type":"queue-operation", "operation":"enqueue"}';
    const changed = jsonl({ type: "attachment", cwd: `${ROOT}/repo`, files: { [`${ROOT}/repo/a.txt`]: 1 } });
    const { files } = normaliseSession({ "s.jsonl": `${untouched}\n${changed}` }, REPLACE);
    expect(files["s.jsonl"]).toBe(
      `${untouched}\n${jsonl({ type: "attachment", cwd: `${P}/repo`, files: { [`${P}/repo/a.txt`]: 1 } })}`,
    );
  });

  test("applies replacements in the given order", () => {
    const { files } = normaliseSession({ "s.jsonl": jsonl({ a: `${ROOT}/x -private-tmp-qxrec-Ab12` }) }, [
      [ROOT, P],
      ["-private-tmp-qxrec-Ab12", "-fixture-00000000000000"],
    ]);
    expect(rowsOf(files["s.jsonl"])).toEqual([{ a: `${P}/x -fixture-00000000000000` }]);
  });

  test("keeps the length of every string, so content sizes and token estimates do not change", () => {
    const text = `a ${ROOT} b`;
    const row = { type: "user", cwd: `${ROOT}/repo`, message: { role: "user", content: [{ text }] } };
    const [after] = rowsOf(normaliseSession({ "s.jsonl": jsonl(row) }, REPLACE).files["s.jsonl"]);
    expect(after.cwd.length).toBe(row.cwd.length);
    expect(after.message.content[0].text.length).toBe(text.length);
    expect(JSON.stringify(after).length).toBe(JSON.stringify(row).length);
  });

  test("rejects a replacement that changes the length", () => {
    expect(() => normaliseSession({ "s.jsonl": "{}\n" }, [[ROOT, "/fixture"]])).toThrow(/same length/);
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

  test("remaps a tail hash of a string prompt that the API received as one text block", () => {
    const input = jsonl(
      { type: "user", message: { role: "user", content: `see ${ROOT}/repo/a.txt` } },
      { type: "api-request", keep: 0, tail: ["cc6bf601be8f19d8c1e95d87761efc433153d93c9ded6afa3b9337d3645f396b"] },
    );
    const result = normaliseSession({ "s.jsonl": input }, REPLACE);
    expect(rowsOf(result.files["s.jsonl"])[1].tail).toEqual([
      "e6f0d4fbb8033b71dddc49052bda5a1d98f5e53b1db2a05eeb1c8e78cdc6282d",
    ]);
    expect(result.unresolvedTailHashes).toBe(0);
  });

  test("remaps the tail hash of one API message made of adjacent user rows (tool result, then skill text)", () => {
    const input = jsonl(
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `ok ${ROOT}` }] },
      },
      { type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "skill" }] } },
      { type: "attachment" },
      { type: "api-request", keep: 0, tail: ["e8ad691996a4e82e381f0e9a856adda9b7591542508996a8c8045584b73f0fad"] },
    );
    const result = normaliseSession({ "s.jsonl": input }, REPLACE);
    expect(rowsOf(result.files["s.jsonl"])[3].tail).toEqual([
      "2bb892d4040733fdbbcc0c5974508aba93d6deec699624463fe3147bb2c9c35a",
    ]);
    expect(result.unresolvedTailHashes).toBe(0);
  });

  test("remaps the tail hash of an assistant message that is split over rows with one message id", () => {
    const part = (text: string) => ({ role: "assistant", id: "msg_1", content: [{ type: "text", text }] });
    const input = jsonl(
      { type: "assistant", message: part(`in ${ROOT}/repo`) },
      { type: "user", message: { role: "user", content: "between" } },
      { type: "assistant", message: part("two") },
      { type: "api-request", keep: 0, tail: ["a9dcf240e712548ebdc145886051d14e259530e87beb8b3ec7ba9cb5f38da91f"] },
    );
    const result = normaliseSession({ "s.jsonl": input }, REPLACE);
    expect(rowsOf(result.files["s.jsonl"])[3].tail).toEqual([
      "4e431f07c3b32918736fa20cdfb61ebc9647c598da9f085c8c12aebe739f37dd",
    ]);
    expect(result.unresolvedTailHashes).toBe(0);
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
    expect(files["agent.meta.json"]).toBe(`{"cwd": "${P}/repo"}\n`);
  });

  test("fails on a line that is not JSON", () => {
    expect(() => normaliseSession({ "s.jsonl": "{nope\n" }, REPLACE)).toThrow(/s\.jsonl:1/);
  });
});

describe("replacementsFor", () => {
  test("maps the recording root, plain and dash-encoded, to a placeholder of the same length", () => {
    expect(replacementsFor("/private/tmp/qxrec.Ab12Cd")).toEqual([
      ["/private/tmp/qxrec.Ab12Cd", "/fixture-0000000000000000"],
      ["-private-tmp-qxrec-Ab12Cd", "-fixture-0000000000000000"],
    ]);
  });

  test("works for a shorter root, as on Linux", () => {
    expect(replacementsFor("/tmp/qxrec.Ab12Cd")).toEqual([
      ["/tmp/qxrec.Ab12Cd", "/fixture-00000000"],
      ["-tmp-qxrec-Ab12Cd", "-fixture-00000000"],
    ]);
  });
});
