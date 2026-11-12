/** Ask a local port for `/health`, as a second start does before it starts an engine of its own. */
import { request } from "node:http";
import type { Health } from "@quantext/shared";

/** The engine's health at 127.0.0.1:`port`, or undefined when nothing answers as an engine in `timeoutMs`. */
export function probeHealth(port: number, timeoutMs = 1000): Promise<Health | undefined> {
  return new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/health", headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 64 * 1024) req.destroy(); // no engine sends that much
        });
        res.on("end", () => resolve(res.statusCode === 200 ? asHealth(body) : undefined));
        res.on("error", () => resolve(undefined));
        res.on("close", () => resolve(undefined)); // after "end" this changes nothing
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined)); // refused, reset, timed out: no engine there
    req.end();
  });
}

function asHealth(body: string): Health | undefined {
  try {
    const h = JSON.parse(body) as Partial<Health> | null;
    return h?.ok === true && typeof h.version === "string" && typeof h.pid === "number" ? (h as Health) : undefined;
  } catch {
    return undefined; // something else listens on the port
  }
}
