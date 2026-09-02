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
import { useOverlay } from "@/state/overlayStore";
import { useShell, ZOOM_MAX, ZOOM_MIN } from "@/state/shellStore";
import { useFavorites } from "@/state/favoritesStore";
import { useSplit } from "@/state/splitStore";
import { trashFile } from "@/lib/vault/aux";
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
 * Which row currently owns the tree's one open menu / inline editor.
 *
 * Kept in the Sidebar rather than in each row so only one can ever be open —
 * two rename fields at once would be a way to lose an edit.
 */
interface TreeOps {
  menuFor: string | null;
  setMenuFor: (path: string | null) => void;
  renaming: string | null;
  setRenaming: (path: string | null) => void;
  /** Every folder path in the workflow, for the "Move to…" list. */
  folders: string[];
  /**
   * Remember which folder the writer last touched, so "+" adds *there*.
   *
   * Deliberately not the vault's `selectedPath`: selecting a folder would put
   * a folder in the editor pane, which has nothing to render for one.
   */
  noteTarget: (folder: string) => void;
  /** Drag-a-row-into-a-folder. See `useTreeDrag`. */
  drag: TreeDrag;
}

const TreeOpsContext = createContext<TreeOps | null>(null);
const useTreeOps = () => useContext(TreeOpsContext)!;

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
 */
interface TreeDrag {
  /** The row being carried, or null when no drag is in flight. */
  path: string | null;
  /** The folder currently accepting the drop — "" is the vault root. */
  into: string | null;
  begin: (path: string) => void;
  end: () => void;
  /** Hover a folder. False means "not a legal target" — don't accept the drop. */
  hover: (folder: string) => boolean;
  leave: (folder: string) => void;
  commit: (folder: string) => void;
  /** Whether `folder` is somewhere the in-flight drag could actually land. */
  allows: (folder: string) => boolean;
}

/** How long a closed folder has to be hovered before it springs open. */
const SPRING_MS = 700;

function useTreeDrag(): TreeDrag {
  const moveEntry = useVault((s) => s.moveEntry);
  const [path, setPath] = useState<string | null>(null);
  const [into, setInto] = useState<string | null>(null);
  // One spring-open timer, because only one folder can be under the pointer.
  const spring = useRef<{ folder: string; id: number } | null>(null);

  const cancelSpring = useCallback(() => {
    if (spring.current) {
      window.clearTimeout(spring.current.id);
      spring.current = null;
    }
  }, []);

  const end = useCallback(() => {
    cancelSpring();
    setPath(null);
    setInto(null);
  }, [cancelSpring]);

  // Esc cancels. The engine already aborts a native drag on Escape and answers
  // with `dragend`, which is what really clears this — the listener is the belt
  // to that braces, because WebKitGTK has not always delivered key events to
  // the page mid-drag. Both routes end in the same `end()`, so a double fire is
  // harmless.
  useEffect(() => {
    if (path === null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") end(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path, end]);

  // Unmounting mid-drag (switching workflows) must not leave a timer running.
  useEffect(() => cancelSpring, [cancelSpring]);

  /**
   * The three refusals, in the UI so the writer sees them rather than finding
   * out from a failure notice. The backend refuses the first two as well —
   * `ops::move_entry` on the Rust side, `relocate` in the browser mock — this
   * is the same rule drawn.
   */
  const allows = useCallback((folder: string) => {
    if (path === null) return false;
    if (folder === path) return false;                    // a folder into itself
    if (folder.startsWith(`${path}/`)) return false;      // …or into its own descendant
    if (folder === parentOf(path)) return false;          // already there: a no-op
    return true;
  }, [path]);

  const begin = useCallback((p: string) => {
    cancelSpring();
    setPath(p);
    setInto(null);
  }, [cancelSpring]);

  const hover = useCallback((folder: string) => {
    if (!allows(folder)) return false;
    setInto(folder);
    // Spring-open, so a drag can reach a nested destination without being let
    // go of first. The root strip ("") has nothing to open.
    if (spring.current?.folder !== folder) {
      cancelSpring();
      if (folder && !useVault.getState().expanded.has(folder)) {
        spring.current = {
          folder,
          id: window.setTimeout(() => {
            spring.current = null;
            const vault = useVault.getState();
            if (!vault.expanded.has(folder)) vault.toggleExpanded(folder);
          }, SPRING_MS),
        };
      }
    }
    return true;
  }, [allows, cancelSpring]);

  const leave = useCallback((folder: string) => {
    setInto((v) => (v === folder ? null : v));
    if (spring.current?.folder === folder) cancelSpring();
  }, [cancelSpring]);

  const commit = useCallback((folder: string) => {
    const from = path;
    end();
    if (from === null || !allows(folder)) return;
    void moveEntry(from, folder).then((to) => {
      // Open the tree to where it landed. Dropping a chapter into a folded
      // folder otherwise reads as "my file vanished" — which is the one thing a
      // move must never look like.
      if (to && folder) useVault.getState().expandAll([...ancestorsOf(folder), folder]);
    });
  }, [path, allows, end, moveEntry]);

  return { path, into, begin, end, hover, leave, commit, allows };
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
  const current = useVault((s) => s.current);
  const tree = useVault((s) => s.tree);
  const expanded = useVault((s) => s.expanded);
  const selectedPath = useVault((s) => s.selectedPath);
  const toggleExpanded = useVault((s) => s.toggleExpanded);
  const selectPath = useVault((s) => s.selectPath);
  const expandAll = useVault((s) => s.expandAll);
  const openOverlay = useOverlay((s) => s.open);
  const query = useShell((s) => s.query);
  const sidebarZoom = useShell((s) => s.sidebarZoom);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [lastFolder, setLastFolder] = useState<string | null>(null);
  const drag = useTreeDrag();

  const folders = useMemo(() => (tree ? collectFolders(tree) : []), [tree]);

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

  // New things land beside whatever the writer last touched: inside the folder
  // they opened, alongside the document they selected, at the root otherwise.
  // Same rule the Swift add menu follows.
  const target = lastFolder ?? (selectedPath ? parentOf(selectedPath) : "");

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
        <AddMenu onPick={(what) => setComposer({ what, parent: target })} />
      </div>

      {/* `--sb-zoom` scales only what is inside this container. The quick views
          above and the rail below keep their size on purpose: this is the
          *navigator* zoom, the way Swift means it, not an app-wide text size. */}
      <div
        className="sb-tree"
        style={{ "--sb-zoom": sidebarZoom } as CSSProperties}
        onClick={() => setMenuFor(null)}
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
              onClick: () => setComposer({ what: "file", parent: target }),
            }}
          />
        )}
        <TreeOpsContext.Provider
          value={{
            menuFor, setMenuFor, renaming, setRenaming, folders,
            noteTarget: setLastFolder, drag,
          }}
        >
          {shown?.children?.map((node) => (
            <TreeBranch
              key={node.path}
              node={node}
              depth={0}
              expanded={expanded}
              onToggle={toggleExpanded}
              selected={selectedPath}
              onSelect={selectPath}
            />
          ))}
        </TreeOpsContext.Provider>

        {/* The vault root as a drop target. Only while a drag is in flight, and
            only when the row is not already at the root — an always-visible
            strip would be a permanent 30px of chrome for a rare act, and one
            that refuses the drop is worse than one that is not there. */}
        {drag.allows("") && (
          <div
            className={`sb-droproot${drag.into === "" ? " on" : ""}`}
            onDragOver={(e) => {
              if (!drag.hover("")) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDragLeave={() => drag.leave("")}
            onDrop={(e) => { e.preventDefault(); drag.commit(""); }}
          >
            {/* "Vault root" is what the ⋯ menu's own destination list calls it
                — two names for one place would be two places. */}
            Move to the vault root
          </div>
        )}
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
 * Starred · Today · Manuscript — the three shortcuts that sit above the
 * WORKFLOW eyebrow in the Swift app (SWIFT-AUDIT §1.4).
 *
 * They use the tree's own row shape on purpose: these are places in the vault,
 * and giving them a second visual language would make the top of the sidebar
 * look like a toolbar someone bolted on.
 */
function QuickViews() {
  const tree = useVault((s) => s.tree);
  const view = useVault((s) => s.view);
  const expanded = useVault((s) => s.expanded);
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
      if (!expanded.has(node.path)) toggleExpanded(node.path);
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

      {/* Outline and Corkboard are two faces of the same manuscript surface,
          so the row reads as active in both. */}
      <button
        className={`sb-row sb-quick-row${view !== "editor" ? " selected" : ""}`}
        onClick={() => setView("outline")}
      >
        <span className="sb-caret" />
        <BookIcon size={12} color="var(--ink-soft)" />
        <span className="sb-label">Manuscript</span>
        <span className="sb-quick-key">⌘2</span>
      </button>
    </div>
  );
}

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

function TreeBranch({
  node,
  depth,
  expanded,
  onToggle,
  selected,
  onSelect,
}: {
  node: VaultNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const ops = useTreeOps();
  const drag = ops.drag;
  const isFolder = node.kind === "folder";
  const isOpen = expanded.has(node.path);
  const isSelected = selected === node.path;
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
      drag.begin(node.path);
    },
    onDragEnd: () => drag.end(),
  };

  // Only folders accept a drop. A file row is not a target: "into the folder
  // this file happens to live in" is a guess, and a guess that moves files is
  // the wrong kind of convenience.
  const target = {
    onDragOver: (e: ReactDragEvent<HTMLDivElement>) => {
      // No preventDefault when the move is illegal or a no-op — that is how the
      // engine is told "not here", cursor included.
      if (!drag.hover(node.path)) return;
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
      drag.leave(node.path);
    },
    onDrop: (e: ReactDragEvent<HTMLDivElement>) => {
      e.preventDefault();
      drag.commit(node.path);
    },
  };

  const wrapClass = [
    "sb-rowwrap",
    drag.path === node.path ? "sb-dragging" : "",
    drag.into === node.path ? "sb-drop-into" : "",
  ].filter(Boolean).join(" ");

  if (ops.renaming === node.path) {
    return (
      <>
        <RenameRow node={node} indent={indent} />
        {isFolder && isOpen && node.children?.map((child) => (
          <TreeBranch key={child.path} node={child} depth={depth + 1} expanded={expanded}
            onToggle={onToggle} selected={selected} onSelect={onSelect} />
        ))}
      </>
    );
  }

  if (isFolder) {
    return (
      <>
        <div className={wrapClass} {...source} {...target}>
          <button
            className={`sb-row sb-folder${isSelected ? " selected" : ""}`}
            style={{ paddingLeft: scaled(indent) }}
            onClick={() => { ops.noteTarget(node.path); onToggle(node.path); }}
            onContextMenu={(e) => { e.preventDefault(); ops.setMenuFor(node.path); }}
          >
            <span className="sb-caret">
              <Caret open={isOpen} color="var(--ink-soft)" />
            </span>
            <FolderIcon size={12} color="var(--ink-soft)" />
            <span className="sb-label">{node.name}</span>
            <span className="sb-count">{node.children?.length ?? 0}</span>
            <StarAffordance path={node.path} />
            <MoreAffordance path={node.path} />
          </button>
          <RowMenu node={node} />
        </div>
        {isOpen &&
          node.children?.map((child) => (
            <TreeBranch
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              selected={selected}
              onSelect={onSelect}
            />
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
        onClick={() => { ops.noteTarget(parentOf(node.path)); onSelect(node.path); }}
        onContextMenu={(e) => { e.preventDefault(); ops.setMenuFor(node.path); }}
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
        <DeleteAffordance path={node.path} />
      </button>
      <RowMenu node={node} />
    </div>
  );
}

/** The row, replaced by a text field, while it is being renamed. */
function RenameRow({ node, indent }: { node: VaultNode; indent: number }) {
  const renameEntry = useVault((s) => s.renameEntry);
  const ops = useTreeOps();
  const [name, setName] = useState(node.name);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  async function submit() {
    if (busy) return;
    if (!name.trim() || name === node.name) { ops.setRenaming(null); return; }
    setBusy(true);
    const to = await renameEntry(node.path, name);
    setBusy(false);
    if (to) ops.setRenaming(null);
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
          if (e.key === "Escape") ops.setRenaming(null);
        }}
        onBlur={() => { if (!busy) void submit(); }}
      />
    </div>
  );
}

/**
 * Star / Open in Split View / Rename / Move to… — the row's context menu, also
 * on the "⋯" button. Swift's row menu, minus the Finder items (SWIFT-AUDIT
 * §1.4).
 */
function RowMenu({ node }: { node: VaultNode }) {
  const ops = useTreeOps();
  const moveEntry = useVault((s) => s.moveEntry);
  const starredPaths = useFavorites((s) => s.starred);
  const toggleFavorite = useFavorites((s) => s.toggle);
  const [picking, setPicking] = useState(false);
  const starred = starredPaths.has(node.path);
  const isFile = node.kind !== "folder";

  useEffect(() => { if (ops.menuFor !== node.path) setPicking(false); }, [ops.menuFor, node.path]);

  if (ops.menuFor !== node.path) return null;

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
      onMouseLeave={() => ops.setMenuFor(null)}
    >
      {!picking ? (
        <>
          <button
            className="sb-menu-item"
            onClick={() => { ops.setMenuFor(null); void toggleFavorite(node.path); }}
          >{starred ? "Unstar" : "Star"}</button>
          {isFile && (
            <button
              className="sb-menu-item"
              onClick={() => {
                ops.setMenuFor(null);
                // Editable, not reference — the pane's own header switches it
                // to read-only, and the writer asked for a second editor.
                useSplit.getState().openSplit(node.path, false);
                // The split only exists in the editor view.
                useVault.getState().setView("editor");
              }}
            >Open in Split View</button>
          )}
          <button
            className="sb-menu-item"
            onClick={() => { ops.setMenuFor(null); ops.setRenaming(node.path); }}
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
                ops.setMenuFor(null);
                void moveEntry(node.path, folder);
              }}
            >{folder || "Vault root"}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The star on a tree row.
 *
 * Always visible once the row is starred — that is the whole point of it — and
 * revealed on hover otherwise, so an unstarred tree stays quiet. The same flip
 * is in the row's ⋯ menu and in the command palette, because a hover-only
 * control is not a control on a trackpad-less machine.
 */
function StarAffordance({ path }: { path: string }) {
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
}

function MoreAffordance({ path }: { path: string }) {
  const ops = useTreeOps();
  return (
    <span
      className="sb-more"
      role="button"
      title="Rename or move"
      onClick={(e) => {
        e.stopPropagation();
        ops.setMenuFor(ops.menuFor === path ? null : path);
      }}
    >⋯</span>
  );
}

/** Hover-revealed soft-delete — moves the file to Recently Deleted. */
function DeleteAffordance({ path }: { path: string }) {
  const current = useVault((s) => s.current);
  const removeFromTree = useVault((s) => s.removeFromTree);
  return (
    <span
      className="sb-del"
      role="button"
      title="Move to Recently Deleted"
      onClick={(e) => {
        e.stopPropagation();
        if (!current) return;
        if (!window.confirm(`Move "${path}" to Recently Deleted?`)) return;
        // Evict first: a pending debounced save would resurrect the file.
        useEditor.getState().evict(path);
        void trashFile(current.id, path).then(() => {
          removeFromTree(path);
          // The backend already dropped the star (`ops::trash_entry`); this is
          // the sidebar catching up without another round trip.
          useFavorites.getState().forget(path);
        });
      }}
    >×</span>
  );
}

function FileGlyph({ kind }: { kind: NodeKind }) {
  const color = "var(--ink-mute)";
  const size = 12;
  if (kind === "fountain") return <ScreenplayIcon size={size} color={color} />;
  if (kind === "image") return <ImageIcon size={size} color={color} />;
  if (kind === "pdf") return <PdfIcon size={size} color={color} />;
  return <FileIcon size={size} color={color} />;
}

/**
 * The workflow switcher, as a chip pinned to the bottom of the sidebar — the
 * Swift app's shape (SWIFT-AUDIT §1.4), and the fix for the port's own version
 * of it, which was the sidebar *title* with a 10px caret: a control nobody
 * could find because it did not look like one ("I cannot switch workflows",
 * PARITY §3).
 *
 * The popover opens upward, since the chip is at the bottom of the column.
 */
function WorkflowChip() {
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
}
