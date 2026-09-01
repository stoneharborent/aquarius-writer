// Workflow-wide Find & Replace (⇧⌘F) — web mirror of FindReplaceSheet.swift.
import { useEffect, useRef, useState } from "react";
import { Overlay } from "./Overlay";
import { useVault } from "@/state/vaultStore";
import { useOverlay } from "@/state/overlayStore";
import { useEditor } from "@/state/editorStore";
import { replaceInFile, searchWorkflow, type SearchHit } from "@/lib/vault/aux";
import { EmptyState } from "@/components/shell/EmptyState";
import "./FindReplace.css";

export function FindReplace() {
  const { current, tree, selectPath, setView } = useVault();
  const close = useOverlay((s) => s.close);
  // Seeded when the top bar's ⌘K capsule handed its words over on Enter.
  const seed = useOverlay((s) => s.payload.query);
  const [query, setQuery] = useState(seed ?? "");
  const [replace, setReplace] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!current || !tree) return;
    if (timer.current) clearTimeout(timer.current);
    if (query.trim().length < 2) { setHits([]); return; }
    timer.current = setTimeout(async () => {
      setBusy(true);
      try { setHits(await searchWorkflow(current.id, tree, query.trim())); }
      finally { setBusy(false); }
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query, current, tree]);

  const jump = (hit: SearchHit) => {
    selectPath(hit.path);
    setView("editor");
    close();
  };

  const replaceIn = async (hit: SearchHit) => {
    if (!current) return;
    const res = await replaceInFile(current.id, hit.path, query, replace);
    if (!res) return;
    setNote(`Replaced ${res.replaced} in ${hit.path}`);
    // Drop any open editor copy so it reloads the rewritten file. `evict`
    // rather than deleting the key by hand: it also cancels the buffer's
    // debounced save, which would otherwise land on a file this replace just
    // rewrote and raise a conflict for a document nobody is looking at.
    useEditor.getState().evict(hit.path);
    if (tree) setHits(await searchWorkflow(current.id, tree, query.trim()));
  };

  return (
    <Overlay title="Find in workflow" width={680}>
      <div className="fr">
        <div className="fr-inputs">
          <input autoFocus placeholder="Find…" value={query}
            onChange={(e) => setQuery(e.target.value)} />
          <input placeholder="Replace with…" value={replace}
            onChange={(e) => setReplace(e.target.value)} />
        </div>
        {note && <p className="fr-note">{note}</p>}
        <div className="fr-hits">
          {busy && <p className="fr-idle">Searching…</p>}
          {!busy && query.trim().length >= 2 && hits.length === 0 && (
            <EmptyState
              art="search"
              headline="Nothing in this workflow says that"
              subline={<>No document contains “{query.trim()}”. Try a shorter
                phrase, or check the spelling.</>}
            />
          )}
          {hits.map((h) => (
            <div key={h.path} className="fr-hit">
              <button className="fr-hit-main" onClick={() => jump(h)}>
                <span className="fr-path">{h.path}</span>
                <span className="fr-preview">{h.preview}</span>
              </button>
              <span className="fr-count">{h.count}×</span>
              {replace !== "" && (
                <button className="fr-replace" onClick={() => void replaceIn(h)}>
                  Replace all
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </Overlay>
  );
}
