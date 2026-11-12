import { describe, expect, test } from "vitest";
import { hrefOf, parseRoute } from "./route.ts";

describe("routes", () => {
  test("the root is the session list, with its filters from the query", () => {
    expect(parseRoute("/", "")).toEqual({ page: "sessions" });
    expect(parseRoute("/", "?project=repo&sort=cost&q=fix")).toEqual({
      page: "sessions",
      project: "repo",
      sort: "cost",
      search: "fix",
    });
  });

  test("a Session page names its key and, when set, the Call", () => {
    expect(parseRoute("/s/3/abc-1", "")).toEqual({ page: "session", key: { log: 3, id: "abc-1" } });
    expect(parseRoute("/s/3/abc-1", "?call=12")).toEqual({ page: "session", key: { log: 3, id: "abc-1" }, call: 12 });
  });

  test("a Session's tool calls and compactions are pages of their own; tool calls keep their sort", () => {
    expect(parseRoute("/s/3/abc-1/tools", "?sort=tokens")).toEqual({
      page: "session",
      key: { log: 3, id: "abc-1" },
      view: "tools",
      sort: "tokens",
    });
    expect(parseRoute("/s/3/abc-1/compactions", "")).toEqual({
      page: "session",
      key: { log: 3, id: "abc-1" },
      view: "compactions",
    });
    expect(parseRoute("/s/3/abc-1/tools", "?sort=nope")).toEqual({
      page: "session",
      key: { log: 3, id: "abc-1" },
      view: "tools",
    });
  });

  test("an unknown path is not found", () => {
    expect(parseRoute("/nope", "")).toEqual({ page: "not-found" });
    expect(parseRoute("/s/x/abc", "")).toEqual({ page: "not-found" });
  });

  test("hrefOf is the inverse of parseRoute", () => {
    for (const r of [
      { page: "sessions" },
      { page: "sessions", project: "a b", sort: "calls", search: "x" },
      { page: "session", key: { log: 1, id: "a/b" }, call: 0 },
      { page: "session", key: { log: 1, id: "a:b" }, view: "tools", sort: "time" },
      { page: "session", key: { log: 1, id: "a" }, view: "compactions" },
      { page: "session", key: { log: 1, id: "a" }, call: 3, block: "ab12" },
    ] as const) {
      const url = new URL(hrefOf(r), "http://x");
      expect(parseRoute(url.pathname, url.search)).toEqual(r);
    }
  });
});
