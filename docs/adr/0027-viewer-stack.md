# 27. The viewer's stack: React and Vite, hand-made charts and lists, one bundled typeface

Status: accepted (build step 8)

## Context

The live context viewer (`packages/web`) is served by the engine from `dist/web/` under a strict CSP (ADR 24):
scripts and styles from the same origin only, no inline script, no injected `<style>`, no network beyond the
engine. It must stay fast on Sessions of 2,000+ Calls and be readable on a projector. The eduagent visualiser, whose
components it reuses, is React + Vite. ADR 13 already chose Vite 8 (Rolldown) as the one toolchain.

## Decision

Exact versions, each for one job:

| Package | Version | Why |
|---|---|---|
| `react`, `react-dom` | 19.3.1 | Components reused from the eduagent visualiser; the best-known UI library. React sets `style` through the CSSOM, which `style-src 'self'` allows (only `style` attributes in HTML and `<style>` elements are blocked) |
| `vite` | 8.3.7 | The version Vitest already resolves, so one Rolldown (`scripts/dependencies.test.ts`) |
| `@vitejs/plugin-react` | 6.3.0 | Fast refresh in dev; one dependency (`@rolldown/pluginutils`), no Babel |
| `@types/react`, `@types/react-dom` | 19.3.0 | Types |
| `@fontsource-variable/atkinson-hyperlegible-next`, `…-mono` | 5.3.0 | One typeface family, bundled (no CDN): Atkinson Hyperlegible is drawn for legibility at a distance and for low vision, which is the projector case. Font files and CSS only, no code; OFL |
| `@playwright/test` (root, dev) | 1.65.0 | End-to-end tests in `e2e/` against the bundled engine; browsers by `playwright install chromium` |

Not added, on purpose:

- **No chart library.** The charts are a few stacked areas, columns and markers in SVG; a library would bring its
  own styling (often injected `<style>`, against the CSP) and a large bundle. Chart data shaping is pure code with
  unit tests (`src/chart/`).
- **No virtualisation library.** Rows have a fixed height, so a windowed list is a small hook (`ui/useWindow.ts`).
- **No router, no state library.** Two pages; the route is parsed from the URL (`src/route.ts`) and state lives
  in hooks over the API client.

## Consequences

- The build is `pnpm build`: `vite build` into `packages/web/dist/`, which `scripts/build-engine.ts` copies into
  `packages/engine/dist/web/`. From source, `qx serve` serves `packages/web/dist/` when it is built, else the
  placeholder page in `packages/engine/static/`.
- A new dependency of the viewer needs a row here; one that injects styles or loads from the network is out.
