/** Display text cut to a preview. Redaction comes first: a cut word could escape the redactor's patterns. */

export interface Preview {
  preview: string;
  /** Characters of the whole (redacted) text. */
  chars: number;
  truncated: boolean;
}

/** The text redacted, on one line, cut to `max` characters with `…` when longer. */
export function previewOf(text: string, max: number, redact: (text: string) => string = (t) => t): Preview {
  const shown = redact(text);
  const flat = shown.replace(/\s+/g, " ").trim();
  const truncated = flat.length > max;
  return { preview: truncated ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat, chars: shown.length, truncated };
}
