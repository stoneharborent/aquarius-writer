import { useEffect, useRef, useState } from "react";
import type { VaultNode } from "@/types/vault";
import { useVault } from "@/state/vaultStore";
import { findNode, statusOf, STATUS_COLOR } from "@/lib/manuscript";

const PLACEHOLDER = "No synopsis yet — write one here and it saves to the chapter.";

export function Corkboard({
  chapters, tree,
}: { chapters: string[]; tree: VaultNode }) {
  const selectPath = useVault((s) => s.selectPath);
  const setView = useVault((s) => s.setView);

  return (
    <div className="ms-corkboard">
      {chapters.map((path, idx) => {
        const node = findNode(tree, path);
        const status = statusOf(node);
        const title = (node?.frontmatter?.title as string | undefined) ?? node?.name ?? path;
        const num = String(idx + 1).padStart(2, "0");
        return (
          <article key={path} className={`ms-card ms-card-${status}`}>
            <header
              className="ms-card-head"
              onClick={() => { selectPath(path); setView("editor"); }}
            >
              <span className="ms-card-num">Ch {num}</span>
              <span className="ms-card-dot" style={{ background: STATUS_COLOR[status] }} />
              <span className="ms-card-status">{status}</span>
            </header>
            <h3
              className="ms-card-title"
              onClick={() => { selectPath(path); setView("editor"); }}
            >
              {title}
            </h3>
            <Synopsis path={path} value={node?.frontmatter?.synopsis as string | undefined} />
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

/**
 * The synopsis, edited on the card — Scrivener's behaviour, and SWIFT-AUDIT
 * §2.2's ("committed to frontmatter"). This is the one place in the app where
 * a document is written without being opened, so two things matter:
 *
 * * **It commits on blur, not per keystroke.** A card is a small box someone
 *   types a sentence into and clicks away from; saving on every letter would
 *   put a write on the disk (and a snapshot behind it) for each one.
 * * **It is never a whole-file write.** `vaultStore.setSynopsis` flushes any
 *   open buffer for the chapter, then goes through the backend's
 *   `ops::set_synopsis`, which is frontmatter line surgery — the body survives
 *   byte for byte, as does every other key in the block — and reconciles the
 *   buffer afterwards. The whole conflict apparatus of NOTES §20 stays intact:
 *   we are not overwriting a file we last read some time ago.
 */
function Synopsis({ path, value }: { path: string; value: string | undefined }) {
  const setSynopsis = useVault((s) => s.setSynopsis);
  const [text, setText] = useState(value ?? "");
  const [editing, setEditing] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  // A change from elsewhere — an MCP client's `set_synopsis`, an edit to the
  // file — wins, but never while the writer is mid-sentence in this box.
  useEffect(() => {
    if (!editing) setText(value ?? "");
  }, [value, editing]);

  if (!editing) {
    return (
      <p
        className={`ms-card-syn${text ? "" : " empty"}`}
        role="button"
        tabIndex={0}
        title="Click to write a synopsis"
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); setEditing(true); }
        }}
      >
        {text || PLACEHOLDER}
      </p>
    );
  }

  return (
    <textarea
      ref={box}
      className="ms-card-syn ms-card-syn-edit"
      value={text}
      autoFocus
      placeholder={PLACEHOLDER}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false);
        void setSynopsis(path, text.trim());
      }}
      onKeyDown={(e) => {
        // Escape abandons the edit; the card goes back to what is on disk.
        if (e.key === "Escape") {
          e.preventDefault();
          setText(value ?? "");
          setEditing(false);
          return;
        }
        // ⌘/Ctrl+Enter commits without reaching for the mouse. A plain Enter
        // is a new line: a synopsis is prose, and often more than one.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          box.current?.blur();
        }
      }}
    />
  );
}
