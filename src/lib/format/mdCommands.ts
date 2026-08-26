// Markdown format commands applied to a CodeMirror view — the web mirror of
// the desktop toolbar's FormatBus commands (prose/note editors).
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import type { FormatCommand } from "./formatBus";

/** Toggle `marker` around the selection (or insert a pair at the caret). */
function toggleInline(view: EditorView, marker: string) {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const before = state.sliceDoc(Math.max(0, range.from - marker.length), range.from);
    const after = state.sliceDoc(range.to, range.to + marker.length);
    if (before === marker && after === marker) {
      // unwrap
      return {
        changes: [
          { from: range.from - marker.length, to: range.from },
          { from: range.to, to: range.to + marker.length },
        ],
        range: EditorSelection.range(range.from - marker.length, range.to - marker.length),
      };
    }
    return {
      changes: [
        { from: range.from, insert: marker },
        { from: range.to, insert: marker },
      ],
      range: EditorSelection.range(range.from + marker.length, range.to + marker.length),
    };
  });
  view.dispatch(changes, { userEvent: "input.format" });
}

/** Set (or clear) a line prefix on every selected line. */
function setLinePrefix(view: EditorView, prefix: string | ((n: number) => string),
                       strip: RegExp) {
  const { state } = view;
  const changes: { from: number; to: number; insert: string }[] = [];
  const seen = new Set<number>();
  let n = 0;
  for (const range of state.selection.ranges) {
    let pos = range.from;
    while (pos <= range.to) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.number)) {
        seen.add(line.number);
        const bare = line.text.replace(strip, "");
        const p = typeof prefix === "function" ? prefix(n++) : prefix;
        const already = typeof prefix !== "function" && line.text.startsWith(p) && p !== "";
        changes.push({ from: line.from, to: line.to, insert: already ? bare : p + bare });
      }
      if (line.to + 1 > range.to) break;
      pos = line.to + 1;
    }
  }
  view.dispatch({ changes, userEvent: "input.format" });
}

const STRIP_BLOCK = /^(#{1,6} |> |[-*] (\[[ x]\] )?|\d+\. )/;

export function applyMdCommand(view: EditorView, cmd: FormatCommand): void {
  switch (cmd) {
    case "bold": toggleInline(view, "**"); break;
    case "italic": toggleInline(view, "*"); break;
    case "strike": toggleInline(view, "~~"); break;
    case "code": toggleInline(view, "`"); break;
    case "h1": setLinePrefix(view, "# ", STRIP_BLOCK); break;
    case "h2": setLinePrefix(view, "## ", STRIP_BLOCK); break;
    case "h3": setLinePrefix(view, "### ", STRIP_BLOCK); break;
    case "bulletList": setLinePrefix(view, "- ", STRIP_BLOCK); break;
    case "numberedList": setLinePrefix(view, (n) => `${n + 1}. `, STRIP_BLOCK); break;
    case "taskList": setLinePrefix(view, "- [ ] ", STRIP_BLOCK); break;
    case "blockquote": setLinePrefix(view, "> ", STRIP_BLOCK); break;
    case "divider": {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      view.dispatch({
        changes: { from: line.to, insert: "\n\n---\n" },
        selection: { anchor: line.to + 6 },
        userEvent: "input.format",
      });
      break;
    }
    case "link": wrapCaretWord(view, "[", "](url)"); break;
    case "wikilink": wrapCaretWord(view, "[[", "]]"); break;
    case "table": {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const tbl = "\n\n| Column | Column |\n| ------ | ------ |\n|        |        |\n";
      view.dispatch({
        changes: { from: line.to, insert: tbl },
        selection: { anchor: line.to + 5 },
        userEvent: "input.format",
      });
      break;
    }
    case "undo": undo(view); break;
    case "redo": redo(view); break;
  }
  view.focus();
}

function wrapCaretWord(view: EditorView, open: string, close: string) {
  const { state } = view;
  const range = state.selection.main;
  const from = range.from, to = range.to;
  view.dispatch({
    changes: [{ from, insert: open }, { from: to, insert: close }],
    selection: { anchor: from + open.length, head: to + open.length },
    userEvent: "input.format",
  });
}
