import { useEffect, useState } from "react";
import { MemoryPage } from "./memory/MemoryPage.tsx";
import { Link, useRoute } from "./nav.tsx";
import { SessionList } from "./pages/SessionList.tsx";
import { SessionPage } from "./pages/SessionPage.tsx";
import { GlossaryPanel } from "./teach/GlossaryPanel.tsx";
import { KeysHelp } from "./teach/KeysHelp.tsx";
import { overlay, useOverlay } from "./teach/panel.ts";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";
import { LiveStatus } from "./ui/LiveStatus.tsx";
import { Tooltip } from "./ui/Tooltip.tsx";
import type { Theme } from "./ui/theme.ts";
import { applyTheme, savedTheme } from "./ui/theme.ts";

const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const THEME_LABEL: Record<Theme, string> = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" };

export function App() {
  const route = useRoute();
  const shown = useOverlay();
  useGlobalKeys();
  const [theme, setTheme] = useState(savedTheme);
  const cycle = () => {
    const next = NEXT[theme];
    applyTheme(next);
    setTheme(next);
  };
  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="masthead">
        <Link to={{ page: "sessions" }} className="brand" aria-label="Quantext: all sessions">
          <span className="brand-mark" aria-hidden="true" />
          Quantext
        </Link>
        {route.page !== "sessions" && (
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link to={{ page: "sessions" }}>All sessions</Link>
          </nav>
        )}
        <div className="masthead-end">
          <LiveStatus />
          <button type="button" className="quiet" onClick={() => overlay.glossary()} aria-keyshortcuts="g">
            Glossary
          </button>
          <button
            type="button"
            className="quiet"
            onClick={overlay.keys}
            aria-label="Keyboard shortcuts"
            aria-keyshortcuts="?"
            data-tip="Keyboard shortcuts (?)"
          >
            Keys
          </button>
          <button
            type="button"
            className="quiet"
            onClick={cycle}
            data-tip="Light suits a projector. The OS setting is the default."
          >
            {THEME_LABEL[theme]}
          </button>
        </div>
      </header>
      <main className="page" id="main">
        <ErrorBoundary key={location.pathname}>
          {route.page === "sessions" && <SessionList route={route} />}
          {route.page === "session" && <SessionPage key={`${route.key.log}/${route.key.id}`} route={route} />}
          {route.page === "memory" && <MemoryPage route={route} />}
          {route.page === "not-found" && (
            <section className="empty">
              <h1>No page at this address</h1>
              <p>
                <Link to={{ page: "sessions" }}>Open the session list</Link>
              </p>
            </section>
          )}
        </ErrorBoundary>
      </main>
      {shown.kind === "glossary" && <GlossaryPanel term={shown.term} />}
      {shown.kind === "keys" && <KeysHelp />}
      <Tooltip />
    </div>
  );
}

/** "?" shows the keys, "g" the glossary: not while typing, nor with a modifier other than Shift. */
function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, select, textarea, [contenteditable]")) return;
      if (e.key === "?") {
        e.preventDefault();
        overlay.keys();
      } else if (e.key === "g") {
        e.preventDefault();
        overlay.glossary();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
}
