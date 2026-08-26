import { create } from "zustand";
import type {
  VaultNode,
  Workflow,
  WorkflowSummary,
} from "@/types/vault";
import { vault } from "@/lib/vault";
import { hydrateAux } from "@/lib/vault/aux";

export type EditorView = "editor" | "outline" | "corkboard";

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

  // actions
  bootstrap: () => Promise<void>;
  fetchWorkflows: () => Promise<void>;
  openWorkflow: (id: string) => Promise<void>;
  closeWorkflow: () => void;
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
        await get().openWorkflow(w.id);
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
    }
  },

  async openWorkflow(id) {
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
