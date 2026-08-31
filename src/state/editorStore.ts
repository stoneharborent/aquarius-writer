import { create } from "zustand";
import { parse, stringify } from "@/lib/frontmatter";
import { vault } from "@/lib/vault";
import { recordAutoVersion } from "@/lib/vault/aux";
import type { DocFrontMatter } from "@/types/vault";

export type SaveStatus = "clean" | "dirty" | "saving" | "saved" | "error";

interface OpenDoc {
  workflowId: string;
  path: string;
  raw: string; // full file content (with frontmatter)
  body: string;
  frontmatter: DocFrontMatter;
  status: SaveStatus;
  lastSavedAt?: number;
  /** debounce timer id */
  timer?: ReturnType<typeof setTimeout>;
}

interface EditorState {
  docs: Record<string, OpenDoc>;
  open: (workflowId: string, path: string) => Promise<void>;
  edit: (path: string, body: string) => void;
  flushSave: (path: string) => Promise<void>;
  /**
   * Save every open buffer at or under `prefix` right now — the file itself,
   * or every document inside it when `prefix` is a folder.
   *
   * The half of a rename/move that has to happen *before* the file leaves its
   * old path: a debounced save that fires afterwards would write the writer's
   * unsaved paragraph back to a path that no longer exists, quietly recreating
   * the file they just moved.
   */
  flushUnder: (prefix: string) => Promise<void>;
  /**
   * Follow a rename or move: re-key the open buffers at or under `from` to
   * their new paths. Without this a renamed document's editor is orphaned —
   * still on screen, still holding text, saving to a path nothing points at.
   *
   * Call `flushUnder(from)` first; this cancels any timer it finds, on the
   * assumption that whatever was pending has already been written.
   */
  remapPath: (from: string, to: string) => void;
  /** Drop an open doc WITHOUT saving — cancels the debounced save so a
   * pending flush can't resurrect a deleted file or clobber a restore. */
  evict: (path: string) => void;
}

/** The open document at `prefix`, plus everything inside it when it's a folder. */
function pathsUnder(docs: Record<string, OpenDoc>, prefix: string): string[] {
  return Object.keys(docs).filter((p) => p === prefix || p.startsWith(`${prefix}/`));
}

const SAVE_DEBOUNCE = 800;

export const useEditor = create<EditorState>((set, get) => ({
  docs: {},

  async open(workflowId, path) {
    if (get().docs[path]) return;
    const raw = await vault().readFile(workflowId, path);
    const parsed = parse(raw);
    set((s) => ({
      docs: {
        ...s.docs,
        [path]: {
          workflowId,
          path,
          raw,
          body: parsed.body,
          frontmatter: parsed.frontmatter,
          status: "clean",
        },
      },
    }));
  },

  edit(path, body) {
    const doc = get().docs[path];
    if (!doc) return;
    if (doc.timer) clearTimeout(doc.timer);
    const timer = setTimeout(() => {
      void get().flushSave(path);
    }, SAVE_DEBOUNCE);
    set((s) => ({
      docs: {
        ...s.docs,
        [path]: { ...doc, body, status: "dirty", timer },
      },
    }));
  },

  async flushSave(path) {
    const doc = get().docs[path];
    if (!doc) return;
    set((s) => ({ docs: { ...s.docs, [path]: { ...doc, status: "saving" } } }));
    try {
      const next = stringify(doc.frontmatter, doc.body);
      await vault().writeFile(doc.workflowId, path, next);
      // Version trail: every save records an auto version (coalesced within
      // 5 minutes) — the web mirror of the desktop SnapshotStore cadence.
      recordAutoVersion(doc.workflowId, path, next);
      set((s) => ({
        docs: {
          ...s.docs,
          [path]: { ...s.docs[path], raw: next, status: "saved", lastSavedAt: Date.now() },
        },
      }));
      // Fade to "clean" after a moment so the UI doesn't shout "saved" forever.
      setTimeout(() => {
        const d = get().docs[path];
        if (d?.status === "saved") {
          set((s) => ({ docs: { ...s.docs, [path]: { ...d, status: "clean" } } }));
        }
      }, 1200);
    } catch (e) {
      console.error("save failed:", e);
      set((s) => ({ docs: { ...s.docs, [path]: { ...s.docs[path], status: "error" } } }));
    }
  },

  async flushUnder(prefix) {
    const docs = get().docs;
    await Promise.all(
      pathsUnder(docs, prefix)
        .filter((p) => docs[p].status === "dirty" || docs[p].status === "saving")
        .map((p) => get().flushSave(p)),
    );
  },

  remapPath(from, to) {
    if (from === to) return;
    set((s) => {
      const docs = { ...s.docs };
      for (const oldPath of pathsUnder(s.docs, from)) {
        const doc = docs[oldPath];
        if (doc.timer) clearTimeout(doc.timer);
        const newPath = to + oldPath.slice(from.length);
        delete docs[oldPath];
        docs[newPath] = { ...doc, path: newPath, timer: undefined };
      }
      return { docs };
    });
  },

  evict(path) {
    const doc = get().docs[path];
    if (doc?.timer) clearTimeout(doc.timer);
    set((s) => {
      const docs = { ...s.docs };
      delete docs[path];
      return { docs };
    });
  },
}));
