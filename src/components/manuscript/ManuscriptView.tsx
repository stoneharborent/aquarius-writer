import { useMemo } from "react";
import { BookIcon } from "@/icons";
import { useVault } from "@/state/vaultStore";
import type { ChapterStatus, VaultNode } from "@/types/vault";
import { Outline } from "./Outline";
import { Corkboard } from "./Corkboard";
import "./Manuscript.css";

export function ManuscriptView() {
  const current = useVault((s) => s.current);
  const tree = useVault((s) => s.tree);
  const view = useVault((s) => s.view);
  const activeDraftId = useVault((s) => s.activeDraftId);
  const setView = useVault((s) => s.setView);
  const setActiveDraft = useVault((s) => s.setActiveDraft);
  if (!current || !tree) return null;

  const manuscript = current.manuscripts[0];
  const activeDraft = current.drafts.find((d) => d.id === activeDraftId) ?? current.drafts[0];
  const chapters = activeDraft?.chapterOrder ?? manuscript?.chapterOrder ?? [];

  const stats = useMemo(() => collectStats(tree, chapters), [tree, chapters]);

  return (
    <div className="manuscript">
      <div className="ms-tabs">
        <BookIcon size={13} color="var(--ink-soft)" strokeWidth={1.3} />
        <span className="ms-tabs-name">Manuscript</span>
        <span className="ms-tabs-spacer" />
        <TabPill active={view === "outline"} onClick={() => setView("outline")}>Outline</TabPill>
        <TabPill active={view === "corkboard"} onClick={() => setView("corkboard")}>Cards</TabPill>
        <TabPill onClick={() => setView("editor")}>Editor</TabPill>
      </div>

      <div className="ms-scroll">
        <div className="ms-inner">
          <div className="ms-eyebrow">Working manuscript</div>
          <h1 className="ms-title">{current.title}</h1>

          <div className="ms-section-head">Drafts</div>
          <div className="ms-drafts">
            {current.drafts.map((d) => (
              <button
                key={d.id}
                className={`ms-draft${d.id === activeDraftId ? " active" : ""}`}
                onClick={() => setActiveDraft(d.id)}
              >
                <div className="ms-draft-name">
                  {d.id === activeDraftId && <span className="ms-draft-dot" />}
                  {d.name}
                </div>
                <div className="ms-draft-meta">
                  {d.chapterOrder.length} chapters · {stats.totalWords.toLocaleString()} words
                </div>
              </button>
            ))}
          </div>

          <div className="ms-section-row">
            <span className="ms-section-head no-margin">
              {view === "corkboard" ? "Cards" : "Chapters · drag to reorder"}
            </span>
            <span className="ms-section-meta">
              {chapters.length} chapters · {stats.totalWords.toLocaleString()} words ·
              ~{Math.round(stats.totalWords / 250)} pages · {readTime(stats.totalWords)} read
            </span>
          </div>

          {view === "corkboard" ? (
            <Corkboard chapters={chapters} tree={tree} />
          ) : (
            <Outline chapters={chapters} tree={tree} />
          )}

          <div className="ms-summary">
            <span>{chapters.length} chapters</span>
            <span className="ms-summary-rule" />
            <span>{stats.totalWords.toLocaleString()} words</span>
            <span className="ms-summary-rule" />
            <span>~{Math.round(stats.totalWords / 250)} pages</span>
            <span className="ms-summary-rule" />
            <span>{readTime(stats.totalWords)} read</span>
            <span className="ms-summary-spacer" />
            <span className="ms-summary-touched">last touched today</span>
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

export function collectStats(tree: VaultNode, chapters: string[]) {
  let totalWords = 0;
  const statusCounts: Record<ChapterStatus, number> = {
    final: 0, drafting: 0, rev: 0, outline: 0,
  };
  for (const path of chapters) {
    const n = findNode(tree, path);
    if (!n) continue;
    totalWords += n.words ?? 0;
    const s = n.frontmatter?.status as ChapterStatus | undefined;
    if (s) statusCounts[s]++;
  }
  return { totalWords, statusCounts };
}

export function findNode(node: VaultNode | null, path: string): VaultNode | null {
  if (!node) return null;
  if (node.path === path) return node;
  if (!node.children) return null;
  for (const c of node.children) {
    const hit = findNode(c, path);
    if (hit) return hit;
  }
  return null;
}

function readTime(words: number): string {
  const min = Math.round(words / 250);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
