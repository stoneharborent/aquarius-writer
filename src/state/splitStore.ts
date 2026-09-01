// Split editors — the web mirror of the desktop split (SWIFT-AUDIT §2.1):
// two documents side by side, **both fully editable**, each with its own
// caret, scroll, undo history and autosave, separated by a draggable divider,
// with a subtle accent line marking which of the two the writer is in.
//
// The secondary pane can also be put in **Reference mode**, which is the
// read-only pane Swift keeps as a separate right-pane mode
// (`ReferencePane.swift`). The port keeps both behaviours on one mechanism:
// the same split, with a toggle in the secondary pane's slim header.
//
// What this store does NOT do: hold text. Both panes read and write the same
// `editorStore` buffers, keyed by path, so a document open in the split is an
// ordinary open document — same 800ms debounce, same conflict guard, same
// session word-count trail. This store only says *which* document is beside
// the primary, how wide it is, which pane is active, and whether it is
// editable.
import { create } from "zustand";

/** Neither pane is ever squeezed below this by a divider drag. */
export const SPLIT_MIN = 320;
/** Half and half — what double-clicking the divider goes back to. */
export const SPLIT_DEFAULT_RATIO = 0.5;

/**
 * Persisted the way every other pane geometry in the app is (shellStore's
 * `aquarius.*` keys, mirroring Swift's UserDefaults).
 */
const RATIO_KEY = "aquarius.split.ratio";

/** Fraction of the editor column the PRIMARY pane gets. Clamped on read. */
function readRatio(): number {
  try {
    const raw = localStorage.getItem(RATIO_KEY);
    if (raw === null) return SPLIT_DEFAULT_RATIO;
    const n = Number(raw);
    if (!Number.isFinite(n)) return SPLIT_DEFAULT_RATIO;
    return Math.min(0.9, Math.max(0.1, n));
  } catch {
    return SPLIT_DEFAULT_RATIO;
  }
}

function writeRatio(r: number) {
  try { localStorage.setItem(RATIO_KEY, String(r)); } catch { /* private mode */ }
}

/** Kill floating-point crumbs — the ratio is read back and multiplied out. */
const round4 = (n: number) => Math.round(n * 10000) / 10000;

export type SplitPane = "primary" | "secondary";

interface SplitState {
  secondaryPath: string | null;
  /** Reference mode: the secondary pane is read-only. */
  reference: boolean;
  /**
   * Which pane the writer is in. Drives the accent line, the top bar's
   * toolbar and, through it, where a format command lands.
   *
   * Always `"primary"` while nothing is in the split — there is no second
   * pane to be active in.
   */
  active: SplitPane;
  /** Primary pane's share of the editor column, 0.1–0.9. */
  ratio: number;

  openSplit: (path: string, reference?: boolean) => void;
  closeSplit: () => void;
  setReference: (on: boolean) => void;
  setActive: (pane: SplitPane) => void;
  setRatio: (r: number) => void;
  resetRatio: () => void;
}

export const useSplit = create<SplitState>((set) => ({
  secondaryPath: null,
  reference: false,
  active: "primary",
  ratio: readRatio(),

  // Opening the split moves the writer into it — they asked for that document,
  // so that is the pane the caret and the toolbar should belong to.
  openSplit: (path, reference = false) =>
    set({ secondaryPath: path, reference, active: "secondary" }),

  closeSplit: () => set({ secondaryPath: null, reference: false, active: "primary" }),

  setReference: (on) => set({ reference: on }),

  setActive: (pane) =>
    set((s) => {
      // A pane that is not on screen cannot be active.
      const next = pane === "secondary" && !s.secondaryPath ? "primary" : pane;
      return next === s.active ? s : { active: next };
    }),

  setRatio: (r) => {
    const next = round4(Math.min(0.9, Math.max(0.1, r)));
    writeRatio(next);
    set({ ratio: next });
  },

  resetRatio: () => {
    writeRatio(SPLIT_DEFAULT_RATIO);
    set({ ratio: SPLIT_DEFAULT_RATIO });
  },
}));
