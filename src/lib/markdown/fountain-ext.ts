// CM6 line decorations for Fountain. Stateless line-by-line classifier — for
// most files this is plenty; export/render goes through fountain-js.

import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { classify, FountainLineKind } from "@/lib/fountain";
import { estimatePages } from "@/lib/markdown/fountain-smart";

const LINE = (kind: FountainLineKind) =>
  Decoration.line({ class: `cm-fnt cm-fnt-${kind}` });

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  let prev: FountainLineKind = "blank";
  let prevPrev: FountainLineKind = "blank";

  // Estimated page starts (page 2+) get a break rule + "p. N" label.
  const { breaks } = estimatePages(view.state.doc.toString().split("\n"));
  const breakPage = new Map(breaks.map((lineIdx, n) => [lineIdx + 1, n + 2]));

  for (let i = 1; i <= view.state.doc.lines; i++) {
    const line = view.state.doc.line(i);
    const kind = classify(line.text, prev, prevPrev);
    b.add(line.from, line.from, LINE(kind));
    const page = breakPage.get(i);
    if (page !== undefined) {
      b.add(line.from, line.from, Decoration.line({
        class: "cm-aq-pagebreak-line",
        attributes: { "data-page": `p. ${page}` },
      }));
    }
    prevPrev = prev;
    prev = kind;
  }
  return b.finish();
}

export function fountainDecorations() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) {
          this.decorations = build(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/* Metrics rule: identical to the one written out at length above `proseTheme`
 * in wysiwyg.ts, and for the same reason (NOTES §1a). Vertical rhythm is
 * PADDING, never margin — CodeMirror's height map is built from border boxes
 * and cannot see a margin. Every length is a whole pixel, because WebKitGTK
 * snaps fractional boxes to device pixels and CoreText does not.
 *
 * The screenplay's left indents were percentages of the content width, which
 * resolve to fractions (26% of the 696px content box is 180.96px) and move
 * with the pane. They are fixed pixels now: a screenplay indent is an absolute
 * grid measured in inches, not a proportion of whatever the window happens to
 * be, so this is closer to the PARITY row 12 target as well as cheaper to
 * measure. Values are the old percentages resolved at the 696px design width
 * (`.cm-content` is max-width 720px less its 12px side padding).
 */
export const fountainTheme = EditorView.theme(
  {
    "&": {
      color: "var(--ink-prose)",
      backgroundColor: "transparent",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--screenplay-size)",      // 14px
      lineHeight: "var(--screenplay-line-px)", // was 1.55 → 21.7px, now 22px
      // Grow with content — the article scrolls, not the editor. A fixed
      // height + internal scroller broke CM's viewport virtualization in
      // this embed (only the first ~27 lines ever rendered).
      height: "auto",
    },
    ".cm-content": {
      caretColor: "var(--accent)",
      padding: "0",
      // Restated so nothing from the shell reaches the content path.
      fontFamily: "var(--font-mono)",
      fontSize: "var(--screenplay-size)",
      lineHeight: "var(--screenplay-line-px)",
      letterSpacing: "normal",
    },
    "&.cm-focused": { outline: "none" },
    // was `padding: 0 0 0.15em 0` = 2.1px
    ".cm-line": { padding: "0 0 var(--screenplay-para-gap) 0", margin: "0" },

    // Each `marginTop` below became a `paddingTop` of the same rounded value
    // less the 2px the previous line already contributes as padding-bottom.
    ".cm-fnt-scene-heading": {
      fontWeight: "700",
      textTransform: "uppercase",
      color: "var(--ink)",
      paddingTop: "18px", // was marginTop 1.4em = 19.6px
      borderBottom: "1px solid var(--line)",
      paddingBottom: "2px", // was 0.15em = 2.1px
    },
    ".cm-fnt-character": {
      fontWeight: "600",
      textTransform: "uppercase",
      color: "var(--ink)",
      paddingLeft: "181px", // was 26% = 180.96px at the design width
      paddingTop: "9px", // was marginTop 0.8em = 11.2px
    },
    ".cm-fnt-parenthetical": {
      color: "var(--ink-soft)",
      paddingLeft: "139px", // was 20% = 139.2px
      fontStyle: "italic",
    },
    ".cm-fnt-dialogue": {
      paddingLeft: "97px", // was 14% = 97.44px
      paddingRight: "97px",
      color: "var(--ink-prose)",
    },
    ".cm-fnt-transition": {
      fontWeight: "700",
      textTransform: "uppercase",
      textAlign: "right",
      color: "var(--ink-soft)",
      paddingTop: "15px", // was marginTop 1.2em = 16.8px
    },
    ".cm-fnt-section": {
      fontFamily: "var(--font-ui)",
      fontWeight: "700",
      color: "var(--accent)",
      // was 0.04em = 0.56px; a fraction of a pixel per glyph is exactly what
      // the two engines disagree about, so it is a whole pixel now.
      letterSpacing: "1px",
      textTransform: "uppercase",
      paddingTop: "15px", // was marginTop 1.2em = 16.8px
    },
    ".cm-fnt-synopsis": {
      fontFamily: "var(--font-serif)",
      fontStyle: "italic",
      color: "var(--ink-soft)",
    },
    ".cm-fnt-action": { color: "var(--ink-prose)" },

    ".cm-selectionBackground": { backgroundColor: "var(--selection) !important" },
    ".cm-cursor": { borderLeftColor: "var(--accent)" },
    ".cm-scroller": { fontFamily: "inherit", overflow: "visible" },
  },
  { dark: false },
);
