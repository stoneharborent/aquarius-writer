import { create } from "zustand";

/**
 * The app's one way of asking "are you sure?".
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
 * Only the delete gate uses this today. The three remaining `window.confirm`
 * sites (Empty trash, Purge one trash row, Restore a version) are unchanged
 * on purpose — see docs/NOTES.md §31.
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

interface ConfirmState {
  pending: (ConfirmRequest & { id: number }) | null;
  /** Ask. Resolves `true` if the writer confirmed, `false` for anything else. */
  ask: (req: ConfirmRequest) => Promise<boolean>;
  /** Answer the open request. Called by the dialog only. */
  answer: (ok: boolean) => void;
}

let nextId = 1;

export const useConfirm = create<ConfirmState>((set, get) => {
  // Held outside the store: a resolver is not state, nothing renders it, and
  // putting a function in the store would make every `set` look like it might
  // be one.
  let resolve: ((ok: boolean) => void) | null = null;

  return {
    pending: null,

    ask(req) {
      // A second question while one is open answers the first with "no". This
      // cannot happen from the UI — the dialog covers the app — but a stray
      // caller silently dropping a promise would leak an awaited delete.
      resolve?.(false);
      set({ pending: { ...req, id: nextId++ } });
      return new Promise<boolean>((r) => { resolve = r; });
    },

    answer(ok) {
      if (!get().pending) return;
      set({ pending: null });
      const r = resolve;
      resolve = null;
      r?.(ok);
    },
  };
});

/** Ask, from outside React. */
export function confirmAsk(req: ConfirmRequest): Promise<boolean> {
  return useConfirm.getState().ask(req);
}
