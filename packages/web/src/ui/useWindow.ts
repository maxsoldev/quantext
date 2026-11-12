/** A windowed list in a scrolling element: which rows to draw, and how to bring one row into view. */
import type { RefObject } from "react";
import { useCallback, useEffect, useState } from "react";
import type { Window } from "./window.ts";
import { windowOf } from "./window.ts";

export function useWindow(
  scroller: RefObject<HTMLElement | null>,
  count: number,
  rowHeight: number,
  overscan = 6,
): Window & { reveal(index: number): void } {
  const [view, setView] = useState({ scrollTop: 0, height: 800 });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setView({ scrollTop: el.scrollTop, height: el.clientHeight }));
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    const resize = new ResizeObserver(read);
    resize.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", read);
      resize.disconnect();
    };
  }, [scroller]);
  const reveal = useCallback(
    (index: number) => {
      const el = scroller.current;
      if (!el) return;
      const top = index * rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
    },
    [scroller, rowHeight],
  );
  return { ...windowOf({ ...view, rowHeight, count, overscan }), reveal };
}
