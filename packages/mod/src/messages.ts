/**
 * The mod's messages: each one a toast, and kept, newest first, for the pane that bare `/quantext` opens and
 * closes. A toast lasts seconds; the pane keeps the session's newest 50. While the pane is closed the footer
 * counts the new ones.
 */
import type { EngineInterface, RenderElement, RenderInput } from "claude-code";
import { atom, read, update } from "claude-code";
import type { Messages } from "../types/index.js";

export const PANE = "quantext";
const TITLE = "Quantext";
const KEEP = 50;
/** Inline above the prompt the frame grows with its rows: there only the newest few. */
const INLINE = 5;
const EMPTY: Messages = { list: [], unread: 0 };
// Change the tag when a message's fields change: it declines what an earlier version stored.
const messages = atom({ plugin: "quantext", key: "messages" } as const, EMPTY, { shape: "messages-1" });

/** Whether the pane is on screen; a failed look counts as closed, so a message counts as new. */
async function paneIsShown($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some((p) => p.id === PANE && p.isPlaced && p.isShown);
  } catch (error) {
    $.ui.log(`quantext: could not list the panes: ${String(error)}`, { to: "debug" });
    return false;
  }
}

/** Shows `text` as a toast and keeps it for the pane. */
export async function say($: EngineInterface, text: string): Promise<void> {
  $.ui.toast(text);
  const at = await $.clock.now();
  const seen = await paneIsShown($);
  await update($, messages, (m) => ({
    list: [{ at, text }, ...m.list].slice(0, KEEP),
    unread: seen ? 0 : m.unread + 1,
  }));
}

/** How many messages came while the pane was closed. */
export async function unread($: EngineInterface): Promise<number> {
  return (await read($, messages)).unread;
}

/** Opens the pane, or closes it when it is open; answers what it did, for the command's reply. */
export async function togglePane($: EngineInterface): Promise<string> {
  if ((await $.ui.panes()).some((p) => p.id === PANE)) {
    await $.ui.close({ id: PANE });
    return "quantext: messages pane closed.";
  }
  const opened = await $.ui.open({ id: PANE, title: TITLE });
  await update($, messages, (m) => ({ ...m, unread: 0 }));
  return opened.isPlaced
    ? "quantext: messages pane opened; /quantext again closes it."
    : `quantext: the messages pane waits to be drawn (${opened.reason}).`;
}

/** `14:05`, in the person's time zone. */
function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** `h` with a component tag: `h` is typed for every tag (a string too), so it may answer a bare string or null. */
const el = (...args: Parameters<typeof h>): RenderElement => h(...args) as RenderElement;

/** Draws the pane: one row per message, its time, then its words without the "quantext: " the title says. */
export async function drawPane($: EngineInterface, e: RenderInput<"Pane">): Promise<RenderElement> {
  const { Box, Text } = $.ui.resolve(e);
  const { list } = await read($, messages);
  if (list.length === 0) return el(Text, { dimColor: true }, "No messages yet. Quantext's toasts land here.");
  const shown = e.props.placement === "inline" ? list.slice(0, INLINE) : list;
  return el(
    Box,
    { flexDirection: "column" },
    ...shown.map((m) =>
      el(
        Box,
        { flexDirection: "row", gap: 1 },
        el(Text, { dimColor: true }, clockTime(m.at)),
        el(Text, { wrap: "wrap" }, m.text.replace(/^quantext: /, "")),
      ),
    ),
  );
}
