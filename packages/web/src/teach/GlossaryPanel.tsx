/**
 * The glossary: every explainer in one side panel, opened at a term. "Show me" opens the view that shows the term
 * and points at the element there.
 */
import { useEffect, useRef } from "react";
import { navigate, useRoute } from "../nav.tsx";
import type { Where } from "./glossary.ts";
import { TERMS } from "./glossary.ts";
import { overlay } from "./panel.ts";

export function GlossaryPanel({ term }: { term?: string | undefined }) {
  const close = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const route = useRoute();
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const target = term ? list.current?.querySelector<HTMLElement>(`#term-${term}`) : null;
    const panel = list.current?.closest("aside");
    if (target && panel) {
      // Scroll the panel only: scrollIntoView would move the page under it too.
      panel.scrollTop += target.getBoundingClientRect().top - panel.getBoundingClientRect().top - 16;
      target.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
    } else close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") overlay.close();
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [term]);
  const onSession = route.page === "session";
  const show = (w: Where) => {
    overlay.close();
    if (route.page === "session" && w.view) {
      const view = w.view === "context" ? undefined : w.view;
      if (view !== route.view) navigate({ page: "session", key: route.key, ...(view ? { view } : {}) });
    }
    if (w.selector) pointAt(w.selector);
  };
  return (
    <aside className="block-panel glossary" aria-labelledby="glossary-title" data-testid="glossary">
      <div className="block-panel-head">
        <div>
          <h2 id="glossary-title">Glossary</h2>
          <p className="muted">The ideas behind what this viewer shows.</p>
        </div>
        <button type="button" ref={close} onClick={overlay.close} aria-label="Close the glossary">
          Close
        </button>
      </div>
      <div className="glossary-list" ref={list}>
        {TERMS.map((t) => (
          <section
            key={t.id}
            id={`term-${t.id}`}
            className={t.id === term ? "glossary-term current" : "glossary-term"}
            aria-labelledby={`term-title-${t.id}`}
          >
            <h3 id={`term-title-${t.id}`} tabIndex={-1}>
              {t.term}
            </h3>
            <p className="glossary-short">{t.short}</p>
            <p>{t.body}</p>
            {t.where && (
              <p className="muted">
                Where to see it: {t.where.label}.{" "}
                {onSession || !t.where.view ? (
                  <button type="button" className="link" onClick={() => show(t.where as Where)}>
                    Show me
                  </button>
                ) : (
                  "Open a session to see it."
                )}
              </p>
            )}
          </section>
        ))}
      </div>
    </aside>
  );
}

/** Bring the first element that matches into view and mark it for a moment; tries again while a view loads. */
function pointAt(selector: string, tries = 20): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) {
    if (tries > 0) setTimeout(() => pointAt(selector, tries - 1), 100);
    return;
  }
  el.scrollIntoView({ block: "center" });
  el.classList.add("pointed");
  setTimeout(() => el.classList.remove("pointed"), 2400);
}
