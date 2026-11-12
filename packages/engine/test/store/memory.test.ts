import { describe, expect, test } from "vitest";
import type { Store } from "../../src/store/index.ts";
import { openStore } from "../../src/store/index.ts";
import { onCleanup, tempDir } from "./temp.ts";

async function open(dataDir = tempDir()): Promise<Store> {
  const store = await openStore({ dataDir });
  onCleanup(() => store.close());
  return store;
}

const doc = (path: string, content: string, mtimeMs = 1000) => ({
  projectDir: "/projects/-repo",
  path,
  content,
  mtimeMs,
  size: content.length,
});

describe("project memory documents", () => {
  test("are kept by project folder and path, with their marks for change detection", async () => {
    const store = await open();
    store.memory.write({ put: [doc("MEMORY.md", "# index"), doc("notes/a.md", "a")], remove: [] });
    expect(store.memory.marks()).toEqual([
      { projectDir: "/projects/-repo", path: "MEMORY.md", mtimeMs: 1000, size: 7 },
      { projectDir: "/projects/-repo", path: "notes/a.md", mtimeMs: 1000, size: 1 },
    ]);
  });

  test("replace a changed document and delete a removed one, in one write", async () => {
    const dataDir = tempDir();
    const store = await openStore({ dataDir });
    store.memory.write({ put: [doc("MEMORY.md", "# index"), doc("a.md", "a")], remove: [] });
    store.memory.write({
      put: [doc("MEMORY.md", "# index v2", 2000)],
      remove: [{ projectDir: "/projects/-repo", path: "a.md" }],
    });
    store.close();
    const again = await open(dataDir);
    expect(again.memory.marks()).toEqual([
      { projectDir: "/projects/-repo", path: "MEMORY.md", mtimeMs: 2000, size: 10 },
    ]);
    expect(again.db.prepare("SELECT content FROM project_memory").all()).toEqual([{ content: "# index v2" }]);
  });
});
