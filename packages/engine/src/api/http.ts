/**
 * What every response of the engine carries, and the checks every request passes first (ADR 5, ADR 24): the Host
 * must name this server (DNS rebinding), a browser request must come from this origin, only GET and HEAD.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiError } from "@quantext/shared";
import { HttpError } from "./params.ts";

const API_VERSION = 1;

/** The viewer's pages: scripts, styles and data only from the engine; no inline script, no frames. */
export const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Everything else (JSON, media, scripts) is not a document: should a browser render it, it may do nothing. */
const DATA_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/** On every response. No Access-Control-* header, ever: other origins must not read anything. */
const COMMON: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export function securityHeaders(html: boolean): Record<string, string> {
  return { ...COMMON, "Content-Security-Policy": html ? HTML_CSP : DATA_CSP };
}

export const MAX_URL_LENGTH = 4096;

/**
 * Refuse a request this server must not answer, or return undefined. `port` is the port it listens on. A browser
 * page of another origin can send a GET with no Origin header (an image, a script), so `Sec-Fetch-Site` is checked
 * too; only a top-level navigation to a page (not the API) may come from another site, as a link does.
 */
export function refusal(req: IncomingMessage, port: number, api: boolean): HttpError | undefined {
  const host = (req.headers.host ?? "").toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return new HttpError(403, "forbidden-host", "this server answers only to 127.0.0.1 and localhost on its port");
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new HttpError(405, "method-not-allowed", "only GET and HEAD");
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) {
    return new HttpError(403, "forbidden-origin", "requests from other origins are refused");
  }
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    const navigation = req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
    if (api || !navigation) return new HttpError(403, "forbidden-site", "requests from other sites are refused");
  }
  if ((req.url ?? "").length > MAX_URL_LENGTH) return new HttpError(414, "uri-too-long", "the URL is too long");
  const length = req.headers["content-length"];
  if ((length !== undefined && length !== "0") || req.headers["transfer-encoding"] !== undefined) {
    return new HttpError(413, "content-too-large", "requests have no body");
  }
  return undefined;
}

/** A JSON response; on HEAD, only its headers. */
export function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    ...securityHeaders(false),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(bytes.length),
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(req.method === "HEAD" ? undefined : bytes);
}

export function sendError(req: IncomingMessage, res: ServerResponse, error: HttpError): void {
  const body: ApiError = {
    apiVersion: API_VERSION,
    error: { status: error.status, code: error.code, message: error.message },
  };
  const extra: Record<string, string> = error.status === 405 ? { Allow: "GET, HEAD" } : {};
  // A refused body is not read: the connection cannot carry another request after it (Bun ignores the header).
  if (error.status === 413) {
    extra.Connection = "close";
    res.on("finish", () => req.socket.destroy());
  }
  sendJson(req, res, error.status, body, extra);
}

/** Bytes with their type and caching; on HEAD, only the headers. */
export function sendBytes(
  req: IncomingMessage,
  res: ServerResponse,
  bytes: Uint8Array,
  headers: Record<string, string>,
  html: boolean,
): void {
  res.writeHead(200, { ...securityHeaders(html), "Content-Length": String(bytes.byteLength), ...headers });
  res.end(req.method === "HEAD" ? undefined : bytes);
}
