import { useMemo } from "react";
import { Overlay } from "@/components/overlays/Overlay";
import { useConflict } from "@/state/conflictStore";
import { useEditor } from "@/state/editorStore";
import { WarnIcon } from "@/icons";
import "./ConflictDialog.css";

export function ConflictDialog() {
  const { pending, resolve } = useConflict();
  const flushSave = useEditor((s) => s.flushSave);

  const diff = useMemo(
    () => (pending ? lineDiff(pending.mine, pending.theirs) : []),
    [pending],
  );
  if (!pending) return null;

  function keepMine() {
    void flushSave(pending!.path).then(resolve);
  }
  function takeTheirs() {
    // Replace editor body with disk version; will mark dirty=false since
    // editorStore needs an explicit reload — we simulate via flushSave after
    // editing back to theirs.
    useEditor.setState((s) => ({
      docs: {
        ...s.docs,
        [pending!.path]: {
          ...s.docs[pending!.path],
          body: pending!.theirs,
          status: "saved",
        },
      },
    }));
    resolve();
  }

  return (
    <Overlay title="" width={720} onClose={resolve}>
      <div className="cf">
        <header className="cf-head">
          <WarnIcon size={18} color="var(--warn)" />
          <div>
            <div className="cf-title">{pending.path} changed on disk</div>
            <div className="cf-sub">
              Another writer or your sync provider modified this file while you were editing.
              Pick which version to keep — Aquarius will save the choice and clear the conflict.
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
          <button className="cf-cancel" onClick={resolve}>Decide later</button>
          <span className="cf-spacer" />
          <button className="cf-take" onClick={takeTheirs}>Take disk version</button>
          <button className="cf-keep" onClick={keepMine}>Keep mine</button>
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
