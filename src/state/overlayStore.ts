import { create } from "zustand";

export type OverlayKind =
  | "palette"
  | "compile"
  | "today"
  | "settings"
  | "graph"
  | "cheatsheet"
  | "find"
  | "trash"
  | "version-diff"
  | "screenplay-preview"
  | null;

/** Optional per-overlay payload (e.g. which version to diff). */
export interface OverlayPayload {
  path?: string;
  versionId?: string;
  /**
   * Which tab a multi-tab overlay should land on. Settings uses it so
   * "Manage workflows…" opens on Workflows instead of on Appearance.
   */
  tab?: string;
}

interface OverlayState {
  active: OverlayKind;
  payload: OverlayPayload;
  open: (kind: Exclude<OverlayKind, null>, payload?: OverlayPayload) => void;
  close: () => void;
  toggle: (kind: Exclude<OverlayKind, null>) => void;
}

export const useOverlay = create<OverlayState>((set, get) => ({
  active: null,
  payload: {},
  open: (kind, payload = {}) => set({ active: kind, payload }),
  close: () => set({ active: null, payload: {} }),
  toggle: (kind) => set({ active: get().active === kind ? null : kind }),
}));
