import { create } from "zustand";

/**
 * A document whose file changed on disk while the writer had unsaved edits.
 *
 * Raised in exactly two places, both in `editorStore`: a guarded save the
 * backend refused, and the file watcher noticing the change first. Whichever
 * gets there, nothing has been written and nothing has been thrown away —
 * `resolveConflict` decides which version survives, and snapshots the other.
 */
export interface Conflict {
  /** Which vault. A conflict outlives a workflow switch; the path alone would not. */
  workflowId: string;
  path: string;
  /** What's in the editor right now (user's unsaved edits) */
  mine: string;
  /** What's on disk now (changed externally) */
  theirs: string;
  /** When the conflict was detected */
  at: number;
}

interface ConflictState {
  pending: Conflict | null;
  raise: (c: Conflict) => void;
  resolve: () => void;
}

export const useConflict = create<ConflictState>((set) => ({
  pending: null,
  raise: (c) => set({ pending: c }),
  resolve: () => set({ pending: null }),
}));
