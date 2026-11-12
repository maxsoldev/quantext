import type { MemoryDocumentView } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { indexEntries, memoryFiles } from "./model.ts";

const doc = (path: string, mtimeMs: number, content = ""): MemoryDocumentView => ({
  path,
  content,
  mtimeMs,
  size: content.length,
});

describe("a project's memory files", () => {
  test("the index first, then the most recently changed", () => {
    const files = memoryFiles([doc("b.md", 10), doc("MEMORY.md", 1), doc("a.md", 20)]);
    expect(files.map((f) => f.path)).toEqual(["MEMORY.md", "a.md", "b.md"]);
  });

  test("the index's entries name the files it points to, with their line of description", () => {
    const index = "# Memory\n- [Style](style.md) — how we write\n- [Old](gone.md)\nsome text";
    expect(indexEntries(index)).toEqual([
      { title: "Style", file: "style.md", hook: "how we write" },
      { title: "Old", file: "gone.md", hook: "" },
    ]);
  });
});
