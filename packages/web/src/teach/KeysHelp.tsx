/** The keyboard shortcuts, in a modal dialog (Escape closes it, as the browser does for a modal). */
import { useEffect, useRef } from "react";
import { overlay } from "./panel.ts";

const KEYS: [string[], string][] = [
  [["←", "→"], "Previous or next call, on a session page"],
  [["Shift", "←"], "Ten calls back (Shift + → ten on)"],
  [["Home", "End"], "First or latest call of the lane"],
  [["↑", "↓"], "Move between rows of a list or table"],
  [["Enter"], "Open the row or block that has the focus"],
  [["e"], "Expand all sections of the block list"],
  [["c"], "Collapse all sections of the block list"],
  [["Esc"], "Close a panel"],
  [["g"], "Open the glossary"],
  [["?"], "Show these keys"],
];

export function KeysHelp() {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    d.showModal();
    const onClose = () => overlay.close();
    d.addEventListener("close", onClose);
    return () => d.removeEventListener("close", onClose);
  }, []);
  return (
    <dialog ref={dialog} className="keys-help" aria-labelledby="keys-title" data-testid="keys-help">
      <h2 id="keys-title">Keyboard</h2>
      <dl>
        {KEYS.map(([keys, what]) => (
          <div key={what}>
            <dt>
              {keys.map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <form method="dialog">
        <button type="submit">Close</button>
      </form>
    </dialog>
  );
}
