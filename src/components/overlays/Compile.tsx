import { useMemo, useState } from "react";
import { Overlay } from "./Overlay";
import { useVault } from "@/state/vaultStore";
import { useLicense, StudioFeature } from "@/state/licenseStore";
import { DownloadIcon } from "@/icons";
import "./Compile.css";

type SourceKind = "manuscript" | "screenplay" | "notes";
type Format = {
  id: string;
  label: string;
  ext: string;
  description: string;
  /** which source kinds support this format */
  kinds: SourceKind[];
  tier?: "studio";
};

// HANDOFF §5 + §9.2 — gated by tier in production; here we mark Studio formats
// but the picker stays usable so the dialog reads in the preview.
const FORMATS: Format[] = [
  { id: "md", label: "Markdown", ext: ".md", description: "One file per chapter, concatenated. Plain text, open anywhere.", kinds: ["manuscript", "notes"] },
  { id: "pdf", label: "PDF", ext: ".pdf", description: "Page-laid-out, ready to print or share. Pandoc via xelatex.", kinds: ["manuscript", "screenplay", "notes"] },
  { id: "epub", label: "EPUB", ext: ".epub", description: "Reflowable ebook. Submit to KDP, Apple Books, Kobo.", kinds: ["manuscript"], tier: "studio" },
  { id: "docx", label: "Word", ext: ".docx", description: "Track-changes-friendly for editors and agents.", kinds: ["manuscript", "notes"], tier: "studio" },
  { id: "fountain", label: "Fountain", ext: ".fountain", description: "Plain-text screenplay format.", kinds: ["screenplay"] },
  { id: "fdx", label: "Final Draft", ext: ".fdx", description: "Industry-standard screenplay format.", kinds: ["screenplay"], tier: "studio" },
];

// Map format ids to gate features so a Notes user attempting an EPUB
// export triggers the right unlock dialog flavor.
const FEATURE_FOR_FORMAT: Record<string, StudioFeature | null> = {
  md: null, pdf: null, fountain: null,
  epub: "export-epub", docx: "export-word", fdx: "export-fdx",
};

export function Compile() {
  const { current, selectedPath } = useVault();
  const license = useLicense();

  const sourceKind: SourceKind = useMemo(() => {
    if (selectedPath?.endsWith(".fountain")) return "screenplay";
    if (current?.manuscripts.length) return "manuscript";
    return "notes";
  }, [current, selectedPath]);

  const [picked, setPicked] = useState<string>("pdf");

  return (
    <Overlay title="Compile / Export" width={720}>
      <div className="cm">
        <div className="cm-source">
          <span className="cm-eyebrow">Source</span>
          <span className="cm-source-label">
            {current?.title ?? "Untitled"} · {sourceKind}
          </span>
        </div>

        <div className="cm-section-head">Format</div>
        <div className="cm-grid">
          {FORMATS.map((f) => {
            const supported = f.kinds.includes(sourceKind);
            const active = picked === f.id && supported;
            const gateFeature = FEATURE_FOR_FORMAT[f.id];
            const isGated = supported && gateFeature && license.base !== "studio";
            return (
              <button
                key={f.id}
                className={`cm-card${active ? " active" : ""}${supported ? "" : " disabled"}${isGated ? " gated" : ""}`}
                onClick={() => {
                  if (!supported) return;
                  if (isGated && gateFeature) {
                    license.requestStudioFeature(gateFeature);
                    return;
                  }
                  setPicked(f.id);
                }}
                disabled={!supported}
              >
                <div className="cm-card-head">
                  <span className="cm-card-label">{f.label}</span>
                  <span className="cm-card-ext">{f.ext}</span>
                </div>
                <div className="cm-card-desc">{f.description}</div>
                {f.tier && (
                  <span className="cm-tier">Studio</span>
                )}
                {!supported && (
                  <span className="cm-incompat">Not available for {sourceKind}</span>
                )}
              </button>
            );
          })}
        </div>

        <div className="cm-section-head">Output</div>
        <div className="cm-output">
          <input
            type="text"
            defaultValue={`~/Aquarius/Exports/${current?.title?.replace(/[^A-Za-z0-9]+/g, "-") ?? "untitled"}.${FORMATS.find((f) => f.id === picked)?.ext.replace(/^\./, "")}`}
            spellCheck={false}
          />
          <button className="cm-browse">Browse…</button>
        </div>

        <footer className="cm-foot">
          <span className="cm-fine">
            Pandoc bundled; exports run locally. Nothing leaves your machine.
          </span>
          <span className="cm-spacer" />
          <button className="cm-cancel">Cancel</button>
          <button className="cm-go">
            <DownloadIcon size={13} color="white" />
            Compile
          </button>
        </footer>
      </div>
    </Overlay>
  );
}
