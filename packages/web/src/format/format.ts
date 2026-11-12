/** How the viewer writes numbers, money, shares, times, and the basis of a token number. */
import type { TokenBasis } from "@quantext/shared";

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** In full under 10,000 (axis-tick rule), else compact with three significant digits. */
export function tokens(n: number): string {
  if (Math.abs(n) < 10_000) return whole.format(n);
  if (Math.abs(n) < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

function trim(x: number): string {
  return String(Number(x.toPrecision(3)));
}

/** US dollars: two significant digits below 10 cents, cents up to $1,000, whole dollars above. */
export function usd(x: number): string {
  if (x === 0) return "$0";
  if (Math.abs(x) < 0.1) return `$${Number(x.toPrecision(2)).toString()}`;
  if (Math.abs(x) < 1000) return `$${x.toFixed(2)}`;
  return `$${whole.format(x)}`;
}

/** A share of 0..1 as a percent; one decimal below 10%. */
export function percent(x: number): string {
  const p = 100 * x;
  if (p === 0) return "0%";
  if (p < 0.1) return "<0.1%";
  return p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

export interface Basis {
  /** Written before the number: none for exact. */
  mark: string;
  label: string;
  explain: string;
}

const BASES: Record<TokenBasis | "framing", Basis> = {
  exact: { mark: "", label: "exact", explain: "Exact: the model provider reported this count in the call's usage." },
  derived: {
    mark: "Δ",
    label: "derived",
    explain:
      "Derived: computed from exact running totals (the change between two calls), as the call's own usage is not in the log.",
  },
  anchored: {
    mark: "≈",
    label: "anchored",
    explain:
      "Anchored: an exact change between two calls, less the previous reply's output. Near exact, off by tens of tokens.",
  },
  estimate: {
    mark: "~",
    label: "estimate",
    explain: "Estimate: an exact total split between blocks by a token estimator. The sum is exact, this share is not.",
  },
  framing: {
    mark: "",
    label: "framing",
    explain: "Framing: input tokens after the last Block (the end of the request). Exact as a remainder of the total.",
  },
};

export function basisOf(basis: TokenBasis | "framing"): Basis {
  return BASES[basis];
}

/** A past time relative to `now`, in its largest whole unit. */
export function ago(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s - 60 * m)} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

const dateTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** A short local date and time: "12 Nov, 09:41". */
export function when(iso: string): string {
  return dateTime.format(new Date(iso));
}

/** A model id without its provider prefix and date: `claude-opus-5-5` → `opus-5-5`. */
export function shortModel(model: string): string {
  return model.replace(/^(anthropic\.|us\.anthropic\.|eu\.anthropic\.)?claude-/, "").replace(/-\d{8}(-v\d+:\d+)?$/, "");
}

/** The last folder of a project path, as people name it. */
export function projectName(project: string): string {
  const parts = project.split(/[\\/]/).filter((p) => p !== "");
  return parts.at(-1) ?? project;
}
