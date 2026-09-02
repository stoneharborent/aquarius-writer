import { useMemo, useState } from "react";
import { BookIcon } from "@/icons";
import { useVault } from "@/state/vaultStore";
import type { ChapterStatus } from "@/types/vault";
import {
  collectStats,
  findNode,
  pagesFor,
  spliceFiltered,
  statusOf,
  STATUS_COLOR,
  STATUS_LABEL,
  STATUS_ORDER,
} from "@/lib/manuscript";
import { Outline } from "./Outline";
import { Corkboard } from "./Corkboard";
import "./Manuscript.css";

// `findNode` and `collectStats` used to live in this file and are now in
// `@/lib/manuscript`, beside the front-matter convention and the page formula
// they belong with — and, crucially, somewhere the Corkboard and the rails can
// import them from without importing this component back.

export function ManuscriptView() {
  const current = useVault((s) => s.current);
  const tree = useVault((s) => s.tree);
  const view = useVault((s) => s.view);
  const activeDraftId = useVault((s) => s.activeDraftId);
  const activeManuscriptId = useVault((s) => s.activeManuscriptId);
  const setView = useVault((s) => s.setView);
  const setActiveDraft = useVault((s) => s.setActiveDraft);
  const reorderChapters = useVault((s) => s.reorderChapters);

  /**
   * Which statuses the outline and the corkboard are showing. Empty means all
   * of them — the chips are a filter, and a filter nobody has touched should
   * hide nothing. Deliberately shared by both views: they are two drawings of
   * one list, and a filter that reset when you pressed Cards would be a filter
   * you had to set twice.
   */
  const [filter, setFilter] = useState<Set<ChapterStatus>>(new Set());

  const manuscript =
    current?.manuscripts.find((m) => m.id === activeManuscriptId) ?? current?.manuscripts[0];

  // The cut being shown: the active draft when it belongs to this manuscript,
  // the manuscript's own order otherwise. A folder-backed draft belongs to the
  // manuscript its folder sits inside; a plain named cut belongs to all of them.
  const drafts = useMemo(
    () =>
      (current?.drafts ?? []).filter(
        (d) => !d.folder || (manuscript && d.folder.startsWith(`${manuscript.folder}/`)),
      ),
    [current?.drafts, manuscript],
  );
  const activeDraft = drafts.find((d) => d.id === activeDraftId) ?? drafts[0];
  const chapters = useMemo(
    () => activeDraft?.chapterOrder ?? manuscript?.chapterOrder ?? [],
    [activeDraft, manuscript],
  );

  const stats = useMemo(() => collectStats(tree, chapters), [tree, chapters]);

  const visible = useMemo(
    () =>
      filter.size === 0
        ? chapters
        : chapters.filter((p) => filter.has(statusOf(findNode(tree, p)))),
    [chapters, filter, tree],
  );
  const shownWords = useMemo(
    () => (filter.size === 0 ? stats.words : collectStats(tree, visible).words),
    [filter, stats.words, tree, visible],
  );

  if (!current || !tree) return null;

  function toggleStatus(s: ChapterStatus) {
    setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  /**
   * A drag inside a *filtered* view rearranges only the chapters the filter
   * kept; everything hidden stays exactly where it was. `reorderChapters`
   * refuses anything that is not a permutation of the whole order, so the
   * filtered order is spliced back into the full one before it is sent.
   */
  function handleReorder(nextVisible: string[]) {
    void reorderChapters(
      filter.size === 0 ? nextVisible : spliceFiltered(chapters, visible, nextVisible),
    );
  }

  return (
    <div className="manuscript">
      <div className="ms-tabs">
        <BookIcon size={13} color="var(--ink-soft)" strokeWidth={1.3} />
        <span className="ms-tabs-name">{manuscript?.title ?? "Manuscript"}</span>
        {current.manuscripts.length > 1 && (
          <button className="ms-back" onClick={() => setView("home")}>
            ‹ All manuscripts
          </button>
        )}
        <span className="ms-tabs-spacer" />
        <TabPill active={view === "outline"} onClick={() => setView("outline")}>Outline</TabPill>
        <TabPill active={view === "corkboard"} onClick={() => setView("corkboard")}>Cards</TabPill>
        <TabPill onClick={() => setView("editor")}>Editor</TabPill>
      </div>

      <div className="ms-scroll">
        <div className="ms-inner">
          <div className="ms-eyebrow">Working manuscript</div>
          <h1 className="ms-title">{manuscript?.title ?? current.title}</h1>

          <div className="ms-section-head">Drafts</div>
          <div className="ms-drafts">
            {drafts.map((d) => {
              const draftStats = collectStats(tree, d.chapterOrder);
              return (
                <button
                  key={d.id}
                  className={`ms-draft${d.id === activeDraft?.id ? " active" : ""}`}
                  onClick={() => void setActiveDraft(d.id)}
                >
                  <div className="ms-draft-name">
                    {d.id === activeDraft?.id && <span className="ms-draft-dot" />}
                    {d.name}
                  </div>
                  <div className="ms-draft-meta">
                    {d.chapterOrder.length} chapters · {draftStats.words.toLocaleString()} words
                  </div>
                </button>
              );
            })}
          </div>

          {/* The status chips, with the counts that make them worth pressing —
              SWIFT-AUDIT §2.2. They filter the outline and the corkboard
              together, and a status with no chapters in it is still shown so
              the row does not change shape as work moves through it. */}
          <div className="ms-section-head ms-filter-head">Status</div>
          <div className="ms-filters">
            {STATUS_ORDER.map((s) => (
              <button
                key={s}
                className={`ms-filter${filter.has(s) ? " on" : ""}`}
                aria-pressed={filter.has(s)}
                disabled={stats.statusCounts[s] === 0 && !filter.has(s)}
                onClick={() => toggleStatus(s)}
              >
                <span className="ms-filter-dot" style={{ background: STATUS_COLOR[s] }} />
                {STATUS_LABEL[s]}
                <span className="ms-filter-count">{stats.statusCounts[s]}</span>
              </button>
            ))}
            {filter.size > 0 && (
              <button className="ms-filter ms-filter-clear" onClick={() => setFilter(new Set())}>
                Show all
              </button>
            )}
          </div>

          <div className="ms-section-row">
            <span className="ms-section-head no-margin">
              {view === "corkboard" ? "Cards" : "Chapters · drag to reorder"}
            </span>
            <span className="ms-section-meta">
              {filter.size > 0 && `${visible.length} of `}
              {chapters.length} chapters · {shownWords.toLocaleString()} words ·
              ~{pagesFor(shownWords)} pages · {readTime(shownWords)} read
            </span>
          </div>

          {visible.length === 0 ? (
            <p className="ms-nomatch">
              No chapter is at{" "}
              {[...filter].map((s) => STATUS_LABEL[s].toLowerCase()).join(" or ")} right now.
            </p>
          ) : view === "corkboard" ? (
            <Corkboard chapters={visible} tree={tree} />
          ) : (
            <Outline chapters={visible} tree={tree} onReorder={handleReorder} />
          )}

          {/* "N chapters · N words · ~N pages" — pages is words / 250 rounded
              up, the paperback rule of thumb, and the same number the home
              card and the MCP `list_manuscripts` tool quote (lib/manuscript). */}
          <div className="ms-summary">
            <span>{chapters.length} chapters</span>
            <span className="ms-summary-rule" />
            <span>{stats.words.toLocaleString()} words</span>
            <span className="ms-summary-rule" />
            <span>~{pagesFor(stats.words)} pages</span>
            <span className="ms-summary-rule" />
            <span>{readTime(stats.words)} read</span>
            <span className="ms-summary-spacer" />
            <span className="ms-summary-touched">{manuscript?.folder}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabPill({
  active, onClick, children,
}: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`ms-pill${active ? " active" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

function readTime(words: number): string {
  const min = Math.round(words / 250);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
