/** The turns of a Call's messages: where each prompt's turn starts, and what each turn holds. */
import type { BlockKind, ContextBlock, ContextTurn } from "@quantext/shared";

/** Blocks of the model's answer, and the tool results that answer its calls: a prompt after them starts a turn. */
const ANSWER: ReadonlySet<BlockKind | "framing"> = new Set(["assistant", "reasoning", "tool-call", "tool-result"]);

/**
 * Marks each message Block with its turn and gives the turns in order. A turn starts with the lead-in of a prompt
 * (a `user` Block after an answer): the Blocks after the last answer. Before the first answer all is the first
 * turn; when the model answered before any prompt, that part is a turn with no prompt.
 */
export function markTurns(blocks: readonly ContextBlock[]): ContextTurn[] {
  const messages = blocks.filter((b) => b.section === "messages");
  const starts: number[] = [];
  let lead = 0;
  let answered = false;
  let waiting = true;
  messages.forEach((b, i) => {
    if (ANSWER.has(b.kind)) {
      answered = true;
      waiting = true;
      lead = i + 1;
    } else if (b.kind === "user" && waiting) {
      if (starts.length === 0 && answered) starts.push(0);
      starts.push(starts.length === 0 ? 0 : lead);
      waiting = false;
    }
  });
  if (starts.length === 0 && messages.length > 0) starts.push(0);
  return starts.map((from, k) => {
    const own = messages.slice(from, starts[k + 1] ?? messages.length);
    const turn: ContextTurn = {
      turn: k + 1,
      start: own[0]?.position ?? 0,
      blocks: own.length,
      tokens: 0,
      cachedTokens: 0,
    };
    const firstAnswer = own.findIndex((b) => ANSWER.has(b.kind));
    const prompt = own.slice(0, firstAnswer < 0 ? own.length : firstAnswer).findLast((b) => b.kind === "user");
    if (prompt !== undefined) turn.prompt = { position: prompt.position, preview: prompt.preview };
    for (const b of own) {
      b.turn = turn.turn;
      turn.tokens += b.tokens ?? 0;
      if (b.inCachedPrefix) turn.cachedTokens += b.tokens ?? 0;
    }
    return turn;
  });
}
