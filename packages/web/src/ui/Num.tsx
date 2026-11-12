/** Numbers that say how they were found: a basis mark before the value and its explanation on hover and focus. */
import type { TokenBasis } from "@quantext/shared";
import { basisOf, tokens, usd } from "../format/format.ts";

const full = new Intl.NumberFormat("en-US");

/** Token count; `basis` absent means exact. `note` adds a line to the explanation (where the number comes from). */
export function Tokens({ n, basis = "exact", note }: { n: number; basis?: TokenBasis | "framing"; note?: string }) {
  const b = basisOf(basis);
  const tip = [`${full.format(n)} tokens`, b.explain, note].filter(Boolean).join("\n");
  return (
    <button type="button" className={`tip-anchor num basis-${basis}`} data-tip={tip}>
      {b.mark && <span className="basis-mark">{b.mark}</span>}
      {tokens(n)}
    </button>
  );
}

/** Dollars, with how they were priced. */
export function Usd({ x, note }: { x: number; note: string }) {
  return (
    <button type="button" className="tip-anchor num" data-tip={`${usd(x)}\n${note}`}>
      {usd(x)}
    </button>
  );
}
