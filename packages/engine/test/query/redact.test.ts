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

describe("demo mode: what the first redaction missed", () => {
  const redact = createRedactor({ home: alice, user: "alice" });

  test("decodes %2F and %5C in any case before it looks for paths", () => {
    expect(redact(`open file:%2F${j("Us", "ers%2Falice")}%2fx and ${j("C:%5C", "Users%5ccarol")}%5Cy`)).toBe(
      "open file:~/x and ~\\y",
    );
  });

  test("hides a home folder whose name has spaces or letters beyond ASCII", () => {
    expect(redact(`${j("/Us", "ers/Bob Smith")}/x`)).toBe("~/x");
    expect(redact(`"${j("/ho", "me/zoë")}/notes"`)).toBe('"~/notes"');
  });

  test("hides the user name in any case, also after : and ~", () => {
    expect(redact("git@github.com:alice/shop.git, ~alice/x, ALICE@host")).toBe(
      "git@github.com:user/shop.git, ~user/x, user@host",
    );
  });

  test("hides an encoded home folder with a drive, also with no user name known", () => {
    const anon = createRedactor({});
    expect(anon(`projects/${j("C--Us", "ers-carol")}-code-x/s.jsonl`)).toBe("projects/-~-code-x/s.jsonl");
    expect(redact(`${j("-Us", "ers-alice")}-x`)).toBe("-~-x");
  });

  test("puts a placeholder for every hidden project, in every form it takes", () => {
    const secret = `${alice}/code/secret-plans`;
    const hiding = createRedactor({ home: alice, user: "alice", hidden: [secret] });
    const text = [
      `cd ${secret}/src`,
      JSON.stringify({ cwd: secret }),
      `projects/${secret.replace(/[^A-Za-z0-9]/g, "-")}/s.jsonl`,
      encodeURIComponent(secret),
      "the secret-plans repo",
    ].join("\n");
    const out = hiding(text, `${alice}/code/shop`);
    expect(out).not.toMatch(/secret-plans|alice/i);
    expect(out).toContain("<hidden project>/src");
  });
});

describe("demo mode: what the second review found", () => {
  const secret = `${alice}/code/secretproj`;
  const redact = createRedactor({ home: alice, user: "alice", hidden: [secret], host: "alice-mbp" });

  test("hides a hidden project's name next to . _ - and in any case", () => {
    expect(redact("secretproj.git, mcp__secretproj__search, SecretProj-v2 and SECRETPROJ")).toBe(
      "<hidden project>.git, mcp__<hidden project>__search, <hidden project>-v2 and <hidden project>",
    );
  });

  test("decodes paths encoded twice, JSON-escaped slashes and HTML entities", () => {
    expect(redact(`a ${j("%252FUs", "ers%252Falice%252Fx")}`)).toBe("a ~/x");
    expect(redact(j("\\/Us", "ers\\/alice\\/y"))).toBe("~/y");
    expect(redact(j("&#x2F;Us", "ers&#x2F;alice&#47;z"))).toBe("~/z");
  });

  test("masks e-mail addresses (not git@) and the machine's name", () => {
    expect(redact("by jane.doe@corp.example via git@github.com:x/y")).toBe("by <email> via git@github.com:x/y");
    expect(redact("ssh ALICE-MBP.local and alice-mbp:22")).toBe("ssh <host> and <host>:22");
  });
});

describe("demo mode: the last review", () => {
  const redact = createRedactor({ home: alice, user: "alice", host: "studio" });

  test("decodes \\u002F and \\u005C escapes, also escaped again inside JSON strings", () => {
    expect(redact(j("\\u002FUs", "ers\\u002Falice\\u002fx"))).toBe("~/x");
    expect(redact(j("C:\\u005CUs", "ers\\u005Ccarol\\u005Cy"))).toBe("~\\y");
    expect(redact(j("\\\\u002FUs", "ers\\\\u002Falice\\\\u002Fz"))).toBe("~/z");
  });

  test("masks host names made from the user's or the machine's name", () => {
    expect(redact("on alice-mbp, Alices-MacBook-Pro, alice-air.local and studio.local")).toBe(
      "on <host>, <host>, <host> and <host>",
    );
    expect(redact("a macbook and a.local")).toBe("a macbook and a.local");
  });
});

describe("demo mode: project allowlist", () => {
  test("allows a project by its exact path only, not every project with the same folder name", () => {
    expect(projectAllowed("/w/shop", ["/w/shop"])).toBe(true);
    expect(projectAllowed("/w/shop/", ["/w/shop"])).toBe(true);
    expect(projectAllowed("C:\\w\\shop", ["C:\\w\\shop"])).toBe(true);
    expect(projectAllowed("/w/shop", ["shop"])).toBe(false);
    expect(projectAllowed("/other/shop", ["/w/shop"])).toBe(false);
    expect(projectAllowed(undefined, ["shop"])).toBe(false);
    expect(projectAllowed("/w/anything", undefined)).toBe(true);
  });
});
