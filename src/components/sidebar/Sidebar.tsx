import {
  BookIcon,
  Caret,
  CheckIcon,
  FileIcon,
  FolderIcon,
  ImageIcon,
  PdfIcon,
  PlusIcon,
  ScreenplayIcon,
  SparkleIcon,
  StarIcon,
} from "@/icons";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, DragEvent as ReactDragEvent } from "react";
import type { ChapterStatus, NewFileKind, NodeKind, VaultNode } from "@/types/vault";
import { useVault } from "@/state/vaultStore";
import { useTreeUi } from "@/state/treeUiStore";
import { useOverlay } from "@/state/overlayStore";
import { useShell, ZOOM_MAX, ZOOM_MIN } from "@/state/shellStore";
import { useFavorites } from "@/state/favoritesStore";
import { useSplit } from "@/state/splitStore";
import { trashFile } from "@/lib/vault/aux";
import { confirmAsk } from "@/state/confirmStore";
import { useEditor } from "@/state/editorStore";
import { EmptyState } from "@/components/shell/EmptyState";
import "./Sidebar.css";

const STATUS_COLOR: Record<ChapterStatus, string> = {
  final: "var(--success)",
  drafting: "var(--starred)",
  rev: "var(--warn)",
  outline: "var(--ink-mute)",
};

/** What a new file or folder is being made in, and which composer is showing. */
interface Composer {
  what: "file" | "folder";
  /** Destination folder, "" for the vault root. */
  parent: string;
}

/**
 * What every tree row needs and none of them should ask for twice.
 *
 * Two fields only, and both change roughly never: the folder list the "Move
 * to…" menu offers, and the manuscript/draft marks. Everything that changes
 * *often* — the open menu, the rename, the drag — was in here too and is now in
 * `treeUiStore`, because a context value is one identity shared by all sixteen
 * rows and re-renders every one of them on any change (docs/NOTES.md §27n).
 * What is left is stable enough that a row can read it for free.
 */
interface TreeOps {
  /** Every folder path in the workflow, for the "Move to…" list. */
  folders: string[];
  /**
   * Which folders carry a manuscript or draft mark, so a row can say so
   * without every row subscribing to the manifest separately (PARITY row 8).
   */
  roleOf: (path: string) => "manuscript" | "draft" | null;
}

const TreeOpsContext = createContext<TreeOps | null>(null);
const useTreeOps = () => useContext(TreeOpsContext)!;

/** How long a closed folder has to be hovered before it springs open. */
const SPRING_MS = 700;

/** One spring-open timer, because only one folder can be under the pointer. */
let spring: { folder: string; id: number } | null = null;

function cancelSpring() {
  if (spring) {
    window.clearTimeout(spring.id);
    spring = null;
  }
}

/**
 * Dragging a row onto a folder to move it there.
 *
 * The same `moveEntry` the row's "Move to…" menu calls, so there is exactly one
 * move path in the app: `vault_move` → `EntryReport` → `applyRelocation`, with
 * open buffers, the selection, the split pane, stars and chapter order all
 * following the file. Nothing here writes to disk itself.
 *
 * Deliberately *not* here: reordering rows inside a folder (chapter order is
 * the manuscript rail's job, and the tree is sorted folders-then-name), and
 * dragging in or out of the OS file manager (PARITY row 6).
 *
 * **A module constant rather than a hook.** This used to be `useTreeDrag()`,
 * which returned a fresh object of fresh closures on every Sidebar render and
 * handed it to every row through the context — one new identity was enough to
 * re-render all sixteen rows whatever `React.memo` said. The callbacks are the
 * same six functions for the life of the app now; the *state* they read lives
 * in `treeUiStore`, so a row can select the one boolean about itself.
 */
const treeDrag = {
  /**
   * Whether `folder` is somewhere the in-flight drag could actually land.
   *
   * The three refusals, in the UI so the writer sees them rather than finding
   * out from a failure notice. The backend refuses the first two as well —
   * `ops::move_entry` on the Rust side, `relocate` in the browser mock — this
   * is the same rule drawn.
   */
  allows(folder: string): boolean {
    const path = useTreeUi.getState().dragPath;
    if (path === null) return false;
    if (folder === path) return false;                    // a folder into itself
    if (folder.startsWith(`${path}/`)) return false;      // …or into its own descendant
    if (folder === parentOf(path)) return false;          // already there: a no-op
    return true;
  },

  begin(path: string) {
    cancelSpring();
    const ui = useTreeUi.getState();
    ui.setDragPath(path);
    ui.setDragInto(null);
  },

  end() {
    cancelSpring();
    const ui = useTreeUi.getState();
    ui.setDragPath(null);
    ui.setDragInto(null);
  },

  /** Hover a folder. False means "not a legal target" — don't accept the drop. */
  hover(folder: string): boolean {
    if (!treeDrag.allows(folder)) return false;
    useTreeUi.getState().setDragInto(folder);
    // Spring-open, so a drag can reach a nested destination without being let
    // go of first. The root strip ("") has nothing to open.
    if (spring?.folder !== folder) {
      cancelSpring();
      if (folder && !useVault.getState().expanded.has(folder)) {
        spring = {
          folder,
          id: window.setTimeout(() => {
            spring = null;
            const vault = useVault.getState();
            if (!vault.expanded.has(folder)) vault.toggleExpanded(folder);
          }, SPRING_MS),
        };
      }
    }
    return true;
  },

  leave(folder: string) {
    const ui = useTreeUi.getState();
    if (ui.dragInto === folder) ui.setDragInto(null);
    if (spring?.folder === folder) cancelSpring();
  },

  commit(folder: string) {
    // Asked *before* `end()` clears the drag — `allows` reads the store, and
    // the store answers immediately rather than on the next render.
    const from = useTreeUi.getState().dragPath;
    const legal = treeDrag.allows(folder);
    treeDrag.end();
    if (from === null || !legal) return;
    void useVault.getState().moveEntry(from, folder).then((to) => {
      // Open the tree to where it landed. Dropping a chapter into a folded
      // folder otherwise reads as "my file vanished" — which is the one thing a
      // move must never look like.
      if (to && folder) useVault.getState().expandAll([...ancestorsOf(folder), folder]);
    });
  },
};

/**
 * Esc cancels a drag, and unmounting mid-drag must not leave a timer running.
 *
 * The engine already aborts a native drag on Escape and answers with
 * `dragend`, which is what really clears this — the listener is the belt to
 * that braces, because WebKitGTK has not always delivered key events to the
 * page mid-drag. Both routes end in the same `end()`, so a double fire is
 * harmless. It is mounted for the sidebar's whole life now rather than only
 * while a drag is in flight, which costs one no-op key check and saves the
 * Sidebar a re-render at the start and end of every drag.
 */
function useTreeDragLifecycle() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useTreeUi.getState().dragPath !== null) treeDrag.end();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelSpring();
    };
  }, []);
}

/** Every folder in the tree, depth-first, as vault-relative paths. */
function collectFolders(node: VaultNode, out: string[] = []): string[] {
  for (const child of node.children ?? []) {
    if (child.kind === "folder") {
      out.push(child.path);
      collectFolders(child, out);
    }
  }
  return out;
}

const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/**
 * A pixel measurement that follows the navigator zoom.
 *
 * Indents are computed per-row in JS (`10 + depth * 14`), so they cannot be a
 * plain CSS rule like the row's font and padding are. Handing the arithmetic
 * to `calc()` keeps the one variable in charge of all of it: outside
 * `.sb-tree` the variable is unset, `var(--sb-zoom, 1)` falls back to 1, and
 * the number is exactly what it was before this existed.
 */
const scaled = (px: number) => `calc(${px}px * var(--sb-zoom, 1))`;

/** The node at `path`, or null when the tree no longer has one. */
function findNode(node: VaultNode, path: string): VaultNode | null {
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, path);
    if (hit) return hit;
  }
  return null;
}

/** Every ancestor folder of `path`, so the tree can be opened down to it. */
function ancestorsOf(path: string): string[] {
  const segments = path.split("/").slice(0, -1);
  return segments.map((_, i) => segments.slice(0, i + 1).join("/"));
}

/**
 * The tree, keeping only what matches `q` — a folder survives because one of
 * its descendants matched, never on its own account alone unless its name
 * matches too. Returns null when nothing under `node` matched.
 */
function filterTree(node: VaultNode, q: string): VaultNode | null {
  const hit = node.name.toLowerCase().includes(q);
  if (node.kind !== "folder") return hit ? node : null;
  const kids = (node.children ?? [])
    .map((c) => filterTree(c, q))
    .filter((c): c is VaultNode => c !== null);
  if (!hit && kids.length === 0) return null;
  return { ...node, children: kids };
}

/** Every folder path in a (filtered) tree — what the search result expands. */
function folderPaths(node: VaultNode, out: string[] = []): string[] {
  for (const child of node.children ?? []) {
    if (child.kind === "folder") {
      out.push(child.path);
      folderPaths(child, out);
    }
  }
  return out;
}

export function Sidebar() {
  // One selector per field. `useVault()` with no selector woke the entire
  // sidebar — every row, every branch — on any vault change at all.
  //
  // Four fields, and none of them is the selection or the expanded set: those
  // belong to the *rows*, which read them one boolean at a time. The Sidebar
  // does not re-render when a document is selected or a folder is folded, and
  // that is what keeps its children still (docs/NOTES.md §27n).
  const current = useVault((s) => s.current);
  const tree = useVault((s) => s.tree);
  const expandAll = useVault((s) => s.expandAll);
  const openOverlay = useOverlay((s) => s.open);
  const query = useShell((s) => s.query);
  const sidebarZoom = useShell((s) => s.sidebarZoom);
  const [composer, setComposer] = useState<Composer | null>(null);
  useTreeDragLifecycle();

  const folders = useMemo(() => (tree ? collectFolders(tree) : []), [tree]);

  // One map for the whole tree rather than a subscription per row: the eyebrow
  // on a marked folder is a read of the manifest, and the manifest changes far
  // less often than the tree redraws.
  const roles = useMemo(() => {
    const map = new Map<string, "manuscript" | "draft">();
    for (const d of current?.drafts ?? []) if (d.folder) map.set(d.folder, "draft");
    for (const m of current?.manuscripts ?? []) map.set(m.folder, "manuscript");
    return map;
  }, [current?.manuscripts, current?.drafts]);
  const roleOf = useCallback((path: string) => roles.get(path) ?? null, [roles]);

  // One identity for as long as its two fields hold still. An object literal
  // here would be a new context value on every render, and a new context value
  // re-renders every row regardless of `React.memo`.
  const ops = useMemo<TreeOps>(() => ({ folders, roleOf }), [folders, roleOf]);

  // The top bar's ⌘K capsule filters the tree by name; Enter in it opens the
  // full-text Find sheet, which is the part a name filter cannot do.
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => (!tree || !q ? tree : filterTree(tree, q)),
    [tree, q],
  );

  // A filtered tree is useless folded up — open everything the filter kept.
  useEffect(() => {
    if (!q || !shown) return;
    expandAll(folderPaths(shown));
  }, [q, shown, expandAll]);

  if (!current || !tree) return null;

  return (
    <aside className="sidebar">
      {/* Just a title now. Switching workflows is the chip at the bottom of
          the sidebar, which is where the Swift app puts it (SWIFT-AUDIT §1.4)
          and where it reads as a control rather than as a heading. */}
      <header className="sb-title">
        <span className="sb-name">Aquarius</span>
        <span className="sb-kind">Writer</span>
      </header>

      <QuickViews />

      <div className="sb-eyebrow">
        <span className="sb-eyebrow-label">Workflow</span>
        <NavigatorZoom />
        <AddMenu onPick={(what) => setComposer({ what, parent: targetFolder() })} />
      </div>

      {/* `--sb-zoom` scales only what is inside this container. The quick views
          above and the rail below keep their size on purpose: this is the
          *navigator* zoom, the way Swift means it, not an app-wide text size. */}
      <div
        className="sb-tree"
        style={{ "--sb-zoom": sidebarZoom } as CSSProperties}
        onClick={() => useTreeUi.getState().setMenuFor(null)}
      >
        {composer && (
          <Composer
            what={composer.what}
            parent={composer.parent}
            onDone={() => setComposer(null)}
          />
        )}
        {q && (!shown || (shown.children?.length ?? 0) === 0) && (
          <EmptyState
            size="inline"
            art="search"
            headline="No file name matches"
            subline={<>Nothing here is called “{query.trim()}”. Press Enter to search
              inside the documents instead.</>}
          />
        )}

        {/* A brand-new workflow. Not the same emptiness as a filter with no
            hits, so not the same words: there is nothing to find because
            nothing has been written yet, and the answer is a button. */}
        {!q && !composer && (shown?.children?.length ?? 0) === 0 && (
          <EmptyState
            size="inline"
            art="folder"
            headline="An empty workflow"
            subline="Every document lives in this folder. Make the first one and it opens straight away."
            action={{
              label: "New document",
              onClick: () => setComposer({ what: "file", parent: targetFolder() }),
            }}
          />
        )}
        <TreeOpsContext.Provider value={ops}>
          {shown?.children?.map((node) => (
            <TreeBranch key={node.path} node={node} depth={0} />
          ))}
        </TreeOpsContext.Provider>

        <DropRoot />
      </div>

      {/* Six now, not four: Palette and Settings moved here when the status bar
          was retired (SWIFT-AUDIT §1.3 — Swift has no status bar), so nothing
          that used to be down there lost its button. */}
      <div className="sb-rail">
        <button className="sb-rail-btn" title="Command palette (⌘P)"
          onClick={() => openOverlay("palette")}>Palette</button>
        <button className="sb-rail-btn" title="Today (⌘T)"
          onClick={() => openOverlay("today")}>Today</button>
        <button className="sb-rail-btn" title="Graph (⌘G)"
          onClick={() => openOverlay("graph")}>Graph</button>
        <button className="sb-rail-btn" title="Find in workflow (⇧⌘F)"
          onClick={() => openOverlay("find")}>Find</button>
        <button className="sb-rail-btn" title="Recently Deleted"
          onClick={() => openOverlay("trash")}>Trash</button>
        <button className="sb-rail-btn" title="Settings (⌘,)"
          onClick={() => openOverlay("settings")}>Settings</button>
      </div>

      <WorkflowChip />
    </aside>
  );
}

/**
 * Where a new file or folder lands: inside the folder the writer last opened,
 * alongside the document they selected, at the vault root otherwise. Same rule
 * the Swift add menu follows.
 *
 * Read at the moment "+" is clicked rather than on every render, so neither
 * the selection nor the last-touched folder is a thing the Sidebar has to
 * subscribe to.
 */
function targetFolder(): string {
  const last = useTreeUi.getState().lastFolder;
  if (last !== null) return last;
  const selected = useVault.getState().selectedPath;
  return selected ? parentOf(selected) : "";
}

/**
 * The vault root as a drop target. Only while a drag is in flight, and only
 * when the row is not already at the root — an always-visible strip would be a
 * permanent 30px of chrome for a rare act, and one that refuses the drop is
 * worse than one that is not there.
 *
 * Its own component so that the two fields it watches are watched *here*: in
 * the Sidebar they would re-render the whole column twice per drag.
 */
const DropRoot = memo(function DropRoot() {
  const dragPath = useTreeUi((s) => s.dragPath);
  const into = useTreeUi((s) => s.dragInto);
  if (dragPath === null || !treeDrag.allows("")) return null;
  return (
    <div
      className={`sb-droproot${into === "" ? " on" : ""}`}
      onDragOver={(e) => {
        if (!treeDrag.hover("")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragLeave={() => treeDrag.leave("")}
      onDrop={(e) => { e.preventDefault(); treeDrag.commit(""); }}
    >
      {/* "Vault root" is what the ⋯ menu's own destination list calls it — two
          names for one place would be two places. */}
      Move to the vault root
    </div>
  );
});

/**
 * Starred · Today · Manuscript — the three shortcuts that sit above the
 * WORKFLOW eyebrow in the Swift app (SWIFT-AUDIT §1.4).
 *
 * They use the tree's own row shape on purpose: these are places in the vault,
 * and giving them a second visual language would make the top of the sidebar
 * look like a toolbar someone bolted on.
 */
const QuickViews = memo(function QuickViews() {
  const tree = useVault((s) => s.tree);
  const view = useVault((s) => s.view);
  const setView = useVault((s) => s.setView);
  const selectPath = useVault((s) => s.selectPath);
  const toggleExpanded = useVault((s) => s.toggleExpanded);
  const expandAll = useVault((s) => s.expandAll);
  const openOverlay = useOverlay((s) => s.open);
  const starred = useFavorites((s) => s.starred);
  const [showStarred, setShowStarred] = useState(false);

  // Sorted by the name the tree paints, not by path, so the list reads the way
  // the writer's eye expects rather than grouping by folder.
  const rows = useMemo(() => {
    if (!tree) return [];
    return [...starred]
      .map((path) => ({ path, node: findNode(tree, path) }))
      .filter((r): r is { path: string; node: VaultNode } => r.node !== null)
      .sort((a, b) => a.node.name.toLowerCase().localeCompare(b.node.name.toLowerCase()));
  }, [tree, starred]);

  function openStarredRow(node: VaultNode) {
    // A starred folder can't go in the editor; opening the tree to it is the
    // useful thing instead.
    expandAll(ancestorsOf(node.path));
    if (node.kind === "folder") {
      // Read at click time — the expanded set is not something this list has
      // any reason to re-render for.
      if (!useVault.getState().expanded.has(node.path)) toggleExpanded(node.path);
      return;
    }
    selectPath(node.path);
    setView("editor");
  }

  return (
    <div className="sb-quick">
      <button
        className={`sb-row sb-quick-row${showStarred ? " open" : ""}`}
        onClick={() => setShowStarred((o) => !o)}
        aria-expanded={showStarred}
      >
        <span className="sb-caret">
          <Caret open={showStarred} color="var(--ink-soft)" />
        </span>
        <StarIcon size={12} filled color="var(--starred)" />
        <span className="sb-label">Starred</span>
        {rows.length > 0 && <span className="sb-count">{rows.length}</span>}
      </button>

      {showStarred && (
        rows.length === 0 ? (
          <EmptyState
            size="inline"
            art="star"
            headline="Nothing starred yet"
            subline="Star a row from its ⋯ menu and it will wait for you up here."
          />
        ) : (
          rows.map(({ node }) => (
            <button
              key={node.path}
              className="sb-row sb-file sb-quick-starred"
              title={node.path}
              onClick={() => openStarredRow(node)}
            >
              {node.kind === "folder"
                ? <FolderIcon size={12} color="var(--ink-soft)" />
                : <FileGlyph kind={node.kind} />}
              <span className="sb-label">{node.name}</span>
            </button>
          ))
        )
      )}

      <button className="sb-row sb-quick-row" onClick={() => openOverlay("today")}>
        <span className="sb-caret" />
        <SparkleIcon size={12} color="var(--ink-soft)" />
        <span className="sb-label">Today</span>
        <span className="sb-quick-key">⌘T</span>
      </button>

      {/* Home, Outline and Corkboard are three faces of the same manuscript
          surface, so the row reads as active in all of them. It opens the home
          grid (PARITY row 8) — the card is how you get into one manuscript,
          and a vault can have more than one. */}
      <button
        className={`sb-row sb-quick-row${view !== "editor" ? " selected" : ""}`}
        onClick={() => setView("home")}
      >
        <span className="sb-caret" />
        <BookIcon size={12} color="var(--ink-soft)" />
        <span className="sb-label">Manuscript</span>
        <span className="sb-quick-key">⌘2</span>
      </button>
    </div>
  );
});

/**
 * A− / A+ beside the WORKFLOW eyebrow — SWIFT-AUDIT §1.4's navigator zoom.
 *
 * Two buttons, no menu and no slider, because the thing being adjusted is
 * right underneath them and the only useful interaction is "a bit bigger" a
 * couple of times. Clicking A− at the floor (or A+ at the ceiling) does
 * nothing and the button says so by going quiet; a middle-click on either
 * resets to 1×, which is the escape hatch for someone who has scrolled the
 * scale somewhere strange.
 */
function NavigatorZoom() {
  const zoom = useShell((s) => s.sidebarZoom);
  const step = useShell((s) => s.stepSidebarZoom);
  const pct = `${Math.round(zoom * 100)}%`;
  return (
    <div className="sb-zoom" role="group" aria-label="Navigator text size">
      <button
        className="sb-zoom-btn"
        disabled={zoom <= ZOOM_MIN}
        title={`Smaller tree text (now ${pct}) — middle-click to reset`}
        aria-label="Smaller tree text"
        onClick={() => step(-1)}
        onAuxClick={(e) => { if (e.button === 1) step(0); }}
      >A−</button>
      <button
        className="sb-zoom-btn"
        disabled={zoom >= ZOOM_MAX}
        title={`Larger tree text (now ${pct}) — middle-click to reset`}
        aria-label="Larger tree text"
        onClick={() => step(1)}
        onAuxClick={(e) => { if (e.button === 1) step(0); }}
      >A+</button>
    </div>
  );
}

/** The "+" beside the WORKFLOW eyebrow — new file, new folder. */
function AddMenu({ onPick }: { onPick: (what: "file" | "folder") => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sb-add">
      <button
        className="sb-add-btn"
        title="Add a file or folder"
        aria-label="Add a file or folder"
        onClick={() => setOpen((o) => !o)}
      >
        <PlusIcon size={12} color="var(--ink-soft)" />
      </button>
      {open && (
        <div className="sb-menu sb-menu-right" onMouseLeave={() => setOpen(false)}>
          <button className="sb-menu-item" onClick={() => { setOpen(false); onPick("file"); }}>
            New file…
          </button>
          <button className="sb-menu-item" onClick={() => { setOpen(false); onPick("folder"); }}>
            New folder…
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The inline row that names a new file or folder.
 *
 * Deliberately inline rather than a modal: naming a chapter is a half-second
 * act, and a dialog for it would be the heaviest thing in the sidebar.
 */
function Composer({
  what,
  parent,
  onDone,
}: {
  what: "file" | "folder";
  parent: string;
  onDone: () => void;
}) {
  const createFile = useVault((s) => s.createFile);
  const createFolder = useVault((s) => s.createFolder);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<NewFileKind>("markdown");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); }, []);

  async function submit() {
    if (busy || !name.trim()) return;
    setBusy(true);
    const made = what === "file"
      ? await createFile(parent, name, kind)
      : await createFolder(parent, name);
    setBusy(false);
    // A failure keeps the field open with the text still in it — the notice
    // says what was wrong and the writer can fix the name in place.
    if (made) onDone();
  }

  // The segmented buttons prevent `mousedown` so that switching kind does not
  // blur the name field: the blur is a cancel, and picking Screenplay must not
  // throw away the name already typed.
  return (
    <div className="sb-composer">
      <div className="sb-composer-where">
        in {parent || "the vault root"}
      </div>
      {what === "file" && (
        <div className="sb-segmented" role="group" aria-label="Document kind">
          <button
            className={`sb-seg${kind === "markdown" ? " on" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setKind("markdown")}
          >Markdown</button>
          <button
            className={`sb-seg${kind === "fountain" ? " on" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setKind("fountain")}
          >Screenplay</button>
        </div>
      )}
      <input
        ref={input}
        className="sb-name-input"
        value={name}
        disabled={busy}
        placeholder={what === "file" ? "Chapter Five" : "Research"}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") onDone();
        }}
        // Clicking away is a cancel, the way an inline field usually behaves —
        // but not while the create is in flight.
        onBlur={() => { if (!busy) onDone(); }}
      />
    </div>
  );
}

/**
 * One row of the tree, plus its children when it is an open folder.
 *
 * **Memoised, and its props are down to two.** It used to take `expanded`,
 * `selected`, `onToggle` and `onSelect` from the Sidebar, which meant the whole
 * tree re-rendered whenever any one row's state changed — a `Set` and a
 * `string | null` describe *every* row, so every row had to be handed them
 * again to find out about one. Each row now asks the store the one question it
 * cares about, as a boolean: am I selected, am I open, am I the one being
 * dragged. Selecting a document re-renders the row that lost the highlight and
 * the row that gained it, and folding a folder re-renders that folder and the
 * subtree it is folding. docs/NOTES.md §27n.
 *
 * `node` and `depth` are all that is left, and `node` holds still until the
 * tree itself is reloaded — which is a redraw of everything by definition.
 */
const TreeBranch = memo(function TreeBranch({
  node,
  depth,
}: {
  node: VaultNode;
  depth: number;
}) {
  const ops = useTreeOps();
  const isFolder = node.kind === "folder";
  // Booleans, not the containers they come out of: `s.expanded` is a new Set on
  // every toggle and `s.selectedPath` changes for every row at once, so
  // selecting either of them wholesale is a subscription to the whole tree.
  const isOpen = useVault((s) => isFolder && s.expanded.has(node.path));
  const isSelected = useVault((s) => s.selectedPath === node.path);
  const isRenaming = useTreeUi((s) => s.renaming === node.path);
  const isDragging = useTreeUi((s) => s.dragPath === node.path);
  const isDropTarget = useTreeUi((s) => s.dragInto === node.path);
  const toggleExpanded = useVault((s) => s.toggleExpanded);
  const selectPath = useVault((s) => s.selectPath);
  const indent = 10 + depth * 14 + (isFolder ? 0 : 14);

  // A row is picked up by its *wrapper*, never by the `<button>` inside it:
  // WebKit treats a form control as its own drag source, and the wrapper is
  // also the element that has to carry the drop ring. `.sb-tree` sets
  // `user-select: none`, which is why the CSS opts back in with
  // `-webkit-user-drag: element`.
  const source = {
    draggable: true,
    onDragStart: (e: ReactDragEvent<HTMLDivElement>) => {
      e.dataTransfer.effectAllowed = "move";
      // Some engines refuse to start a drag with an empty payload, and the
      // path is the honest thing to carry anyway.
      e.dataTransfer.setData("text/plain", node.path);
      treeDrag.begin(node.path);
    },
    onDragEnd: () => treeDrag.end(),
  };

  // Only folders accept a drop. A file row is not a target: "into the folder
  // this file happens to live in" is a guess, and a guess that moves files is
  // the wrong kind of convenience.
  const target = {
    onDragOver: (e: ReactDragEvent<HTMLDivElement>) => {
      // No preventDefault when the move is illegal or a no-op — that is how the
      // engine is told "not here", cursor included.
      if (!treeDrag.hover(node.path)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDragLeave: (e: ReactDragEvent<HTMLDivElement>) => {
      // `dragleave` also fires when the pointer crosses from the row into one
      // of its own children — the label, the caret, the ⋯ — which would make
      // the ring flicker on and off as the writer moves along the row. Only a
      // relatedTarget outside the row is a real leave (null means the pointer
      // left the window entirely, which is one too).
      const to = e.relatedTarget as Node | null;
      if (to && e.currentTarget.contains(to)) return;
      treeDrag.leave(node.path);
    },
    onDrop: (e: ReactDragEvent<HTMLDivElement>) => {
      e.preventDefault();
      treeDrag.commit(node.path);
    },
  };

  const wrapClass = [
    "sb-rowwrap",
    isDragging ? "sb-dragging" : "",
    isDropTarget ? "sb-drop-into" : "",
  ].filter(Boolean).join(" ");

  if (isRenaming) {
    return (
      <>
        <RenameRow node={node} indent={indent} />
        {isFolder && isOpen && node.children?.map((child) => (
          <TreeBranch key={child.path} node={child} depth={depth + 1} />
        ))}
      </>
    );
  }

  if (isFolder) {
    const role = ops.roleOf(node.path);
    return (
      <>
        <div className={wrapClass} {...source} {...target}>
          <button
            className={`sb-row sb-folder${isSelected ? " selected" : ""}`}
            style={{ paddingLeft: scaled(indent) }}
            onClick={() => {
              useTreeUi.getState().setLastFolder(node.path);
              toggleExpanded(node.path);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              useTreeUi.getState().setMenuFor(node.path);
            }}
          >
            <span className="sb-caret">
              <Caret open={isOpen} color="var(--ink-soft)" />
            </span>
            <FolderIcon
              size={12}
              color={role ? "var(--accent)" : "var(--ink-soft)"}
            />
            <span className="sb-label">{node.name}</span>
            {/* The mark, said out loud. A folder that is the book should not
                look exactly like a folder of research. */}
            {role && (
              <span className={`sb-role sb-role-${role}`}>
                {role === "manuscript" ? "MS" : "Draft"}
              </span>
            )}
            <span className="sb-count">{node.children?.length ?? 0}</span>
            <StarAffordance path={node.path} />
            <MoreAffordance path={node.path} />
          </button>
          <RowMenu node={node} />
        </div>
        {isOpen &&
          node.children?.map((child) => (
            <TreeBranch key={child.path} node={child} depth={depth + 1} />
          ))}
      </>
    );
  }

  const status = node.frontmatter?.status as ChapterStatus | undefined;

  return (
    <div className={wrapClass} {...source}>
      <button
        className={`sb-row sb-file${isSelected ? " selected" : ""}`}
        style={{ paddingLeft: scaled(indent) }}
        onClick={() => {
          useTreeUi.getState().setLastFolder(parentOf(node.path));
          selectPath(node.path);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          useTreeUi.getState().setMenuFor(node.path);
        }}
      >
        <FileGlyph kind={node.kind} />
        <span className="sb-label">{node.name}</span>
        {status && (
          <span
            className="sb-status-dot"
            style={{ background: STATUS_COLOR[status] }}
            aria-label={status}
          />
        )}
        <StarAffordance path={node.path} />
        <MoreAffordance path={node.path} />
        <DeleteAffordance node={node} />
      </button>
      <RowMenu node={node} />
    </div>
  );
});

/** The row, replaced by a text field, while it is being renamed. */
function RenameRow({ node, indent }: { node: VaultNode; indent: number }) {
  const renameEntry = useVault((s) => s.renameEntry);
  const setRenaming = useTreeUi((s) => s.setRenaming);
  const [name, setName] = useState(node.name);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  async function submit() {
    if (busy) return;
    if (!name.trim() || name === node.name) { setRenaming(null); return; }
    setBusy(true);
    const to = await renameEntry(node.path, name);
    setBusy(false);
    if (to) setRenaming(null);
  }

  return (
    <div className="sb-row sb-renaming" style={{ paddingLeft: scaled(indent) }}>
      {node.kind === "folder"
        ? <FolderIcon size={12} color="var(--ink-soft)" />
        : <FileGlyph kind={node.kind} />}
      <input
        ref={input}
        className="sb-name-input sb-name-inline"
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") setRenaming(null);
        }}
        onBlur={() => { if (!busy) void submit(); }}
      />
    </div>
  );
}

/**
 * Star / Open in Split View / Mark as Manuscript / Rename / Move to… — the
 * row's context menu, also on the "⋯" button. Swift's row menu, minus the
 * Finder items (SWIFT-AUDIT §1.4).
 *
 * The two manuscript marks are folder-only, and the draft one only appears
 * where it could actually succeed: a draft is an alternate cut *of* something,
 * so a folder with no manuscript above it is not offered a mark the backend
 * would refuse (PARITY row 8).
 */
const RowMenu = memo(function RowMenu({ node }: { node: VaultNode }) {
  const ops = useTreeOps();
  const open = useTreeUi((s) => s.menuFor === node.path);
  const moveEntry = useVault((s) => s.moveEntry);
  const manuscripts = useVault((s) => s.current?.manuscripts);
  const drafts = useVault((s) => s.current?.drafts);
  const toggleManuscriptFolder = useVault((s) => s.toggleManuscriptFolder);
  const toggleDraftFolder = useVault((s) => s.toggleDraftFolder);
  const starredPaths = useFavorites((s) => s.starred);
  const toggleFavorite = useFavorites((s) => s.toggle);
  const [picking, setPicking] = useState(false);
  const starred = starredPaths.has(node.path);
  const isFile = node.kind !== "folder";
  const isManuscript = (manuscripts ?? []).some((m) => m.folder === node.path);
  const isDraft = (drafts ?? []).some((d) => d.folder === node.path);
  // Strictly inside: a manuscript folder is not its own alternate cut.
  const insideManuscript = (manuscripts ?? []).some(
    (m) => m.folder && node.path.startsWith(`${m.folder}/`),
  );

  useEffect(() => { if (!open) setPicking(false); }, [open]);

  if (!open) return null;

  // Where this row could go: any folder except the one it is already in, and —
  // for a folder — never into itself or anything it contains.
  const here = parentOf(node.path);
  const destinations = ["", ...ops.folders].filter(
    (f) => f !== here && f !== node.path && !f.startsWith(`${node.path}/`),
  );

  return (
    // The tree's own click handler closes this menu, which is how clicking
    // anywhere else dismisses it — so the menu has to keep its own clicks to
    // itself, or "Move to…" would close before it could show the folders.
    <div
      className="sb-menu"
      onClick={(e) => e.stopPropagation()}
      onMouseLeave={() => useTreeUi.getState().setMenuFor(null)}
    >
      {!picking ? (
        <>
          <button
            className="sb-menu-item"
            onClick={() => { useTreeUi.getState().setMenuFor(null); void toggleFavorite(node.path); }}
          >{starred ? "Unstar" : "Star"}</button>
          {isFile && (
            <button
              className="sb-menu-item"
              onClick={() => {
                useTreeUi.getState().setMenuFor(null);
                // Editable, not reference — the pane's own header switches it
                // to read-only, and the writer asked for a second editor.
                useSplit.getState().openSplit(node.path, false);
                // The split only exists in the editor view.
                useVault.getState().setView("editor");
              }}
            >Open in Split View</button>
          )}
          {!isFile && (
            <button
              className="sb-menu-item"
              onClick={() => {
                useTreeUi.getState().setMenuFor(null);
                void toggleManuscriptFolder(node.path);
              }}
            >{isManuscript ? "Unmark Manuscript" : "Mark as Manuscript"}</button>
          )}
          {!isFile && (isDraft || insideManuscript) && (
            <button
              className="sb-menu-item"
              onClick={() => {
                useTreeUi.getState().setMenuFor(null);
                void toggleDraftFolder(node.path);
              }}
            >{isDraft ? "Unmark Draft folder" : "Mark as Draft folder"}</button>
          )}
          <button
            className="sb-menu-item"
            onClick={() => {
              const ui = useTreeUi.getState();
              ui.setMenuFor(null);
              ui.setRenaming(node.path);
            }}
          >Rename</button>
          <button
            className="sb-menu-item"
            disabled={destinations.length === 0}
            onClick={() => setPicking(true)}
          >Move to…</button>
        </>
      ) : (
        <div className="sb-menu-scroll">
          {destinations.map((folder) => (
            <button
              key={folder || "/"}
              className="sb-menu-item"
              onClick={() => {
                useTreeUi.getState().setMenuFor(null);
                void moveEntry(node.path, folder);
              }}
            >{folder || "Vault root"}</button>
          ))}
        </div>
      )}
    </div>
  );
});

/**
 * The star on a tree row.
 *
 * Always visible once the row is starred — that is the whole point of it — and
 * revealed on hover otherwise, so an unstarred tree stays quiet. The same flip
 * is in the row's ⋯ menu and in the command palette, because a hover-only
 * control is not a control on a trackpad-less machine.
 */
const StarAffordance = memo(function StarAffordance({ path }: { path: string }) {
  const starred = useFavorites((s) => s.starred.has(path));
  const toggle = useFavorites((s) => s.toggle);
  return (
    <span
      className={`sb-star${starred ? " on" : ""}`}
      role="button"
      aria-pressed={starred}
      title={starred ? "Unstar" : "Star"}
      onClick={(e) => {
        e.stopPropagation();
        void toggle(path);
      }}
    >
      <StarIcon
        size={11}
        filled={starred}
        color={starred ? "var(--starred)" : "var(--ink-mute)"}
      />
    </span>
  );
});

/**
 * The row's "⋯". It reads which menu is open at click time rather than
 * subscribing to it: sixteen of these watching one string is sixteen rows
 * re-rendering every time any menu opens.
 */
const MoreAffordance = memo(function MoreAffordance({ path }: { path: string }) {
  return (
    <span
      className="sb-more"
      role="button"
      title="Rename or move"
      onClick={(e) => {
        e.stopPropagation();
        const ui = useTreeUi.getState();
        ui.setMenuFor(ui.menuFor === path ? null : path);
      }}
    >⋯</span>
  );
});

/** Every editable file under `node`, however deep. Folders do not count. */
function countFilesIn(node: VaultNode): number {
  if (node.kind !== "folder") return 1;
  return (node.children ?? []).reduce((n, c) => n + countFilesIn(c), 0);
}

/** The question this row's `×` asks before anything moves. */
function deleteQuestion(node: VaultNode): { title: string; body: string } {
  const body = "It moves to Recently Deleted, where you can put it back.";
  if (node.kind !== "folder") {
    return { title: `Delete “${node.name}”?`, body };
  }
  const n = countFilesIn(node);
  if (n === 0) return { title: `Delete “${node.name}”?`, body };
  return {
    title: `Delete “${node.name}” and the ${n} ${n === 1 ? "file" : "files"} inside it?`,
    body,
  };
}

/**
 * Hover-revealed soft-delete — moves the file to Recently Deleted.
 *
 * **This is the only human-facing delete in the app**, and the gate below is
 * the only thing between a mis-aimed click and a chapter leaving the tree.
 * There is no Delete in the row's ⋯ menu, no Delete/Backspace key bound to the
 * selection, no drop-on-trash target, and nothing in the command palette or in
 * the manuscript / corkboard / rail surfaces that removes a document — so
 * there is exactly one path to gate, not several. Anything added later must
 * come through `deleteQuestion` too rather than growing a second question.
 *
 * The gate is UI-only, deliberately. The MCP `trash` tool
 * (`src-tauri/src/mcp/tools.rs`) calls `ops::trash_entry` straight through with
 * no confirmation, and should: an agent has no hand to slip, its caller already
 * asked for the delete in words, and a dialog in a headless surface is a hang.
 * The safety net is the same one either way — the file is in Recently Deleted,
 * not gone.
 */
const DeleteAffordance = memo(function DeleteAffordance({ node }: { node: VaultNode }) {
  // The id, not the whole workflow: `current` is replaced wholesale whenever
  // anything in the manifest moves, and this row only needs to know where to
  // send the file.
  const workflowId = useVault((s) => s.current?.id);
  const removeFromTree = useVault((s) => s.removeFromTree);
  const path = node.path;
  return (
    <span
      className="sb-del"
      role="button"
      title="Move to Recently Deleted"
      onClick={(e) => {
        e.stopPropagation();
        if (!workflowId) return;
        void (async () => {
          const { title, body } = deleteQuestion(node);
          const ok = await confirmAsk({
            title,
            body,
            confirmLabel: "Delete",
            destructive: true,
          });
          if (!ok) return;
          // Everything below is unchanged from before the gate existed.
          // Evict first: a pending debounced save would resurrect the file.
          useEditor.getState().evict(path);
          await trashFile(workflowId, path);
          removeFromTree(path);
          // The backend already dropped the star (`ops::trash_entry`); this is
          // the sidebar catching up without another round trip.
          useFavorites.getState().forget(path);
        })();
      }}
    >×</span>
  );
});

const FileGlyph = memo(function FileGlyph({ kind }: { kind: NodeKind }) {
  const color = "var(--ink-mute)";
  const size = 12;
  if (kind === "fountain") return <ScreenplayIcon size={size} color={color} />;
  if (kind === "image") return <ImageIcon size={size} color={color} />;
  if (kind === "pdf") return <PdfIcon size={size} color={color} />;
  return <FileIcon size={size} color={color} />;
});

/**
 * The workflow switcher, as a chip pinned to the bottom of the sidebar — the
 * Swift app's shape (SWIFT-AUDIT §1.4), and the fix for the port's own version
 * of it, which was the sidebar *title* with a 10px caret: a control nobody
 * could find because it did not look like one ("I cannot switch workflows",
 * PARITY §3).
 *
 * The popover opens upward, since the chip is at the bottom of the column.
 */
const WorkflowChip = memo(function WorkflowChip() {
  const current = useVault((s) => s.current);
  const workflows = useVault((s) => s.workflows);
  const workflowsLoading = useVault((s) => s.workflowsLoading);
  const pending = useVault((s) => s.pending);
  const fetchWorkflows = useVault((s) => s.fetchWorkflows);
  const openWorkflow = useVault((s) => s.openWorkflow);
  const closeWorkflow = useVault((s) => s.closeWorkflow);
  const addWorkflowFromFolder = useVault((s) => s.addWorkflowFromFolder);
  const openOverlay = useOverlay((s) => s.open);
  const [open, setOpen] = useState(false);

  // Fetched when the popover opens rather than on mount: the list is only ever
  // read here, and the boot path already has enough to do.
  useEffect(() => {
    if (open) void fetchWorkflows();
  }, [open, fetchWorkflows]);

  if (!current) return null;

  const alone = !workflowsLoading && workflows.filter((w) => w.id !== current.id).length === 0;

  return (
    <div className="sb-foot">
      <button
        className={`sb-chip${open ? " open" : ""}`}
        title="Switch workflow"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sb-chip-text">
          <span className="sb-chip-name">{current.title}</span>
          <span className="sb-chip-kind">{current.kind}</span>
        </span>
        <Caret open={open} color="var(--ink-mute)" />
      </button>

      {open && (
        <div className="sb-switch-menu sb-switch-up" onMouseLeave={() => setOpen(false)}>
          {workflows.map((w) => (
            <button
              key={w.id}
              className={`sb-switch-item${w.id === current.id ? " on" : ""}`}
              onClick={() => {
                setOpen(false);
                if (w.id !== current.id) void openWorkflow(w.id);
              }}
            >
              <span className="sb-switch-tick">
                {w.id === current.id && <CheckIcon size={11} color="var(--accent)" />}
              </span>
              <span className="sb-label">{w.name}</span>
              <span className="sb-switch-meta">{w.items} items</span>
            </button>
          ))}

          {/* Honest rather than hidden: one workflow is a normal state, and a
              menu that silently listed a single row would look broken. */}
          {alone && (
            <p className="sb-switch-note">
              This is the only workflow you have connected.
            </p>
          )}

          <div className="sb-switch-sep" />

          <button
            className="sb-switch-item sb-switch-action"
            disabled={pending !== null}
            onClick={() => { setOpen(false); void addWorkflowFromFolder(); }}
          >
            {pending === "picking" ? "Choosing a folder…" : "Add workflow…"}
          </button>
          <button
            className="sb-switch-item sb-switch-action"
            onClick={() => { setOpen(false); closeWorkflow(); }}
          >
            All workflows
          </button>
          <button
            className="sb-switch-item sb-switch-action"
            onClick={() => { setOpen(false); openOverlay("settings", { tab: "workflows" }); }}
          >
            Manage workflows…
          </button>
        </div>
      )}
    </div>
  );
});
