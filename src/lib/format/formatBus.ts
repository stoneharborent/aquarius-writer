// One-way, path-targeted dispatch from the editor toolbar to the focused
// editor pane — the web mirror of `swift/AquariusWriter/State/FormatBus.swift`.
// Editors register their EditorView under their document path; the toolbar
// sends commands to the focused path (falling back to the only registered one).
import type { EditorView } from "@codemirror/view";

export type FormatCommand =
  // inline
  | "bold" | "italic" | "strike" | "code"
  // headings
  | "h1" | "h2" | "h3"
  // blocks
  | "bulletList" | "numberedList" | "taskList" | "blockquote" | "divider"
  // insert
  | "link" | "wikilink" | "table"
  // history
  | "undo" | "redo";

// A path can be open in BOTH split panes at once — keep a stack per path so
// the secondary pane's registration doesn't clobber (and its close doesn't
// orphan) the primary's toolbar target. Last registered = most recent pane.
const views = new Map<string, EditorView[]>();
let focused: string | null = null;

function last(path: string): EditorView | null {
  const stack = views.get(path);
  return stack?.length ? stack[stack.length - 1] : null;
}

export const formatBus = {
  register(path: string, view: EditorView) {
    const stack = views.get(path) ?? [];
    stack.push(view);
    views.set(path, stack);
  },
  unregister(path: string, view: EditorView) {
    const stack = views.get(path);
    if (!stack) return;
    const next = stack.filter((v) => v !== view);
    if (next.length) views.set(path, next);
    else {
      views.delete(path);
      if (focused === path) focused = null;
    }
  },
  focus(path: string) {
    focused = path;
  },
  /** The view commands should target: focused path, else sole registrant. */
  target(path?: string): EditorView | null {
    if (path && views.has(path)) return last(path);
    if (focused && views.has(focused)) return last(focused);
    if (views.size === 1) return last(views.keys().next().value as string);
    return null;
  },
};
