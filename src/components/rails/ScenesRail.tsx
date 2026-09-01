import { useState } from "react";
import type { SceneIndex } from "@/lib/fountain";
import { Gutter } from "@/components/shell/Gutter";
import "./Rail.css";

interface ScenesRailProps {
  scenes: SceneIndex[];
  activeIndex: number | null;
  onSelect: (idx: number) => void;
  /**
   * Drag finished: move scene `from` to position `to`.
   *
   * The rail does not rewrite anything itself. It hands the move to the pane,
   * which runs the same `reorderScenes` the MCP tool's Rust twin runs and
   * pushes the result through the editor buffer — so the rewrite is one undo
   * away and one conflict-guarded save away, like every other edit.
   * Absent (the split pane, a script with no scenes) → the rail is read-only.
   */
  onReorder?: (from: number, to: number) => void;
}

export function ScenesRail({ scenes, activeIndex, onSelect, onReorder }: ScenesRailProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  function endDrag() {
    setDragFrom(null);
    setDragOver(null);
  }

  function handleDrop(toIdx: number) {
    if (!onReorder || dragFrom === null || dragFrom === toIdx) return endDrag();
    onReorder(dragFrom, toIdx);
    endDrag();
  }

  // Same 28px gutter as every other collapsed pane — SWIFT-AUDIT §1.3.
  if (collapsed) {
    return <Gutter label="Scenes" side="right" onOpen={() => setCollapsed(false)} />;
  }

  return (
    <div className="rail" aria-label="Scenes rail">
      <header className="rail-head">
        <span className="rail-title">Scenes</span>
        <button className="rail-toggle" onClick={() => setCollapsed(true)} aria-label="Collapse scenes rail">›</button>
      </header>

      <ol className="rail-list">
        {scenes.map((s, idx) => {
          const isSelected = idx === activeIndex;
          const slug = parseSlug(s.slug);
          // Slide-into-place: every row between the grabbed one and the drop
          // target shifts one slot, so the gap the scene will land in is open
          // before the writer lets go. Purely a transform — nothing about the
          // list order changes until the drop rewrites the script.
          const shift = slideOffset(idx, dragFrom, dragOver);
          return (
            <li
              key={`${s.from}-${idx}`}
              className={
                "rail-item rail-scene" +
                (isSelected ? " selected" : "") +
                (dragFrom === idx ? " dragging" : "") +
                (shift !== 0 ? " sliding" : "")
              }
              style={shift !== 0 ? { transform: `translateY(${shift * 100}%)` } : undefined}
              draggable={!!onReorder}
              onDragStart={(e) => {
                if (!onReorder) return;
                e.dataTransfer.effectAllowed = "move";
                // Firefox refuses to start a drag without payload.
                e.dataTransfer.setData("text/plain", String(idx));
                setDragFrom(idx);
              }}
              onDragOver={(e) => {
                if (!onReorder || dragFrom === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOver(idx);
              }}
              onDragLeave={() => setDragOver((v) => (v === idx ? null : v))}
              onDragEnd={endDrag}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(idx);
              }}
              onClick={() => onSelect(idx)}
            >
              <span className="rail-grip" aria-hidden>⋮⋮</span>
              <span className="rail-scene-prefix">{slug.prefix}</span>
              <span className="rail-num">{String(idx + 1).padStart(2, "0")}</span>
              <span className="rail-title-cell">{slug.label}</span>
              {s.number && <span className="rail-words">#{s.number}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * How far row `idx` slides while a drag is in flight: −1 up, +1 down, 0 still.
 * The grabbed row itself never slides — it is under the cursor.
 */
export function slideOffset(idx: number, from: number | null, over: number | null): number {
  if (from === null || over === null || from === over || idx === from) return 0;
  if (from < over) return idx > from && idx <= over ? -1 : 0;
  return idx >= over && idx < from ? 1 : 0;
}

function parseSlug(slug: string): { prefix: string; label: string } {
  const m = /^(INT\.\/EXT\.|INT\.|EXT\.|EST\.|I\/E\.)\s+(.*)$/i.exec(slug);
  if (!m) return { prefix: "·", label: slug };
  return { prefix: m[1].replace(".", "").toUpperCase(), label: m[2] };
}
