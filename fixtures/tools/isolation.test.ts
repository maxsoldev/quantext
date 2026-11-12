import { describe, expect, test } from "vitest";
import { checkClean, childEnv, secretValues } from "./isolation.ts";

const AT = { home: "/r/home", config: "/r/config", tmp: "/r/tmp", bin: "/r/bin" };

describe("childEnv", () => {
  test("passes only the allowlist: fixed variables plus auth, nothing else of the caller", () => {
    const caller = {
      PATH: "/caller/bin",
      HOME: "/caller/home",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "eu-west-1",
      AWS_BEARER_TOKEN_BEDROCK: "token",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_MESSAGING_SOCKET: "/sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDECODE: "1",
      CLAUDE_EFFORT: "max",
      SSH_AUTH_SOCK: "/agent",
      TZ: "Europe/Berlin",
    };
    expect(childEnv(AT, caller, {})).toEqual({
      PATH: "/r/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/r/home",
      TMPDIR: "/r/tmp",
      CLAUDE_CONFIG_DIR: "/r/config",
      LANG: "en_US.UTF-8",
      TZ: "UTC",
      GIT_CONFIG_NOSYSTEM: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "eu-west-1",
      AWS_BEARER_TOKEN_BEDROCK: "token",
    });
  });

  test("takes auth variables missing from the caller from the real settings env, and only those", () => {
    const env = childEnv(AT, { ANTHROPIC_API_KEY: "k" }, { ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-x", HOOK_URL: "u" });
    expect(env.ANTHROPIC_API_KEY).toBe("k");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("opus-x");
    expect(env.HOOK_URL).toBeUndefined();
  });

  test("fails without any auth", () => {
    expect(() => childEnv(AT, {}, {})).toThrow(/No auth/);
  });
});

describe("secretValues", () => {
  test("returns the set values of the secret variables", () => {
    const env = { AWS_BEARER_TOKEN_BEDROCK: "abc", AWS_SESSION_TOKEN: "", ANTHROPIC_API_KEY: "def", AWS_REGION: "x" };
    expect(secretValues(env)).toEqual(["abc", "def"]);
  });
});

describe("checkClean", () => {
  const root = "/private/tmp/qxrec.Ab12Cd";

  test("passes clean files", () => {
    expect(checkClean({ "s.jsonl": '{"cwd":"/fixture/repo"}\n' }, root, [])).toEqual([]);
  });

  test("names the file and line, never the value, for a leftover root, personal data or a denied term", () => {
    const files = {
      "a.jsonl": `{"x":1}\n{"cwd":"${root}/repo"}\n`,
      "b.jsonl": '{"token":"s3cr3t-value"}\n',
      "c/qxrec.Ab12Cd.jsonl": "{}\n",
    };
    expect(checkClean(files, root, ["s3cr3t-value"])).toEqual([
      "a.jsonl:2  recording root left over",
      "b.jsonl:1  local identity",
      "c/qxrec.Ab12Cd.jsonl  recording root left over",
    ]);
  });
});
