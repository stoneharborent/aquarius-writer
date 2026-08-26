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

export const fountainTheme = EditorView.theme(
  {
    "&": {
      color: "var(--ink-prose)",
      backgroundColor: "transparent",
      fontFamily: "var(--font-mono)",
      fontSize: "14px",
      lineHeight: "1.55",
      // Grow with content — the article scrolls, not the editor. A fixed
      // height + internal scroller broke CM's viewport virtualization in
      // this embed (only the first ~27 lines ever rendered).
      height: "auto",
    },
    ".cm-content": { caretColor: "var(--accent)", padding: "0" },
    "&.cm-focused": { outline: "none" },
    ".cm-line": { padding: "0 0 0.15em 0", margin: "0" },

    ".cm-fnt-scene-heading": {
      fontWeight: "700",
      textTransform: "uppercase",
      color: "var(--ink)",
      marginTop: "1.4em",
      borderBottom: "1px solid var(--line)",
      paddingBottom: "0.15em",
    },
    ".cm-fnt-character": {
      fontWeight: "600",
      textTransform: "uppercase",
      color: "var(--ink)",
      paddingLeft: "26%",
      marginTop: "0.8em",
    },
    ".cm-fnt-parenthetical": {
      color: "var(--ink-soft)",
      paddingLeft: "20%",
      fontStyle: "italic",
    },
    ".cm-fnt-dialogue": {
      paddingLeft: "14%",
      paddingRight: "14%",
      color: "var(--ink-prose)",
    },
    ".cm-fnt-transition": {
      fontWeight: "700",
      textTransform: "uppercase",
      textAlign: "right",
      color: "var(--ink-soft)",
      marginTop: "1.2em",
    },
    ".cm-fnt-section": {
      fontFamily: "var(--font-ui)",
      fontWeight: "700",
      color: "var(--accent)",
      letterSpacing: "0.04em",
      textTransform: "uppercase",
      marginTop: "1.2em",
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
