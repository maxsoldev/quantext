/** Which runtime starts the engine: Node.js 22.18 or later, else Bun 1.3.3 or later (the versions CI tests). */

export const MIN_NODE = [22, 18, 0] as const;
export const MIN_BUN = [1, 3, 3] as const;

/** Whether `--version` output (`v24.14.0`, `1.3.3`) names `min` or later. */
export function meetsVersion(output: string, min: readonly [number, number, number]): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
  if (m === null) return false;
  const got = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    const [a = 0, b = 0] = [got[i], min[i]];
    if (a !== b) return a > b;
  }
  return true;
}

export const INSTALL_HINT =
  "quantext: the viewer needs Node.js 22.18 or later, or Bun 1.3.3 or later, on PATH. " +
  "Install one (https://nodejs.org or https://bun.sh), then run /quantext view again.";
