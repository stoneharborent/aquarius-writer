import { useMemo, useState } from "react";
import { Overlay } from "@/components/overlays/Overlay";
import { useConflict } from "@/state/conflictStore";
import { useEditor, type Resolution } from "@/state/editorStore";
import { notices } from "@/state/noticeStore";
import { WarnIcon } from "@/icons";
import "./ConflictDialog.css";

/**
 * "This file changed while you were editing it. Which version wins?"
 *
 * Three answers, matching the Swift app (SWIFT-AUDIT §2.3), and **nothing is
 * ever lost by any of them**: whichever version a choice discards is written
 * into the document's version history first, so it is one click away in the
 * Versions panel. The work is `editorStore.resolveConflict` — this component
 * shows the two texts and takes the answer.
 *
 * "Decide later" is a real option too. Closing the dialog leaves the buffer
 * dirty and unsaved with every character intact; the next save will raise this
 * again rather than quietly overwriting anything.
 */
export function ConflictDialog() {
  const { pending, resolve } = useConflict();
  const resolveConflict = useEditor((s) => s.resolveConflict);
  const [busy, setBusy] = useState<Resolution | null>(null);

  const diff = useMemo(
    () => (pending ? lineDiff(pending.mine, pending.theirs) : []),
    [pending],
  );
  if (!pending) return null;

  const choose = (choice: Resolution) => {
    if (busy) return;
    setBusy(choice);
    void resolveConflict(pending.path, choice)
      .catch((e) => notices.fail("Could not resolve the conflict", e))
      .finally(() => {
        setBusy(null);
        resolve();
      });
  };

  return (
    <Overlay title="" width={720} onClose={resolve}>
      <div className="cf">
        <header className="cf-head">
          <WarnIcon size={18} color="var(--warn)" />
          <div>
            <div className="cf-title">{pending.path} changed on disk</div>
            <div className="cf-sub">
              Another program — a sync client, a script, an AI assistant — changed this file
              while you were editing it. Nothing has been written yet. Whichever version you
              don’t keep is saved into this document’s version history first, so you can get
              it back.
            </div>
          </div>
        </header>

        <div className="cf-grid">
          <section className="cf-pane">
            <div className="cf-pane-head">Yours · in editor</div>
            <pre className="cf-pre">{collapseEmpty(pending.mine)}</pre>
          </section>
          <section className="cf-pane">
            <div className="cf-pane-head">Theirs · on disk</div>
            <pre className="cf-pre">{collapseEmpty(pending.theirs)}</pre>
          </section>
        </div>

        <div className="cf-diff">
          <div className="cf-pane-head">Differences (line-level)</div>
          <ol className="cf-diff-list">
            {diff.map((d, i) => (
              <li key={i} className={`cf-diff-${d.kind}`}>
                <span className="cf-diff-marker">{d.kind === "add" ? "+" : d.kind === "del" ? "−" : " "}</span>
                <span className="cf-diff-text">{d.text || "·"}</span>
              </li>
            ))}
            {diff.length === 0 && <li className="cf-diff-empty">Files are identical now — nothing to merge.</li>}
          </ol>
        </div>

        <footer className="cf-foot">
          <button className="cf-cancel" onClick={resolve} disabled={!!busy}>Decide later</button>
          <span className="cf-spacer" />
          <button
            className="cf-take"
            disabled={!!busy}
            title="Save your version as a separate file beside this one, then open the disk version here"
            onClick={() => choose("saveMineAsCopy")}
          >{busy === "saveMineAsCopy" ? "Saving…" : "Save mine as a copy"}</button>
          <button
            className="cf-take"
            disabled={!!busy}
            title="Discard your unsaved edits and open what is on disk"
            onClick={() => choose("takeTheirs")}
          >{busy === "takeTheirs" ? "Loading…" : "Take disk version"}</button>
          <button
            className="cf-keep"
            disabled={!!busy}
            title="Overwrite the file with your version"
            onClick={() => choose("keepMine")}
          >{busy === "keepMine" ? "Saving…" : "Keep mine"}</button>
        </footer>
      </div>
    </Overlay>
  );
}

function collapseEmpty(s: string): string {
  return s.length === 0 ? "(empty)" : s;
}

interface DiffLine { kind: "ctx" | "add" | "del"; text: string; }

/** Line-by-line diff; not LCS, just paired walk — good enough for the
 * conflict preview, real merging is deferred to the user. */
function lineDiff(a: string, b: string): DiffLine[] {
  const al = a.split("\n");
  const bl = b.split("\n");
  const out: DiffLine[] = [];
  const n = Math.max(al.length, bl.length);
  for (let i = 0; i < n; i++) {
    const x = al[i], y = bl[i];
    if (x === y) {
      if (x !== undefined) out.push({ kind: "ctx", text: x });
    } else {
      if (x !== undefined) out.push({ kind: "del", text: x });
      if (y !== undefined) out.push({ kind: "add", text: y });
    }
  }
  return out;
}
