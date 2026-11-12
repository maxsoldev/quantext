/** A key term with a "?" that opens its explainer in the glossary panel. */
import type { ReactNode } from "react";
import { TERM } from "./glossary.ts";
import { overlay } from "./panel.ts";

export function Term({ id, children }: { id: string; children?: ReactNode }) {
  const t = TERM[id];
  if (!t) throw new Error(`no glossary term ${id}`);
  return (
    <span className="term">
      {children}
      <button
        type="button"
        className="term-q"
        aria-label={`What is ${t.term.toLowerCase()}?`}
        data-tip={`${t.short}\nClick for more.`}
        onClick={() => overlay.glossary(id)}
      >
        ?
      </button>
    </span>
  );
}
