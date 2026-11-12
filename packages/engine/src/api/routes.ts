/**
 * The JSON routes under `/api/v1/`, one per query method (docs/api.md). Each route reads its path segments and
 * query string strictly, calls the query layer, and gives its response type, or a 404 for what does not exist or
 * demo mode hides. The query layer applies demo mode, so no route can get around it.
 */
import type { SessionKey } from "@quantext/shared";
import type { Query } from "../query/index.ts";
import type { Params } from "./params.ts";
import { badRequest, checkText, integer, notFound, queryParams } from "./params.ts";
import type { Offload } from "./server.ts";

export type Reply = { kind: "json"; body: unknown } | { kind: "media"; mediaType: string; bytes: Uint8Array };

/** Images a browser shows inline; anything else (an SVG, a PDF) is sent as a download, never rendered here. */
const INLINE_MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isInlineMedia(mediaType: string): boolean {
  return INLINE_MEDIA.has(mediaType);
}

const MAX_LOG = 2 ** 31 - 1;
const MAX_INDEX = 100_000_000;
const SORTS = ["ended", "started", "cost", "calls"] as const;
const LIFETIME_SORTS = ["cost", "tokens", "calls"] as const;

interface Route {
  /** Literal segments, or `:name` for a parameter. */
  path: string[];
  params: string[];
  run(query: Query, p: Record<string, string>, q: Params, offload: Offload): Reply | Promise<Reply>;
}

const json = (body: unknown): Reply => ({ kind: "json", body });
const found = <T>(value: T | undefined): Reply => {
  if (value === undefined) throw notFound();
  return json(value);
};

/** A Session key from its path segments; 404 when it is not there or demo mode hides it. */
function session(query: Query, p: Record<string, string>): SessionKey {
  const key = { log: integer(p.log ?? "", "log", 0, MAX_LOG), id: sessionId(p.id ?? "") };
  if (!query.hasSession(key)) throw notFound("no such session");
  return key;
}

function sessionId(text: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/.test(text)) throw badRequest("the session id is not one");
  return text;
}

function hash(text: string, name: string): string {
  if (!/^[0-9a-f]{16,128}$/.test(text)) throw badRequest(`${name} must be a hex hash`);
  return text;
}

const lifetime = (q: Params) => {
  const sort = q.oneOf("sort", LIFETIME_SORTS);
  const limit = q.int("limit", 1, 10_000);
  return { ...(sort === undefined ? {} : { sort }), ...(limit === undefined ? {} : { limit }) };
};

const SESSION = ["sessions", ":log", ":id"];
const CALL = [...SESSION, "calls", ":n"];
/** A Call's Session and index; the index is read first, so a bad one is a 400 before any lookup. */
const call = (query: Query, p: Record<string, string>): [SessionKey, number] => {
  const n = integer(p.n ?? "", "n", 0, MAX_INDEX);
  return [session(query, p), n];
};

const ROUTES: Route[] = [
  {
    path: ["sessions"],
    params: ["project", "search", "sort", "order", "changedSince", "limit", "offset"],
    run(query, _p, q) {
      const project = q.text("project");
      const search = q.text("search", 200);
      const sort = q.oneOf("sort", SORTS);
      const order = q.oneOf("order", ["asc", "desc"] as const);
      const changedSince = q.int("changedSince", 0, Number.MAX_SAFE_INTEGER);
      return json(
        query.listSessions({
          ...(project === undefined ? {} : { project }),
          ...(search === undefined ? {} : { search }),
          ...(sort === undefined ? {} : { sort }),
          ...(order === undefined ? {} : { order }),
          ...(changedSince === undefined ? {} : { changedSince }),
          limit: q.int("limit", 1, 500) ?? 50,
          offset: q.int("offset", 0, MAX_INDEX) ?? 0,
        }),
      );
    },
  },
  {
    path: ["session-keys"],
    params: ["id"],
    run(query, _p, q) {
      const id = q.text("id", 200);
      if (id === undefined) throw badRequest("id is needed");
      return json({ apiVersion: 1, items: query.findSessions(id) });
    },
  },
  { path: SESSION, params: [], run: (query, p) => found(query.getSession(session(query, p))) },
  {
    path: [...SESSION, "calls"],
    params: ["lane", "afterIndex", "limit"],
    run(query, p, q) {
      const key = session(query, p);
      const lane = q.text("lane", 200);
      const afterIndex = q.int("afterIndex", 0, MAX_INDEX);
      const limit = q.int("limit", 1, 5000);
      return json(
        query.listCalls(key, {
          ...(lane === undefined ? {} : { lane }),
          ...(afterIndex === undefined ? {} : { afterIndex }),
          ...(limit === undefined ? {} : { limit }),
        }),
      );
    },
  },
  { path: CALL, params: [], run: (query, p) => found(query.getCall(...call(query, p))) },
  { path: [...CALL, "context"], params: [], run: (query, p) => found(query.contextAt(...call(query, p))) },
  { path: [...CALL, "diff"], params: [], run: (query, p) => found(query.contextDiff(...call(query, p))) },
  { path: [...SESSION, "timeline"], params: [], run: (query, p) => json(query.callTimeline(session(query, p))) },
  { path: [...SESSION, "tool-calls"], params: [], run: (query, p) => json(query.toolCalls(session(query, p))) },
  {
    path: [...SESSION, "tool-outputs"],
    params: ["sort", "limit"],
    run: async (query, p, q, offload) => json(await offload("toolOutputs", session(query, p), lifetime(q))),
  },
  {
    path: [...SESSION, "blocks"],
    params: ["sort", "limit"],
    run: async (query, p, q, offload) => json(await offload("blockLifetimes", session(query, p), lifetime(q))),
  },
  { path: [...SESSION, "compactions"], params: [], run: (query, p) => json(query.compactions(session(query, p))) },
  { path: [...SESSION, "cache-breaks"], params: [], run: (query, p) => json(query.cacheBreaks(session(query, p))) },
  {
    path: ["blocks", ":log", ":hash"],
    params: [],
    run: (query, p) => found(query.getBlock(hash(p.hash ?? "", "hash"), integer(p.log ?? "", "log", 0, MAX_LOG))),
  },
  {
    path: ["blocks", ":log", ":hash", "media", ":media"],
    params: [],
    run(query, p) {
      const media = query.getMedia(
        hash(p.hash ?? "", "hash"),
        integer(p.log ?? "", "log", 0, MAX_LOG),
        hash(p.media ?? "", "media"),
      );
      if (media === undefined) throw notFound();
      return { kind: "media", mediaType: media.mediaType, bytes: media.bytes };
    },
  },
  {
    path: ["memory"],
    params: ["project"],
    run(query, _p, q) {
      const project = q.text("project");
      if (project === undefined) throw badRequest("project is needed");
      return json(query.projectMemory(project));
    },
  },
  { path: ["report"], params: [], run: (query) => json(query.ingestReport()) },
];

/** The reply for the decoded segments after `/api/v1/`; 404 for no route. */
export function route(
  query: Query,
  segments: readonly string[],
  search: URLSearchParams,
  offload: Offload,
): Reply | Promise<Reply> {
  for (const r of ROUTES) {
    if (r.path.length !== segments.length) continue;
    const p: Record<string, string> = {};
    const match = r.path.every((part, i) => {
      const segment = segments[i] ?? "";
      if (part.startsWith(":")) {
        p[part.slice(1)] = checkText(segment, part.slice(1), 256);
        return true;
      }
      return part === segment;
    });
    if (match) return r.run(query, p, queryParams(search, r.params), offload);
  }
  throw notFound("no such route");
}
