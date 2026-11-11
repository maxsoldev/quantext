import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { localDenylist, redactPath, scanPatch, scanText } from "./personal-data.ts";

/** Join parts at run time, so this file does not itself trip the scan. */
const j = (...parts: string[]) => parts.join("");

describe("scanText", () => {
  test("finds a macOS home path", () => {
    expect(scanText(j("cwd: /Us", "ers/alice/code/app\n"))).toEqual([
      { line: 1, kind: "home path", match: j("/Us", "ers/alice") },
    ]);
  });

  test("finds Linux and Windows home paths", () => {
    const text = j("/ho", "me/bob/.claude\n", "C:", "\\Users\\carol\\AppData\n");
    expect(scanText(text)).toEqual([
      { line: 1, kind: "home path", match: j("/ho", "me/bob") },
      { line: 2, kind: "home path", match: j("C:", "\\Users\\carol") },
    ]);
  });

  test("allows placeholders and paths that name no person", () => {
    const text = j("/Us", "ers/<name>/x  /ho", "me/<user>  ~/.quantext  /Us", "ers/Shared/x  $HOME/.claude\n");
    expect(scanText(text)).toEqual([]);
  });

  test("finds emails, except at reserved example domains and git SSH remotes", () => {
    const text = [
      j("author: dave", "@corp.io"),
      j("ok: user", "@example.com, a", "@b.example, x", "@sub.example.org, t", "@host.test"),
      j("remote: git", "@github.com:org/repo.git"),
      "not an email: @scope/pkg@1.2.3 typescript@7.0.2",
    ].join("\n");
    expect(scanText(text)).toEqual([{ line: 1, kind: "email", match: j("dave", "@corp.io") }]);
  });

  test("finds AWS access keys and sk- API keys", () => {
    const aws = j("AKIA", "IOSFODNN7EXAMPL3");
    const anthropic = j("sk-", "ant-api03-", "a".repeat(40));
    const openai = j("sk-", "proj-", "B1c2D3e4F5g6H7i8J9k0L1m2");
    const text = [`key=${aws}`, `ANTHROPIC_API_KEY=${anthropic}`, `"${openai}"`, "task-list sk-short"].join("\n");
    expect(scanText(text)).toEqual([
      { line: 1, kind: "AWS access key", match: aws },
      { line: 2, kind: "API key (sk-)", match: anthropic },
      { line: 3, kind: "API key (sk-)", match: openai },
    ]);
  });

  test("finds home paths in escaped and encoded forms", () => {
    const text = [
      j('{"cwd":"C:', "\\\\Users\\\\erin\\\\code"),
      j("projects/-Us", "ers-frank-code-app/1.jsonl"),
      j("projects/-ho", "me-gina-src/2.jsonl"),
      j("/ro", "ot/.claude/settings.json"),
      j("file%3A%2F%2F%2FUs", "ers%2Fhank%2Fx"),
    ].join("\n");
    expect(scanText(text).map((f) => [f.line, f.kind])).toEqual([
      [1, "home path"],
      [2, "home path"],
      [3, "home path"],
      [4, "home path"],
      [5, "home path"],
    ]);
  });

  test("ignores /home/ and /Users/ inside web URLs", () => {
    const text = j("see https://example.com/ho", "me/docs and http://host.test/Us", "ers/list\n");
    expect(scanText(text)).toEqual([]);
  });

  test("finds the local git email and host name, given at run time", () => {
    const deny = localDenylist({ email: j("ivan.k", "@corp.io"), hostname: "Ivans-MacBook.local" });
    const text = ["owner: Ivan", j("by ivan.k", "@corp.io"), "on ivans-macbook today", "ivans-macbooks is fine"].join(
      "\n",
    );
    expect(scanText(text, { deny }).map((f) => [f.line, f.kind])).toEqual([
      [2, "email"],
      [2, "local identity"],
      [3, "local identity"],
    ]);
  });

  test("skips host names that are empty, short or generic", () => {
    for (const hostname of ["", "pc", "localhost", "runnervm0abc12", "fv-az123-456", "ip-10-1-2-3.ec2.internal"]) {
      expect(localDenylist({ email: "", hostname })).toEqual([]);
    }
  });

  test("skips common default host names", () => {
    const defaults = ["ubuntu", "Debian", "fedora", "raspberrypi", "MacBook", "macbook-pro.local", "MacBook-Air"];
    const more = ["iMac", "mac-mini", "desktop", "laptop", "devbox", "codespaces-1a2b3c"];
    for (const hostname of [...defaults, ...more]) expect(localDenylist({ email: "", hostname })).toEqual([]);
  });

  test("a host named ubuntu gives no finding on the CI workflow", () => {
    const workflow = readFileSync(join(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");
    expect(scanText(workflow, { deny: localDenylist({ email: "", hostname: "ubuntu" }) })).toEqual([]);
  });
});

describe("scanPatch", () => {
  test("finds personal data in lines that a commit added, once per commit, file and kind", () => {
    const log = [
      "commit 1111111111111111111111111111111111111111",
      "diff --git a/fixtures/a.jsonl b/fixtures/a.jsonl",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/fixtures/a.jsonl",
      "@@ -0,0 +1,2 @@",
      j('+{"cwd":"/Us', 'ers/alice/x"}'),
      j('+{"cwd":"/Us', 'ers/alice/y"}'),
      "commit 2222222222222222222222222222222222222222",
      "diff --git a/fixtures/a.jsonl b/fixtures/a.jsonl",
      "deleted file mode 100644",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      j('-{"cwd":"/Us', 'ers/alice/x"}'),
      "diff --git a/README.md b/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "+Data lives in ~/.quantext.",
    ].join("\n");
    expect(scanPatch(log)).toEqual([{ commit: "1111111", path: "fixtures/a.jsonl", kind: "home path" }]);
  });
});

describe("redactPath", () => {
  test("replaces each path segment that holds personal data, keeping the extension", () => {
    expect(redactPath(j("fixtures/dave", "@corp.io/a.jsonl"))).toBe("fixtures/<redacted>/a.jsonl");
    expect(redactPath("fixtures/clean/a.jsonl")).toBe("fixtures/clean/a.jsonl");
    expect(redactPath(j("notes/dave", "@corp.io.txt"))).toBe("notes/<redacted>.txt");
  });

  test("hides the whole path behind a short hash when the match spans segments", () => {
    expect(redactPath(j("fixtures/-Us", "ers-alice-app/x.jsonl"))).toBe("fixtures/<redacted>/x.jsonl");
    expect(redactPath(j("x/Us", "ers/alice/a.txt"))).toMatch(/^<redacted path [0-9a-f]{8}>$/);
  });
});
