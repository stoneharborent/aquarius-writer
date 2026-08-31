import { create } from "zustand";
import { parse, stringify } from "@/lib/frontmatter";
import { vault } from "@/lib/vault";
import { recordAutoVersion, takeSnapshot } from "@/lib/vault/aux";
import { useConflict } from "@/state/conflictStore";
import { notices } from "@/state/noticeStore";
import type { DocFrontMatter, FileStamp } from "@/types/vault";

export type SaveStatus = "clean" | "dirty" | "saving" | "saved" | "error" | "conflict";

interface OpenDoc {
  workflowId: string;
  path: string;
  raw: string; // full file content (with frontmatter)
  body: string;
  frontmatter: DocFrontMatter;
  status: SaveStatus;
  lastSavedAt?: number;
  /**
   * The file as it was when this buffer last agreed with the disk — set on
   * open and after every successful save.
   *
   * This is the whole conflict mechanism (docs/PARITY.md row 9). Every save
   * carries it, and the backend refuses the write if what is on disk has
   * stopped matching. Undefined only while a document is being opened.
   */
  baseline?: FileStamp;
  /** debounce timer id */
  timer?: ReturnType<typeof setTimeout>;
}

/** Which version of a conflicted document to keep. */
export type Resolution = "keepMine" | "takeTheirs" | "saveMineAsCopy";

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
  /**
   * The vault changed on disk. Check every open buffer against it: a clean one
   * quietly reloads, a dirty one raises the conflict dialog.
   *
   * This is the Swift trigger (SWIFT-AUDIT §2.3) — the writer is told the
   * moment the file moves under them, not eight hundred milliseconds later
   * when their next keystroke happens to save.
   */
  reconcile: (workflowId: string) => Promise<void>;
  /**
   * Apply one of the three answers the conflict dialog offers.
   *
   * Whichever version a choice discards is written into the document's version
   * history *first*, so "nothing is lost" is literally true and the writer can
   * be told where the other one went.
   */
  resolveConflict: (path: string, choice: Resolution) => Promise<void>;
}

/** The open document at `prefix`, plus everything inside it when it's a folder. */
function pathsUnder(docs: Record<string, OpenDoc>, prefix: string): string[] {
  return Object.keys(docs).filter((p) => p === prefix || p.startsWith(`${prefix}/`));
}

const SAVE_DEBOUNCE = 800;

/** The exact text a buffer would write: frontmatter block plus body. */
function serialize(doc: OpenDoc): string {
  return stringify(doc.frontmatter, doc.body);
}

/** A document with unsaved text in it — the state a conflict matters in. */
function isDirty(doc: OpenDoc): boolean {
  return doc.status === "dirty" || doc.status === "error" || doc.status === "conflict";
}

/**
 * `Drafts/Ch_03.md` → `Drafts/Ch_03.conflict.md`, and the kind to create it as.
 *
 * The Swift app writes `*.conflict.md` (SWIFT-AUDIT §2.3); a screenplay keeps
 * its own extension instead, because a `.fountain` file renamed to `.md` stops
 * opening in the screenplay editor. De-duplication is the backend's job — a
 * second unresolved conflict lands on "Ch_03.conflict 2.md".
 */
function conflictCopyName(path: string): { parent: string; name: string; kind: "markdown" | "fountain" } {
  const slash = path.lastIndexOf("/");
  const parent = slash < 0 ? "" : path.slice(0, slash);
  const file = slash < 0 ? path : path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const kind = /\.fountain$/i.test(file) ? "fountain" : "markdown";
  return { parent, name: `${stem}.conflict`, kind };
}

export const useEditor = create<EditorState>((set, get) => ({
  docs: {},

  async open(workflowId, path) {
    if (get().docs[path]) return;
    const { content, stamp } = await vault().readFileStamped(workflowId, path);
    const parsed = parse(content);
    set((s) => ({
      docs: {
        ...s.docs,
        [path]: {
          workflowId,
          path,
          raw: content,
          body: parsed.body,
          frontmatter: parsed.frontmatter,
          status: "clean",
          baseline: stamp,
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
      const next = serialize(doc);
      // The baseline is what makes this a *guarded* save. Without one — a
      // buffer opened before this shipped, or one whose baseline was cleared
      // by a "Keep mine" — the write behaves exactly as it always did.
      const result = await vault().writeFile(doc.workflowId, path, next, doc.baseline);

      if (result.status === "conflict") {
        // Nothing was written. The buffer keeps every character the writer
        // typed; the dialog decides what happens to it.
        set((s) => ({ docs: { ...s.docs, [path]: { ...s.docs[path], status: "conflict" } } }));
        useConflict.getState().raise({
          workflowId: doc.workflowId,
          path,
          mine: next,
          theirs: result.theirs,
          at: Date.now(),
        });
        return;
      }

      // Version trail: every save records an auto version (coalesced within
      // 5 minutes) — the web mirror of the desktop SnapshotStore cadence.
      recordAutoVersion(doc.workflowId, path, next);
      set((s) => ({
        docs: {
          ...s.docs,
          [path]: {
            ...s.docs[path],
            raw: next,
            baseline: result.stamp,
            status: "saved",
            lastSavedAt: Date.now(),
          },
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

  async reconcile(workflowId) {
    // One conflict dialog at a time; the rest wait for the next event.
    if (useConflict.getState().pending) return;

    for (const [path, doc] of Object.entries(get().docs)) {
      if (doc.workflowId !== workflowId || !doc.baseline) continue;
      // A save that is in flight is about to move the baseline itself, and
      // reading disk underneath it would compare the new bytes against the
      // old stamp — a conflict with ourselves.
      if (doc.status === "saving") continue;

      let read;
      try {
        read = await vault().readFileStamped(workflowId, path);
      } catch {
        // Trashed, renamed, or on a drive that just went away. The tree
        // reload that arrives with this event is what handles that.
        continue;
      }
      // Everything below is judged on the buffer as it is *now*, not as it was
      // when the loop started: a save may have finished during the read and
      // moved the baseline on, or raised a dialog of its own.
      const live = get().docs[path];
      if (!live || !live.baseline || live.status === "saving") continue;
      if (read.stamp.hash === live.baseline.hash) continue;
      if (useConflict.getState().pending) return;

      if (!isDirty(live)) {
        // Clean buffer: nothing of the writer's to lose, so take the new text
        // silently. This is what an MCP client's edit looks like from here.
        const parsed = parse(read.content);
        set((s) => ({
          docs: {
            ...s.docs,
            [path]: {
              ...s.docs[path],
              raw: read.content,
              body: parsed.body,
              frontmatter: parsed.frontmatter,
              baseline: read.stamp,
              status: "clean",
            },
          },
        }));
        continue;
      }

      // Dirty buffer and a file that moved: ask, now, rather than waiting for
      // the next keystroke's save to discover it.
      if (live.timer) clearTimeout(live.timer);
      set((s) => ({
        docs: { ...s.docs, [path]: { ...s.docs[path], timer: undefined, status: "conflict" } },
      }));
      useConflict.getState().raise({
        workflowId,
        path,
        mine: serialize(live),
        theirs: read.content,
        at: Date.now(),
      });
      return;
    }
  },

  async resolveConflict(path, choice) {
    const doc = get().docs[path];
    const pending = useConflict.getState().pending;
    if (!doc || !pending || pending.path !== path) return;
    const { workflowId } = doc;
    const mine = pending.mine;
    const theirs = pending.theirs;
    const v = vault();

    /** Put `content` in the buffer and re-baseline it on `stamp`. */
    const load = (content: string, stamp: FileStamp | undefined, status: SaveStatus) => {
      const parsed = parse(content);
      set((s) => ({
        docs: {
          ...s.docs,
          [path]: {
            ...s.docs[path],
            raw: content,
            body: parsed.body,
            frontmatter: parsed.frontmatter,
            baseline: stamp,
            status,
            lastSavedAt: Date.now(),
          },
        },
      }));
    };

    if (choice === "takeTheirs") {
      // Discards the writer's unsaved text, so it is snapshotted first.
      takeSnapshot(workflowId, path, "Mine, before taking the disk version", mine);
      const stamped = await v.readFileStamped(workflowId, path);
      load(stamped.content, stamped.stamp, "clean");
      notices.say("Opened the version from disk", "yours is in Versions, as “Mine, before taking the disk version”");
      return;
    }

    if (choice === "saveMineAsCopy") {
      // Nothing is lost here: mine goes to a new file, theirs stays where it
      // is and becomes the buffer. So no snapshot — the copy *is* the record.
      const { parent, name, kind } = conflictCopyName(path);
      const copy = await writeConflictCopy(workflowId, parent, name, kind, mine);
      const stamped = await v.readFileStamped(workflowId, path);
      load(stamped.content, stamped.stamp, "clean");
      if (copy) notices.say("Your version was saved beside it", copy);
      return;
    }

    // keepMine — the writer's text wins and the disk version is overwritten,
    // so *that* is what gets snapshotted.
    takeSnapshot(workflowId, path, "Theirs, before keeping mine", theirs);
    // No baseline: this is the deliberate force-write. The buffer picks up the
    // stamp of what it just wrote, so the next ordinary save is guarded again.
    const result = await v.writeFile(workflowId, path, mine, null);
    recordAutoVersion(workflowId, path, mine);
    load(mine, result.status === "written" ? result.stamp : undefined, "clean");
    notices.say("Kept your version", "theirs is in Versions, as “Theirs, before keeping mine”");
  },
}));

/**
 * Make the `.conflict` copy through the vault store, so the sidebar's tree
 * gains the row the same way it would for any other new file.
 *
 * Imported lazily: `vaultStore` imports this module, and a static import back
 * would be a cycle. Resolves to the copy's path, or null if it could not be
 * written — in which case "Keep mine" is still available and nothing is lost.
 */
async function writeConflictCopy(
  workflowId: string,
  parent: string,
  name: string,
  kind: "markdown" | "fountain",
  content: string,
): Promise<string | null> {
  try {
    const { useVault } = await import("@/state/vaultStore");
    const store = useVault.getState();
    if (store.current?.id === workflowId) {
      return store.createFile(parent, name, kind, { content, open: false });
    }
    // A workflow that is no longer open still gets its copy, just without the
    // tree patch — there is no tree to patch.
    const report = await vault().createFile(workflowId, parent, name, kind);
    await vault().writeFile(workflowId, report.path, content, null);
    return report.path;
  } catch (e) {
    console.error("could not save the conflict copy:", e);
    return null;
  }
}
