import { useEffect, useRef } from "react";
import { Overlay } from "@/components/overlays/Overlay";
import { useConfirm } from "@/state/confirmStore";
import { WarnIcon } from "@/icons";
import "./ConfirmDialog.css";

/**
 * "Are you sure?" — the styled, in-app replacement for `window.confirm`.
 *
 * Mounted once, in App, beside `ConflictDialog`. It renders whatever
 * `confirmStore` has pending and answers the promise the asker is holding.
 *
 * **Where the keys land, and why.** `Overlay` already takes Escape and calls
 * `onClose`, which here is a cancel — so backing out is one key, or a click on
 * the backdrop, or Cancel. Enter is deliberately *not* bound globally: it does
 * whatever the focused button does, and focus starts on **Cancel**. So Enter
 * on a dialog the writer has not touched cancels. That is the entire safety
 * property — a `×` caught in passing followed by a habitual Enter must not
 * delete a chapter. Tab to the destructive button and Enter deletes, which is
 * a deliberate act and reads as one.
 */
export function ConfirmDialog() {
  const pending = useConfirm((s) => s.pending);
  const answer = useConfirm((s) => s.answer);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // `Overlay` focuses its own panel on mount, and this has to land *after*
  // that or Cancel is not focused and the gate loses the property it exists
  // for. Effect order alone does not settle it: Overlay is a newly-mounted
  // subtree, so StrictMode runs its mount effect twice — the second pass
  // after this component's single one — and the panel wins.
  //
  // A zero timer, not `requestAnimationFrame`. A frame callback never fires
  // in a window the compositor has parked (a hidden pane, another workspace,
  // a minimised window), and a dialog that only focuses Cancel when someone
  // is looking is exactly the wrong way round. Timers fire regardless.
  //
  // Keyed on `id` rather than `pending`, so a second question re-focuses
  // Cancel instead of leaving focus wherever the last one ended.
  const id = pending?.id;
  useEffect(() => {
    if (id === undefined) return;
    const t = window.setTimeout(() => cancelRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [id]);

  // Escape is answered here, in the CAPTURE phase, instead of letting
  // `Overlay`'s own handler do it. Every mounted `Overlay` listens for Escape
  // on `window`, and the questions this dialog asks are now raised from
  // *inside* other overlays — Empty trash and Purge come from the Recently
  // Deleted sheet. Left alone, one Escape would cancel the question and close
  // the sheet behind it, which is a sheet the writer never asked to leave.
  // A capture listener on `window` runs before every bubble-phase one, so
  // stopping propagation there means Escape does exactly one thing.
  useEffect(() => {
    if (id === undefined) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      answer(false);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [id, answer]);

  if (!pending) return null;

  return (
    <Overlay title="" width={420} onClose={() => answer(false)}>
      <div
        className="ask"
        onKeyDown={(e) => {
          // Enter follows focus: a focused <button> is activated by the engine
          // itself, and focus starts on Cancel — so the reflex press cancels.
          // This only catches Enter arriving with focus on neither button (the
          // panel itself, say), where the engine would do nothing at all. It
          // answers "no", because a dialog that swallows a key is a dialog the
          // writer presses again, harder.
          if (e.key !== "Enter") return;
          if ((e.target as HTMLElement).tagName === "BUTTON") return;
          e.preventDefault();
          answer(false);
        }}
      >
        <header className="ask-head">
          <WarnIcon size={18} color={pending.destructive ? "var(--danger)" : "var(--warn)"} />
          <div>
            <div className="ask-title">{pending.title}</div>
            <div className="ask-sub">{pending.body}</div>
          </div>
        </header>
        <footer className="ask-foot">
          <span className="ask-spacer" />
          <button ref={cancelRef} className="ask-cancel" onClick={() => answer(false)}>
            Cancel
          </button>
          <button
            className={`ask-go${pending.destructive ? " danger" : ""}`}
            onClick={() => answer(true)}
          >
            {pending.confirmLabel}
          </button>
        </footer>
      </div>
    </Overlay>
  );
}
