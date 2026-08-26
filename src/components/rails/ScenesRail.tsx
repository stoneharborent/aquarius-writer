import { useState } from "react";
import type { SceneIndex } from "@/lib/fountain";
import "./Rail.css";

interface ScenesRailProps {
  scenes: SceneIndex[];
  activeIndex: number | null;
  onSelect: (idx: number) => void;
}

export function ScenesRail({ scenes, activeIndex, onSelect }: ScenesRailProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <div className="rail rail-collapsed" aria-label="Scenes rail">
        <button className="rail-toggle" onClick={() => setCollapsed(false)} aria-label="Expand scenes rail">⌃</button>
      </div>
    );
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
          return (
            <li
              key={`${s.from}-${idx}`}
              className={`rail-item${isSelected ? " selected" : ""}`}
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

function parseSlug(slug: string): { prefix: string; label: string } {
  const m = /^(INT\.\/EXT\.|INT\.|EXT\.|EST\.|I\/E\.)\s+(.*)$/.exec(slug);
  if (!m) return { prefix: "·", label: slug };
  return { prefix: m[1].replace(".", ""), label: m[2] };
}
