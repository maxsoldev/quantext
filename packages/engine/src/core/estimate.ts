/** The estimator seam: a token estimate per Block, used only to split an exact total (ADR 6). */
import type { Block } from "@quantext/shared";

/**
 * `unknown`: no estimate; such Blocks share what the others leave, equally. `rest`: the Block takes, with the other
 * `rest` Blocks and in proportion to its tokens, what the known weights leave (used when one Block's weight is
 * known much better than the others').
 */
export type EstimateMethod = "chars" | "image" | "unknown" | "rest";

export interface Estimate {
  tokens: number;
  method: EstimateMethod;
}

/** Estimates one Block from its content alone. A model provider supplies the default one. */
export type Estimator = (block: Block) => Estimate;
