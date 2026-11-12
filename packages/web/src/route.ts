/** The viewer's pages as URLs: `/` (Sessions, filters in the query) and `/s/<log>/<id>?call=<n>`. */
import type { SessionKey } from "@quantext/shared";

export type SortKey = "ended" | "started" | "cost" | "calls";

export type Route =
  | { page: "sessions"; project?: string; sort?: SortKey; search?: string }
  | { page: "session"; key: SessionKey; call?: number }
  | { page: "not-found" };

const SORTS: readonly string[] = ["ended", "started", "cost", "calls"];

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
  const m = /^\/s\/(\d+)\/([^/]+)\/?$/.exec(pathname);
  if (m?.[1] && m[2]) {
    const route: Route = { page: "session", key: { log: Number(m[1]), id: decodeURIComponent(m[2]) } };
    const call = q.get("call");
    if (call !== null && /^\d+$/.test(call)) route.call = Number(call);
    return route;
  }
  return { page: "not-found" };
}

export function hrefOf(route: Route): string {
  if (route.page === "session") {
    const path = `/s/${route.key.log}/${encodeURIComponent(route.key.id)}`;
    return route.call === undefined ? path : `${path}?call=${route.call}`;
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
