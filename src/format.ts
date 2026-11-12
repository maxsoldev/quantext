/** Tokens, short: `950` → `1k`, `333_000` → `333k`, `1_234_567` → `1.2M`. */
export const tokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

/** Tokens at ~4 characters each: `850`, `4.2k`, `12k`. */
export const approx = (chars: number): string => {
  const n = Math.round(chars / 4);
  return n < 1000 ? `${n}` : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : tokens(n);
};

/** A whole number with thousands commas: `11,950`. */
export const grouped = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** US dollars, short: two decimals below $100, whole dollars from there. */
export const usd = (n: number): string => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
