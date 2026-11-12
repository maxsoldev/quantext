import { describe, expect, test } from "vitest";
import { ApiRequestError, createApi } from "./client.ts";

/** A fetch that records each URL and answers with the given status and body. */
function fakeFetch(status: number, body: unknown) {
  const urls: string[] = [];
  const fetchFn = async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { urls, fetchFn };
}

describe("api client", () => {
  test("lists sessions with only the filter fields that are set", async () => {
    const page = { apiVersion: 1, total: 0, offset: 0, items: [], cursor: 7 };
    const { urls, fetchFn } = fakeFetch(200, page);
    const api = createApi(fetchFn);
    expect(await api.sessions({ project: "repo one", sort: "cost", order: "desc", limit: 100 })).toEqual(page);
    expect(urls).toEqual(["/api/v1/sessions?project=repo+one&sort=cost&order=desc&limit=100"]);
  });

  test("names a Session and a Call by path, with each part encoded", async () => {
    const { urls, fetchFn } = fakeFetch(200, { apiVersion: 1 });
    const api = createApi(fetchFn);
    const key = { log: 3, id: "a/b" };
    await api.session(key);
    await api.timeline(key);
    await api.context(key, 12);
    await api.block(3, "h#1");
    expect(urls).toEqual([
      "/api/v1/sessions/3/a%2Fb",
      "/api/v1/sessions/3/a%2Fb/timeline",
      "/api/v1/sessions/3/a%2Fb/calls/12/context",
      "/api/v1/blocks/3/h%231",
    ]);
  });

  test("gives the media URL of a Block's image without a request", () => {
    const api = createApi(fakeFetch(200, {}).fetchFn);
    expect(api.mediaUrl(2, "abc", "m1")).toBe("/api/v1/blocks/2/abc/media/m1");
  });

  test("turns an API error body into an ApiRequestError with its code", async () => {
    const body = { apiVersion: 1, error: { status: 404, code: "not-found", message: "No such Session." } };
    const api = createApi(fakeFetch(404, body).fetchFn);
    const error = await api.session({ log: 1, id: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 404, code: "not-found", message: "No such Session." });
  });

  test("names the status when the error body is not the API's", async () => {
    const api = createApi(async () => new Response("bad gateway", { status: 502 }));
    await expect(api.status()).rejects.toMatchObject({ status: 502, code: "http-502" });
  });
});
