import { useCallback, useEffect, useMemo, useState } from "react";
import { Overlay } from "./Overlay";
import { useVault } from "@/state/vaultStore";
import { useOverlay } from "@/state/overlayStore";
import { DownloadIcon, FolderIcon } from "@/icons";
import {
  formatBytes,
  pickOutputFolder,
  probeCompile,
  revealCompiled,
  runCompile,
  slugify,
  splitDestination,
} from "@/lib/compile";
import { asCompileFailure } from "@/types/compile";
import type {
  CompileFailure,
  CompileFormatId,
  CompileProbe,
  CompileReport,
  CompileSource,
} from "@/types/compile";
import "./Compile.css";

type SourceKind = "manuscript" | "screenplay" | "notes";
type Format = {
  id: CompileFormatId;
  label: string;
  ext: string;
  description: string;
  /** which source kinds support this format */
  kinds: SourceKind[];
};

// HANDOFF §5. Every format is available to everyone — the tier gates that used
// to sit on EPUB / Word / FDX were removed with the rest of the pricing
// plumbing (Royce, 2026-08-25: the app is free).
//
// There were six cards here. **Final Draft (.fdx) is gone**, not gated: it is a
// friendly stub in the macOS Swift app too (SWIFT-AUDIT §2.4), and a card that
// cannot ever work is the same lie the "Pandoc bundled" footer used to tell.
// The fine print under the grid says what to do instead.
const FORMATS: Format[] = [
  { id: "markdown", label: "Markdown", ext: ".md", description: "Every chapter in order, in one plain-text file. Opens anywhere.", kinds: ["manuscript", "notes"] },
  { id: "pdf", label: "PDF", ext: ".pdf", description: "Page-laid-out, ready to print or send. Pandoc plus a TeX engine.", kinds: ["manuscript", "screenplay", "notes"] },
  { id: "epub", label: "EPUB", ext: ".epub", description: "Reflowable ebook. Submit to KDP, Apple Books, Kobo.", kinds: ["manuscript"] },
  { id: "docx", label: "Word", ext: ".docx", description: "Track-changes-friendly for editors and agents.", kinds: ["manuscript", "notes"] },
  { id: "fountain", label: "Fountain", ext: ".fountain", description: "Plain-text screenplay, round-tripped. Final Draft imports it.", kinds: ["screenplay"] },
];

type Phase =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; report: CompileReport }
  | { state: "failed"; error: CompileFailure };

export function Compile() {
  const current = useVault((s) => s.current);
  const selectedPath = useVault((s) => s.selectedPath);
  const activeDraftId = useVault((s) => s.activeDraftId);
  const close = useOverlay((s) => s.close);

  const sourceKind: SourceKind = useMemo(() => {
    if (selectedPath?.endsWith(".fountain")) return "screenplay";
    if (current?.manuscripts.length) return "manuscript";
    return "notes";
  }, [current, selectedPath]);

  // A screenplay or a loose note compiles *the open document*; a manuscript
  // compiles its chapters in the order workflow.json records.
  const source: CompileSource = useMemo(() => {
    if (sourceKind === "manuscript") {
      return {
        kind: "manuscript",
        manuscriptId: current?.manuscripts[0]?.id ?? null,
        draftId: activeDraftId ?? null,
      };
    }
    return { kind: "document", path: selectedPath ?? "" };
  }, [sourceKind, current, activeDraftId, selectedPath]);

  const [probe, setProbe] = useState<CompileProbe | null>(null);
  const [picked, setPicked] = useState<CompileFormatId>("pdf");
  const [profile, setProfile] = useState<string>("");
  const [destination, setDestination] = useState<string>("");
  const [phase, setPhase] = useState<Phase>({ state: "idle" });

  const format = FORMATS.find((f) => f.id === picked) ?? FORMATS[0];

  const title = useMemo(() => {
    if (sourceKind === "manuscript") {
      return current?.manuscripts[0]?.title ?? current?.title ?? "untitled";
    }
    const name = selectedPath?.split("/").pop() ?? current?.title ?? "untitled";
    return name.replace(/\.[^.]+$/, "");
  }, [sourceKind, current, selectedPath]);

  // Ask the backend what it can actually do before painting a card that would
  // fail on click.
  useEffect(() => {
    let live = true;
    probeCompile(current?.id ?? null)
      .then((p) => {
        if (!live) return;
        setProbe(p);
        // Land on something that works: PDF needs the most installed, so a
        // machine with no pandoc opens on Markdown instead of on a dead card.
        setPicked((now) =>
          p.availableFormats.includes(now) || p.availableFormats.length === 0 ? now : "markdown",
        );
      })
      .catch(() => live && setProbe(null));
    return () => {
      live = false;
    };
  }, [current?.id]);

  // The destination follows the format's extension until the writer edits it —
  // switching from PDF to EPUB should not leave ".pdf" on the end.
  useEffect(() => {
    setDestination((prev) => {
      const stem = prev ? splitDestination(prev).fileName : slugify(title);
      const folder = prev ? splitDestination(prev).directory : (probe?.defaultDirectory ?? "");
      // No folder yet: the probe has not answered and nothing has been picked.
      // Leave the field empty so the placeholder can say what to do.
      if (!folder || !stem) return prev;
      return `${folder.replace(/\/+$/, "")}/${stem}${format.ext}`;
    });
  }, [probe?.defaultDirectory, format.ext, title]);

  const profilesForFormat = useMemo(
    () => probe?.profiles.filter((p) => p.formats.includes(picked)) ?? [],
    [probe, picked],
  );
  useEffect(() => {
    // A profile that does not apply to the new format would be refused by the
    // backend, so reset to "the format's default" when the format changes.
    setProfile((now) => (profilesForFormat.some((p) => p.id === now) ? now : ""));
  }, [profilesForFormat]);

  /**
   * Whether this machine can produce that format right now.
   *
   * `!probe` — the answer has not come back yet — counts as available on
   * purpose: a card that flickers to "needs pandoc" and back is worse than one
   * that is briefly optimistic, and Compile re-checks before it runs anyway.
   */
  const installed = useCallback(
    (id: CompileFormatId) => !probe || probe.availableFormats.includes(id),
    [probe],
  );

  async function browse() {
    const folder = await pickOutputFolder();
    if (!folder) return;
    const { fileName } = splitDestination(destination);
    const stem = fileName || slugify(title);
    setDestination(`${folder.replace(/\/+$/, "")}/${stem}${format.ext}`);
    setPhase({ state: "idle" });
  }

  async function compile() {
    if (!current) return;
    const { directory, fileName } = splitDestination(destination);
    setPhase({ state: "running" });
    try {
      const report = await runCompile(current.id, {
        format: picked,
        source,
        profile: profile || undefined,
        outputDirectory: directory,
        fileName: fileName || undefined,
      });
      setPhase({ state: "done", report });
    } catch (err) {
      setPhase({ state: "failed", error: asCompileFailure(err) });
    }
  }

  const running = phase.state === "running";
  const blocked = !current || !destination.trim() || !installed(picked);

  return (
    <Overlay title="Compile / Export" width={720}>
      <div className="cm">
        <div className="cm-source">
          <span className="cm-eyebrow">Source</span>
          <span className="cm-source-label">
            {title} · {sourceKind}
          </span>
        </div>

        <div className="cm-section-head">Format</div>
        <div className="cm-grid">
          {FORMATS.map((f) => {
            const supported = f.kinds.includes(sourceKind);
            const ready = installed(f.id);
            const active = picked === f.id && supported;
            return (
              <button
                key={f.id}
                className={`cm-card${active ? " active" : ""}${supported ? "" : " disabled"}`}
                onClick={() => {
                  if (!supported) return;
                  setPicked(f.id);
                  setPhase({ state: "idle" });
                }}
                disabled={!supported}
              >
                <div className="cm-card-head">
                  <span className="cm-card-label">{f.label}</span>
                  <span className="cm-card-ext">{f.ext}</span>
                </div>
                <div className="cm-card-desc">{f.description}</div>
                {!supported && (
                  <span className="cm-incompat">Not available for {sourceKind}</span>
                )}
                {supported && !ready && (
                  <span className="cm-incompat cm-needs">
                    {f.id === "pdf" && probe?.pandoc ? "needs a PDF engine" : "needs pandoc"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <span className="cm-fdx">
          Final Draft (.fdx) is not exported — it is a stub in the macOS app too. Compile
          Fountain; Final Draft imports it directly.
        </span>

        {profilesForFormat.length > 0 && (
          <>
            <div className="cm-section-head">Profile</div>
            <div className="cm-profile">
              <select
                value={profile}
                onChange={(e) => {
                  setProfile(e.target.value);
                  setPhase({ state: "idle" });
                }}
              >
                <option value="">{profilesForFormat[0].label} (default)</option>
                {profilesForFormat.slice(1).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span className="cm-profile-note">
                {(profilesForFormat.find((p) => p.id === profile) ?? profilesForFormat[0]).note}
              </span>
            </div>
          </>
        )}

        <div className="cm-section-head">Output</div>
        <div className="cm-output">
          <input
            type="text"
            value={destination}
            onChange={(e) => {
              setDestination(e.target.value);
              setPhase({ state: "idle" });
            }}
            spellCheck={false}
            placeholder="Choose a folder with Browse…"
          />
          <button className="cm-browse" onClick={browse} disabled={running}>
            Browse…
          </button>
        </div>

        {phase.state === "done" && (
          <div className="cm-result">
            <div className="cm-result-line">
              <strong>{phase.report.fileName}</strong> · {formatBytes(phase.report.bytes)} ·{" "}
              {phase.report.chapters} chapter{phase.report.chapters === 1 ? "" : "s"} ·{" "}
              {phase.report.words.toLocaleString()} words
              {phase.report.engine ? ` · rendered with ${phase.report.engine}` : ""}
            </div>
            <div className="cm-result-path">{phase.report.directory}</div>
            {phase.report.renamed && (
              <div className="cm-result-note">
                That name was taken, so this one is numbered — nothing was overwritten.
              </div>
            )}
            {phase.report.missing.length > 0 && (
              <div className="cm-result-note">
                Skipped {phase.report.missing.length} chapter
                {phase.report.missing.length === 1 ? "" : "s"} that are no longer on disk:{" "}
                {phase.report.missing.join(", ")}
              </div>
            )}
            <button className="cm-reveal" onClick={() => revealCompiled(phase.report.path)}>
              <FolderIcon size={12} />
              Show in folder
            </button>
          </div>
        )}

        {phase.state === "failed" && (
          <div className="cm-error">
            <div className="cm-error-line">{phase.error.message}</div>
            {phase.error.hint && <div className="cm-error-hint">{phase.error.hint}</div>}
          </div>
        )}

        <footer className="cm-foot">
          <span className="cm-fine">
            {probe?.pandoc
              ? `${probe.pandocVersion ?? "pandoc"} found. Exports run locally — nothing leaves your machine.`
              : "Markdown and Fountain always work. EPUB, Word and PDF need pandoc installed."}
          </span>
          <span className="cm-spacer" />
          <button className="cm-cancel" onClick={close}>
            Cancel
          </button>
          <button className="cm-go" onClick={compile} disabled={blocked || running}>
            <DownloadIcon size={13} color="white" />
            {running ? "Compiling…" : "Compile"}
          </button>
        </footer>
      </div>
    </Overlay>
  );
}
