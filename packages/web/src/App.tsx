import { useState } from "react";
import { MemoryPage } from "./memory/MemoryPage.tsx";
import { Link, useRoute } from "./nav.tsx";
import { SessionList } from "./pages/SessionList.tsx";
import { SessionPage } from "./pages/SessionPage.tsx";
import { LiveStatus } from "./ui/LiveStatus.tsx";
import { Tooltip } from "./ui/Tooltip.tsx";
import type { Theme } from "./ui/theme.ts";
import { applyTheme, savedTheme } from "./ui/theme.ts";

const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const THEME_LABEL: Record<Theme, string> = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" };

export function App() {
  const route = useRoute();
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
      </main>
      <Tooltip />
    </div>
  );
}
