/**
 * The typed client of the engine's HTTP API (docs/api.md). Same origin only: the viewer is served by the engine,
 * and Vite's dev server proxies `/api` to it. Every method returns the response body as its shared type.
 */
import type {
  ApiError,
  BlockDetail,
  CacheBreak,
  CallContext,
  CompactionDetail,
  ContextDiff,
  EngineStatus,
  Items,
  MemoryDocumentView,
  Page,
  ProjectSummary,
  SessionDetail,
  SessionFilter,
  SessionKey,
  SessionSummary,
  TimelineCall,
  ToolCallSummary,
  ToolOutput,
} from "@quantext/shared";

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** A response with a status ≥ 400: `code` is the API's stable word, or `http-<status>` when the body is not JSON. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

export interface Api {
  status(signal?: AbortSignal): Promise<EngineStatus>;
  sessions(filter: SessionFilter, signal?: AbortSignal): Promise<Page<SessionSummary>>;
  projects(signal?: AbortSignal): Promise<Items<ProjectSummary>>;
  session(key: SessionKey, signal?: AbortSignal): Promise<SessionDetail>;
  timeline(key: SessionKey, signal?: AbortSignal): Promise<Items<TimelineCall>>;
  cacheBreaks(key: SessionKey, signal?: AbortSignal): Promise<Items<CacheBreak>>;
  context(key: SessionKey, call: number, signal?: AbortSignal): Promise<CallContext>;
  diff(key: SessionKey, call: number, signal?: AbortSignal): Promise<ContextDiff>;
  toolCalls(key: SessionKey, signal?: AbortSignal): Promise<Items<ToolCallSummary>>;
  toolOutputs(key: SessionKey, signal?: AbortSignal): Promise<Items<ToolOutput>>;
  compactions(key: SessionKey, signal?: AbortSignal): Promise<Items<CompactionDetail>>;
  memory(project: string, signal?: AbortSignal): Promise<Items<MemoryDocumentView>>;
  block(log: number, hash: string, signal?: AbortSignal): Promise<BlockDetail>;
  mediaUrl(log: number, hash: string, media: string): string;
}

const BASE = "/api/v1";

export function createApi(fetchFn: FetchFn): Api {
  const get = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
    const response = await fetchFn(path, signal ? { signal } : undefined);
    if (!response.ok) throw await errorOf(response);
    return (await response.json()) as T;
  };
  const sessionPath = (key: SessionKey) => `${BASE}/sessions/${key.log}/${encodeURIComponent(key.id)}`;
  return {
    status: (signal) => get(`${BASE}/status`, signal),
    sessions: (filter, signal) => get(`${BASE}/sessions${query(filter)}`, signal),
    projects: (signal) => get(`${BASE}/projects`, signal),
    session: (key, signal) => get(sessionPath(key), signal),
    timeline: (key, signal) => get(`${sessionPath(key)}/timeline`, signal),
    cacheBreaks: (key, signal) => get(`${sessionPath(key)}/cache-breaks`, signal),
    context: (key, call, signal) => get(`${sessionPath(key)}/calls/${call}/context`, signal),
    diff: (key, call, signal) => get(`${sessionPath(key)}/calls/${call}/diff`, signal),
    toolCalls: (key, signal) => get(`${sessionPath(key)}/tool-calls`, signal),
    toolOutputs: (key, signal) => get(`${sessionPath(key)}/tool-outputs?limit=10000`, signal),
    compactions: (key, signal) => get(`${sessionPath(key)}/compactions`, signal),
    memory: (project, signal) => get(`${BASE}/memory?project=${encodeURIComponent(project)}`, signal),
    block: (log, hash, signal) => get(`${BASE}/blocks/${log}/${encodeURIComponent(hash)}`, signal),
    mediaUrl: (log, hash, media) =>
      `${BASE}/blocks/${log}/${encodeURIComponent(hash)}/media/${encodeURIComponent(media)}`,
  };
}

/** `?a=1&b=2` of the fields that are set, in the filter's order; "" when none is. */
function query(filter: SessionFilter): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filter)) {
    if (value !== undefined && value !== "") params.set(name, String(value));
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

async function errorOf(response: Response): Promise<ApiRequestError> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as Partial<ApiError>;
    if (body.error && typeof body.error.code === "string") {
      return new ApiRequestError(response.status, body.error.code, body.error.message);
    }
  } catch {
    // Not JSON (a proxy's page): fall through to the status alone.
  }
  return new ApiRequestError(response.status, `http-${response.status}`, `The engine answered ${response.status}.`);
}

/** The client of the page's own engine. */
export const api: Api = createApi((url, init) => fetch(url, init));
