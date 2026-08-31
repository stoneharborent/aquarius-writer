// Right pane — Comments + Versions tabs. Collapsible.
//
// There is no third tab. The embedded AI panel this pane once made room for
// was cut in Stage 5 (Royce, 2026-08-25: no embedded agent); external AI apps
// drive the vault through the MCP server instead — see src-tauri/src/mcp/.
import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelRightIcon } from "@/icons";
import { useVault } from "@/state/vaultStore";
import { useEditor } from "@/state/editorStore";
import { useOverlay } from "@/state/overlayStore";
import { useShell } from "@/state/shellStore";
import {
  addComment,
  deleteComment,
  listComments,
  listVersions,
  restoreVersion,
  setCommentResolved,
  takeSnapshot,
  type CommentEntry,
  type VersionEntry,
} from "@/lib/vault/aux";
import { formatBus } from "@/lib/format/formatBus";
import { stringify } from "@/lib/frontmatter";
import "./RightPane.css";

/**
 * Which tab is showing and whether the pane is open both live in `shellStore`
 * now, not here: the top bar's Comments / Versions buttons and ⌘⌥\ drive the
 * same state, and the collapsed pane is a 28px gutter drawn by MainWindow
 * rather than a stub of this component.
 */
export function RightPane() {
  const { current, selectedPath } = useVault();
  const tab = useShell((s) => s.rightTab);
  const setRightTab = useShell((s) => s.setRightTab);
  const setRightCollapsed = useShell((s) => s.setRightCollapsed);

  return (
    <aside className="rp">
      <header className="rp-tabs">
        <button className={`rp-tab${tab === "comments" ? " on" : ""}`}
          onClick={() => setRightTab("comments")}>Comments</button>
        <button className={`rp-tab${tab === "versions" ? " on" : ""}`}
          onClick={() => setRightTab("versions")}>Versions</button>
        <span className="rp-spacer" />
        <button className="rp-collapse" title="Hide pane (⌘⌥\)"
          onClick={() => setRightCollapsed(true)}>
          <PanelRightIcon size={14} />
        </button>
      </header>
      {!current || !selectedPath ? (
        <p className="rp-idle">Open a document to see its {tab}.</p>
      ) : tab === "comments" ? (
        <CommentsTab wf={current.id} path={selectedPath} />
      ) : (
        <VersionsTab wf={current.id} path={selectedPath} />
      )}
    </aside>
  );
}

function CommentsTab({ wf, path }: { wf: string; path: string }) {
  const [comments, setComments] = useState<CommentEntry[]>([]);
  const [draft, setDraft] = useState("");
  const reload = useCallback(() => setComments(listComments(wf, path)), [wf, path]);
  useEffect(reload, [reload]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    // Anchor to the editor's current selection when there is one.
    const view = formatBus.target(path);
    const sel = view?.state.selection.main;
    const anchor = view && sel && !sel.empty
      ? view.state.sliceDoc(sel.from, Math.min(sel.to, sel.from + 80))
      : "";
    addComment(wf, path, anchor, text);
    setDraft("");
    reload();
  };

  const open = comments.filter((c) => !c.resolved);
  const resolved = comments.filter((c) => c.resolved);

  return (
    <div className="rp-body">
      <div className="rp-compose">
        <textarea
          value={draft}
          placeholder="Comment on this document — select text first to anchor it…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
        />
        <button className="rp-btn" disabled={!draft.trim()} onClick={submit}>
          Comment
        </button>
      </div>
      {comments.length === 0 && (
        <p className="rp-idle">No comments yet.</p>
      )}
      {open.map((c) => (
        <CommentCard key={c.id} c={c} wf={wf} path={path} onChange={reload} />
      ))}
      {resolved.length > 0 && <div className="rp-section">Resolved</div>}
      {resolved.map((c) => (
        <CommentCard key={c.id} c={c} wf={wf} path={path} onChange={reload} />
      ))}
    </div>
  );
}

function CommentCard({ c, wf, path, onChange }: {
  c: CommentEntry; wf: string; path: string; onChange: () => void;
}) {
  return (
    <article className={`rp-card${c.resolved ? " resolved" : ""}`}>
      {c.anchor && <blockquote className="rp-anchor">“{c.anchor}”</blockquote>}
      <p className="rp-text">{c.text}</p>
      <footer className="rp-card-foot">
        <time>{new Date(c.at).toLocaleString()}</time>
        <span className="rp-spacer" />
        <button className="rp-link" onClick={() => {
          setCommentResolved(wf, path, c.id, !c.resolved); onChange();
        }}>{c.resolved ? "Reopen" : "Resolve"}</button>
        <button className="rp-link danger" onClick={() => {
          deleteComment(wf, path, c.id); onChange();
        }}>Delete</button>
      </footer>
    </article>
  );
}

function VersionsTab({ wf, path }: { wf: string; path: string }) {
  const { docs, open: openDoc } = useEditor();
  const overlay = useOverlay();
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const reload = useCallback(() => setVersions(listVersions(wf, path)), [wf, path]);
  useEffect(reload, [reload]);
  const current = docs[path];
  // Versions store the FULL serialized doc (frontmatter + body) — same
  // representation the autosave trail records (editorStore.flushSave).
  const body = useMemo(
    () => (current ? stringify(current.frontmatter, current.body) : ""),
    [current],
  );

  const snapshot = () => {
    const label = window.prompt("Snapshot label:", "Snapshot");
    if (label === null) return;
    takeSnapshot(wf, path, label.trim() || "Snapshot", body);
    reload();
  };

  const restore = async (v: VersionEntry) => {
    if (!window.confirm(`Restore "${path}" to “${v.label}”?\nThe current text is snapshotted first.`)) return;
    await restoreVersion(wf, path, v.id, body);
    // Reload the doc from disk so the editor shows the restored text (evict
    // cancels the debounced save that would otherwise clobber the restore).
    const wfId = current?.workflowId ?? wf;
    useEditor.getState().evict(path);
    void openDoc(wfId, path);
    reload();
  };

  return (
    <div className="rp-body">
      <button className="rp-btn" onClick={snapshot}>📸 Take snapshot</button>
      {versions.length === 0 && <p className="rp-idle">No versions yet — they appear as you write.</p>}
      {versions.map((v) => (
        <article key={v.id} className="rp-card">
          <p className="rp-text">
            {v.label}{v.named ? " ★" : ""}
          </p>
          <footer className="rp-card-foot">
            <time>{new Date(v.at).toLocaleString()} · {v.words.toLocaleString()} w</time>
            <span className="rp-spacer" />
            <button className="rp-link" onClick={() =>
              overlay.open("version-diff", { path, versionId: v.id })
            }>Diff</button>
            <button className="rp-link danger" onClick={() => void restore(v)}>Restore</button>
          </footer>
        </article>
      ))}
    </div>
  );
}
