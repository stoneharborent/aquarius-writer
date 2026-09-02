import { useState } from "react";
import type { VaultNode } from "@/types/vault";
import { useVault } from "@/state/vaultStore";
import { findNode, statusOf, STATUS_COLOR, STATUS_LABEL } from "@/lib/manuscript";

export function Outline({
  chapters, tree, onReorder,
}: {
  chapters: string[];
  tree: VaultNode;
  /**
   * The rearranged list. Taken as a prop rather than calling the store
   * directly, because the list this component is drawing may be a *filtered*
   * view of the manuscript — only the parent knows how to put a filtered
   * order back into the whole one (`spliceFiltered`).
   */
  onReorder: (next: string[]) => void;
}) {
  const selectPath = useVault((s) => s.selectPath);
  const setView = useVault((s) => s.setView);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  function handleDrop(toIdx: number) {
    if (dragFrom === null || dragFrom === toIdx) {
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

  return (
    <ol className="ms-outline">
      {chapters.map((path, idx) => {
        const node = findNode(tree, path);
        const status = statusOf(node);
        const title = (node?.frontmatter?.title as string | undefined) ?? node?.name ?? path;
        const synopsis = node?.frontmatter?.synopsis as string | undefined;
        const num = String(idx + 1).padStart(2, "0");
        const isDragOver = dragOver === idx;

        return (
          <li
            key={path}
            className={`ms-outline-row${isDragOver ? " drag-over" : ""}`}
            draggable
            onDragStart={() => setDragFrom(idx)}
            onDragOver={(e) => { e.preventDefault(); setDragOver(idx); }}
            onDragLeave={() => setDragOver((v) => (v === idx ? null : v))}
            onDrop={(e) => { e.preventDefault(); handleDrop(idx); }}
            onDoubleClick={() => { selectPath(path); setView("editor"); }}
          >
            <span className="ms-outline-grip" aria-hidden>⋮⋮</span>
            <span className="ms-outline-num">Ch {num}</span>
            <span
              className="ms-outline-dot"
              style={{ background: STATUS_COLOR[status] }}
              aria-label={STATUS_LABEL[status]}
            />
            <div className="ms-outline-main">
              <div className="ms-outline-title">{title}</div>
              {synopsis && <div className="ms-outline-syn">{synopsis}</div>}
            </div>
            <span className="ms-outline-words">
              {node?.words?.toLocaleString() ?? "—"}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
