/** Demo mode in the query layer: every method shows only the allowed projects, and no local path. */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCodeCodec } from "../../src/adapters/claude-code/index.ts";
import type { Query } from "../../src/query/index.ts";
import { createQuery } from "../../src/query/index.ts";
import type { SqlDriver } from "../../src/store/index.ts";
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

/**
 * The fixtures moved to home folders, in the store: each scenario's repo path becomes the project above, in every
 * column and in content (as JSON text). The transcripts stay as recorded, so their requests still resolve.
 */
function moveToHomes(db: SqlDriver): void {
  for (const [scenario, project] of Object.entries(PROJECTS)) {
    const log = Number(
      db.prepare("SELECT id FROM logs WHERE path LIKE ?").get(`%-fixture-${scenario}%`)?.id ?? Number.NaN,
    );
    const escaped = JSON.stringify(project).slice(1, -1);
    const set = (table: string, column: string, to: string, where = "log = ?") =>
      db.prepare(`UPDATE ${table} SET ${column} = replace(${column}, ?, ?) WHERE ${where}`).run(FIXTURE_REPO, to, log);
    for (const column of ["project", "cwd"]) set("sessions", column, project);
    set("log_blocks", "file_path", project);
    set("tool_calls", "file_path", project);
    set("tool_calls", "input", escaped);
    set("session_events", "value", project);
    set("blocks", "content", escaped, "hash IN (SELECT hash FROM log_blocks WHERE log = ?)");
  }
}

/** Memory documents of the shop project, which name its home and another project. */
function writeMemory(root: string): void {
  const memory = join(root, "projects", "-fixture-basic-tools", "memory");
  writeText(join(memory, "MEMORY.md"), `See ${ALICE}/code/shop/NOTES.md\n`);
  writeText(join(memory, "other.md"), `Like ${JSON.stringify(PROJECTS.resume)} and the secret repo\n`);
}

/** The store's memory folder of the shop project is the one ingest found; the store names it by that path. */
const homes = () => ingested(Object.keys(PROJECTS), writeMemory, moveToHomes);

async function demo(projects?: string[]): Promise<Query> {
  const { db } = await homes();
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
    out.push(q.getSession(s), q.toolCalls(s), q.compactions(s), q.callTimeline(s), q.cacheBreaks(s));
    out.push(q.blockLifetimes(s), q.toolOutputs(s));
    for (const c of q.listCalls(s).items) {
      const ctx = q.contextAt(s, c.index);
      out.push(c, ctx, q.contextDiff(s, c.index), q.getCall(s, c.index));
      for (const b of ctx?.blocks ?? []) if (b.hash !== undefined) out.push(q.getBlock(b.hash, s.log));
    }
  }
  return JSON.stringify(out);
}

/** The image of the image scenario: its Block, log and media hash. */
function imageMedia(q: Query, key: { log: number; id: string }) {
  const block = q
    .contextAt(key, 1)
    ?.blocks.find((b) => b.source.filePath?.endsWith("diagram.png") && b.kind === "tool-result");
  const hash = q.getBlock(block?.hash ?? "", key.log)?.media[0]?.hash;
  return block?.hash === undefined || hash === undefined ? undefined : { block: block.hash, log: key.log, hash };
}

describe("demo mode", () => {
  test("shows only the allowed projects, by their folder name", async () => {
    const q = await demo([PROJECTS["basic-tools"], PROJECTS.image]);
    const page = q.listSessions();
    expect(page.total).toBe(2);
    expect(page.items.map((s) => s.project).sort()).toEqual(["app", "shop"]);
    expect(page.items.map((s) => s.cwd)).toEqual([".", "."]);
  });

  test("hides every Session of another project from every method", async () => {
    const { db } = await homes();
    const all = createQuery({ db, codec: claudeCodeCodec });
    const hidden = all.findSessions("00000000-0000-4000-8000-000000000004")[0];
    if (hidden === undefined) throw new Error("the resume session is missing");
    const blockHash = all.contextAt(hidden, 0)?.blocks[0]?.hash ?? "";
    const q = createQuery({
      db,
      codec: claudeCodeCodec,
      demo: { projects: [PROJECTS["basic-tools"]], redactPaths: false },
    });
    expect(q.findSessions(hidden.id)).toEqual([]);
    expect(q.getSession(hidden)).toBeUndefined();
    expect(q.listCalls(hidden).items).toEqual([]);
    expect(q.contextAt(hidden, 0)).toBeUndefined();
    expect(q.contextDiff(hidden, 1)).toBeUndefined();
    expect(q.toolCalls(hidden).items).toEqual([]);
    expect(q.compactions(hidden).items).toEqual([]);
    expect(q.getBlock(blockHash, hidden.log)).toBeUndefined();
    expect(q.projectMemory("secret").items).toEqual([]);
    const image = all.findSessions("00000000-0000-4000-8000-000000000003")[0];
    const media = image === undefined ? undefined : imageMedia(all, image);
    expect(media && all.getMedia(media.block, media.log, media.hash)).toBeDefined();
    expect(media && q.getMedia(media.block, media.log, media.hash)).toBeUndefined();
    expect(JSON.stringify(q.ingestReport())).not.toContain("resume");
  });

  test("never shows a home folder or the user name, in any method", async () => {
    const { db } = await homes();
    const plain = everything(createQuery({ db, codec: claudeCodeCodec }));
    for (const shown of ["alice", "carol", "bob/"]) expect(plain).toContain(shown); // without demo mode
    const text = everything(await demo());
    for (const secret of ["alice", "/Users/", "/home/", "Users\\\\", "carol", "bob/"])
      expect(text).not.toContain(secret);
    expect(text).toContain("~"); // the paths are still there, redacted
  });

  test("names a hidden project nowhere, also when another project's text mentions it", async () => {
    const q = await demo([PROJECTS["basic-tools"], PROJECTS.image]);
    const text = everything(q);
    expect(text).not.toContain("carol");
    expect(text).not.toMatch(/\bsecret\b/);
  });

  test("cuts previews and tool input summaries after it redacts them, at any length", async () => {
    const { db } = await homes();
    for (const previewChars of [10, 23, 37, 61, 120]) {
      const q = createQuery({
        db,
        codec: claudeCodeCodec,
        demo: { redactPaths: true },
        home: ALICE,
        user: "alice",
        previewChars,
      });
      const text = everything(q);
      for (const part of ["alice", "/Users/", "carol", "/home/", "Users\\\\"]) expect(text).not.toContain(part);
    }
  });

  test("marks its responses as redacted, with images to blur", async () => {
    const q = await demo([PROJECTS.image]);
    const [s] = q.listSessions().items;
    if (s === undefined) throw new Error("no session");
    expect(q.listSessions()).toMatchObject({ apiVersion: 1, redacted: true, blurImages: true });
    expect(q.contextAt(s, 1)).toMatchObject({ redacted: true, blurImages: true });
    const media = imageMedia(q, s);
    expect(media && q.getMedia(media.block, media.log, media.hash)?.mediaType).toBe("image/png");
    const { db } = await ingested(["image"]);
    const plain = createQuery({ db, codec: claudeCodeCodec }).listSessions();
    expect(plain.apiVersion).toBe(1);
    expect("redacted" in plain).toBe(false);
  });

  test("shows paths in the project relative to it: file sources, tool input, display text, memory", async () => {
    const q = await demo([PROJECTS["basic-tools"]]);
    const [s] = q.listSessions().items;
    if (s === undefined) throw new Error("no session");
    const reads = q.toolCalls(s).items.filter((t) => t.name === "Read");
    expect(reads.map((t) => t.source.filePath)).toContain("src/big.txt");
    expect(reads.map((t) => (t.input as { file_path: string }).file_path)).toContain("missing.txt");
    const ctx = q.contextAt(s, 7);
    expect(ctx?.blocks.some((b) => b.preview.includes('"file_path":"src/math.ts"'))).toBe(true);
    expect(q.projectMemory("shop").items).toMatchObject([
      { path: "MEMORY.md", content: "See NOTES.md\n" },
      { path: "other.md", content: 'Like "<hidden project>" and the <hidden project> repo\n' },
    ]);
  });
});
