/** Which overlay is open: the glossary (at a term) or the keyboard help. One at a time; React reads it as a store. */
import { useSyncExternalStore } from "react";

export type Overlay = { kind: "none" } | { kind: "glossary"; term?: string } | { kind: "keys" };

let current: Overlay = { kind: "none" };
const listeners = new Set<() => void>();

function set(next: Overlay): void {
  current = next;
  for (const fn of listeners) fn();
}

export const overlay = {
  get: (): Overlay => current,
  glossary: (term?: string) => set(term ? { kind: "glossary", term } : { kind: "glossary" }),
  keys: () => set({ kind: "keys" }),
  close: () => set({ kind: "none" }),
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useOverlay(): Overlay {
  return useSyncExternalStore(overlay.subscribe, overlay.get);
}
