import { create } from "zustand";
import type {
  VaultNode,
  Workflow,
  WorkflowKind,
  WorkflowSummary,
} from "@/types/vault";
import { vault } from "@/lib/vault";
import { hydrateAux } from "@/lib/vault/aux";
import { notices } from "@/state/noticeStore";
import { logToShell } from "@/lib/logging";

export type EditorView = "editor" | "outline" | "corkboard";

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
  toggleExpanded: (path: string) => void;
  expandAll: (paths: string[]) => void;
  setView: (view: EditorView) => void;
  setActiveDraft: (id: string) => void;
  reorderChapters: (next: string[]) => void;
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
  });
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
      set({
        current: workflow,
        tree,
        loading: false,
        selectedPath: workflow.manuscripts[0]?.chapterOrder[0] ?? null,
        activeDraftId:
          workflow.drafts.find((d) => d.active)?.id ?? workflow.drafts[0]?.id ?? null,
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
    set({ current: null, tree: null, selectedPath: null });
  },

  async refreshTree() {
    const id = get().current?.id;
    if (!id) return;
    try {
      const { workflow, tree } = await vault().loadWorkflow(id);
      // Deliberately narrow: the selection, the view mode and the open editors
      // all survive an external edit. Only the tree and the metadata change.
      set({ current: workflow, tree });
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

  setActiveDraft(id) { set({ activeDraftId: id }); },

  reorderChapters(next) {
    const cur = get().current;
    if (!cur || cur.manuscripts.length === 0) return;
    const updated: Workflow = {
      ...cur,
      manuscripts: cur.manuscripts.map((m, i) =>
        i === 0 ? { ...m, chapterOrder: next } : m,
      ),
      drafts: cur.drafts.map((d) =>
        d.id === get().activeDraftId ? { ...d, chapterOrder: next } : d,
      ),
    };
    set({ current: updated });
  },
}));
