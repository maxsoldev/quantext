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
    expect(parseRoute("/s/3/abc-1", "?call=12")).toEqual({ page: "session", key: { log: 3, id: "abc-1" }, call: 11 });
  });

  test("the URL has the Call's number as the UI shows it (1-based); the route has the API's index", () => {
    expect(hrefOf({ page: "session", key: { log: 1, id: "a" }, call: 0 })).toBe("/s/1/a?call=1");
    expect(parseRoute("/s/1/a", "?call=1")).toMatchObject({ call: 0 });
    expect(parseRoute("/s/1/a", "?call=0")).toEqual({ page: "session", key: { log: 1, id: "a" } });
  });

  test("a tool call to open is named by its tool use id, on the tool calls page only", () => {
    const route = { page: "session", key: { log: 3, id: "a" }, view: "tools", tool: "toolu_01" } as const;
    expect(hrefOf(route)).toBe("/s/3/a/tools?tool=toolu_01");
    expect(parseRoute("/s/3/a/tools", "?tool=toolu_01")).toEqual(route);
    expect(parseRoute("/s/3/a", "?tool=toolu_01")).toEqual({ page: "session", key: { log: 3, id: "a" } });
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

  test("a project's memory is a page of its own, the file in the query", () => {
    expect(parseRoute("/memory", "?project=%2Fa%2Frepo&file=notes.md")).toEqual({
      page: "memory",
      project: "/a/repo",
      file: "notes.md",
    });
    expect(parseRoute("/memory", "")).toEqual({ page: "not-found" });
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
      { page: "memory", project: "/x y/repo" },
    ] as const) {
      const url = new URL(hrefOf(r), "http://x");
      expect(parseRoute(url.pathname, url.search)).toEqual(r);
    }
  });
});
