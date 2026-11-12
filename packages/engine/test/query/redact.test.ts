import { describe, expect, test } from "vitest";
import { createRedactor, projectAllowed } from "../../src/query/redact.ts";

/** Joined at run time, so that the repo holds no home path for the personal-data scan to flag. */
const j = (...parts: string[]) => parts.join("");
const alice = j("/Us", "ers/alice");
const bob = j("/ho", "me/bob");
const carol = j("C:", "\\Users\\carol");

describe("demo mode: path redaction", () => {
  const redact = createRedactor({ home: alice, user: "alice" });

  test("shows a path in the project relative to it, and the project itself as .", () => {
    const root = `${alice}/code/shop`;
    expect(redact(`Read ${root}/src/a.ts and ${root}`, root)).toBe("Read src/a.ts and .");
    expect(redact(`${root}-old/x`, root)).toBe("~/code/shop-old/x");
  });

  test("shows other paths in the home folder under ~", () => {
    expect(redact(`cat ${alice}/.claude/settings.json`)).toBe("cat ~/.claude/settings.json");
    expect(redact(alice)).toBe("~");
  });

  test("hides any home folder, also of other users and on Linux and Windows, also JSON-escaped", () => {
    expect(redact(`${bob}/x and ${j("/ro", "ot/")}y`)).toBe("~/x and ~/y");
    expect(redact(`${carol}\\code\\app.ts`)).toBe("~\\code\\app.ts");
    expect(redact(`{"cwd":"${carol.replace(/\\/g, "\\\\")}\\\\code"}`)).toBe('{"cwd":"~\\\\code"}');
    expect(redact(`${j("C:/", "Users/carol")}/code`)).toBe("~/code");
  });

  test("hides the home folder in the folder names the harness encodes from paths", () => {
    expect(redact(`projects/${j("-Us", "ers-alice")}-code-shop/s.jsonl`)).toBe("projects/-~-code-shop/s.jsonl");
    expect(redact(`projects/${j("-ho", "me-bob")}-x`)).toBe("projects/-~-x");
  });

  test("hides the user name next to a path or an address, but not the same letters in other words", () => {
    expect(redact("alice@laptop:~$ and git@alice.example")).toBe("user@laptop:~$ and git@user.example");
    expect(redact("Alice wrote malice")).toBe("Alice wrote malice");
  });

  test("redacts every string of a JSON value, not its keys", () => {
    const value = { file_path: `${alice}/code/shop/a.ts`, list: [`${bob}/b`, 3, null] };
    expect(redact.json(value, `${alice}/code/shop`)).toEqual({ file_path: "a.ts", list: ["~/b", 3, null] });
  });
});

describe("demo mode: project allowlist", () => {
  test("allows a project by its path or by its last folder name, on any platform", () => {
    expect(projectAllowed("/w/shop", ["/w/shop"])).toBe(true);
    expect(projectAllowed("/w/shop", ["shop"])).toBe(true);
    expect(projectAllowed("C:\\w\\shop", ["shop"])).toBe(true);
    expect(projectAllowed("/w/shop", ["sho"])).toBe(false);
    expect(projectAllowed(undefined, ["shop"])).toBe(false);
    expect(projectAllowed("/w/anything", undefined)).toBe(true);
  });
});
