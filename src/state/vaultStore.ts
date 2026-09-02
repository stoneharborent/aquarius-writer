import { create } from "zustand";
import type { StoreApi } from "zustand";
import type {
  EntryReport,
  NewFileKind,
  VaultNode,
  Workflow,
  WorkflowKind,
  WorkflowSummary,
} from "@/types/vault";
import { vault } from "@/lib/vault";
import { hydrateAux } from "@/lib/vault/aux";
import { notices } from "@/state/noticeStore";
import { logToShell } from "@/lib/logging";
import { useEditor } from "@/state/editorStore";
import { useSplit } from "@/state/splitStore";
import { useFavorites } from "@/state/favoritesStore";
import { useSessions } from "@/state/sessionsStore";
import { DEFAULT_GOAL } from "@/lib/vault/sessions";

/**
 * What the editor column is showing.
 *
 * `home` is the ManuscriptHome grid (PARITY row 8) — the vault's manuscripts as
 * cards. It sits behind the sidebar's Manuscript quick view (⌘2), which is
 * where the Swift audit's silence left the decision to us: the audit names
 * ManuscriptHome and says it is a home screen, but not what opens it. Putting
 * it on the entry that already means "the manuscript" keeps one door instead
 * of inventing a second (docs/NOTES.md §30).
 */
export type EditorView = "editor" | "home" | "outline" | "corkboard";

/// Which welcome-screen action is in flight. "picking" is the one that can sit
/// there a long time: it means a native folder dialog is open somewhere, and on
/// Linux "somewhere" has been known to mean *behind the window*.
export type PendingAction = "picking" | "creating" | "sample" | "opening";

interface VaultState {
  // workflow index
  workflows: WorkflowSummary[];
  workflowsLoading: boolean;

  // current
  current: Workflow | null;
  tree: VaultNode | null;
  loading: boolean;
  error: string | null;

  // selection
  selectedPath: string | null;
  expanded: Set<string>;

  // view mode for the editor pane
  view: EditorView;
  activeDraftId: string | null;
  /**
   * Which manuscript the outline, the corkboard and the chapter rail are of.
   *
   * A vault can have several — a book and its novella, each a marked folder —
   * and until row 8 every surface silently meant `manuscripts[0]`. Null when
   * the workflow has none.
   */
  activeManuscriptId: string | null;

  /// True once `bootstrap` has FINISHED. The welcome screen renders only
  /// after a boot attempt opened nothing (empty index, or every candidate
  /// failed to load) — so it never flashes while the launch workflow loads.
  booted: boolean;

  /// What the welcome screen is waiting on, so a click always visibly does
  /// something. Null when nothing is pending.
  pending: PendingAction | null;

  // actions
  bootstrap: () => Promise<void>;
  fetchWorkflows: () => Promise<void>;
  /** `quiet` suppresses the failure toast — boot uses it, clicks do not. */
  openWorkflow: (id: string, opts?: { quiet?: boolean }) => Promise<void>;
  closeWorkflow: () => void;
  /// Pick a folder and open it as a workflow. False when nothing opened —
  /// either the writer dismissed the picker or it failed (and said so).
  addWorkflowFromFolder: () => Promise<boolean>;
  /// Open a folder the writer typed the path of.
  addWorkflowByPath: (path: string) => Promise<boolean>;
  /// Make a new workflow folder and open it.
  createWorkflow: (name: string, kind: WorkflowKind) => Promise<boolean>;
  /// Write the sample workflow to disk and open it.
  openSampleWorkflow: () => Promise<boolean>;
  /** Re-read the open workflow's tree from disk, keeping the current
   * selection and view. Called by the file watcher. */
  refreshTree: () => Promise<void>;
  selectPath: (path: string | null) => void;
  /** Drop a node from the in-memory tree (after a soft-delete). */
  removeFromTree: (path: string) => void;
  /** Re-insert a restored file into the tree, creating parent folders. */
  addToTree: (path: string) => void;
  /**
   * Make a document inside `parent` ("" for the vault root) and open it.
   * Resolves to its path, or null when it could not be made (the reason is
   * already on screen as a notice).
   *
   * `content` replaces the seeded frontmatter with text of your own, and
   * `open: false` leaves the writer where they are — the two things the
   * conflict dialog's "Save mine as a copy" needs, and nothing else uses.
   */
  createFile: (
    parent: string,
    name: string,
    kind: NewFileKind,
    opts?: { content?: string; open?: boolean },
  ) => Promise<string | null>;
  /** Make an empty folder inside `parent` ("" for the vault root). */
  createFolder: (parent: string, name: string) => Promise<string | null>;
  /** Rename a tree row in place. `newName` is one name, never a path. */
  renameEntry: (path: string, newName: string) => Promise<string | null>;
  /** Move a tree row into another folder ("" for the vault root). */
  moveEntry: (path: string, destFolder: string) => Promise<string | null>;
  toggleExpanded: (path: string) => void;
  expandAll: (paths: string[]) => void;
  setView: (view: EditorView) => void;
  /** Open one manuscript's outline — what a ManuscriptHome card does. */
  openManuscript: (id: string) => void;
  /**
   * Make one draft the working draft, and *keep* it: the flag is written to
   * `workflow.json` through the same `ops::set_active_draft` the MCP
   * `set_active_draft` tool calls, so the choice survives a relaunch.
   */
  setActiveDraft: (id: string) => Promise<void>;
  /**
   * Mark a folder as a manuscript, or unmark it — the sidebar row's ⋯ menu.
   * Resolves to true when the mark is now on.
   */
  toggleManuscriptFolder: (path: string) => Promise<boolean>;
  /** Mark a folder inside a manuscript as an alternate cut, or unmark it. */
  toggleDraftFolder: (path: string) => Promise<boolean>;
  /**
   * Write a chapter's `synopsis` frontmatter — the corkboard card, edited in
   * place. Never a whole-file write from here: the backend does frontmatter
   * surgery, and any open buffer for that file is flushed first and reconciled
   * afterwards so the writer's unsaved text is neither lost nor fought over.
   */
  setSynopsis: (path: string, synopsis: string) => Promise<void>;
  /**
   * Rearrange the manuscript's chapters — and *keep* the arrangement.
   *
   * Painted immediately, then written to `.aquarius/workflow.json` through the
   * same `vault::ops::reorder_chapters` the MCP `reorder_chapters` tool calls.
   * A refused write puts the old order back and says so, because a rail that
   * silently forgets a drag is worse than one that never offered it
   * (docs/PARITY.md row 10).
   */
  reorderChapters: (next: string[]) => Promise<void>;
  /** Set the vault's daily word goal — the Today panel's ring is editable. */
  setDailyGoal: (dailyWords: number) => Promise<void>;
}

/// Last workflow the user had open — so the app launches straight back into
/// it instead of the welcome screen. Cleared when they deliberately close a
/// workflow ("← workflows"), so the next launch picks from the index rather
/// than reopening the one they just left. The welcome screen is reachable
/// in-session via that button; a fresh launch always enters a workflow.
const LAST_WORKFLOW_KEY = "aq.lastWorkflow";
/// Re-entrancy guard for `bootstrap` — React StrictMode double-invokes mount
/// effects in dev, and `booted` only flips when the attempt finishes.
let bootStarted = false;
function readLastWorkflow(): string | null {
  try { return localStorage.getItem(LAST_WORKFLOW_KEY); } catch { return null; }
}
function writeLastWorkflow(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_WORKFLOW_KEY, id);
    else localStorage.removeItem(LAST_WORKFLOW_KEY);
  } catch { /* private mode / storage disabled — boot falls back to the index */ }
}

/// The live filesystem subscription for whichever workflow is open. Exactly
/// one at a time: opening another workflow (or closing this one) disposes it.
/// The app's own saves don't come back through here — the backend suppresses
/// its own writes — so this only fires for edits made outside Aquarius.
let unwatch: (() => void) | null = null;

function stopWatching() {
  unwatch?.();
  unwatch = null;
}

function startWatching(id: string) {
  stopWatching();
  unwatch = vault().watch(id, () => {
    void useVault.getState().refreshTree();
    // The tree is only half of what changed. Every open buffer now has to
    // check itself against the file it came from: a clean one quietly takes
    // the new text, a dirty one raises the conflict dialog rather than
    // waiting to discover the problem at save time (docs/PARITY.md row 9).
    void useEditor.getState().reconcile(id);
  });
}

// ── patching the tree after a create / rename / move ─────────────────────
//
// The backend answers each of those with an `EntryReport` — where the entry is
// now, what to call it, what kind it is, and where it came from. That is
// deliberately enough to edit the tree in place: a full `loadWorkflow` would
// re-read every file in the vault to redraw one row, and would throw away the
// writer's expanded folders on the way past.

const cloneTree = (n: VaultNode): VaultNode => ({ ...n, children: n.children?.map(cloneTree) });

/** Folders first, then files, each case-insensitive — the backend's order. */
function sortChildren(node: VaultNode) {
  node.children?.sort((a, b) => {
    const ad = a.kind === "folder" ? 0 : 1;
    const bd = b.kind === "folder" ? 0 : 1;
    return ad - bd || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

function findFolder(node: VaultNode, path: string): VaultNode | null {
  if (node.kind === "folder" && node.path === path) return node;
  for (const child of node.children ?? []) {
    const hit = findFolder(child, path);
    if (hit) return hit;
  }
  return null;
}

/** Remove the node at `path` from the tree and hand it back, subtree intact. */
function detachNode(node: VaultNode, path: string): VaultNode | null {
  if (!node.children) return null;
  const i = node.children.findIndex((c) => c.path === path);
  if (i >= 0) return node.children.splice(i, 1)[0];
  for (const child of node.children) {
    const hit = detachNode(child, path);
    if (hit) return hit;
  }
  return null;
}

/** Rewrite a moved subtree's paths: everything under `from` now lives at `to`. */
function repath(node: VaultNode, from: string, to: string) {
  if (node.path === from || node.path.startsWith(`${from}/`)) {
    node.path = to + node.path.slice(from.length);
  }
  for (const child of node.children ?? []) repath(child, from, to);
}

/** Find a node by path — the tree is small enough that a walk is honest. */
function findInTree(node: VaultNode, path: string): VaultNode | null {
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const hit = findInTree(child, path);
    if (hit) return hit;
  }
  return null;
}

/** A copy of the tree with one frontmatter key set on one node. */
function withFrontmatter(tree: VaultNode, path: string, key: string, value: string): VaultNode {
  const walk = (n: VaultNode): VaultNode =>
    n.path === path
      ? { ...n, frontmatter: { ...n.frontmatter, [key]: value } }
      : { ...n, children: n.children?.map(walk) };
  return walk(tree);
}

const parentPathOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/** Every ancestor folder path of `path`, so the tree can be opened to it. */
function ancestorsOf(path: string): string[] {
  const segments = path.split("/").slice(0, -1);
  return segments.map((_, i) => segments.slice(0, i + 1).join("/"));
}

/** Apply one `EntryReport` to a tree, returning a new one. */
function applyEntry(tree: VaultNode, report: EntryReport): VaultNode {
  const root = cloneTree(tree);
  let node = report.from ? detachNode(root, report.from) : null;
  if (node && report.from) repath(node, report.from, report.path);
  if (!node) {
    node = { name: report.name, path: report.path, kind: report.kind };
    if (report.kind === "folder") node.children = [];
  }
  node.name = report.name;
  node.kind = report.kind;
  node.path = report.path;

  const parent = findFolder(root, parentPathOf(report.path)) ?? root;
  parent.children = parent.children ?? [];
  if (!parent.children.some((c) => c.path === node.path)) parent.children.push(node);
  sortChildren(parent);
  return root;
}

/** `path`, if it sat at or inside `from`, rewritten to its new home. */
const followed = (path: string | null, from: string, to: string) =>
  path && (path === from || path.startsWith(`${from}/`)) ? to + path.slice(from.length) : path;

/** The manifest addresses chapters by path too — keep it in step. */
function followInWorkflow(wf: Workflow, from: string, to: string): Workflow {
  const at = (p: string) => followed(p, from, to) ?? p;
  return {
    ...wf,
    manuscripts: wf.manuscripts.map((m) => ({
      ...m,
      folder: at(m.folder),
      chapterOrder: m.chapterOrder.map(at),
    })),
    drafts: wf.drafts.map((d) => ({ ...d, chapterOrder: d.chapterOrder.map(at) })),
  };
}

type SetVault = StoreApi<VaultState>["setState"];
type GetVault = StoreApi<VaultState>["getState"];

/**
 * The shared body of rename and move.
 *
 * A path is not just a row in the tree: it is also the key of an open editor
 * buffer, the current selection, the split pane's document, a set of expanded
 * folders, and the manuscript's chapter order. All of them follow the file, in
 * one `set` — anything left pointing at the old path would be an editor
 * writing to a file that no longer exists.
 */
async function applyRelocation(
  set: SetVault,
  get: GetVault,
  path: string,
  run: (workflowId: string) => Promise<EntryReport>,
  failure: string,
): Promise<string | null> {
  const wf = get().current;
  if (!wf || !get().tree) return null;
  try {
    // Unsaved text belongs to the old path, and only the old path exists right
    // now. A debounced save landing after the move would recreate the file the
    // writer just moved away.
    await useEditor.getState().flushUnder(path);

    const report = await run(wf.id);
    const to = report.path;
    if (to === path) return path;

    useEditor.getState().remapPath(path, to);
    void useFavorites.getState().remap(path, to);

    const split = useSplit.getState();
    const secondary = followed(split.secondaryPath, path, to);
    if (secondary !== split.secondaryPath) {
      if (secondary) split.openSplit(secondary, split.reference);
      else split.closeSplit();
    }

    const tree = get().tree;
    const current = get().current;
    set({
      tree: tree ? applyEntry(tree, report) : tree,
      current: current ? followInWorkflow(current, path, to) : current,
      selectedPath: followed(get().selectedPath, path, to),
      expanded: new Set([...get().expanded].map((p) => followed(p, path, to) ?? p)),
    });

    if (report.renamed) {
      notices.say(`Saved as "${report.name}"`, "that name was already taken in that folder");
    }
    return to;
  } catch (e) {
    notices.fail(failure, e);
    return null;
  }
}

export const useVault = create<VaultState>((set, get) => ({
  workflows: [],
  workflowsLoading: false,
  booted: false,
  pending: null,
  current: null,
  tree: null,
  loading: false,
  error: null,
  selectedPath: null,
  expanded: new Set(["Drafts", "Characters", "Worldbuilding", "Research"]),
  view: "editor",
  activeDraftId: null,
  activeManuscriptId: null,

  /// Launch straight into a workflow: the last one open, else the index's
  /// active/first entry that actually loads. Only falls through to the
  /// welcome screen when nothing opens.
  async bootstrap() {
    if (bootStarted || get().current) return;
    bootStarted = true;
    try {
      await get().fetchWorkflows();
      const list = get().workflows;
      const last = readLastWorkflow();
      const candidates = [
        ...(last ? list.filter((w) => w.id === last) : []),
        ...list.filter((w) => w.active && w.id !== last),
        ...list.filter((w) => !w.active && w.id !== last),
      ];
      for (const w of candidates) {
        await get().openWorkflow(w.id, { quiet: true });
        // Opened: drop any error left by an earlier candidate that failed.
        if (get().current) { set({ error: null }); return; }
      }
    } finally {
      set({ booted: true });
    }
  },

  async fetchWorkflows() {
    set({ workflowsLoading: true });
    try {
      const workflows = await vault().listWorkflows();
      set({ workflows, workflowsLoading: false });
    } catch (e) {
      set({ workflowsLoading: false, error: (e as Error).message });
      notices.fail("Could not read the list of workflows", e);
    }
  },

  /// Open the native folder picker and take whatever it gives us.
  async addWorkflowFromFolder() {
    if (get().pending) return false;
    set({ pending: "picking" });
    try {
      const summary = await vault().addWorkflowFromFolder();
      // Null is a dismissed dialog, which is not a failure and gets no toast.
      if (!summary) return false;
      await get().fetchWorkflows();
      await get().openWorkflow(summary.id);
      return get().current?.id === summary.id;
    } catch (e) {
      notices.fail("Could not open that folder", e);
      return false;
    } finally {
      set({ pending: null });
    }
  },

  async addWorkflowByPath(path) {
    if (get().pending) return false;
    set({ pending: "opening" });
    try {
      const summary = await vault().addWorkflowByPath(path);
      await get().fetchWorkflows();
      await get().openWorkflow(summary.id);
      return get().current?.id === summary.id;
    } catch (e) {
      notices.fail("Could not open that path", e);
      return false;
    } finally {
      set({ pending: null });
    }
  },

  async createWorkflow(name, kind) {
    if (get().pending) return false;
    set({ pending: "creating" });
    try {
      const summary = await vault().createWorkflow(name, kind);
      if (!summary) return false;
      await get().fetchWorkflows();
      await get().openWorkflow(summary.id);
      return get().current?.id === summary.id;
    } catch (e) {
      notices.fail("Could not create the workflow", e);
      return false;
    } finally {
      set({ pending: null });
    }
  },

  /// "Try the sample" — writes a real folder of Markdown to disk and opens it.
  /// Before v0.1.1 this asked the backend for a workflow called "lantern",
  /// which only ever existed in the browser mock, so the click failed with a
  /// message nothing rendered.
  async openSampleWorkflow() {
    if (get().pending) return false;
    set({ pending: "sample" });
    try {
      const summary = await vault().createSampleWorkflow();
      await get().fetchWorkflows();
      await get().openWorkflow(summary.id);
      const opened = get().current?.id === summary.id;
      if (opened) notices.say("Sample workflow ready", summary.path);
      return opened;
    } catch (e) {
      notices.fail("Could not set up the sample workflow", e);
      return false;
    } finally {
      set({ pending: null });
    }
  },

  async openWorkflow(id, opts) {
    const quiet = opts?.quiet === true;
    set({ loading: true, error: null });
    try {
      const { workflow, tree } = await vault().loadWorkflow(id);
      // Version history, comments and trash for this workflow. Awaited so the
      // panels that read them synchronously have data on first render.
      try {
        await hydrateAux(workflow.id);
      } catch (e) {
        console.error("aux state failed to load:", e);
      }
      // After the hydration, never before it: the starred list arrives with the
      // rest of the aux snapshot.
      useFavorites.getState().load(workflow.id);
      // Today's words and the last fortnight. Not awaited — the panel is an
      // overlay nobody is looking at yet, and a vault should open at the speed
      // of its tree.
      void useSessions
        .getState()
        .load(workflow.id, workflow.goals?.dailyWords ?? DEFAULT_GOAL);
      set({
        current: workflow,
        tree,
        loading: false,
        selectedPath: workflow.manuscripts[0]?.chapterOrder[0] ?? null,
        activeDraftId:
          workflow.drafts.find((d) => d.active)?.id ?? workflow.drafts[0]?.id ?? null,
        activeManuscriptId: workflow.manuscripts[0]?.id ?? null,
        view: "editor",
      });
      writeLastWorkflow(workflow.id);
      startWatching(workflow.id);
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
      // Boot tries every remembered workflow in turn and the ones that fail are
      // ordinary — a vault on an unplugged drive, a folder that got moved. Only
      // a workflow the writer just asked for is worth interrupting them about.
      if (quiet) logToShell("error", `could not open workflow ${id}:`, e);
      else notices.fail("Could not open that workflow", e);
    }
  },

  closeWorkflow() {
    stopWatching();
    writeLastWorkflow(null);
    useFavorites.getState().clear();
    useSessions.getState().clear();
    set({ current: null, tree: null, selectedPath: null });
  },

  async refreshTree() {
    const id = get().current?.id;
    if (!id) return;
    try {
      const { workflow, tree } = await vault().loadWorkflow(id);
      // Deliberately narrow: the selection, the view mode and the open editors
      // all survive an external edit. Only the tree and the metadata change —
      // plus the two manifest cursors, which have to stay pointing at records
      // that still exist (an MCP client can unmark the manuscript you are
      // looking at).
      const manuscriptId = workflow.manuscripts.some((m) => m.id === get().activeManuscriptId)
        ? get().activeManuscriptId
        : workflow.manuscripts[0]?.id ?? null;
      const draftId = workflow.drafts.some((d) => d.id === get().activeDraftId)
        ? get().activeDraftId
        : workflow.drafts.find((d) => d.active)?.id ?? workflow.drafts[0]?.id ?? null;
      set({ current: workflow, tree, activeManuscriptId: manuscriptId, activeDraftId: draftId });
      // The tree reloading is also how an MCP client's `toggle_star` reaches
      // the sidebar — the tool emits the same change event a file edit does.
      void useFavorites.getState().refresh();
      // `workflow.json` may have been edited by hand while the app was open.
      useSessions.getState().setGoal(workflow.goals?.dailyWords ?? DEFAULT_GOAL);
    } catch (e) {
      console.error("tree refresh failed:", e);
    }
  },

  selectPath(path) {
    set({ selectedPath: path });
  },

  removeFromTree(path) {
    const prune = (node: VaultNode): VaultNode => ({
      ...node,
      children: node.children
        ?.filter((c) => c.path !== path)
        .map(prune),
    });
    const tree = get().tree;
    if (!tree) return;
    const next = prune(tree);
    // The split pane is a second selection and it follows the same rule: a
    // pane left holding a trashed file is an editor writing to nothing.
    if (useSplit.getState().secondaryPath === path) useSplit.getState().closeSplit();
    set({
      tree: next,
      selectedPath: get().selectedPath === path ? null : get().selectedPath,
    });
  },

  addToTree(path) {
    const tree = get().tree;
    if (!tree) return;
    const kind = /\.fountain$/i.test(path) ? "fountain"
      : /\.md$/i.test(path) ? "markdown"
      : /\.(jpe?g|png|gif|webp|svg)$/i.test(path) ? "image"
      : /\.pdf$/i.test(path) ? "pdf" : "other";
    const segs = path.split("/");
    const clone = (n: VaultNode): VaultNode => ({ ...n, children: n.children?.map(clone) });
    const root = clone(tree);
    let cursor = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const folderPath = segs.slice(0, i + 1).join("/");
      cursor.children = cursor.children ?? [];
      let folder = cursor.children.find((c) => c.path === folderPath && c.kind === "folder");
      if (!folder) {
        folder = { name: segs[i], path: folderPath, kind: "folder", children: [] };
        cursor.children.push(folder);
      }
      cursor = folder;
    }
    cursor.children = cursor.children ?? [];
    if (!cursor.children.some((c) => c.path === path)) {
      cursor.children.push({ name: segs[segs.length - 1], path, kind });
    }
    set({ tree: root });
  },

  async createFile(parent, name, kind, opts) {
    const wf = get().current;
    const tree = get().tree;
    if (!wf || !tree) return null;
    try {
      const report = await vault().createFile(wf.id, parent, name, kind);
      // Given text of its own, the file is written over the seed the backend
      // laid down. Unguarded on purpose: it was created a line ago and there
      // is nothing there yet to disagree with.
      if (opts?.content !== undefined) {
        await vault().writeFile(wf.id, report.path, opts.content, null);
      }
      set({ tree: applyEntry(tree, report) });
      get().expandAll(ancestorsOf(report.path));
      // A new document opens in the editor — making a file and then having to
      // find it in the tree would be a strange way to start writing.
      if (opts?.open !== false) set({ selectedPath: report.path, view: "editor" });
      if (report.renamed) {
        notices.say(`Created "${report.name}"`, "a file of that name was already there");
      }
      return report.path;
    } catch (e) {
      notices.fail("Could not create that file", e);
      return null;
    }
  },

  async createFolder(parent, name) {
    const wf = get().current;
    const tree = get().tree;
    if (!wf || !tree) return null;
    try {
      const report = await vault().createFolder(wf.id, parent, name);
      set({ tree: applyEntry(tree, report) });
      get().expandAll([...ancestorsOf(report.path), report.path]);
      if (report.renamed) {
        notices.say(`Created "${report.name}"`, "a folder of that name was already there");
      }
      return report.path;
    } catch (e) {
      notices.fail("Could not create that folder", e);
      return null;
    }
  },

  async renameEntry(path, newName) {
    return applyRelocation(set, get, path, (wf) => vault().rename(wf, path, newName),
      "Could not rename that");
  },

  async moveEntry(path, destFolder) {
    return applyRelocation(set, get, path, (wf) => vault().move(wf, path, destFolder),
      "Could not move that");
  },

  toggleExpanded(path) {
    const next = new Set(get().expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    set({ expanded: next });
  },

  expandAll(paths) {
    const next = new Set(get().expanded);
    paths.forEach((p) => next.add(p));
    set({ expanded: next });
  },

  setView(view) { set({ view }); },

  openManuscript(id) { set({ activeManuscriptId: id, view: "outline" }); },

  async setActiveDraft(id) {
    const cur = get().current;
    if (!cur) return;
    const previous = get().activeDraftId;
    if (previous === id) return;
    // Painted first: switching cuts should feel like a click, not a save.
    set({
      activeDraftId: id,
      current: {
        ...cur,
        drafts: cur.drafts.map((d) => ({ ...d, active: d.id === id ? true : undefined })),
      },
    });
    try {
      await vault().setActiveDraft(cur.id, id);
    } catch (e) {
      if (get().current?.id === cur.id) {
        set({
          activeDraftId: previous,
          current: {
            ...get().current!,
            drafts: cur.drafts.map((d) => ({
              ...d,
              active: d.id === previous ? true : undefined,
            })),
          },
        });
      }
      notices.fail("Could not switch the working draft", e);
    }
  },

  async toggleManuscriptFolder(path) {
    const cur = get().current;
    if (!cur) return false;
    try {
      const report = await vault().toggleManuscriptFolder(cur.id, path);
      const now = get().current;
      if (!now || now.id !== cur.id) return report.marked;
      // The report is exactly what the backend wrote, so the manifest is
      // patched from it rather than re-walking the whole vault. The watcher
      // will not fight this: `save_workflow` stamps the self-write ledger, so
      // the app's own write never comes back as an external change.
      const next: Workflow = report.marked
        ? {
            ...now,
            manuscripts: [
              ...now.manuscripts,
              {
                id: report.id!,
                title: path.split("/").pop() ?? path,
                folder: path,
                chapterOrder: report.chapters,
              },
            ],
          }
        : {
            ...now,
            manuscripts: now.manuscripts.filter((m) => m.folder !== path),
            drafts: now.drafts.filter((d) => !d.folder?.startsWith(`${path}/`)),
          };
      set({
        current: next,
        activeManuscriptId: next.manuscripts.some((m) => m.id === get().activeManuscriptId)
          ? get().activeManuscriptId
          : next.manuscripts[0]?.id ?? null,
        activeDraftId: next.drafts.some((d) => d.id === get().activeDraftId)
          ? get().activeDraftId
          : next.drafts[0]?.id ?? null,
      });
      notices.say(
        report.marked ? `"${path}" is a manuscript` : `"${path}" is no longer a manuscript`,
        report.marked
          ? `${report.chapters.length} chapter${report.chapters.length === 1 ? "" : "s"} in it`
          : "the mark came off — nothing on disk changed",
      );
      return report.marked;
    } catch (e) {
      notices.fail("Could not change that folder's manuscript mark", e);
      return false;
    }
  },

  async toggleDraftFolder(path) {
    const cur = get().current;
    if (!cur) return false;
    try {
      const report = await vault().toggleDraftFolder(cur.id, path);
      const now = get().current;
      if (!now || now.id !== cur.id) return report.marked;
      const next: Workflow = report.marked
        ? {
            ...now,
            drafts: [
              ...now.drafts,
              {
                id: report.id!,
                name: path.split("/").pop() ?? path,
                chapterOrder: report.chapters,
                folder: path,
              },
            ],
          }
        : { ...now, drafts: now.drafts.filter((d) => d.folder !== path) };
      set({
        current: next,
        activeDraftId: next.drafts.some((d) => d.id === get().activeDraftId)
          ? get().activeDraftId
          : next.drafts[0]?.id ?? null,
      });
      notices.say(
        report.marked ? `"${path}" is a draft` : `"${path}" is no longer a draft`,
        report.marked
          ? `${report.chapters.length} chapter${report.chapters.length === 1 ? "" : "s"} in this cut`
          : "the mark came off — nothing on disk changed",
      );
      return report.marked;
    } catch (e) {
      notices.fail("Could not change that folder's draft mark", e);
      return false;
    }
  },

  async setSynopsis(path, synopsis) {
    const cur = get().current;
    const tree = get().tree;
    if (!cur || !tree) return;
    const node = findInTree(tree, path);
    if (((node?.frontmatter?.synopsis as string | undefined) ?? "") === synopsis) return;
    try {
      // Unsaved text in that document belongs to the writer, and the backend is
      // about to rewrite the file's frontmatter underneath it. Flush first, and
      // reconcile after, so the open buffer ends up holding the file that now
      // exists rather than raising a conflict against a change the writer made
      // themselves (docs/NOTES.md §20).
      await useEditor.getState().flushUnder(path);
      await vault().setSynopsis(cur.id, path, synopsis);
      const live = get().tree;
      if (live && get().current?.id === cur.id) {
        set({ tree: withFrontmatter(live, path, "synopsis", synopsis) });
      }
      void useEditor.getState().reconcile(cur.id);
    } catch (e) {
      notices.fail("Could not save that synopsis", e);
    }
  },

  async reorderChapters(next) {
    const cur = get().current;
    if (!cur || cur.manuscripts.length === 0) return;
    const manuscript =
      cur.manuscripts.find((m) => m.id === get().activeManuscriptId) ?? cur.manuscripts[0];
    const previous = manuscript.chapterOrder;

    // Which drafts follow is the backend's rule, mirrored here so the screen
    // and `workflow.json` never disagree: a draft that was showing the
    // manuscript's own order follows it, a draft the writer has re-cut keeps
    // its own shape.
    const mirrors = (order: string[]) =>
      order.length === previous.length && order.every((p, i) => p === previous[i]);
    const withOrder = (base: Workflow, order: string[]): Workflow => ({
      ...base,
      manuscripts: base.manuscripts.map((m) =>
        m.id === manuscript.id ? { ...m, chapterOrder: order } : m,
      ),
      drafts: base.drafts.map((d) => (mirrors(d.chapterOrder) ? { ...d, chapterOrder: order } : d)),
    });

    set({ current: withOrder(cur, next) });
    try {
      const report = await vault().reorderChapters(cur.id, next, manuscript.id);
      if (get().current?.id !== cur.id) return;
      set({ current: withOrder(cur, report.order) });
    } catch (e) {
      // Nothing was written, so the screen has to go back to what is on disk.
      if (get().current?.id === cur.id) set({ current: withOrder(cur, previous) });
      notices.fail("Could not save the new chapter order", e);
    }
  },

  async setDailyGoal(dailyWords) {
    const cur = get().current;
    if (!cur) return;
    const previous = cur.goals;
    const goal = Math.round(dailyWords);
    if (!Number.isFinite(goal) || goal <= 0) return;

    set({ current: { ...cur, goals: { ...previous, dailyWords: goal } } });
    useSessions.getState().setGoal(goal);
    try {
      const goals = await vault().setDailyGoal(cur.id, goal);
      if (get().current?.id !== cur.id) return;
      set({ current: { ...get().current!, goals } });
      useSessions.getState().setGoal(goals.dailyWords);
    } catch (e) {
      if (get().current?.id === cur.id) {
        set({ current: { ...get().current!, goals: previous } });
        useSessions.getState().setGoal(previous.dailyWords);
      }
      notices.fail("Could not save the daily goal", e);
    }
  },
}));
