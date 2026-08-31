// Which document the top bar's editor toolbar is driving.
//
// The toolbar used to sit inside each editor pane, so it could be handed its
// kind and path as props. It now lives in the window's top bar (SWIFT-AUDIT
// §1.3), one row above the columns, so the pane has to publish that context
// instead. Only the PRIMARY pane publishes: a split pane's toolbar would
// otherwise fight the primary's for the same one row.
import { create } from "zustand";
import type { FountainElement } from "@/lib/markdown/fountain-smart";

export type ToolbarKind = "md" | "fountain";

interface ToolbarState {
  kind: ToolbarKind | null;
  path: string | null;
  /** Screenplay only — the element under the caret, for the lit pill. */
  element: FountainElement | null;
  setContext: (kind: ToolbarKind, path: string) => void;
  setElement: (el: FountainElement | null) => void;
  /** Called by a pane's unmount; a no-op if another pane already took over. */
  clear: (path: string) => void;
}

export const useToolbar = create<ToolbarState>((set, get) => ({
  kind: null,
  path: null,
  element: null,
  setContext: (kind, path) => set({ kind, path, element: null }),
  setElement: (element) => set({ element }),
  clear: (path) => {
    if (get().path === path) set({ kind: null, path: null, element: null });
  },
}));
