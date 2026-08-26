import { useState } from "react";
import type { Chapter, ChapterStatus, VaultNode } from "@/types/vault";
import { useVault } from "@/state/vaultStore";
import "./Rail.css";

interface ChapterRailProps {
  /** absolute paths in chapterOrder (matches manuscript.chapterOrder) */
  chapters: string[];
  selected: string | null;
  onSelect: (path: string) => void;
  onReorder?: (next: string[]) => void;
}

const STATUS_COLOR: Record<ChapterStatus, string> = {
  final: "var(--success)",
  drafting: "var(--starred)",
  rev: "var(--warn)",
  outline: "var(--ink-mute)",
};

export function ChapterRail({ chapters, selected, onSelect, onReorder }: ChapterRailProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const { tree } = useVault();

  const items = chapters.map((p) => ({ path: p, node: findNode(tree, p) }));

  function handleDrop(toIdx: number) {
    if (!onReorder || dragFrom === null || dragFrom === toIdx) {
      setDragFrom(null);
      setDragOver(null);
      return;
    }
    const next = [...chapters];
    const [moved] = next.splice(dragFrom, 1);
    next.splice(toIdx, 0, moved);
    onReorder(next);
    setDragFrom(null);
    setDragOver(null);
  }

  if (collapsed) {
    return (
      <div className="rail rail-collapsed" aria-label="Chapter rail">
        <button
          className="rail-toggle"
          onClick={() => setCollapsed(false)}
          aria-label="Expand chapter rail"
        >
          ⌃
        </button>
      </div>
    );
  }

  return (
    <div className="rail" aria-label="Chapter rail">
      <header className="rail-head">
        <span className="rail-title">Chapters</span>
        <button
          className="rail-toggle"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse chapter rail"
        >
          ›
        </button>
      </header>

      <ol className="rail-list">
        {items.map(({ path, node }, idx) => {
          const isSelected = path === selected;
          const isDragOver = dragOver === idx;
          const fm = node?.frontmatter;
          const status = (fm?.status as ChapterStatus | undefined) ?? "outline";
          const num = String(idx + 1).padStart(2, "0");
          const title = fm?.title ?? node?.name ?? path;
          const chapter: Chapter = {
            n: idx + 1,
            title,
            words: node?.words ?? 0,
            status,
          };
          return (
            <li
              key={path}
              className={`rail-item${isSelected ? " selected" : ""}${isDragOver ? " drag-over" : ""}`}
              draggable
              onDragStart={() => setDragFrom(idx)}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(idx);
              }}
              onDragLeave={() => setDragOver((v) => (v === idx ? null : v))}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(idx);
              }}
              onClick={() => onSelect(path)}
            >
              <span className="rail-grip" aria-hidden>⋮⋮</span>
              <span
                className="rail-status-dot"
                style={{ background: STATUS_COLOR[status] }}
                aria-label={status}
              />
              <span className="rail-num">{num}</span>
              <span className="rail-title-cell">{chapter.title}</span>
              <span className="rail-words">{chapter.words ? chapter.words.toLocaleString() : "—"}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function findNode(node: VaultNode | null, path: string): VaultNode | null {
  if (!node) return null;
  if (node.path === path) return node;
  if (!node.children) return null;
  for (const c of node.children) {
    const hit = findNode(c, path);
    if (hit) return hit;
  }
  return null;
}
