// WYSIWYG-ish markdown decorations.
// HANDOFF: prose editor shows styled output, never raw syntax. We hide the
// syntax marks (#, *, _, etc) unless the cursor is on the line, then they fade
// in so the writer can edit without surprise.

import { syntaxTree } from "@codemirror/language";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";

// Off-caret syntax marks are fully hidden (desktop rule 5: markdown is the
// wire format, never user-visible); the caret line shows them raw.
const HIDE_MARK = Decoration.replace({});
const HEADING_LINE = (level: number) =>
  Decoration.line({ class: `cm-heading cm-h${level}` });
const EM = Decoration.mark({ class: "cm-em" });
const STRONG = Decoration.mark({ class: "cm-strong" });
const LINK = Decoration.mark({ class: "cm-link" });
const CODE = Decoration.mark({ class: "cm-inline-code" });
const QUOTE_LINE = Decoration.line({ class: "cm-quote" });

export function wysiwygDecorations() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view.state);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet) {
          this.decorations = build(u.state);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

function build(state: EditorState): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const cursorLine = state.doc.lineAt(state.selection.main.head).number;
  const tree = syntaxTree(state);

  tree.iterate({
    enter(node) {
      const name = node.name;
      if (name.startsWith("ATXHeading")) {
        const level = Number(name.slice(-1)) || 1;
        const line = state.doc.lineAt(node.from);
        b.add(line.from, line.from, HEADING_LINE(level));
        // hide the "## " prefix unless cursor is on this line
        if (line.number !== cursorLine) {
          const hashEnd = line.from + (line.text.match(/^#+\s*/)?.[0].length ?? 0);
          if (hashEnd > line.from) b.add(line.from, hashEnd, HIDE_MARK);
        }
      } else if (name === "Emphasis") {
        wrapInline(b, node.from, node.to, EM, state, cursorLine, 1);
      } else if (name === "StrongEmphasis") {
        wrapInline(b, node.from, node.to, STRONG, state, cursorLine, 2);
      } else if (name === "Link") {
        b.add(node.from, node.to, LINK);
      } else if (name === "InlineCode") {
        wrapInline(b, node.from, node.to, CODE, state, cursorLine, 1);
      } else if (name === "Blockquote") {
        // Style every line of the quote; hide the "> " marks off-caret.
        const first = state.doc.lineAt(node.from).number;
        const last = state.doc.lineAt(node.to).number;
        for (let n = first; n <= last; n++) {
          const line = state.doc.line(n);
          b.add(line.from, line.from, QUOTE_LINE);
          const mark = line.text.match(/^>\s?/);
          if (mark && n !== cursorLine) {
            b.add(line.from, line.from + mark[0].length, HIDE_MARK);
          }
        }
        return false; // children already handled line-wise
      }
    },
  });

  return b.finish();
}

function wrapInline(
  b: RangeSetBuilder<Decoration>,
  from: number,
  to: number,
  mark: Decoration,
  state: EditorState,
  cursorLine: number,
  markLen: number,
) {
  b.add(from + markLen, to - markLen, mark);
  const line = state.doc.lineAt(from);
  if (line.number !== cursorLine) {
    b.add(from, from + markLen, HIDE_MARK);
    b.add(to - markLen, to, HIDE_MARK);
  }
}

/* ── Metrics rule for everything below (NOTES §1a) ──────────────────────────
 *
 * Two things are load-bearing for caret accuracy, and both were broken here
 * before v0.3.1:
 *
 * 1. VERTICAL RHYTHM IS PADDING, NEVER MARGIN. CodeMirror measures each line
 *    with `getBoundingClientRect()` (see `measureVisibleLineHeights` in
 *    @codemirror/view) — a BORDER BOX, which excludes margins. Every pixel of
 *    margin on a `.cm-line` is space the painted document has and the height
 *    map does not, so the map drifts a little further out of step with the DOM
 *    on every line. `posAtCoords` picks the line via that map, which is
 *    literally "the click landed on the wrong line". `moveVertically` walks
 *    the same map in half-textHeight steps and has an explicit "did I land on
 *    the line's padding?" recovery — it knows about padding and has no such
 *    handling for margins, which is the arrow keys skipping. Padding is inside
 *    the border box and is measured, so all rhythm here is padding.
 *
 * 2. NO FRACTIONAL METRICS. Font sizes, line heights, paddings and letter
 *    spacing in the content path are whole pixels. WebKitGTK snaps fractional
 *    boxes to device pixels; CoreText carries the fraction. Same CSS, two
 *    different painted layouts, and the height map only matches one of them.
 *    Values below are the previous em-relative values rounded once, at design
 *    time, so both engines see the same integer.
 *
 * If you add a rule here: padding, whole pixels, and no `em`.
 */
export const proseTheme = EditorView.theme(
  {
    "&": {
      color: "var(--ink-prose)",
      backgroundColor: "transparent",
      fontFamily: "var(--font-serif)",
      fontSize: "var(--prose-size)",
      lineHeight: "var(--prose-line-px)", // was 1.65 → 28.05px
      // Grow with content — see fountain-ext.ts (same embed fix).
      height: "auto",
    },
    ".cm-content": {
      caretColor: "var(--accent)",
      padding: "0",
      maxWidth: "none",
      // Restated so nothing inherited from the shell (--ui-size is 13.5px
      // under AquariusOS) can reach the content path.
      fontFamily: "var(--font-serif)",
      fontSize: "var(--prose-size)",
      lineHeight: "var(--prose-line-px)",
      letterSpacing: "normal",
    },
    "&.cm-focused": { outline: "none" },
    // Paragraph gap: was `margin: 0 0 0.55em 0` (9.35px, invisible to the
    // height map). Now 9px of padding, which is measured.
    ".cm-line": {
      margin: "0",
      padding: "0 0 var(--prose-para-gap) 0",
    },
    // Headings. `.cm-heading` and `.cm-hN` land on the same line element, so
    // the per-level rules below carry the whole metric set; only the shared,
    // metric-free properties stay here. Padding-top is the old 1.4em margin
    // minus the 9px the previous line already contributes as padding-bottom
    // (margins collapsed, padding does not) — so the gap above a heading in
    // running text is unchanged. A heading on line 1 sits 9px higher than it
    // used to; that is the whole visual cost of the fix.
    //
    //        old size        →  new   old line-height  →  new   pad-top  pad-bottom
    //   h1   1.8em  = 30.6px →  31px   36.72px         →  37px   34px     15px
    //   h2   1.45em = 24.65  →  25px   29.58           →  30px   26px     12px
    //   h3   1.2em  = 20.4   →  20px   24.48           →  24px   20px     10px
    //   h4-6 1.05em = 17.85  →  18px   21.42           →  21px   16px      9px
    ".cm-heading": {
      fontWeight: "600",
      color: "var(--ink-prose)",
      // Dropped: `letterSpacing: -0.01em`. At 31px that is -0.31px per glyph,
      // which WebKitGTK and CoreText accumulate differently across a line and
      // walks the caret's X off the glyph it belongs to.
      letterSpacing: "normal",
      margin: "0",
    },
    ".cm-h1": { fontSize: "31px", lineHeight: "37px", paddingTop: "34px", paddingBottom: "15px" },
    ".cm-h2": { fontSize: "25px", lineHeight: "30px", paddingTop: "26px", paddingBottom: "12px" },
    ".cm-h3": { fontSize: "20px", lineHeight: "24px", paddingTop: "20px", paddingBottom: "10px" },
    ".cm-h4, .cm-h5, .cm-h6": { fontSize: "18px", lineHeight: "21px", paddingTop: "16px", paddingBottom: "9px" },
    ".cm-em": { fontStyle: "italic" },
    ".cm-inline-code": {
      fontFamily: "var(--font-mono)",
      fontSize: "14px", // was 0.85em = 14.45px
      backgroundColor: "var(--bg-soft)",
      borderRadius: "3px",
      padding: "0 3px",
    },
    ".cm-quote": {
      borderLeft: "3px solid var(--accent)",
      paddingLeft: "12px",
      color: "var(--ink-soft)",
      fontStyle: "italic",
    },
    ".cm-strong": { fontWeight: "600" },
    ".cm-link": { color: "var(--accent)", textDecoration: "none" },
    ".cm-wikilink": {
      color: "var(--accent)",
      backgroundColor: "var(--accent-soft)",
      padding: "0 4px",
      borderRadius: "3px",
      cursor: "pointer",
      textDecoration: "none",
    },
    ".cm-wikilink.unresolved": {
      color: "var(--ink-mute)",
      backgroundColor: "transparent",
      textDecoration: "underline dotted",
      cursor: "help",
    },
    ".cm-selectionBackground, .cm-selectionMatch": {
      backgroundColor: "var(--selection) !important",
    },
    ".cm-cursor": { borderLeftColor: "var(--accent)" },
    ".cm-scroller": { fontFamily: "inherit", overflow: "visible" },
  },
  { dark: false },
);
