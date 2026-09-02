import { useMemo, useState } from "react";
import type { Chapter } from "@/types/vault";
import { useVault } from "@/state/vaultStore";
import { Gutter } from "@/components/shell/Gutter";
import {
  collectStats,
  findNode,
  frontMatterPath,
  pagesFor,
  statusOf,
  FRONT_MATTER_NAMES,
  STATUS_COLOR,
  type FrontMatterName,
} from "@/lib/manuscript";
import "./Rail.css";

interface ChapterRailProps {
  /** absolute paths in chapterOrder (matches manuscript.chapterOrder) */
  chapters: string[];
  selected: string | null;
  onSelect: (path: string) => void;
  onReorder?: (next: string[]) => void;
}

export function ChapterRail({ chapters, selected, onSelect, onReorder }: ChapterRailProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const tree = useVault((s) => s.tree);

  const stats = useMemo(() => collectStats(tree, chapters), [tree, chapters]);
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

  // Collapsed, the rail is the same 28px gutter the sidebar and the right pane
  // become — one idiom for every pane that folds away (SWIFT-AUDIT §1.3).
  if (collapsed) {
    return <Gutter label="Chapters" side="right" onOpen={() => setCollapsed(false)} />;
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

      {/* The aggregate, at the top of the rail (SWIFT-AUDIT §2.2). Pages is
          words / 250 rounded up — the same arithmetic the summary bar and the
          MCP `list_manuscripts` tool use, from `lib/manuscript`. */}
      <div className="rail-stats">
        <span>{chapters.length} ch</span>
        <span className="rail-stats-rule" />
        <span>{stats.words.toLocaleString()} words</span>
        <span className="rail-stats-rule" />
        <span>~{pagesFor(stats.words)}p</span>
      </div>

      <WorkingDraftPill />
      <FrontMatter selected={selected} onSelect={onSelect} />

      <div className="rail-section">Chapters</div>
      <ol className="rail-list">
        {items.map(({ path, node }, idx) => {
          const isSelected = path === selected;
          const isDragOver = dragOver === idx;
          const fm = node?.frontmatter;
          const status = statusOf(node);
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

/**
 * The Working Draft pill — SWIFT-AUDIT §2.2's "Working Draft menu pill".
 *
 * A menu, not a row of chips, because a rail is 244px wide and a vault can
 * hold several cuts. Switching writes `workflow.json` through the same
 * `ops::set_active_draft` the MCP `set_active_draft` tool calls, so the choice
 * is still there after a relaunch rather than being something this window
 * happened to remember.
 */
function WorkingDraftPill() {
  const drafts = useVault((s) => s.current?.drafts);
  const activeDraftId = useVault((s) => s.activeDraftId);
  const setActiveDraft = useVault((s) => s.setActiveDraft);
  const [open, setOpen] = useState(false);

  const list = drafts ?? [];
  if (list.length === 0) return null;
  const active = list.find((d) => d.id === activeDraftId) ?? list[0];

  return (
    <div className="rail-draft">
      <button
        className="rail-draft-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        // One cut and nothing to switch to: the pill still names the draft,
        // because "which version am I in" is worth knowing, but it does not
        // pretend to be a menu.
        disabled={list.length === 1}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="rail-draft-label">Working draft</span>
        <span className="rail-draft-name">{active.name}</span>
        {list.length > 1 && <span className="rail-draft-caret">⌄</span>}
      </button>
      {open && (
        <div className="rail-draft-menu" onMouseLeave={() => setOpen(false)}>
          {list.map((d) => (
            <button
              key={d.id}
              className={`rail-draft-item${d.id === active.id ? " on" : ""}`}
              onClick={() => { setOpen(false); void setActiveDraft(d.id); }}
            >
              {d.name}
              <span className="rail-draft-count">{d.chapterOrder.length}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * FRONT MATTER — Title page · Dedication · Epigraph (SWIFT-AUDIT §2.2).
 *
 * The audit names the section and not how the three files are found, so this
 * port settles it by convention and writes it down: a markdown file sitting
 * **directly in the manuscript's own folder**, named exactly `Title Page.md`,
 * `Dedication.md` or `Epigraph.md`, case ignored. `tree::chapter_paths_in`
 * leaves those out of the chapter order on the Rust side, so a title page is
 * never chapter one and never counted in "N chapters".
 *
 * All three rows are always shown. A slot with no file behind it is a "+" that
 * makes one — the alternative is a section that appears out of nowhere the
 * first time a writer happens to name a file correctly, which is not a feature
 * anyone could find.
 */
function FrontMatter({
  selected, onSelect,
}: { selected: string | null; onSelect: (path: string) => void }) {
  const manuscripts = useVault((s) => s.current?.manuscripts);
  const activeManuscriptId = useVault((s) => s.activeManuscriptId);
  const tree = useVault((s) => s.tree);
  const createFile = useVault((s) => s.createFile);

  const manuscript =
    (manuscripts ?? []).find((m) => m.id === activeManuscriptId) ?? (manuscripts ?? [])[0];
  if (!manuscript) return null;

  async function make(label: FrontMatterName) {
    if (!manuscript) return;
    const path = await createFile(manuscript.folder, label, "markdown");
    if (path) onSelect(path);
  }

  return (
    <>
      <div className="rail-section">Front matter</div>
      <ul className="rail-front">
        {FRONT_MATTER_NAMES.map((label) => {
          const path = frontMatterPath(manuscript.folder, label);
          const exists = findNode(tree, path) !== null;
          return (
            <li key={label}>
              <button
                className={`rail-front-item${path === selected ? " selected" : ""}${
                  exists ? "" : " missing"
                }`}
                title={exists ? path : `Create ${path}`}
                onClick={() => (exists ? onSelect(path) : void make(label))}
              >
                <span className="rail-front-name">{label}</span>
                <span className="rail-front-mark">{exists ? "" : "+"}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
