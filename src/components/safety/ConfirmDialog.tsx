import { useEffect, useRef } from "react";
import { Overlay } from "@/components/overlays/Overlay";
import { useConfirm } from "@/state/confirmStore";
import { WarnIcon } from "@/icons";
import "./ConfirmDialog.css";

/**
 * "Are you sure?" and "what should this be called?" — the styled, in-app
 * replacements for `window.confirm` and `window.prompt`.
 *
 * **`window.confirm`, `window.alert` and `window.prompt` are off-limits in
 * this app.** The first two are replaced by `tauri-plugin-dialog` with *async*
 * functions, so a synchronous `if (!window.confirm(…)) return;` tests a
 * pending Promise, which is truthy, and the gate never closes — three of them
 * were silently open for months. `prompt` is not shimmed at all and falls
 * through to the webview's own script dialog, a system-styled modal titled
 * "JavaScript - http://localhost:1420/" that belongs to no part of this
 * design. Ask through this dialog instead: `confirmAsk` / `promptAsk` in
 * `state/confirmStore`. NOTES §31f, §31h.
 *
 * Mounted once, in App, beside `ConflictDialog`. It renders whatever
 * `confirmStore` has pending — a confirm or a text prompt, one slot for both —
 * and answers the promise the asker is holding.
 *
 * **Where the keys land, and why.** `Overlay` already takes Escape and calls
 * `onClose`, which here is a cancel — so backing out is one key, or a click on
 * the backdrop, or Cancel. For a **confirm**, Enter is deliberately *not*
 * bound globally: it does whatever the focused button does, and focus starts
 * on **Cancel**. So Enter on a dialog the writer has not touched cancels. That
 * is the entire safety property — a `×` caught in passing followed by a
 * habitual Enter must not delete a chapter. Tab to the destructive button and
 * Enter deletes, which is a deliberate act and reads as one.
 *
 * A **prompt** is the other way round on purpose: focus starts in the text
 * field with its initial text selected, and Enter submits. Nothing a prompt
 * does is destructive — it names a thing that is about to be created — so the
 * cost of a stray Enter is a snapshot called "Snapshot", and the cost of
 * focusing Cancel would be a writer typing into a field they have to click
 * first. The safety rule is about the destructive question, not about dialogs.
 */
export function ConfirmDialog() {
  const pending = useConfirm((s) => s.pending);
  const answer = useConfirm((s) => s.answer);
  const dismiss = useConfirm((s) => s.dismiss);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
  // instead of leaving focus wherever the last one ended.
  const id = pending?.id;
  const kind = pending?.kind;
  useEffect(() => {
    if (id === undefined) return;
    const t = window.setTimeout(() => {
      if (kind === "prompt") {
        // Selected, not just focused: the initial text is a suggestion, so
        // the first keystroke should replace it and Enter alone should keep it.
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        cancelRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, [id, kind]);

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
      dismiss();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [id, dismiss]);

  if (!pending) return null;

  if (pending.kind === "prompt") {
    const { req } = pending;
    // An empty field is "the usual, please", not a request for a nameless
    // thing — so it submits the caller's fallback.
    const submit = () => {
      const typed = (inputRef.current?.value ?? "").trim();
      answer(typed || req.fallback || req.initial || "");
    };
    return (
      <Overlay title="" width={420} onClose={dismiss}>
        <div
          className="ask"
          // Enter is handled on the whole panel, not just the field. Focus
          // reaches the field on a zero timer (see above), and an Enter that
          // beats that timer lands on the panel — where, without this, it
          // would do nothing at all and the writer would press it again.
          // A focused <button> is activated by the engine, so those are left
          // alone rather than submitted twice.
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            if ((e.target as HTMLElement).tagName === "BUTTON") return;
            e.preventDefault();
            submit();
          }}
        >
          <header className="ask-head">
            <div>
              <div className="ask-title">{req.title}</div>
              {req.body && <div className="ask-sub">{req.body}</div>}
            </div>
          </header>
          <input
            // Keyed on the request, so a second prompt starts from its own
            // initial text rather than whatever the last one was left at.
            key={pending.id}
            ref={inputRef}
            className="ask-input"
            type="text"
            defaultValue={req.initial ?? ""}
            placeholder={req.placeholder}
            aria-label={req.title}
          />
          <footer className="ask-foot">
            <span className="ask-spacer" />
            <button className="ask-cancel" onClick={dismiss}>Cancel</button>
            <button className="ask-go" onClick={submit}>{req.confirmLabel}</button>
          </footer>
        </div>
      </Overlay>
    );
  }

  const { req } = pending;
  return (
    <Overlay title="" width={420} onClose={dismiss}>
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
          dismiss();
        }}
      >
        <header className="ask-head">
          <WarnIcon size={18} color={req.destructive ? "var(--danger)" : "var(--warn)"} />
          <div>
            <div className="ask-title">{req.title}</div>
            <div className="ask-sub">{req.body}</div>
          </div>
        </header>
        <footer className="ask-foot">
          <span className="ask-spacer" />
          <button ref={cancelRef} className="ask-cancel" onClick={dismiss}>
            Cancel
          </button>
          <button
            className={`ask-go${req.destructive ? " danger" : ""}`}
            onClick={() => answer(true)}
          >
            {req.confirmLabel}
          </button>
        </footer>
      </div>
    </Overlay>
  );
}
