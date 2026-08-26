import { Overlay } from "@/components/overlays/Overlay";
import { STUDIO_FEATURE_LABEL, useLicense } from "@/state/licenseStore";
import { BookIcon, CheckIcon, ScreenplayIcon, SparkleIcon } from "@/icons";
import "./Pricing.css";

export function UnlockDialog() {
  const { pendingGate, closeGate, upgradeToStudio } = useLicense();
  if (!pendingGate) return null;

  const label = STUDIO_FEATURE_LABEL[pendingGate];

  return (
    <Overlay title="" width={560} onClose={closeGate}>
      <div className="ul">
        <div className="ul-eyebrow">
          <SparkleIcon size={14} color="var(--accent)" />
          <span>Studio feature</span>
        </div>

        <h2 className="ul-title">{label}</h2>
        <p className="ul-sub">
          {flavorFor(pendingGate)}
        </p>

        <div className="ul-perks">
          <h4>Studio unlocks everything in the writing toolkit</h4>
          <ul>
            <li><CheckIcon size={12} color="var(--success)" />Manuscript outline + corkboard</li>
            <li><CheckIcon size={12} color="var(--success)" />Screenplay editor (Fountain) + scenes rail</li>
            <li><CheckIcon size={12} color="var(--success)" />Chapter rail inside the prose editor</li>
            <li><CheckIcon size={12} color="var(--success)" />Compile to EPUB · Word · FDX · PDF</li>
            <li><CheckIcon size={12} color="var(--success)" />Every future writing tool — no extra charge</li>
          </ul>
        </div>

        <div className="ul-price">
          <div className="ul-price-row">
            <span className="ul-price-amount">$50</span>
            <span className="ul-price-unit">one time</span>
          </div>
          <span className="ul-price-fine">No subscription, no upgrade fees. Pay once, own forever.</span>
        </div>

        <footer className="ul-foot">
          <button className="ul-secondary" onClick={closeGate}>Not yet</button>
          <button className="ul-primary" onClick={() => { upgradeToStudio(); closeGate(); }}>
            <BookIcon size={13} color="white" />
            Unlock Studio
          </button>
        </footer>
      </div>
    </Overlay>
  );
}

function flavorFor(feat: ReturnType<typeof STUDIO_FEATURE_LABEL extends infer T ? T extends Record<infer K, string> ? K : never : never>): string {
  switch (feat) {
    case "manuscript": return "See your whole book at once — order, status, synopses. The outline is where draft-shape happens before any sentence does.";
    case "corkboard": return "Index cards for every chapter. Rearrange the story by dragging cards around — no pinned-to-cardboard rotations, but everything else feels physical.";
    case "fountain": return "The screenplay editor opens .fountain files with the scenes rail, title page, and industry-standard formatting. Same Aquarius — pages instead of paragraphs.";
    case "chapter-rail": return "The chapter rail lives inside the prose editor — drag to reorder, status dots, fast nav between chapters. Same vocabulary as the scenes rail.";
    case "export-epub": return "EPUB is what you upload to KDP, Apple Books, Kobo. Aquarius bundles Pandoc and ships the file straight to disk — no servers, no round-trips.";
    case "export-fdx": return "Final Draft is the industry-standard screenplay format. Aquarius exports a clean .fdx that opens straight into Final Draft, Highland 2, or WriterDuet.";
    case "export-word": return "Word docs with track-changes-friendly styles. The format editors and agents actually open. Pandoc handles the conversion.";
    case "export-pdf": return "Page-laid-out PDFs for printing, sharing, or proofreading. xelatex under the hood — full Unicode, real typography.";
    default: return "Studio is the writing toolkit. Notes is the editor; Studio is the book.";
  }
}
