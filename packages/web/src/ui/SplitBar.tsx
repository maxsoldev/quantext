/** A thin segmented bar: one whole split into parts, with each part's share in the tooltip of the whole bar. */
import { percent } from "../format/format.ts";

export interface Slice {
  key: string;
  label: string;
  value: number;
  /** Shown in the tooltip, e.g. "$0.012". */
  text: string;
  className: string;
}

export function SplitBar({ slices, title }: { slices: readonly Slice[]; title: string }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  const tip = [title, ...slices.map((s) => `${s.label}: ${s.text} (${percent(total ? s.value / total : 0)})`)].join(
    "\n",
  );
  return (
    <button type="button" className="tip-anchor split-bar" data-tip={tip} aria-label={tip}>
      {total > 0 &&
        slices
          .filter((s) => s.value > 0)
          .map((s) => (
            <span key={s.key} className={`split-part ${s.className}`} style={{ flexGrow: s.value / total }} />
          ))}
    </button>
  );
}
