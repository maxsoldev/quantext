/** Human output for the terminal: aligned tables and short numbers. JSON output does not go through here. */

export interface Column<T> {
  title: string;
  value: (row: T) => string;
  /** Numbers align right. */
  right?: boolean;
  /** Cut longer cells to this many characters. */
  max?: number;
}

/** Rows as an aligned table with a header line; cells are cut to their column's `max` (after the query layer redacted them). */
export function table<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  const cells = rows.map((row) => columns.map((c) => cut(oneLine(c.value(row)), c.max)));
  const widths = columns.map((c, i) => Math.max(c.title.length, ...cells.map((r) => (r[i] ?? "").length)));
  const line = (values: readonly string[]) =>
    values
      .map((v, i) => (columns[i]?.right === true ? v.padStart(widths[i] ?? 0) : v.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [line(columns.map((c) => c.title)), ...cells.map(line)].join("\n");
}

/** `12,345` */
export function count(n: number | undefined): string {
  return n === undefined ? "-" : Math.round(n).toLocaleString("en-US");
}

/** `$0.1234` (four decimals below a dollar, else two). */
export function usd(n: number | undefined): string {
  if (n === undefined) return "-";
  return `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
}

/** `87%` */
export function percent(rate: number | undefined): string {
  return rate === undefined ? "-" : `${Math.round(rate * 100)}%`;
}

/** `2026-11-12 00:26` from an ISO time, in UTC. */
export function time(iso: string | undefined): string {
  return iso === undefined ? "-" : iso.replace("T", " ").slice(0, 16);
}

/** `1.2 MB` */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cut(text: string, max: number | undefined): string {
  return max === undefined || text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
