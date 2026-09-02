// Workflow-wide Find & Replace (⇧⌘F) — web mirror of FindReplaceSheet.swift.
//
// Two searches live behind one sheet, chosen with a segmented control on the
// input row: **Exact** is the substring match this has always done, and **By
// meaning** ranks passages by what they are about. Exact is the default and is
// always one click away, which is the honesty the pandoc work established —
// a small model is a good small model, not magic, so the plain search must
// never be more than a click from wherever a writer has ended up.
//
// The Replace column hides under By meaning. Replacing "everything that means
// this" is not an operation anyone should be offered.
import { useEffect, useRef, useState } from "react";
import { Overlay } from "./Overlay";
import { useVault } from "@/state/vaultStore";
import { useOverlay } from "@/state/overlayStore";
import { useEditor } from "@/state/editorStore";
import { replaceInFile, searchWorkflow, type SearchHit } from "@/lib/vault/aux";
import {
  downloadSemanticModel,
  formatModelSize,
  isRefusal,
  onSemanticState,
  probeSemantic,
  searchSemantic,
  type SemanticHit,
  type SemanticStatus,
} from "@/lib/semantic";
import { EmptyState } from "@/components/shell/EmptyState";
import "./FindReplace.css";

type Mode = "exact" | "meaning";

export function FindReplace() {
  const current = useVault((s) => s.current);
  const tree = useVault((s) => s.tree);
  const selectPath = useVault((s) => s.selectPath);
  const setView = useVault((s) => s.setView);
  const close = useOverlay((s) => s.close);
  // Seeded when the top bar's ⌘K capsule handed its words over on Enter.
  const seed = useOverlay((s) => s.payload.query);
  const [mode, setMode] = useState<Mode>("exact");
  const [query, setQuery] = useState(seed ?? "");
  const [replace, setReplace] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [meaningHits, setMeaningHits] = useState<SemanticHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [semantic, setSemantic] = useState<SemanticStatus | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Asked once when the sheet opens, so the By meaning tab already knows which
  // of its four states it is in before anyone clicks it — the same reason the
  // Compile sheet probes for pandoc on open rather than on run.
  useEffect(() => {
    void probeSemantic().then(setSemantic);
    return onSemanticState(setSemantic);
  }, []);

  useEffect(() => {
    if (!current || !tree) return;
    if (timer.current) clearTimeout(timer.current);
    if (query.trim().length < 2) { setHits([]); setMeaningHits([]); return; }
    if (mode === "meaning" && !semantic?.available) { setMeaningHits([]); return; }
    timer.current = setTimeout(async () => {
      setBusy(true);
      try {
        if (mode === "exact") {
          setHits(await searchWorkflow(current.id, tree, query.trim()));
        } else {
          setMeaningHits(await searchSemantic(current.id, tree, query.trim()));
        }
      } catch (e) {
        // A refusal is an answer, not a crash: the card below already says
        // what is missing, so there is nothing to report here.
        if (!isRefusal(e)) setNote(String(e));
        setMeaningHits([]);
      } finally {
        setBusy(false);
      }
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query, current, tree, mode, semantic?.available]);

  const jump = (path: string) => {
    selectPath(path);
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

  const download = async () => {
    setDownloadError(null);
    try { setSemantic(await downloadSemanticModel()); }
    catch (e) { setDownloadError(String(e)); }
  };

  const asked = query.trim().length >= 2;

  return (
    <Overlay title="Find in workflow" width={680}>
      <div className="fr">
        <div className="fr-inputs">
          <div className="fr-modes" role="tablist" aria-label="How to search">
            {(["exact", "meaning"] as Mode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                className={`fr-mode${mode === m ? " active" : ""}`}
                onClick={() => setMode(m)}
              >
                {m === "exact" ? "Exact" : "By meaning"}
              </button>
            ))}
          </div>
          <input autoFocus placeholder={mode === "exact" ? "Find…" : "Describe the passage…"}
            value={query} onChange={(e) => setQuery(e.target.value)} />
          {mode === "exact" && (
            <input placeholder="Replace with…" value={replace}
              onChange={(e) => setReplace(e.target.value)} />
          )}
        </div>
        {note && <p className="fr-note">{note}</p>}

        {mode === "meaning" && semantic?.indexing && (
          <p className="fr-idle">
            Indexing {semantic.indexing.done} of {semantic.indexing.total} documents…
            Results are from what is done so far.
          </p>
        )}

        <div className="fr-hits">
          {busy && <p className="fr-idle">Searching…</p>}

          {/* ── the model card ── the one place the 35 MB is asked for. */}
          {mode === "meaning" && semantic && !semantic.available && (
            <ModelCard
              status={semantic}
              error={downloadError}
              onDownload={() => void download()}
              onExact={() => setMode("exact")}
            />
          )}

          {!busy && mode === "exact" && asked && hits.length === 0 && (
            <EmptyState
              art="search"
              headline="Nothing in this workflow says that"
              subline={<>No document contains “{query.trim()}”. Try a shorter
                phrase, or check the spelling.</>}
            />
          )}

          {!busy && mode === "meaning" && semantic?.available && asked
            && meaningHits.length === 0 && (
            <EmptyState
              art="search"
              headline="Nothing in this workflow is about that"
              subline={<>Try describing the passage in a sentence — “the scene
                where she decides to leave” rather than a single word.</>}
            />
          )}

          {mode === "exact" && hits.map((h) => (
            <div key={h.path} className="fr-hit">
              <button className="fr-hit-main" onClick={() => jump(h.path)}>
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

          {mode === "meaning" && semantic?.available && meaningHits.map((h) => (
            <div key={h.path} className="fr-hit">
              <button className="fr-hit-main" onClick={() => jump(h.path)}>
                <span className="fr-path">{h.path}</span>
                <span className="fr-preview">{h.preview}</span>
                <span className="fr-where">
                  {h.chunks} passage{h.chunks === 1 ? "" : "s"} · best match line {h.line + 1}
                </span>
              </button>
              <span className="fr-count">{Math.round(h.score * 100)}</span>
            </div>
          ))}
        </div>
      </div>
    </Overlay>
  );
}

/**
 * What By meaning shows when there is no model on this machine.
 *
 * Deliberately a card in the results slot rather than a disabled tab: the
 * feature is real, it just needs one thing, and saying so is more use than
 * greying something out. The wording says "by meaning" and never "AI search",
 * and it says out loud that nothing leaves the computer — because that is the
 * question a writer actually has about a 35 MB download.
 */
function ModelCard({
  status, error, onDownload, onExact,
}: {
  status: SemanticStatus;
  error: string | null;
  onDownload: () => void;
  onExact: () => void;
}) {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return (
    <div className="fr-card">
      <p className="fr-card-head">Search by meaning</p>
      <p className="fr-card-body">
        This needs a one-time {formatModelSize(status.downloadBytes)} model
        download ({status.modelId.split("/")[1]}, {status.modelLicence}). It
        runs on this computer and never sends your writing anywhere.
      </p>

      {status.phase === "downloading" ? (
        <div
          className="st-progress"
          role="progressbar"
          aria-valuenow={status.percent ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${status.percent ?? 0}%` }} />
        </div>
      ) : (
        <div className="fr-card-actions">
          <button className="fr-replace" disabled={offline} onClick={onDownload}>
            Download
          </button>
          <button className="fr-replace" onClick={onExact}>
            Use exact search instead
          </button>
        </div>
      )}

      {offline && (
        <p className="fr-card-note">No connection — try again when you're online.</p>
      )}
      {error && <p className="fr-card-note">{error}</p>}
      {!offline && !error && status.phase === "error" && status.message && (
        <p className="fr-card-note">{status.message}</p>
      )}
    </div>
  );
}
