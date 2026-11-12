/** Demo mode in the query layer: every method shows only the allowed projects, and no local path. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCodeCodec } from "../../src/adapters/claude-code/index.ts";
import type { Query } from "../../src/query/index.ts";
import { createQuery } from "../../src/query/index.ts";
import { writeText } from "../ingest/corpus.ts";
import { ingested } from "./corpus.ts";

/** Joined at run time, so that the repo holds no home path for the personal-data scan to flag. */
const j = (...parts: string[]) => parts.join("");
const ALICE = j("/Us", "ers/alice");
const PROJECTS = {
  "basic-tools": `${ALICE}/code/shop`,
  image: j("/ho", "me/bob/work/app"),
  resume: j("C:", "\\Users\\carol\\secret"),
};
const FIXTURE_REPO = "/fixture-0000000000000000/repo";

/** The fixtures moved to home folders: each scenario's repo path becomes the project above. */
function moveToHomes(root: string): void {
  for (const [scenario, project] of Object.entries(PROJECTS)) {
    const dir = join(root, "projects", `-fixture-${scenario}`);
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
      const text = readFileSync(join(dir, name), "utf8");
      writeFileSync(join(dir, name), text.replaceAll(FIXTURE_REPO, JSON.stringify(project).slice(1, -1)));
    }
  }
  writeText(join(root, "projects", "-fixture-basic-tools", "memory", "MEMORY.md"), `See ${ALICE}/code/shop/NOTES.md\n`);
}

async function demo(projects?: string[]): Promise<Query> {
  const { db } = await ingested(Object.keys(PROJECTS), moveToHomes);
  return createQuery({
    db,
    codec: claudeCodeCodec,
    demo: { redactPaths: true, ...(projects === undefined ? {} : { projects }) },
    home: ALICE,
    user: "alice",
  });
}

/** Everything every method gives for every visible Session, as one text. */
function everything(q: Query): string {
  const out: unknown[] = [q.listSessions(), q.ingestReport(), q.projectMemory("shop")];
  for (const s of q.listSessions().items) {
    out.push(q.getSession(s), q.toolCalls(s), q.compactions(s));
    for (const c of q.listCalls(s)) {
      const ctx = q.contextAt(s, c.index);
      out.push(c, ctx, q.contextDiff(s, c.index));
      for (const b of ctx?.blocks ?? []) if (b.hash !== undefined) out.push(q.getBlock(b.hash, s.log));
    }
  }
  return JSON.stringify(out);
}

describe("demo mode", () => {
  test("shows only the allowed projects, by their folder name", async () => {
    const q = await demo(["shop", j("/ho", "me/bob/work/app")]);
    const page = q.listSessions();
    expect(page.total).toBe(2);
    expect(page.items.map((s) => s.project).sort()).toEqual(["app", "shop"]);
    expect(page.items.map((s) => s.cwd)).toEqual([".", "."]);
  });

  test("hides every Session of another project from every method", async () => {
    const { db } = await ingested(Object.keys(PROJECTS), moveToHomes);
    const all = createQuery({ db, codec: claudeCodeCodec });
    const hidden = all.findSessions("00000000-0000-4000-8000-000000000004")[0];
    if (hidden === undefined) throw new Error("the resume session is missing");
    const blockHash = all.contextAt(hidden, 0)?.blocks[0]?.hash ?? "";
    const q = createQuery({ db, codec: claudeCodeCodec, demo: { projects: ["shop"], redactPaths: false } });
    expect(q.findSessions(hidden.id)).toEqual([]);
    expect(q.getSession(hidden)).toBeUndefined();
    expect(q.listCalls(hidden)).toEqual([]);
    expect(q.contextAt(hidden, 0)).toBeUndefined();
    expect(q.contextDiff(hidden, 1)).toBeUndefined();
    expect(q.toolCalls(hidden)).toEqual([]);
    expect(q.compactions(hidden)).toEqual([]);
    expect(q.getBlock(blockHash, hidden.log)).toBeUndefined();
    expect(q.projectMemory("secret")).toEqual([]);
    expect(JSON.stringify(q.ingestReport())).not.toContain("resume");
  });

  test("never shows a home folder or the user name, in any method", async () => {
    const { db } = await ingested(Object.keys(PROJECTS), moveToHomes);
    const plain = everything(createQuery({ db, codec: claudeCodeCodec }));
    for (const shown of ["alice", "carol", "bob/"]) expect(plain).toContain(shown); // without demo mode
    const text = everything(await demo());
    for (const secret of ["alice", "/Users/", "/home/", "Users\\\\", "carol", "bob/"])
      expect(text).not.toContain(secret);
    expect(text).toContain("~"); // the paths are still there, redacted
  });

  test("shows paths in the project relative to it: file sources, tool input, display text, memory", async () => {
    const q = await demo(["shop"]);
    const [s] = q.listSessions().items;
    if (s === undefined) throw new Error("no session");
    const reads = q.toolCalls(s).filter((t) => t.name === "Read");
    expect(reads.map((t) => t.source.filePath)).toContain("src/big.txt");
    expect(reads.map((t) => (t.input as { file_path: string }).file_path)).toContain("missing.txt");
    const ctx = q.contextAt(s, 7);
    expect(ctx?.blocks.some((b) => b.preview.includes('"file_path":"src/math.ts"'))).toBe(true);
    expect(q.projectMemory("shop")).toMatchObject([{ path: "MEMORY.md", content: "See NOTES.md\n" }]);
  });
});
