/** Tokens, short: `950` → `1k`, `333_000` → `333k`, `1_234_567` → `1.2M`. */
export const tokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

/** US dollars, short: two decimals below $100, whole dollars from there. */
export const usd = (n: number): string => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
