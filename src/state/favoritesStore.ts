import { create } from "zustand";
import {
  listFavorites,
  migrateFavorites,
  refreshFavorites,
  setFavorite,
} from "@/lib/vault/aux";
import { notices } from "@/state/noticeStore";

/**
 * Starred rows — the reactive half of favorites.
 *
 * Where they *live* is `.aquarius/favorites.json` (localStorage in the browser
 * preview), reached through the aux seam. That layer is deliberately
 * synchronous and cache-shaped, which is right for a render-time read but
 * cannot tell React that a star changed. So this store holds the same set as
 * component state and writes through: the sidebar subscribes here, and the
 * only thing it ever has to know is `has(path)`.
 *
 * A separate store rather than a slice of `vaultStore` because the lifetime is
 * different: stars belong to the aux layer beside comments and versions, they
 * are hydrated with them, and nothing in the tree-patching logic needs to know
 * they exist.
 */
interface FavoritesState {
  /** Which workflow `starred` describes. Null before one is open. */
  workflowId: string | null;
  starred: Set<string>;

  /** Adopt a workflow's stars. Called right after the aux hydration. */
  load: (workflowId: string) => void;
  /** Re-read from disk — an MCP client's `toggle_star` lands this way. */
  refresh: () => Promise<void>;
  /** Forget everything (the workflow closed). */
  clear: () => void;
  /** Flip one row's star. */
  toggle: (path: string) => Promise<void>;
  /**
   * A row was renamed or moved: its star follows it, and so do the stars of
   * everything inside it when it is a folder.
   */
  remap: (from: string, to: string) => Promise<void>;
  /**
   * Drop `path` and everything under it, without a write.
   *
   * For the paths that already dealt with the star on the backend — trashing a
   * row does it in the same Rust call — where a second write would be a
   * pointless round trip.
   */
  forget: (path: string) => void;
}

/** `path` and its descendants, gone from `set`. Returns null if nothing moved. */
function without(set: Set<string>, path: string): Set<string> | null {
  const prefix = `${path}/`;
  const next = new Set([...set].filter((p) => p !== path && !p.startsWith(prefix)));
  return next.size === set.size ? null : next;
}

export const useFavorites = create<FavoritesState>((set, get) => ({
  workflowId: null,
  starred: new Set(),

  load(workflowId) {
    set({ workflowId, starred: new Set(listFavorites(workflowId)) });
  },

  async refresh() {
    const wf = get().workflowId;
    if (!wf) return;
    try {
      set({ starred: new Set(await refreshFavorites(wf)) });
    } catch (e) {
      // A star that did not reload is a cosmetic staleness, not something to
      // interrupt the writer over.
      console.error("could not reload the starred list:", e);
    }
  },

  clear() {
    set({ workflowId: null, starred: new Set() });
  },

  async toggle(path) {
    const wf = get().workflowId;
    if (!wf) return;
    // Optimistic: a star should feel instant. The backend's answer is the
    // truth and replaces this a moment later either way.
    const before = get().starred;
    const guess = new Set(before);
    if (guess.has(path)) guess.delete(path);
    else guess.add(path);
    set({ starred: guess });

    try {
      const now = await setFavorite(wf, path);
      const settled = new Set(get().starred);
      if (now) settled.add(path);
      else settled.delete(path);
      set({ starred: settled });
    } catch (e) {
      set({ starred: before });
      notices.fail("Could not save that star", e);
    }
  },

  async remap(from, to) {
    const wf = get().workflowId;
    if (!wf || from === to) return;
    const prefix = `${from}/`;
    // Paint the move immediately, then take the store's answer — which is what
    // is actually on disk after the backend migrated it.
    set({
      starred: new Set(
        [...get().starred].map((p) =>
          p === from ? to : p.startsWith(prefix) ? to + p.slice(from.length) : p,
        ),
      ),
    });
    try {
      set({ starred: new Set(await migrateFavorites(wf, from, to)) });
    } catch (e) {
      console.error("stars did not follow the move:", e);
    }
  },

  forget(path) {
    const next = without(get().starred, path);
    if (next) set({ starred: next });
  },
}));
