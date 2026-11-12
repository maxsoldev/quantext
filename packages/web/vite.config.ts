/**
 * The viewer's build: `dist/` here, copied into the engine's `dist/web/` by scripts/build-engine.ts. In dev, `/api`
 * and `/health` go to a running engine (QX_ENGINE, default http://127.0.0.1:4747); the engine checks Host and
 * Origin, so the proxy sets both to the engine's own.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const engine = process.env.QX_ENGINE ?? "http://127.0.0.1:4747";
const toEngine = {
  target: engine,
  changeOrigin: true,
  configure: (proxy: { on(event: "proxyReq", fn: (req: { setHeader(n: string, v: string): void }) => void): void }) => {
    proxy.on("proxyReq", (req) => {
      req.setHeader("origin", engine);
      req.setHeader("sec-fetch-site", "same-origin");
    });
  },
};

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, assetsDir: "assets", sourcemap: false },
  server: { proxy: { "/api": toEngine, "/health": toEngine } },
});
