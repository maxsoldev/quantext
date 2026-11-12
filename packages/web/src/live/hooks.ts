/** React access to the page's Live: its state, and a version number that moves when relevant events arrive. */
import type { PublicEvent } from "@quantext/shared";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { live } from "./browser.ts";
import type { LiveState } from "./live.ts";

export function useLiveState(): LiveState {
  return useSyncExternalStore(live.watch, live.state);
}

/**
 * A number that grows when an event `matches` (or on a refresh), at most once per `throttleMs`: pass it as a
 * dependency of a load to read again. A burst of events gives one read at its start and one after it.
 */
export function useLiveVersion(matches: (event: PublicEvent) => boolean, throttleMs = 1000): number {
  const [version, setVersion] = useState(0);
  const match = useRef(matches);
  match.current = matches;
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      const wait = last + throttleMs - Date.now();
      if (wait <= 0) {
        last = Date.now();
        setVersion((v) => v + 1);
      } else if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          last = Date.now();
          setVersion((v) => v + 1);
        }, wait);
      }
    };
    const off = live.subscribe((m) => {
      if (m.type === "refresh" || match.current(m.event)) bump();
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [throttleMs]);
  return version;
}
