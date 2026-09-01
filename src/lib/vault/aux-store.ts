// Where version history, comments, trash and saved searches actually live.
//
// Two backends behind one interface, chosen the same way the vault service is:
//
//  • **browser** — localStorage, for the `npm run dev` preview on sample data.
//  • **disk** — `.aquarius/` inside the vault, via Rust commands. This is the
//    real one. A writer's version trail belongs to the folder it describes, so
//    it travels with the work instead of being stranded in a WebView profile.
//
// The disk backend keeps a synchronous in-memory cache because the public aux
// API (`listVersions`, `listComments`, `listTrash`) is synchronous and is
// called during render. The cache is filled once per workflow by `hydrate()`
// — see `openWorkflow` in the vault store — and every mutation writes through
// to disk immediately.

import { invoke } from "@tauri-apps/api/core";
import { vault } from "@/lib/vault";

export interface VersionEntry {
  id: string;
  at: number;
  label: string;
  named: boolean;
  words: number;
  body: string;
}

export interface CommentEntry {
  id: string;
  at: number;
  anchor: string;
  text: string;
  resolved: boolean;
}

export interface TrashEntry {
  id: string;
  path: string;
  deletedAt: number;
  body: string;
}

export interface AuxBackend {
  /** Load a workflow's aux state. No-op for localStorage. */
  hydrate(wf: string): Promise<void>;
  listVersions(wf: string, path: string): VersionEntry[];
  saveVersions(wf: string, path: string, list: VersionEntry[]): void;
  listComments(wf: string, path: string): CommentEntry[];
  saveComments(wf: string, path: string, list: CommentEntry[]): void;
  listTrash(wf: string): TrashEntry[];
  /** Soft-delete a file. `body` is the captured text, for backends that need it. */
  trashFile(wf: string, path: string, body: string): Promise<void>;
  restoreTrash(wf: string, id: string): Promise<string | null>;
  purgeTrash(wf: string, id: string): void;
  /**
   * Destroy every deletion. Resolves to how many went.
   *
   * This is the *only* bulk destruction in the app, and since 2026-08-31 the
   * only thing that empties the trash at all — the 30-day sweep that used to
   * run on workflow load is gone (SWIFT-AUDIT §4, NOTES §24c). Callers confirm
   * first; this does not ask.
   */
  emptyTrash(wf: string): Promise<number>;
  /**
   * How old a deletion has to be before the sheet calls it old. Display only —
   * nothing expires by itself. Resolves from the backend so the number has one
   * home (`fs_ops::trash::RETENTION_DAYS`).
   */
  trashRetentionDays(): Promise<number>;
  listSearches(wf: string): string[];
  saveSearches(wf: string, list: string[]): void;
  /**
   * Starred rows, sorted. Synchronous like the rest of this API: the sidebar
   * paints a star during render.
   */
  listFavorites(wf: string): string[];
  /**
   * Re-read the starred list from the source of truth.
   *
   * The renderer is not the only writer — an MCP client's `toggle_star` edits
   * `favorites.json` behind the app's back — so the cache needs a way to catch
   * up when the vault changes underneath it.
   */
  refreshFavorites(wf: string): Promise<string[]>;
  /**
   * Star or unstar one path; `starred` omitted means flip it. Resolves to the
   * state it landed in.
   */
  setFavorite(wf: string, path: string, starred?: boolean): Promise<boolean>;
  /**
   * A row moved from `from` to `to` — bring its star (and, for a folder, the
   * stars underneath it) along. Resolves to the list as it now stands.
   *
   * On disk the Rust rename/move already did this, so that backend only has to
   * catch its cache up; in the browser preview this is the migration itself.
   */
  migrateFavorites(wf: string, from: string, to: string): Promise<string[]>;
}

// ── browser: localStorage ────────────────────────────────────────────────

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLS(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage full / disabled — features degrade to session-only */ }
}

const VKEY = (wf: string, path: string) => `aq.versions.${wf}.${path}`;
const CKEY = (wf: string, path: string) => `aq.comments.${wf}.${path}`;
const TKEY = (wf: string) => `aq.trash.${wf}`;
const SKEY = (wf: string) => `aq.searches.${wf}`;
const FKEY = (wf: string) => `aq.favorites.${wf}`;

/** Sorted, duplicate-free — the same shape `favorites.json` keeps on disk. */
function normaliseFavorites(list: string[]): string[] {
  return [...new Set(list.filter(Boolean))].sort();
}

function createBrowserAuxBackend(): AuxBackend {
  return {
    async hydrate() { /* localStorage is already "loaded" */ },
    listVersions: (wf, path) => readLS<VersionEntry[]>(VKEY(wf, path), []),
    saveVersions: (wf, path, list) => writeLS(VKEY(wf, path), list),
    listComments: (wf, path) => readLS<CommentEntry[]>(CKEY(wf, path), []),
    saveComments: (wf, path, list) => writeLS(CKEY(wf, path), list),
    listTrash: (wf) => readLS<TrashEntry[]>(TKEY(wf), []),

    async trashFile(wf, path, body) {
      const all = readLS<TrashEntry[]>(TKEY(wf), []);
      all.unshift({ id: `t${Date.now().toString(36)}`, path, deletedAt: Date.now(), body });
      writeLS(TKEY(wf), all);
      await vault().softDelete(wf, path);
    },

    async restoreTrash(wf, id) {
      const all = readLS<TrashEntry[]>(TKEY(wf), []);
      const entry = all.find((t) => t.id === id);
      if (!entry) return null;
      await vault().writeFile(wf, entry.path, entry.body);
      writeLS(TKEY(wf), all.filter((t) => t.id !== id));
      return entry.path;
    },

    purgeTrash(wf, id) {
      writeLS(TKEY(wf), readLS<TrashEntry[]>(TKEY(wf), []).filter((t) => t.id !== id));
    },

    async emptyTrash(wf) {
      const n = readLS<TrashEntry[]>(TKEY(wf), []).length;
      writeLS(TKEY(wf), []);
      return n;
    },

    // The preview has no Rust to ask, so it repeats the number. Nothing acts
    // on it in either backend — the cost of drift here is a mislabelled row in
    // a browser mock.
    async trashRetentionDays() { return 30; },

    listSearches: (wf) => readLS<string[]>(SKEY(wf), []),
    saveSearches: (wf, list) => writeLS(SKEY(wf), list),

    // Favorites in the preview are per-browser rather than per-vault, which is
    // the same bargain every other aux store makes here: the sample workflow
    // has no `.aquarius/` to write into.
    listFavorites: (wf) => normaliseFavorites(readLS<string[]>(FKEY(wf), [])),

    async refreshFavorites(wf) {
      return normaliseFavorites(readLS<string[]>(FKEY(wf), []));
    },

    async setFavorite(wf, path, starred) {
      const current = normaliseFavorites(readLS<string[]>(FKEY(wf), []));
      const next = starred ?? !current.includes(path);
      writeLS(
        FKEY(wf),
        next ? normaliseFavorites([...current, path]) : current.filter((p) => p !== path),
      );
      return next;
    },

    async migrateFavorites(wf, from, to) {
      const prefix = `${from}/`;
      const next = normaliseFavorites(
        readLS<string[]>(FKEY(wf), []).map((p) =>
          p === from ? to : p.startsWith(prefix) ? to + p.slice(from.length) : p,
        ),
      );
      writeLS(FKEY(wf), next);
      return next;
    },
  };
}

// ── desktop: .aquarius/ on disk ──────────────────────────────────────────

interface AuxSnapshot {
  versions: Record<string, VersionEntry[]>;
  comments: Record<string, CommentEntry[]>;
  trash: TrashEntry[];
  searches: string[];
  favorites: string[];
}

/** `wf` + `path` as one map key. NUL (\\0) can't occur in either. */
const docKey = (wf: string, path: string) => `${wf}\0${path}`;

function createDiskAuxBackend(): AuxBackend {
  const versions = new Map<string, VersionEntry[]>();
  const comments = new Map<string, CommentEntry[]>();
  const trash = new Map<string, TrashEntry[]>();
  const searches = new Map<string, string[]>();
  const favorites = new Map<string, string[]>();
  const hydrated = new Set<string>();

  /** Log and swallow: a failed metadata write must never break a save. */
  const bg = (what: string, p: Promise<unknown>) => {
    void p.catch((e) => console.error(`aux ${what} failed:`, e));
  };

  const refreshTrash = async (wf: string) => {
    trash.set(wf, await invoke<TrashEntry[]>("aux_trash_list", { workflowId: wf }));
  };

  return {
    async hydrate(wf) {
      const snap = await invoke<AuxSnapshot>("aux_hydrate", { workflowId: wf });
      for (const [path, list] of Object.entries(snap.versions ?? {})) {
        versions.set(docKey(wf, path), list);
      }
      for (const [path, list] of Object.entries(snap.comments ?? {})) {
        comments.set(docKey(wf, path), list);
      }
      trash.set(wf, snap.trash ?? []);
      searches.set(wf, snap.searches ?? []);
      favorites.set(wf, snap.favorites ?? []);
      hydrated.add(wf);
    },

    listVersions: (wf, path) => versions.get(docKey(wf, path)) ?? [],

    saveVersions(wf, path, list) {
      versions.set(docKey(wf, path), list);
      bg("saveVersions", invoke("aux_save_versions", { workflowId: wf, relPath: path, entries: list }));
    },

    listComments: (wf, path) => comments.get(docKey(wf, path)) ?? [],

    saveComments(wf, path, list) {
      comments.set(docKey(wf, path), list);
      bg("saveComments", invoke("aux_save_comments", { workflowId: wf, relPath: path, entries: list }));
    },

    listTrash: (wf) => trash.get(wf) ?? [],

    async trashFile(wf, path) {
      // The file itself moves into `.aquarius/trash/`; the Rust side owns the
      // index, so the captured body is not needed here.
      await vault().softDelete(wf, path);
      await refreshTrash(wf);
    },

    async restoreTrash(wf, id) {
      const restored = await invoke<string | null>("trash_restore", { workflowId: wf, id });
      await refreshTrash(wf);
      return restored;
    },

    purgeTrash(wf, id) {
      trash.set(wf, (trash.get(wf) ?? []).filter((t) => t.id !== id));
      bg("purgeTrash", invoke("trash_purge", { workflowId: wf, id }));
    },

    // Awaited, not backgrounded like the single purge: emptying the trash is
    // the one action here a writer might close the app straight after, and it
    // is also the one whose failure they need to hear about.
    async emptyTrash(wf) {
      const n = await invoke<number>("trash_empty", { workflowId: wf });
      await refreshTrash(wf);
      return n;
    },

    trashRetentionDays: () => invoke<number>("trash_retention_days"),

    listSearches: (wf) => searches.get(wf) ?? [],

    saveSearches(wf, list) {
      searches.set(wf, list);
      bg("saveSearches", invoke("aux_save_searches", { workflowId: wf, queries: list }));
    },

    listFavorites: (wf) => favorites.get(wf) ?? [],

    async refreshFavorites(wf) {
      const list = await invoke<string[]>("vault_list_stars", { workflowId: wf });
      favorites.set(wf, list);
      return list;
    },

    // Unlike the other writers this one is awaited, not fire-and-forget: the
    // Rust side owns the read-modify-write (an MCP client may be starring
    // things at the same moment), so its answer is the truth about the state
    // the row ended in.
    async setFavorite(wf, path, starred) {
      const report = await invoke<{ path: string; starred: boolean }>("vault_set_star", {
        workflowId: wf,
        relPath: path,
        starred: starred ?? null,
      });
      const current = favorites.get(wf) ?? [];
      favorites.set(
        wf,
        report.starred
          ? normaliseFavorites([...current, path])
          : current.filter((p) => p !== path),
      );
      return report.starred;
    },

    async migrateFavorites(wf) {
      // `vault::ops::rename_entry` / `move_entry` migrated favorites.json in
      // the same call that moved the file — all that is left is to catch the
      // cache up with what is already on disk.
      const list = await invoke<string[]>("vault_list_stars", { workflowId: wf });
      favorites.set(wf, list);
      return list;
    },
  };
}

let _backend: AuxBackend | null = null;

export function auxBackend(): AuxBackend {
  if (_backend) return _backend;
  const inTauri = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
  _backend = inTauri ? createDiskAuxBackend() : createBrowserAuxBackend();
  return _backend;
}
