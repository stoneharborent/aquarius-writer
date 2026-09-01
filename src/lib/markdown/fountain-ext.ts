// CM6 line decorations for Fountain, and the grid the paged canvas is drawn
// on. Stateless line-by-line classifier — for most files this is plenty;
// export/render goes through fountain-js.

import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { classify, FountainLineKind } from "@/lib/fountain";
import { paginateDoc } from "@/lib/markdown/fountain-pages";

const LINE = (kind: FountainLineKind) =>
  Decoration.line({ class: `cm-fnt cm-fnt-${kind}` });

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  let prev: FountainLineKind = "blank";
  let prevPrev: FountainLineKind = "blank";

  // Where the pages break, and how much blank is owed to the foot of the page
  // above each one. `--sp-fill` is that number of rows; the CSS turns it into
  // the padding that makes every painted sheet exactly `--sp-page-h` tall,
  // which is what lets the sheets be a repeating background instead of a
  // measured layout (docs/NOTES.md §27).
  const { breaks, breakFill } = paginateDoc(view.state.doc.toString());
  const breakAt = new Map(
    breaks.map((lineIdx, n) => [lineIdx + 1, { page: n + 2, fill: breakFill[n] ?? 0 }]),
  );

  for (let i = 1; i <= view.state.doc.lines; i++) {
    const line = view.state.doc.line(i);
    const kind = classify(line.text, prev, prevPrev);
    b.add(line.from, line.from, LINE(kind));
    const brk = breakAt.get(i);
    if (brk !== undefined) {
      b.add(line.from, line.from, Decoration.line({
        class: "cm-aq-pagebreak-line",
        attributes: {
          "data-page": `${brk.page}.`,
          // A unitless count, not a length: the CSS multiplies it by the line
          // box so the arithmetic survives a zoom without a second rounding.
          style: `--sp-fill:${brk.fill}`,
        },
      }));
    }
    prevPrev = prev;
    prev = kind;
  }
  return b.finish();
}

/**
 * ── WHY THIS DOES NOT REBUILD ON `viewportChanged` (NOTES §27k) ───────────
 *
 * `build` decorates the WHOLE document — it has to, because `classify` reads
 * the two lines above each line and because the page breaks come from a
 * pagination of the entire script. A whole-document decoration set is already
 * correct for any viewport, so a viewport change has nothing to recompute.
 *
 * It used to rebuild on one anyway, and that was the screenplay's scroll cost
 * on WebKitGTK. `watchAncestorScroll` (cm-embed.ts) calls `requestMeasure()`
 * on every scroll event of the surrounding article — it must, or CM never
 * re-renders below the initial fold in this grow-to-content embed — and each
 * measure that moved the viewport landed here. So every scrolled frame ran a
 * full `doc.toString()`, a full `split`, a full `paginate`, a `classify` of
 * every line in the script and a `RangeSetBuilder` pass over all of them,
 * before anything was painted. On a 90-page script that is the sluggishness.
 *
 * The rule for anything added here: if the work is O(document), it belongs
 * behind `docChanged`. If it is genuinely viewport-scoped, scope it to
 * `view.visibleRanges` and then it may watch the viewport.
 */
export function fountainDecorations() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) {
          this.decorations = build(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/* THE SCREENPLAY GRID — read this before changing a number.
 *
 * Metrics rule (docs/NOTES.md §1a): vertical rhythm is PADDING, never margin —
 * CodeMirror's height map is built from border boxes and cannot see a margin —
 * and every length is a whole pixel, because WebKitGTK snaps fractional boxes
 * to device pixels and CoreText does not.
 *
 * The paged canvas (PARITY row 12, NOTES §27) leans on that harder than the old
 * continuous surface did. The sheets are painted as a **repeating background**
 * with no measurement at all, so the arithmetic in `fountain-pages.ts` and the
 * layout the browser paints must agree to the pixel. Two consequences:
 *
 *   1. **The screenplay is set solid.** Every element padding-top this file
 *      used to carry (scene 18px, character 9px, transition 15px, section
 *      15px) and the 2px per-line gap are GONE. A line is exactly one line box
 *      tall, always. Fountain's blank lines are the spacing — they are in the
 *      document, they are counted as rows, and adding CSS padding on top of
 *      them double-counted the rhythm and pushed the text off the sheets.
 *      The scene heading's rule is an inset box-shadow for the same reason:
 *      a border-bottom is 1px of layout.
 *   2. **Horizontal geometry is the point geometry.** Each element's block is
 *      a padding-left / padding-right pair inside a text column that is
 *      exactly 432pt (60 Courier columns) wide, from SWIFT-AUDIT §2.1's
 *      margins: character 252→522, parenthetical 216→396, dialogue 180→432,
 *      transition right-aligned ending at 510.98. `screenplayMetrics()` in
 *      `screenplay-metrics.ts` converts them, once, at 4/3 px per point.
 *
 * The `var(…, Npx)` fallbacks ARE the 100%-zoom values. Per-document zoom
 * writes whole-pixel overrides for all of them, scoped to one editor's host
 * element (`applyEditorZoom` in theme.ts, PARITY row 14), so an unzoomed
 * screenplay resolves every one to its fallback.
 *
 * ── COLOUR: THIS IS INK ON PAPER, NOT TEXT ON A THEME (NOTES §27k) ────────
 * Every colour below is a `--page-*` token, not the theme's `--ink*`. The
 * sheet is near-white in all three themes because Final Draft's is, and
 * `--ink-prose` on Midnight is a pale blue that would be invisible on it. The
 * page has its own five-colour palette; see tokens.css.
 *
 * ── AND THE THREE FINAL DRAFT SPACING RULES ──────────────────────────────
 *   1. Set solid: `line-height` == `font-size`, and NO padding-top anywhere.
 *   2. Bold on scene headings, character cues and transitions; action and
 *      dialogue are regular weight. Nothing else is emphasised — in
 *      particular a scene heading gets NO rule, NO underline and NO border.
 *      FD distinguishes a slug with caps and weight alone, and the underline
 *      this file used to draw (a `border-bottom` before §27, an inset
 *      `box-shadow` after it) was never in the format.
 *   3. All of Fountain's blank lines are already in the document and are
 *      already counted as rows. CSS adds none.
 */
export const fountainTheme = EditorView.theme(
  {
    "&": {
      color: "var(--page-ink)",
      backgroundColor: "transparent",
      fontFamily: "var(--font-screenplay)",
      fontSize: "var(--screenplay-size)",      // 16px = 12pt at 4/3
      lineHeight: "var(--screenplay-line-px)", // 16px — set solid, like print
      // Grow with content — the article scrolls, not the editor. A fixed
      // height + internal scroller broke CM's viewport virtualization in
      // this embed (only the first ~27 lines ever rendered).
      height: "auto",
    },
    ".cm-content": {
      caretColor: "var(--accent)",
      // Restated so nothing from the shell reaches the content path.
      fontFamily: "var(--font-screenplay)",
      fontSize: "var(--screenplay-size)",
      lineHeight: "var(--screenplay-line-px)",
      letterSpacing: "normal",
      // The page geometry itself lives in ScreenplayEditor.css, where the
      // sheet is painted; putting it here would put a page inside the
      // popout's and the preview's editors too.
    },
    "&.cm-focused": { outline: "none" },
    ".cm-line": { padding: "0", margin: "0" },

    ".cm-fnt-scene-heading": {
      fontWeight: "700",
      textTransform: "uppercase",
      color: "var(--page-ink)",
      // NO rule under a slug. See rule 2 in the header comment — Final Draft
      // does not draw one, and a `box-shadow` here is one more thing painted
      // per visible line for no format reason.
    },
    ".cm-fnt-character": {
      fontWeight: "700",
      textTransform: "uppercase",
      color: "var(--page-ink)",
      paddingLeft: "var(--fnt-character-indent, 192px)",   // 252pt − 108pt
      paddingRight: "var(--fnt-character-pr, 24px)",       // 540pt − 522pt
    },
    ".cm-fnt-parenthetical": {
      color: "var(--page-ink-soft)",
      paddingLeft: "var(--fnt-paren-indent, 144px)",       // 216pt − 108pt
      paddingRight: "var(--fnt-paren-pr, 192px)",          // 540pt − 396pt
      fontStyle: "italic",
    },
    ".cm-fnt-dialogue": {
      paddingLeft: "var(--fnt-dialogue-indent, 96px)",     // 180pt − 108pt
      paddingRight: "var(--fnt-dialogue-pr, 144px)",       // 540pt − 432pt
      color: "var(--page-ink)",
    },
    ".cm-fnt-transition": {
      fontWeight: "700",
      textTransform: "uppercase",
      textAlign: "right",
      color: "var(--page-ink)",
      paddingRight: "var(--fnt-transition-pr, 39px)",      // 540pt − 510.98pt
    },
    // `#` sections and `=` synopses are Fountain's notes-to-self. They are not
    // script and they do not print, so they are the one place on the page that
    // is allowed to look like an annotation rather than like Courier.
    ".cm-fnt-section": {
      fontFamily: "var(--font-ui)",
      fontWeight: "700",
      color: "var(--page-accent)",
      // was 0.04em = 0.56px; a fraction of a pixel per glyph is exactly what
      // the two engines disagree about, so it is a whole pixel now.
      letterSpacing: "1px",
      textTransform: "uppercase",
    },
    ".cm-fnt-synopsis": {
      fontFamily: "var(--font-serif)",
      fontStyle: "italic",
      color: "var(--page-ink-soft)",
    },
    ".cm-fnt-action": { color: "var(--page-ink)" },

    ".cm-selectionBackground": { backgroundColor: "var(--selection) !important" },
    ".cm-cursor": { borderLeftColor: "var(--accent)" },
    ".cm-scroller": { fontFamily: "inherit", overflow: "visible" },
  },
  { dark: false },
);
