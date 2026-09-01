import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { proseTheme, wysiwygDecorations } from "@/lib/markdown/wysiwyg";
import { wikilinkCompletion } from "@/lib/markdown/wikilink-ext";
import { focusZoomPane, registerZoomPane } from "@/lib/markdown/editor-zoom";
import { useVault } from "@/state/vaultStore";
import { formatBus } from "@/lib/format/formatBus";
import { watchAncestorScroll } from "@/lib/cm-embed";
import { applyMdCommand } from "@/lib/format/mdCommands";
import "./ProseEditor.css";

interface ProseEditorProps {
  value: string;
  onChange: (v: string) => void;
  /** Document path — registers the view on the formatBus for the toolbar. */
  path?: string;
  /**
   * Reference mode — the split pane's read-only half (SWIFT-AUDIT §2.1).
   *
   * Read at mount only: the caller remounts on the toggle (MainWindow keys the
   * pane by path *and* mode), because a document that stops being editable
   * mid-session should also lose the undo history that belongs to editing it.
   */
  readOnly?: boolean;
}

/** ⌘B / ⌘I / ⇧⌘X — the desktop FormatBus shortcuts, editor-local. */
const mdShortcutKeymap = keymap.of([
  { key: "Mod-b", run: (v) => { applyMdCommand(v, "bold"); return true; } },
  { key: "Mod-i", run: (v) => { applyMdCommand(v, "italic"); return true; } },
  { key: "Mod-Shift-x", run: (v) => { applyMdCommand(v, "strike"); return true; } },
]);

export function ProseEditor({ value, onChange, path, readOnly = false }: ProseEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  /**
   * The last text this editor handed out.
   *
   * A controlled CodeMirror echoes: keystroke → `onChange` → store → React →
   * the `value` effect below, for every character typed. Without a record of
   * what we emitted, that effect has to serialise the whole document again and
   * compare it to itself just to discover it has nothing to do — two O(document)
   * passes per keystroke on top of the one the listener already paid
   * (docs/NOTES.md §27l).
   */
  const emittedRef = useRef(value);

  // The vault tree is the completion source for `[[`. Held in a ref and read
  // at query time so a file created since mount is offered without rebuilding
  // the editor.
  const tree = useVault((s) => s.tree);
  const treeRef = useRef<typeof tree>(tree);
  treeRef.current = tree;

  // Create the view once.
  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        mdShortcutKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        EditorView.lineWrapping,
        wysiwygDecorations(),
        ...wikilinkCompletion(treeRef, path),
        proseTheme,
        // Reference mode. `readOnly` stops the commands, `editable` stops the
        // contenteditable itself — both, because either one alone still leaves
        // a way in (a paste handler, a drag-drop, an IME commit).
        ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const text = u.state.doc.toString();
          emittedRef.current = text;
          onChangeRef.current(text);
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    // A read-only pane is not a format target: ⌘B in the top bar must land in
    // the pane the writer can actually type in.
    if (path && !readOnly) formatBus.register(path, view);
    const unwatchScroll = watchAncestorScroll(view);
    const focusPath = path;
    // Restores this document's saved zoom, and makes ⌘+/⌘−/⌘0 land here while
    // the caret is in this pane.
    const unzoom = focusPath
      ? registerZoomPane({ path: focusPath, kind: "prose", host: host.current, view })
      : undefined;
    const onFocus = () => {
      if (!focusPath) return;
      if (!readOnly) formatBus.focus(focusPath);
      focusZoomPane(focusPath);
    };
    view.contentDOM.addEventListener("focus", onFocus);
    return () => {
      unwatchScroll();
      unzoom?.();
      view.contentDOM.removeEventListener("focus", onFocus);
      if (path && !readOnly) formatBus.unregister(path, view);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push external value changes into the editor without breaking undo.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // Our own edit coming back around — nothing to push. For prose and notes
    // this is a pointer comparison (the store holds the very string the
    // listener emitted); for the screenplay, whose value is a slice past the
    // title block, it is a memcmp of equal strings. Either beats serialising
    // the document to find out.
    if (value === emittedRef.current) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={host} className="prose-editor" />;
}
