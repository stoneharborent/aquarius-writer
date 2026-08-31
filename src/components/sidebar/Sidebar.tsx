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
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChapterStatus, NewFileKind, NodeKind, VaultNode } from "@/types/vault";
import { useVault } from "@/state/vaultStore";
import { useOverlay } from "@/state/overlayStore";
import { useFavorites } from "@/state/favoritesStore";
import { trashFile } from "@/lib/vault/aux";
import { useEditor } from "@/state/editorStore";
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
}

const TreeOpsContext = createContext<TreeOps | null>(null);
const useTreeOps = () => useContext(TreeOpsContext)!;

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

export function Sidebar() {
  const { current, tree, expanded, toggleExpanded, selectedPath, selectPath } = useVault();
  const overlay = useOverlay();
  const [composer, setComposer] = useState<Composer | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [lastFolder, setLastFolder] = useState<string | null>(null);

  const folders = useMemo(() => (tree ? collectFolders(tree) : []), [tree]);

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
        <AddMenu onPick={(what) => setComposer({ what, parent: target })} />
      </div>

      <div className="sb-tree" onClick={() => setMenuFor(null)}>
        {composer && (
          <Composer
            what={composer.what}
            parent={composer.parent}
            onDone={() => setComposer(null)}
          />
        )}
        <TreeOpsContext.Provider
          value={{ menuFor, setMenuFor, renaming, setRenaming, folders, noteTarget: setLastFolder }}
        >
          {tree.children?.map((node) => (
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
      </div>

      <div className="sb-rail">
        <button className="sb-rail-btn" onClick={() => overlay.open("today")}>Today</button>
        <button className="sb-rail-btn" onClick={() => overlay.open("graph")}>Graph</button>
        <button className="sb-rail-btn" onClick={() => overlay.open("find")}>Find</button>
        <button className="sb-rail-btn" onClick={() => overlay.open("trash")}>Trash</button>
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
  const { tree, view, setView, selectPath, toggleExpanded, expandAll, expanded } = useVault();
  const overlay = useOverlay();
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
          <p className="sb-quick-empty">
            Nothing starred yet — star a row from its ⋯ menu.
          </p>
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

      <button className="sb-row sb-quick-row" onClick={() => overlay.open("today")}>
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
  const { createFile, createFolder } = useVault();
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
  const isFolder = node.kind === "folder";
  const isOpen = expanded.has(node.path);
  const isSelected = selected === node.path;
  const indent = 10 + depth * 14 + (isFolder ? 0 : 14);

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
        <div className="sb-rowwrap">
          <button
            className={`sb-row sb-folder${isSelected ? " selected" : ""}`}
            style={{ paddingLeft: indent }}
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
    <div className="sb-rowwrap">
      <button
        className={`sb-row sb-file${isSelected ? " selected" : ""}`}
        style={{ paddingLeft: indent }}
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
  const { renameEntry } = useVault();
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
    <div className="sb-row sb-renaming" style={{ paddingLeft: indent }}>
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

/** Star / Rename / Move to… — the row's context menu, also on the "⋯" button. */
function RowMenu({ node }: { node: VaultNode }) {
  const ops = useTreeOps();
  const { moveEntry } = useVault();
  const favorites = useFavorites();
  const [picking, setPicking] = useState(false);
  const starred = favorites.starred.has(node.path);

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
            onClick={() => { ops.setMenuFor(null); void favorites.toggle(node.path); }}
          >{starred ? "Unstar" : "Star"}</button>
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
  const { current, removeFromTree } = useVault();
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
  const {
    current, workflows, workflowsLoading, pending,
    fetchWorkflows, openWorkflow, closeWorkflow, addWorkflowFromFolder,
  } = useVault();
  const overlay = useOverlay();
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
            onClick={() => { setOpen(false); overlay.open("settings", { tab: "workflows" }); }}
          >
            Manage workflows…
          </button>
        </div>
      )}
    </div>
  );
}
