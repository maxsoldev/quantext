/** Display text cut to a preview. */

export interface Preview {
  preview: string;
  /** Characters of the whole text. */
  chars: number;
  truncated: boolean;
}

/** The text on one line, cut to `max` characters with `…` when longer. */
export function previewOf(text: string, max: number): Preview {
  const flat = text.replace(/\s+/g, " ").trim();
  const truncated = flat.length > max;
  return { preview: truncated ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat, chars: text.length, truncated };
}
