/** engine.json is a hint written by another process: read strictly, its URL never trusted. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineFile } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { readEngineFile, writeEngineFile } from "../../src/cli/engine-file.ts";
import { tempDir } from "../store/temp.ts";

const good: EngineFile = {
  apiVersion: 1,
  version: "0.1.0",
  pid: 42,
  port: 4747,
  url: "http://127.0.0.1:4747/",
  startedAt: "x",
};

function read(content: unknown): ReturnType<typeof readEngineFile> {
  const dir = tempDir("qx-data-");
  writeFileSync(join(dir, "engine.json"), typeof content === "string" ? content : JSON.stringify(content));
  return readEngineFile(dir, () => undefined);
}

describe("readEngineFile", () => {
  test("reads what writeEngineFile wrote", () => {
    const dir = tempDir("qx-data-");
    writeEngineFile(dir, good);
    expect(readEngineFile(dir, () => undefined)).toEqual(good);
  });

  test("builds the URL from the port, whatever the file says", () => {
    for (const url of ["-a Calculator", "http://evil.example/", "file:///etc/passwd", "\u001b[31mred"]) {
      expect(read({ ...good, url })?.url).toBe("http://127.0.0.1:4747/");
    }
  });

  test("is no engine when a field is missing or not what it must be", () => {
    for (const bad of [
      { ...good, port: 0 },
      { ...good, port: 65_536 },
      { ...good, port: 47.5 },
      { ...good, port: "4747" },
      { ...good, pid: -1 },
      { ...good, pid: 1.5 },
      { ...good, version: 1 },
      { ...good, version: "1.0\u001b[2J" },
      { ...good, version: "x".repeat(65) },
      { ...good, apiVersion: "1" },
      null,
      [],
      "not json",
    ]) {
      expect([bad, read(bad)]).toEqual([bad, undefined]);
    }
  });

  test("is no engine, with a warning, when the file cannot be read", () => {
    const dir = tempDir("qx-data-");
    mkdirSync(join(dir, "engine.json"));
    const warnings: string[] = [];
    expect(readEngineFile(dir, (w) => warnings.push(w))).toBeUndefined();
    expect(warnings).toEqual([expect.stringMatching(/^cannot read .*engine\.json \(EISDIR\)/)]);
  });
});
