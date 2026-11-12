/** Load data for a component: re-runs when `deps` or `version` change, aborts the stale request, keeps the last value. */
import { useEffect, useState } from "react";

export type Load<T> =
  | { state: "loading"; value?: T }
  | { state: "ready"; value: T }
  | { state: "error"; error: Error; value?: T };

export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): Load<T> {
  const [result, setResult] = useState<Load<T>>({ state: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    setResult((r) => (r.value === undefined ? { state: "loading" } : { state: "loading", value: r.value }));
    load(abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setResult({ state: "ready", value });
      },
      (error: unknown) => {
        if (abort.signal.aborted) return;
        const e = error instanceof Error ? error : new Error(String(error));
        setResult((r) =>
          r.value === undefined ? { state: "error", error: e } : { state: "error", error: e, value: r.value },
        );
      },
    );
    return () => abort.abort();
    // biome-ignore lint/correctness/useExhaustiveDependencies: the caller names what the load depends on.
  }, deps);
  return result;
}
