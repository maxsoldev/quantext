/**
 * The viewer's pages as URLs: `/` (Sessions, filters in the query), `/s/<log>/<id>?call=<n>` (the context view; n is the Call's 1-based number),
 * `/s/<log>/<id>/tools?sort=<key>`, `/s/<log>/<id>/compactions`, and `/memory?project=<project>&file=<name>`.
 */
import type { SessionKey } from "@quantext/shared";

export type SortKey = "ended" | "started" | "cost" | "calls";

export type SessionView = "tools" | "compactions";
/** Tool calls: by lifetime cost (default), result tokens, Calls kept, or in the order they ran. */
export type ToolSort = "cost" | "tokens" | "calls" | "time";

export type Route =
  | { page: "sessions"; project?: string; sort?: SortKey; search?: string }
  | {
      page: "session";
      key: SessionKey;
      call?: number;
      /** The hash of a Block to open in the context at `call`. */
      block?: string;
      view?: SessionView;
      sort?: ToolSort;
    }
  | { page: "memory"; project: string; file?: string }
  | { page: "not-found" };

const SORTS: readonly string[] = ["ended", "started", "cost", "calls"];
const TOOL_SORTS: readonly string[] = ["cost", "tokens", "calls", "time"];

/**
 * A Call's number in the UI (headings, tooltips, the scrubber, `?call=` in URLs) is 1-based and counts every Call
 * of the Session in log order. The API's `index` is the same order, 0-based. Convert only through these two.
 */
export const callNumber = (index: number): number => index + 1;
export const callIndex = (number: number): number => number - 1;

export function parseRoute(pathname: string, search: string): Route {
  const q = new URLSearchParams(search);
  if (pathname === "/" || pathname === "") {
    const route: Route = { page: "sessions" };
    const project = q.get("project");
    const sort = q.get("sort");
    const text = q.get("q");
    if (project) route.project = project;
    if (sort && SORTS.includes(sort)) route.sort = sort as SortKey;
    if (text) route.search = text;
    return route;
  }
  if (pathname === "/memory" || pathname === "/memory/") {
    const project = q.get("project");
    if (!project) return { page: "not-found" };
    const file = q.get("file");
    return file ? { page: "memory", project, file } : { page: "memory", project };
  }
  const m = /^\/s\/(\d+)\/([^/]+)(?:\/(tools|compactions))?\/?$/.exec(pathname);
  if (m?.[1] && m[2]) {
    const route: Route = { page: "session", key: { log: Number(m[1]), id: decodeURIComponent(m[2]) } };
    if (m[3] === "tools" || m[3] === "compactions") route.view = m[3];
    const sort = q.get("sort");
    if (route.view === "tools" && sort && TOOL_SORTS.includes(sort)) route.sort = sort as ToolSort;
    const call = q.get("call");
    if (call !== null && /^\d+$/.test(call) && Number(call) >= 1) route.call = callIndex(Number(call));
    const block = q.get("block");
    if (block && /^[0-9a-f]+$/.test(block) && !route.view) route.block = block;
    return route;
  }
  return { page: "not-found" };
}

export function hrefOf(route: Route): string {
  if (route.page === "session") {
    const path = `/s/${route.key.log}/${encodeURIComponent(route.key.id)}${route.view ? `/${route.view}` : ""}`;
    const q = new URLSearchParams();
    if (route.call !== undefined) q.set("call", String(callNumber(route.call)));
    if (route.block && !route.view) q.set("block", route.block);
    if (route.view === "tools" && route.sort) q.set("sort", route.sort);
    const s = q.toString();
    return s ? `${path}?${s}` : path;
  }
  if (route.page === "memory") {
    const q = new URLSearchParams({ project: route.project });
    if (route.file) q.set("file", route.file);
    return `/memory?${q.toString()}`;
  }
  if (route.page === "sessions") {
    const q = new URLSearchParams();
    if (route.project) q.set("project", route.project);
    if (route.sort) q.set("sort", route.sort);
    if (route.search) q.set("q", route.search);
    const s = q.toString();
    return s ? `/?${s}` : "/";
  }
  return "/";
}
