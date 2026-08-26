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
  /** Drop an open doc WITHOUT saving — cancels the debounced save so a
   * pending flush can't resurrect a deleted file or clobber a restore. */
  evict: (path: string) => void;
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
