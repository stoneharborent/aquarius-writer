import {
  Caret,
  FileIcon,
  FolderIcon,
  ImageIcon,
  PdfIcon,
  PlusIcon,
  ScreenplayIcon,
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
      <WorkflowSwitcher />

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
    </aside>
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

/** Rename / Move to… — the row's context menu, also on the "⋯" button. */
function RowMenu({ node }: { node: VaultNode }) {
  const ops = useTreeOps();
  const { moveEntry } = useVault();
  const [picking, setPicking] = useState(false);

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
        void trashFile(current.id, path).then(() => removeFromTree(path));
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

/** Sidebar-header workflow switcher — web mirror of WorkflowSwitcher.swift.
 * Click the workflow name to switch to any other connected workflow or go
 * back to the picker. */
function WorkflowSwitcher() {
  const { current, workflows, fetchWorkflows, openWorkflow, closeWorkflow } = useVault();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open && workflows.length === 0) void fetchWorkflows();
  }, [open, workflows.length, fetchWorkflows]);

  if (!current) return null;
  return (
    <header className="sb-header sb-switcher">
      <button className="sb-switch-btn" onClick={() => setOpen((o) => !o)}
        title="Switch workflow">
        <span className="sb-name">{current.title}</span>
        <span className="sb-kind">{current.kind}</span>
        <Caret open={open} color="var(--ink-mute)" />
      </button>
      {open && (
        <div className="sb-switch-menu" onMouseLeave={() => setOpen(false)}>
          {workflows.map((w) => (
            <button key={w.id}
              className={`sb-switch-item${w.id === current.id ? " on" : ""}`}
              onClick={() => { setOpen(false); void openWorkflow(w.id); }}>
              {w.name}
              <span className="sb-switch-meta">{w.items} items</span>
            </button>
          ))}
          <button className="sb-switch-item sb-switch-all"
            onClick={() => { setOpen(false); closeWorkflow(); }}>
            ← All workflows
          </button>
        </div>
      )}
    </header>
  );
}
