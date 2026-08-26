import {
  Caret,
  FileIcon,
  FolderIcon,
  ImageIcon,
  PdfIcon,
  ScreenplayIcon,
} from "@/icons";
import { useEffect, useState } from "react";
import type { ChapterStatus, NodeKind, VaultNode } from "@/types/vault";
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

export function Sidebar() {
  const { current, tree, expanded, toggleExpanded, selectedPath, selectPath } = useVault();
  const overlay = useOverlay();

  if (!current || !tree) return null;

  return (
    <aside className="sidebar">
      <WorkflowSwitcher />

      <div className="sb-tree">
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
  const isFolder = node.kind === "folder";
  const isOpen = expanded.has(node.path);
  const isSelected = selected === node.path;

  if (isFolder) {
    return (
      <>
        <button
          className="sb-row sb-folder"
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => onToggle(node.path)}
        >
          <span className="sb-caret">
            <Caret open={isOpen} color="var(--ink-soft)" />
          </span>
          <FolderIcon size={12} color="var(--ink-soft)" />
          <span className="sb-label">{node.name}</span>
          <span className="sb-count">{node.children?.length ?? 0}</span>
        </button>
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
    <button
      className={`sb-row sb-file${isSelected ? " selected" : ""}`}
      style={{ paddingLeft: 10 + depth * 14 + 14 }}
      onClick={() => onSelect(node.path)}
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
      <DeleteAffordance path={node.path} />
    </button>
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
