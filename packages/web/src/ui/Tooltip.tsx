/**
 * One tooltip for the whole page: any element with `data-tip` shows it on hover and on keyboard focus. Text only
 * (newlines kept), placed below the element and kept inside the window; Escape hides it.
 */
import { useEffect, useRef, useState } from "react";

interface Tip {
  text: string;
  x: number;
  y: number;
  above: boolean;
}

const GAP = 8;

export function Tooltip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let target: Element | null = null;
    const show = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
      if (el === target) return;
      target = el;
      const text = el?.getAttribute("data-tip");
      if (!el || !text) return setTip(null);
      const r = el.getBoundingClientRect();
      const above = r.bottom + 140 > innerHeight;
      setTip({ text, x: r.left + r.width / 2, y: above ? r.top - GAP : r.bottom + GAP, above });
    };
    const hide = (e: Event) => {
      const next = (e as FocusEvent | PointerEvent).relatedTarget as Element | null;
      if (target && next && target.contains(next)) return;
      target = null;
      setTip(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTip(null);
    };
    const reset = () => {
      target = null;
      setTip(null);
    };
    document.addEventListener("pointerover", show);
    document.addEventListener("focusin", show);
    document.addEventListener("pointerout", hide);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", onKey);
    addEventListener("scroll", reset, true);
    return () => {
      document.removeEventListener("pointerover", show);
      document.removeEventListener("focusin", show);
      document.removeEventListener("pointerout", hide);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", onKey);
      removeEventListener("scroll", reset, true);
    };
  }, []);
  // Keep the box inside the window once its width is known.
  useEffect(() => {
    const el = box.current;
    if (!el || !tip) return;
    const w = el.offsetWidth;
    const left = Math.min(Math.max(tip.x - w / 2, GAP), innerWidth - w - GAP);
    el.style.left = `${left}px`;
    el.style.top = tip.above ? `${tip.y - el.offsetHeight}px` : `${tip.y}px`;
    el.style.visibility = "visible";
  }, [tip]);
  if (!tip) return null;
  return (
    <div ref={box} className="tooltip" role="tooltip" data-testid="tooltip">
      {tip.text}
    </div>
  );
}
