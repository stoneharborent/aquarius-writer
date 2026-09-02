// Screenplay print preview — the one web surface that renders white pages
// (it previews the compiled PDF layout). Mirror of ScreenplayPreviewSheet.swift.
// Layout metrics: US Letter, 1" top margin, Courier 12, industry indents —
// see `swift/AquariusWriter/Lib/ScreenplayPageFormat.swift`.
//
// PARITY row 12: the preview and the editor's paged canvas now run the SAME
// pagination (`paginate`, fountain-pages.ts), so page 7 here is page 7 there.
// They differ in exactly one way, on purpose: this sheet is drawn at 1pt = 1px
// because it is a picture of the PDF, and the canvas is drawn at 1pt = 4/3px
// because it is a writing surface (screenplay-metrics.ts explains the choice).
// The row model is scale-free, so both read the same page breaks off it.
import { useMemo } from "react";
import { Overlay } from "./Overlay";
import { useOverlay } from "@/state/overlayStore";
import { useVault } from "@/state/vaultStore";
import { useEditor } from "@/state/editorStore";
import { splitTitlePage } from "@/lib/fountain";
import {
  classifyLines,
  isShotLine,
  paginate,
} from "@/lib/markdown/fountain-pages";
import "./ScreenplayPreview.css";

const KIND_CLASS: Record<string, string> = {
  "scene-heading": "sp-scene", action: "sp-action", character: "sp-character",
  parenthetical: "sp-paren", dialogue: "sp-dialogue", transition: "sp-transition",
  section: "sp-section", synopsis: "sp-synopsis", blank: "sp-blank",
};

export function ScreenplayPreview() {
  const payload = useOverlay((s) => s.payload);
  const selectedPath = useVault((s) => s.selectedPath);
  const path = payload.path ?? selectedPath;
  // This document, not the whole editor store: `useEditor()` with no selector
  // re-rendered the preview — and re-paginated the script — on every keystroke
  // in every *other* open buffer too.
  const body = useEditor((s) => (path ? s.docs[path]?.body : undefined));
  const raw = body || "";

  const pages = useMemo(() => {
    const { body } = splitTitlePage(raw);
    const lines = body.split("\n");
    const kinds = classifyLines(lines);
    return paginate(lines).pages.map((page) =>
      lines.slice(page.start, page.end).map((text, i) => ({
        text,
        kind: kinds[page.start + i] === "action" && isShotLine(text)
          ? "sp-shot"
          : KIND_CLASS[kinds[page.start + i]] ?? "sp-action",
      })),
    );
  }, [raw]);

  return (
    <Overlay title={`Preview — ${path ?? ""}`} width={760}>
      <div className="sp-scroll">
        {pages.map((page, p) => (
          <section className="sp-page" key={p}>
            {p > 0 && <span className="sp-pagenum">{p + 1}.</span>}
            {page.map((l, i) => (
              <div key={i} className={`sp-line ${l.kind}`}>
                {l.text || " "}
              </div>
            ))}
          </section>
        ))}
      </div>
    </Overlay>
  );
}
