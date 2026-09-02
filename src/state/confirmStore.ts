import { create } from "zustand";

/**
 * The app's one way of asking the writer something mid-action — "are you
 * sure?", and "what should this be called?".
 *
 * Before this store the answer was `window.confirm`, which the webview draws
 * itself: a system alert in a system font, in the wrong palette, with buttons
 * the app cannot label or focus. That last part is why this exists at all. A
 * `window.confirm` puts focus on OK, so a writer who deletes a chapter by
 * catching the `×` on the way past, and then taps Enter out of habit, has
 * confirmed the delete without reading a word of it. The whole point of a gate
 * is that the accidental press cannot walk straight through it.
 *
 * Shaped like `conflictStore`: one pending request, a component in
 * `components/safety` that renders it, and a single instance mounted in App.
 * `ask()` hands back a promise so a caller reads top to bottom —
 *
 *     if (!(await ask({ ... }))) return;
 *
 * — rather than splitting itself across a callback.
 *
 * Every confirmation in the app comes through here: the delete gate, Empty
 * trash, Purge one trash row, and Restore a version. There is no
 * `window.confirm` left in `src/`, and there must not be one — inside the app
 * it is not a confirm at all. `tauri-plugin-dialog` injects a script that
 * replaces `window.confirm` with an **async** function, so it hands back a
 * pending Promise, a Promise is truthy, and `if (!window.confirm(…)) return;`
 * never returns. The three gates it guarded were open for months. NOTES §31f.
 *
 * `askText()` is the same machinery asking for a *string* instead of a yes/no,
 * and it is here rather than in a store of its own so that the two questions
 * share one pending slot, one `Overlay` mount and one Escape handler — two
 * dialogs listening for Escape on `window` is the bug §31f had to fix once
 * already. It replaces the last `window.prompt`, which `tauri-plugin-dialog`
 * does *not* shim: it fell through to a raw WebKitGTK modal titled
 * "JavaScript - http://localhost:1420/", which worked and looked like nothing
 * else in the app. NOTES §31h.
 */
export interface ConfirmRequest {
  /** The question, as a sentence. e.g. `Delete “Ch_03.md”?` */
  title: string;
  /** What will actually happen, in plain language. */
  body: string;
  /** Label for the button that says yes. */
  confirmLabel: string;
  /** Destructive styling on the confirm button. */
  destructive?: boolean;
}

export interface PromptRequest {
  /** The ask, as a sentence. e.g. `Name this snapshot` */
  title: string;
  /** Optional line under the title, in plain language. */
  body?: string;
  /** Greyed hint inside the empty field. */
  placeholder?: string;
  /** What the field starts with, selected, so typing replaces it. */
  initial?: string;
  /** Label for the button that submits. */
  confirmLabel: string;
  /**
   * What an empty field means. Submitting nothing is a writer saying "the
   * usual, please", not a writer asking for a version called "". Defaults to
   * `initial`.
   */
  fallback?: string;
}

/** One slot, either question. The dialog switches on `kind`. */
export type Pending =
  | { kind: "confirm"; id: number; req: ConfirmRequest }
  | { kind: "prompt"; id: number; req: PromptRequest };

interface ConfirmState {
  pending: Pending | null;
  /** Ask. Resolves `true` if the writer confirmed, `false` for anything else. */
  ask: (req: ConfirmRequest) => Promise<boolean>;
  /** Ask for a string. Resolves the text, or `null` if the writer backed out. */
  askText: (req: PromptRequest) => Promise<string | null>;
  /** Answer the open request. Called by the dialog only. */
  answer: (value: boolean | string) => void;
  /**
   * Back out of the open request — Escape, the backdrop, Cancel. Called by the
   * dialog only. It exists because "no" is a different value for each kind
   * (`false` / `null`) and only the store should know which.
   */
  dismiss: () => void;
}

let nextId = 1;

export const useConfirm = create<ConfirmState>((set, get) => {
  // Held outside the store: a resolver is not state, nothing renders it, and
  // putting a function in the store would make every `set` look like it might
  // be one. `cancelValue` rides along with it for the same reason.
  let resolve: ((value: never) => void) | null = null;
  let cancelValue: boolean | string | null = false;

  /**
   * Open a request, closing any open one with its own "no".
   *
   * A second question while one is open answers the first with "no". This
   * cannot happen from the UI — the dialog covers the app — but a stray caller
   * silently dropping a promise would leak an awaited delete.
   */
  function open<T>(pending: Pending, cancel: boolean | string | null): Promise<T> {
    (resolve as ((v: unknown) => void) | null)?.(cancelValue);
    cancelValue = cancel;
    set({ pending });
    return new Promise<T>((r) => { resolve = r as (value: never) => void; });
  }

  return {
    pending: null,

    ask(req) {
      return open<boolean>({ kind: "confirm", id: nextId++, req }, false);
    },

    askText(req) {
      return open<string | null>({ kind: "prompt", id: nextId++, req }, null);
    },

    answer(value) {
      if (!get().pending) return;
      set({ pending: null });
      const r = resolve as ((v: unknown) => void) | null;
      resolve = null;
      r?.(value);
    },

    dismiss() {
      if (!get().pending) return;
      set({ pending: null });
      const r = resolve as ((v: unknown) => void) | null;
      resolve = null;
      r?.(cancelValue);
    },
  };
});

/** Ask, from outside React. */
export function confirmAsk(req: ConfirmRequest): Promise<boolean> {
  return useConfirm.getState().ask(req);
}

/** Ask for a string, from outside React. */
export function promptAsk(req: PromptRequest): Promise<string | null> {
  return useConfirm.getState().askText(req);
}
