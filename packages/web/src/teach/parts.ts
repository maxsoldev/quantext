/** Short explainers for the parts of injected context that cost tokens on every call without being used. */
import { tokens } from "../format/format.ts";

const PARTS: Record<string, { term: string; what: string }> = {
  "Skill listing": {
    term: "skill-listing",
    what: "The name and description of every skill the model may load, not the skills' text.",
  },
  "Deferred tools": {
    term: "deferred-tools",
    what: "The names of the tools whose schemas are held back until ToolSearch loads them.",
  },
};

/** The glossary term and the tooltip of a part with this label, when it has an explainer. */
export function partTeach(label: string, n: number | undefined): { term: string; tip: string } | undefined {
  const p = Object.hasOwn(PARTS, label) ? PARTS[label] : undefined;
  if (p === undefined) return undefined;
  const cost = n === undefined ? "" : ` Costs ${tokens(n)} tokens here.`;
  return { term: p.term, tip: `${p.what} Sent on every call.${cost}` };
}
