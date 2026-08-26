import type { ChapterStatus, VaultNode } from "@/types/vault";
import { useVault } from "@/state/vaultStore";
import { findNode } from "./ManuscriptView";

const STATUS_COLOR: Record<ChapterStatus, string> = {
  final: "var(--success)",
  drafting: "var(--starred)",
  rev: "var(--warn)",
  outline: "var(--ink-mute)",
};

export function Corkboard({
  chapters, tree,
}: { chapters: string[]; tree: VaultNode }) {
  const { selectPath, setView } = useVault();

  return (
    <div className="ms-corkboard">
      {chapters.map((path, idx) => {
        const node = findNode(tree, path);
        const status = (node?.frontmatter?.status as ChapterStatus | undefined) ?? "outline";
        const title = (node?.frontmatter?.title as string | undefined) ?? node?.name ?? path;
        const synopsis = (node?.frontmatter?.synopsis as string | undefined)
          ?? "No synopsis yet — write a line of frontmatter and it'll show up here.";
        const num = String(idx + 1).padStart(2, "0");
        return (
          <article
            key={path}
            className={`ms-card ms-card-${status}`}
            onClick={() => { selectPath(path); setView("editor"); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { selectPath(path); setView("editor"); }
            }}
            tabIndex={0}
          >
            <header className="ms-card-head">
              <span className="ms-card-num">Ch {num}</span>
              <span
                className="ms-card-dot"
                style={{ background: STATUS_COLOR[status] }}
              />
              <span className="ms-card-status">{status}</span>
            </header>
            <h3 className="ms-card-title">{title}</h3>
            <p className="ms-card-syn">{synopsis}</p>
            <footer className="ms-card-foot">
              {node?.words?.toLocaleString() ?? "—"} words
            </footer>
          </article>
        );
      })}
      <button className="ms-card ms-card-add" aria-label="Add card">
        <span>+ Add card</span>
      </button>
    </div>
  );
}
