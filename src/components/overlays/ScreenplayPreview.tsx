// Screenplay print preview — the one web surface that renders white pages
// (it previews the compiled PDF layout). Mirror of ScreenplayPreviewSheet.swift.
// Layout metrics: US Letter, 1" top margin, Courier 12, industry indents —
// see `swift/AquariusWriter/Lib/ScreenplayPageFormat.swift`.
import { useMemo } from "react";
import { Overlay } from "./Overlay";
import { useOverlay } from "@/state/overlayStore";
import { useVault } from "@/state/vaultStore";
import { useEditor } from "@/state/editorStore";
import { splitTitlePage } from "@/lib/fountain";
import {
  classifyLines,
  estimatePages,
  isShotLine,
} from "@/lib/markdown/fountain-smart";
import "./ScreenplayPreview.css";

const KIND_CLASS: Record<string, string> = {
  "scene-heading": "sp-scene", action: "sp-action", character: "sp-character",
  parenthetical: "sp-paren", dialogue: "sp-dialogue", transition: "sp-transition",
  section: "sp-section", synopsis: "sp-synopsis", blank: "sp-blank",
};

export function ScreenplayPreview() {
  const { payload } = useOverlay();
  const { selectedPath } = useVault();
  const { docs } = useEditor();
  const path = payload.path ?? selectedPath;
  const raw = (path && docs[path]?.body) || "";

  const pages = useMemo(() => {
    const { body } = splitTitlePage(raw);
    const lines = body.split("\n");
    const kinds = classifyLines(lines);
    const { breaks } = estimatePages(lines);
    const bounds = [0, ...breaks, lines.length];
    const out: { text: string; kind: string }[][] = [];
    for (let p = 0; p < bounds.length - 1; p++) {
      out.push(lines.slice(bounds[p], bounds[p + 1]).map((text, i) => ({
        text,
        kind: kinds[bounds[p] + i] === "action" && isShotLine(text)
          ? "sp-shot"
          : KIND_CLASS[kinds[bounds[p] + i]] ?? "sp-action",
      })));
    }
    return out;
  }, [raw]);

  return (
    <Overlay title={`Preview — ${path ?? ""}`} width={760}>
      <div className="sp-scroll">
        {pages.map((page, p) => (
          <section className="sp-page" key={p}>
            {p > 0 && <span className="sp-pagenum">{p + 1}.</span>}
            {page.map((l, i) => (
              <div key={i} className={`sp-line ${l.kind}`}>
                {l.text || " "}
              </div>
            ))}
          </section>
        ))}
      </div>
    </Overlay>
  );
}
