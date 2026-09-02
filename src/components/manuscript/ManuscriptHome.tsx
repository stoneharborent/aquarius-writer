import { useMemo } from "react";
import { BookIcon } from "@/icons";
import { EmptyState } from "@/components/shell/EmptyState";
import { useVault } from "@/state/vaultStore";
import { collectStats, pagesFor, STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from "@/lib/manuscript";
import "./Manuscript.css";

/**
 * The vault's manuscripts, as cards — SWIFT-AUDIT §2.2's ManuscriptHome, the
 * one piece of the manuscript system this port had no equivalent of at all.
 *
 * It sits behind the sidebar's Manuscript quick view (⌘2), which is the choice
 * the audit left open: it names the screen and says it is a home, but not what
 * opens it. Putting it on the entry that already means "the manuscript" gives
 * the feature one door rather than inventing a second one for it.
 *
 * The numbers come out of the tree the store is already holding — the same
 * arithmetic `ops::list_manuscripts` does on the Rust side for an MCP client,
 * kept in `lib/manuscript.ts` so the two cannot quote different lengths for the
 * same book.
 */
export function ManuscriptHome() {
  const current = useVault((s) => s.current);
  const tree = useVault((s) => s.tree);
  const openManuscript = useVault((s) => s.openManuscript);

  const cards = useMemo(() => {
    if (!current || !tree) return [];
    return current.manuscripts.map((m) => {
      const stats = collectStats(tree, m.chapterOrder);
      return { manuscript: m, chapters: m.chapterOrder.length, ...stats };
    });
  }, [current, tree]);

  if (!current || !tree) return null;

  return (
    <div className="manuscript">
      <div className="ms-tabs">
        <BookIcon size={13} color="var(--ink-soft)" strokeWidth={1.3} />
        <span className="ms-tabs-name">Manuscripts</span>
        <span className="ms-tabs-spacer" />
        <span className="ms-tabs-hint">
          {cards.length === 1 ? "1 manuscript" : `${cards.length} manuscripts`}
        </span>
      </div>

      <div className="ms-scroll">
        <div className="ms-inner">
          <div className="ms-eyebrow">Working on</div>
          <h1 className="ms-title">{current.title}</h1>

          {cards.length === 0 ? (
            <EmptyState
              art="book"
              headline="No manuscript marked yet"
              subline={
                "A manuscript is just a folder you have named as the one the book lives in. " +
                "Find it in the sidebar, open its ⋯ menu and choose Mark as Manuscript."
              }
            />
          ) : (
            <div className="ms-home-grid">
              {cards.map(({ manuscript, chapters, words, statusCounts }) => (
                <button
                  key={manuscript.id}
                  className="ms-home-card"
                  onClick={() => openManuscript(manuscript.id)}
                >
                  <div className="ms-home-icon">
                    <BookIcon size={20} color="var(--accent)" strokeWidth={1.2} />
                  </div>
                  <h2 className="ms-home-name">{manuscript.title}</h2>
                  <div className="ms-home-folder">{manuscript.folder}</div>
                  <div className="ms-home-bar" aria-hidden>
                    {STATUS_ORDER.map((s) =>
                      statusCounts[s] > 0 ? (
                        <span
                          key={s}
                          className="ms-home-bar-part"
                          style={{
                            background: STATUS_COLOR[s],
                            flexGrow: statusCounts[s],
                          }}
                          title={`${statusCounts[s]} ${STATUS_LABEL[s]}`}
                        />
                      ) : null,
                    )}
                  </div>
                  <div className="ms-home-meta">
                    {chapters} {chapters === 1 ? "chapter" : "chapters"} ·{" "}
                    {words.toLocaleString()} words · ~{pagesFor(words)} pages
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
