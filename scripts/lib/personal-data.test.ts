import { describe, expect, test } from "vitest";
import { scanText } from "./personal-data.ts";

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

  test("finds emails, except at reserved example domains and allowlisted addresses", () => {
    const text = [
      j("author: dave", "@corp.io"),
      j("ok: user", "@example.com, a", "@b.example, x", "@sub.example.org, t", "@host.test"),
      j("bot: noreply", "@vendor.dev"),
      "not an email: @scope/pkg@1.2.3 typescript@7.0.2",
    ].join("\n");
    expect(scanText(text, { allowEmails: [j("noreply", "@vendor.dev")] })).toEqual([
      { line: 1, kind: "email", match: j("dave", "@corp.io") },
    ]);
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
});
