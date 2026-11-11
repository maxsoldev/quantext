import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";

const script = join(import.meta.dirname, "scan-personal-data.ts");
const j = (...parts: string[]) => parts.join("");
let root = "";

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Write `files` into a fresh git repo and run the scan on it. */
function runOn(files: Record<string, string>, env: Record<string, string> = {}) {
  root = mkdtempSync(join(tmpdir(), "qx-scan-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return spawnSync(process.execPath, [script, root], { encoding: "utf8", env: { ...process.env, ...env } });
}

test("passes on a repo with no personal data, and skips ignored files", () => {
  const result = runOn({
    ".gitignore": "node_modules/\n",
    "README.md": "Data lives in ~/.quantext.\n",
    "node_modules/x/index.js": j("// /Us", "ers/alice\n"),
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("fails and names file, line and kind, without printing the match", () => {
  const result = runOn({ "fixtures/session.jsonl": j('{"a":1}\n{"cwd":"/Us', 'ers/alice/project"}\n') });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("fixtures/session.jsonl:2  home path");
  expect(result.stderr).not.toContain("alice");
  expect(result.stderr).not.toContain(j("/Us", "ers"));
});

test("finds the local user name, read from the environment at run time", () => {
  const result = runOn({ "notes.md": "Recorded by Zelda-Q.\n" }, { USER: "zelda-q" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("notes.md:1  local identity");
});

test("checks file paths too", () => {
  const result = runOn({ [j("notes/dave", "@", "corp.io.txt")]: "hello\n" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("(path)  email");
});

test("with --history, finds personal data that a later commit removed", () => {
  runOn({ "fixtures/a.jsonl": j('{"cwd":"/Us', 'ers/alice/x"}\n') });
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root });
  git("add", "-A");
  git("commit", "-qm", "add");
  git("rm", "-q", "fixtures/a.jsonl");
  git("commit", "-qm", "remove");
  expect(spawnSync(process.execPath, [script, root]).status).toBe(0);
  const history = spawnSync(process.execPath, [script, "--history", root], { encoding: "utf8" });
  expect(history.status).toBe(1);
  expect(history.stderr).toMatch(/^[0-9a-f]{7} fixtures\/a\.jsonl {2}home path$/m);
});
