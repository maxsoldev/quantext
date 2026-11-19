/** A time limit for work that must not hang the process, such as the engine's stop. */

/**
 * Runs `work` and calls `onLate` once if it has not settled within `ms`; the work goes on. The timer does not keep
 * the process alive, so work that ends in time ends the process as before.
 */
export async function withDeadline<T>(work: () => Promise<T>, ms: number, onLate: () => void): Promise<T> {
  const timer = setTimeout(onLate, ms);
  timer.unref();
  try {
    return await work();
  } finally {
    clearTimeout(timer);
  }
}
