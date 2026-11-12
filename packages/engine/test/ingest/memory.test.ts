import { chmodSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createIngest } from "../../src/ingest/index.ts";
import { openStore } from "../../src/store/index.ts";
import { onCleanup, tempDir } from "../store/temp.ts";
import { writeText } from "./corpus.ts";

async function setup() {
  const root = tempDir("qx-root-");
  const store = await openStore({ dataDir: tempDir("qx-data-") });
  onCleanup(() => store.close());
  const project = join(root, "projects", "-repo");
  return { root, store, project, ingest: createIngest({ store, root }) };
}

const docs = (store: Awaited<ReturnType<typeof setup>>["store"]) =>
  store.db.prepare("SELECT project_dir, path, content FROM project_memory ORDER BY project_dir, path").all();

describe("ingest of project memory", () => {
  test("reads the Markdown files of each project's memory folder, and nothing else there", async () => {
    const { store, project, ingest } = await setup();
    writeText(join(project, "memory", "MEMORY.md"), "- [a](a.md)\n");
    writeText(join(project, "memory", "a.md"), "a note\n");
    writeText(join(project, "memory", "image.png"), "not text");
    writeText(join(project, "memory", "deeper", "b.md"), "not in the memory folder itself");
    writeText(join(project, "s.jsonl"), "");
    const summary = await ingest.ingestAll();
    expect(summary.errors).toEqual([]);
    expect(docs(store)).toEqual([
      { project_dir: project, path: "MEMORY.md", content: "- [a](a.md)\n" },
      { project_dir: project, path: "a.md", content: "a note\n" },
    ]);
  });

  test("reads a changed file again and deletes a removed one; an unchanged one is not read", async () => {
    const { store, project, ingest } = await setup();
    const a = join(project, "memory", "a.md");
    writeText(a, "one");
    writeText(join(project, "memory", "b.md"), "b");
    await ingest.ingestAll();
    const when = new Date("2026-01-01T00:00:00Z");
    writeFileSync(a, "two, longer");
    utimesSync(a, when, when);
    rmSync(join(project, "memory", "b.md"));
    await ingest.ingestAll();
    expect(docs(store)).toEqual([{ project_dir: project, path: "a.md", content: "two, longer" }]);
    // Same size and mtime: taken as unchanged, so the stored content stays.
    writeFileSync(a, "TWO, LONGER");
    utimesSync(a, when, when);
    await ingest.ingestAll();
    expect(docs(store)).toEqual([{ project_dir: project, path: "a.md", content: "two, longer" }]);
  });

  test.skipIf(process.getuid?.() === 0)("reports an unreadable memory file and keeps the others", async () => {
    const { store, project, ingest } = await setup();
    writeText(join(project, "memory", "a.md"), "a");
    writeText(join(project, "memory", "locked.md"), "secret");
    chmodSync(join(project, "memory", "locked.md"), 0o000);
    onCleanup(() => chmodSync(join(project, "memory", "locked.md"), 0o644));
    const summary = await ingest.ingestAll();
    expect(summary.errors.map((e) => e.path)).toEqual([join(project, "memory", "locked.md")]);
    expect(store.report().scan.map((s) => s.path)).toEqual([join(project, "memory", "locked.md")]);
    expect(docs(store)).toEqual([{ project_dir: project, path: "a.md", content: "a" }]);
  });
});
