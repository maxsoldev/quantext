/** The estimator seam: a token estimate per Block, used only to split an exact total (ADR 6). */
import type { Block } from "@quantext/shared";

export type EstimateMethod = "chars" | "image" | "unknown";

export interface Estimate {
  tokens: number;
  method: EstimateMethod;
}

/** Estimates one Block from its content alone. A model provider supplies the default one. */
export type Estimator = (block: Block) => Estimate;
