/** Every rule of ADR 5 and ADR 24, over HTTP: Host, origin, methods, sizes, headers, the viewer's files. */
import { connect } from "node:net";
import type { ApiError, Health } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { engine, get } from "./client.ts";

const code = (r: { json<T>(): T }) => r.json<ApiError>().error.code;

/** Send `text` on a new socket; what comes back until the server closes it (or 2 s). */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write(text));
    socket.on("data", (d: Buffer) => (out += d.toString("utf8")));
    socket.on("close", () => resolve(out));
    socket.on("error", () => resolve(out));
    setTimeout(() => socket.destroy(), 2000);
  });
}

describe("the Host check (DNS rebinding)", () => {
  test("answers only to 127.0.0.1 and localhost on its own port", async () => {
    const { port } = await engine(["basic-tools"]);
    expect((await get(port, "/health")).status).toBe(200);
    expect((await get(port, "/health", { host: `localhost:${port}` })).status).toBe(200);
    expect((await get(port, "/health", { host: `LOCALHOST:${port}` })).status).toBe(200);
    for (const host of [
      "evil.example",
      `evil.example:${port}`,
      `127.0.0.1:${port + 1}`,
      "127.0.0.1",
      `localhost.evil.example:${port}`,
      `[::1]:${port}`,
      `0.0.0.0:${port}`,
      "",
    ]) {
      for (const path of ["/health", "/api/v1/sessions", "/", "/api/v1/events"]) {
        const reply = await get(port, path, { host });
        expect([host, path, reply.status, code(reply)]).toEqual([host, path, 403, "forbidden-host"]);
      }
    }
    // With no Host at all: HTTP/1.1 needs one (the runtime sends 400), HTTP/1.0 does not.
    expect(await raw(port, "GET /health HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 400 /);
    expect(await raw(port, "GET /health HTTP/1.0\r\n\r\n")).toMatch(/^HTTP\/1\.1 403 /);
  });

  test("listens on 127.0.0.1 only", async () => {
    const { port } = await engine(["basic-tools"]);
    const reached = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "::1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    expect(reached).toBe(false);
  });
});

describe("cross-site requests", () => {
  test("are refused by Origin, unless it is this origin", async () => {
    const { port } = await engine(["basic-tools"]);
    for (const origin of [
      "https://evil.example",
      "null",
      `http://localhost:${port + 1}`,
      `https://127.0.0.1:${port}`,
    ]) {
      const reply = await get(port, "/api/v1/sessions", { origin });
      expect([origin, reply.status, code(reply)]).toEqual([origin, 403, "forbidden-origin"]);
    }
    expect((await get(port, "/api/v1/sessions", { origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    const local = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    expect((await get(port, "/api/v1/sessions", local)).status).toBe(200);
  });

  test("are refused by Sec-Fetch-Site, but a link from another site may open the viewer's page", async () => {
    const { port } = await engine(["basic-tools"]);
    for (const site of ["cross-site", "same-site"]) {
      for (const path of ["/api/v1/sessions", "/api/v1/events", "/health", "/assets/app-1.js", "/"]) {
        const reply = await get(port, path, { "sec-fetch-site": site, "sec-fetch-mode": "no-cors" });
        expect([site, path, reply.status, code(reply)]).toEqual([site, path, 403, "forbidden-site"]);
      }
      const navigation = { "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
      expect((await get(port, "/", navigation)).status).toBe(200);
      expect((await get(port, "/api/v1/sessions", navigation)).status).toBe(403);
    }
    for (const site of ["same-origin", "none"]) {
      expect((await get(port, "/api/v1/sessions", { "sec-fetch-site": site })).status).toBe(200);
    }
  });

  test("get no CORS headers, also on a preflight", async () => {
    const { port } = await engine(["basic-tools"]);
    for (const reply of [
      await get(port, "/api/v1/sessions"),
      await get(port, "/api/v1/sessions", { origin: "https://evil.example" }),
      await get(port, "/api/v1/sessions", { "access-control-request-method": "GET" }, "OPTIONS"),
    ]) {
      expect(Object.keys(reply.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    }
  });
});

describe("methods and sizes", () => {
  test("only GET and HEAD", async () => {
    const { port } = await engine(["basic-tools"]);
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const reply = await get(port, "/api/v1/sessions", {}, method);
      expect([method, reply.status, code(reply)]).toEqual([method, 405, "method-not-allowed"]);
      expect(reply.headers.allow).toBe("GET, HEAD");
    }
    const head = await get(port, "/api/v1/sessions", {}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(Number(head.headers["content-length"])).toBeGreaterThan(0);
    expect((await get(port, "/api/v1/events", {}, "HEAD")).status).toBe(405);
  });

  test("refuses a body, a long URL and large headers", async () => {
    const { port } = await engine(["basic-tools"]);
    for (const headers of [{ "content-length": "3" }, { "transfer-encoding": "chunked" }]) {
      const body = await get(port, "/api/v1/sessions", headers);
      expect([body.status, code(body)]).toEqual([413, "content-too-large"]);
    }
    const long = await get(port, `/api/v1/sessions?search=${"a".repeat(5000)}`);
    expect([long.status, code(long)]).toEqual([414, "uri-too-long"]);
    const big = await get(port, "/health", { "x-big": "a".repeat(20_000) });
    expect(big.status).toBe(431);
  });

  test("closes connections beyond its limit", async () => {
    const { port } = await engine(["basic-tools"], { maxConnections: 2 });
    /** A kept-alive connection that has had one answer. */
    const hold = () =>
      new Promise<ReturnType<typeof connect>>((resolve) => {
        const s = connect({ host: "127.0.0.1", port }, () =>
          s.write(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`),
        );
        s.once("data", () => resolve(s));
      });
    const held = [await hold(), await hold()];
    expect(await raw(port, `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)).toBe("");
    for (const s of held) s.destroy();
  });
});

describe("slow and silent sockets", () => {
  /** How long until the server closes a socket that sends `first` and then trickles `more` (ms). */
  const lifetime = (port: number, first: string, more = "") =>
    new Promise<number>((resolve) => {
      const started = Date.now();
      const socket = connect({ host: "127.0.0.1", port }, () => first !== "" && socket.write(first));
      const trickle = more === "" ? undefined : setInterval(() => socket.destroyed || socket.write(more), 100);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        clearInterval(trickle);
        resolve(Date.now() - started);
      });
      socket.resume();
    });
  // Node closes them at the limits set; Bun's own idle limit (about 10 s) closes them too.
  const bound = process.versions.bun === undefined ? 3000 : 15_000;

  test("closes a socket that never sends a request", { timeout: 20_000 }, async () => {
    const { port } = await engine(["basic-tools"], { idleSocketMs: 300 });
    expect(await lifetime(port, "")).toBeLessThan(bound);
  });

  test("closes a socket that sends its headers too slowly (slowloris)", { timeout: 20_000 }, async () => {
    const { port } = await engine(["basic-tools"], { idleSocketMs: 300, headersTimeoutMs: 500 });
    expect(await lifetime(port, "GET /health HTTP/1.1\r\n", "X-a: b\r\n")).toBeLessThan(bound);
  });

  test("keeps an event stream open past the idle limit", async () => {
    const { port } = await engine(["basic-tools"], { idleSocketMs: 200, events: { heartbeatMs: 1000 } });
    const socket = connect({ host: "127.0.0.1", port }, () =>
      socket.write(`GET /api/v1/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`),
    );
    let text = "";
    socket.on("data", (d: Buffer) => (text += d.toString("utf8")));
    await new Promise((r) => setTimeout(r, 1300));
    expect(socket.destroyed).toBe(false);
    expect(text).toContain(": ping");
    socket.destroy();
  });
});

describe("headers", () => {
  test("every response is nosniff, no-referrer, not framed, same-origin only", async () => {
    const { port } = await engine(["basic-tools"]);
    for (const path of ["/health", "/api/v1/sessions", "/api/v1/nothing", "/", "/assets/app-1.js"]) {
      const h = (await get(port, path)).headers;
      expect([path, h["x-content-type-options"], h["referrer-policy"], h["x-frame-options"]]).toEqual([
        path,
        "nosniff",
        "no-referrer",
        "DENY",
      ]);
      expect(h["cross-origin-resource-policy"]).toBe("same-origin");
      expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    }
  });

  test("a page has a strict Content-Security-Policy: no inline script, only this origin", async () => {
    const { port } = await engine(["basic-tools"]);
    const page = await get(port, "/");
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("style-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(page.headers["cache-control"]).toBe("no-cache");
    const api = (await get(port, "/api/v1/sessions")).headers;
    expect(api["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
  });
});

describe("/health", () => {
  test("tells the engine's version, pid, start and demo mode, and its data folder outside demo mode", async () => {
    const { port, dataDir } = await engine(["basic-tools"]);
    expect((await get(port, "/health")).json<Health>()).toEqual({
      apiVersion: 1,
      ok: true,
      version: "0.0.0-test",
      pid: process.pid,
      startedAt: "2026-11-12T00:00:00.000Z",
      demo: false,
      dataDir,
    });
    const demo = await engine(["basic-tools"], {
      info: { version: "0.0.0-test", pid: 1, startedAt: "2026-11-12T00:00:00.000Z", demo: true, dataDir },
    });
    const health = (await get(demo.port, "/health")).json<Health>();
    expect(health.demo).toBe(true);
    expect(health.dataDir).toBeUndefined();
  });
});

describe("the viewer's files", () => {
  test("are served with their type; a hashed asset is cached for good", async () => {
    const { port } = await engine(["basic-tools"]);
    const page = await get(port, "/");
    expect(page.body).toContain("<title>Quantext</title>");
    const script = await get(port, "/assets/app-1.js");
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(script.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await get(port, "/assets/style.css")).headers["content-type"]).toBe("text/css; charset=utf-8");
  });

  test("a page of the viewer gets index.html; a missing file does not", async () => {
    const { port } = await engine(["basic-tools"]);
    for (const path of ["/sessions/1/abc", "/index.html", "/assets", "/linkdir"]) {
      const reply = await get(port, path);
      expect([path, reply.status, reply.body.includes("<title>Quantext</title>")]).toEqual([path, 200, true]);
    }
    expect((await get(port, "/assets/missing.js")).status).toBe(404);
  });

  test("nothing outside the folder, no dot files, no listing", async () => {
    const { port } = await engine(["basic-tools"]);
    const traversal = [
      "/../../../../etc/passwd",
      "/assets/../../secret.txt",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd",
      "/..%2f..%2fetc%2fpasswd",
      "/..%5c..%5cetc%5cpasswd",
      "/%252e%252e/etc/passwd",
      "/assets/%00.js",
      "//etc/passwd",
      "/etc/passwd%00.html",
      "/C:%5Cwindows%5Cwin.ini",
      "/.env",
      "/%2eenv",
      "/link.txt",
      "/linkdir/secret.txt",
    ];
    for (const path of traversal) {
      const reply = await get(port, path);
      expect([path, reply.body.includes("secret"), reply.body.includes("root:")]).toEqual([path, false, false]);
      expect([path, reply.status === 404 || reply.body.includes("<title>Quantext</title>")]).toEqual([path, true]);
    }
    expect((await get(port, "/link.txt")).status).toBe(404);
    expect((await get(port, "/.env")).status).toBe(404);
    expect((await get(port, "/linkdir/secret.txt")).status).toBe(404);
  });
});
