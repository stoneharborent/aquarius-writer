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

export const proseTheme = EditorView.theme(
  {
    "&": {
      color: "var(--ink-prose)",
      backgroundColor: "transparent",
      fontFamily: "var(--font-serif)",
      fontSize: "var(--prose-size)",
      lineHeight: "var(--prose-leading)",
      // Grow with content — see fountain-ext.ts (same embed fix).
      height: "auto",
    },
    ".cm-content": {
      caretColor: "var(--accent)",
      padding: "0",
      maxWidth: "none",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-line": {
      padding: "0",
      margin: "0 0 0.55em 0",
    },
    ".cm-heading": {
      fontWeight: "600",
      lineHeight: "1.2",
      color: "var(--ink-prose)",
      letterSpacing: "-0.01em",
      marginTop: "1.4em",
      marginBottom: "0.5em",
    },
    ".cm-h1": { fontSize: "1.8em" },
    ".cm-h2": { fontSize: "1.45em" },
    ".cm-h3": { fontSize: "1.2em" },
    ".cm-h4, .cm-h5, .cm-h6": { fontSize: "1.05em" },
    ".cm-em": { fontStyle: "italic" },
    ".cm-inline-code": {
      fontFamily: "var(--font-mono)",
      fontSize: "0.85em",
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
