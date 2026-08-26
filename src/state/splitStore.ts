// Split editors — web mirror of the desktop SplitEditorStore: a secondary
// pane beside the primary, optionally in read-only "reference" mode
// (ReferencePane.swift semantics).
import { create } from "zustand";

interface SplitState {
  secondaryPath: string | null;
  /** Reference mode: the secondary pane is read-only. */
  reference: boolean;
  openSplit: (path: string, reference?: boolean) => void;
  closeSplit: () => void;
  setReference: (on: boolean) => void;
}

export const useSplit = create<SplitState>((set) => ({
  secondaryPath: null,
  reference: false,
  openSplit: (path, reference = false) => set({ secondaryPath: path, reference }),
  closeSplit: () => set({ secondaryPath: null, reference: false }),
  setReference: (on) => set({ reference: on }),
}));
