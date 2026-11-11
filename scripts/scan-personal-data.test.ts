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

test("finds the git email of this checkout, read at run time", () => {
  const email = j("zed.q", "@example.com"); // reserved domain: only the local identity rule can find it
  root = mkdtempSync(join(tmpdir(), "qx-scan-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", email], { cwd: root });
  writeFileSync(join(root, "notes.md"), `Recorded by ${email}.\n`);
  const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("notes.md:1  local identity");
});

test("a CI user name such as runner causes no findings in this repo", () => {
  root = mkdtempSync(join(tmpdir(), "qx-scan-")); // unused; keeps afterEach simple
  const repo = join(import.meta.dirname, "..");
  for (const args of [[repo], ["--history", repo]]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, USER: "runner", CI: "true" },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }
});

test("checks file paths too, and prints them redacted", () => {
  const result = runOn({ [j("notes/dave", "@", "corp.io.txt")]: j("cwd /Us", "ers/alice\n") });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("notes/<redacted>.txt  (path)  email");
  expect(result.stderr).toContain("notes/<redacted>.txt:1  home path");
  expect(result.stderr).not.toContain("dave");
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

test("with --history, prints matching paths redacted", () => {
  runOn({ [j("notes/dave", "@", "corp.io.txt")]: "hello\n" });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A"], { cwd: root });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "add"], { cwd: root });
  const history = spawnSync(process.execPath, [script, "--history", root], { encoding: "utf8" });
  expect(history.status).toBe(1);
  expect(history.stderr).toMatch(/^[0-9a-f]{7} notes\/<redacted>\.txt {2}email$/m);
  expect(history.stderr).not.toContain("dave");
});

test("with --history, scans HEAD and remote-tracking branches, not other local refs", () => {
  runOn({ "README.md": "clean\n" });
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root });
  git("add", "-A");
  git("commit", "-qm", "clean");
  git("checkout", "-qb", "scratch");
  writeFileSync(join(root, "README.md"), j("cwd /Us", "ers/alice\n"));
  git("commit", "-qam", "local only");
  git("update-ref", "refs/wip/x", "HEAD");
  git("checkout", "-q", "-");
  git("branch", "-qD", "scratch");
  expect(spawnSync(process.execPath, [script, "--history", root]).status).toBe(0);
});

test("with --history, passes on a repo with no commits yet", () => {
  runOn({});
  expect(spawnSync(process.execPath, [script, "--history", root]).status).toBe(0);
});
