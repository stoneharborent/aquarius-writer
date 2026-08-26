import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { proseTheme, wysiwygDecorations } from "@/lib/markdown/wysiwyg";
import { formatBus } from "@/lib/format/formatBus";
import { watchAncestorScroll } from "@/lib/cm-embed";
import { applyMdCommand } from "@/lib/format/mdCommands";
import "./ProseEditor.css";

interface ProseEditorProps {
  value: string;
  onChange: (v: string) => void;
  /** Document path — registers the view on the formatBus for the toolbar. */
  path?: string;
}

/** ⌘B / ⌘I / ⇧⌘X — the desktop FormatBus shortcuts, editor-local. */
const mdShortcutKeymap = keymap.of([
  { key: "Mod-b", run: (v) => { applyMdCommand(v, "bold"); return true; } },
  { key: "Mod-i", run: (v) => { applyMdCommand(v, "italic"); return true; } },
  { key: "Mod-Shift-x", run: (v) => { applyMdCommand(v, "strike"); return true; } },
]);

export function ProseEditor({ value, onChange, path }: ProseEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
        proseTheme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    if (path) formatBus.register(path, view);
    const unwatchScroll = watchAncestorScroll(view);
    const focusPath = path;
    const onFocus = () => { if (focusPath) formatBus.focus(focusPath); };
    view.contentDOM.addEventListener("focus", onFocus);
    return () => {
      unwatchScroll();
      view.contentDOM.removeEventListener("focus", onFocus);
      if (path) formatBus.unregister(path, view);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push external value changes into the editor without breaking undo.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={host} className="prose-editor" />;
}
