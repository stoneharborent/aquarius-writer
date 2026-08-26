import { create } from "zustand";

export interface Conflict {
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
