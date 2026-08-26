import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { proseTheme, wysiwygDecorations } from "@/lib/markdown/wysiwyg";
import { wikilinks } from "@/lib/markdown/wikilink-ext";
import { useVault } from "@/state/vaultStore";
import { formatBus } from "@/lib/format/formatBus";
import { watchAncestorScroll } from "@/lib/cm-embed";
import { applyMdCommand } from "@/lib/format/mdCommands";
import "@/components/editors/prose/ProseEditor.css";

interface NoteEditorProps {
  value: string;
  onChange: (v: string) => void;
  /** Document path — registers the view on the formatBus for the toolbar. */
  path?: string;
}

const mdShortcutKeymap = keymap.of([
  { key: "Mod-b", run: (v) => { applyMdCommand(v, "bold"); return true; } },
  { key: "Mod-i", run: (v) => { applyMdCommand(v, "italic"); return true; } },
  { key: "Mod-Shift-x", run: (v) => { applyMdCommand(v, "strike"); return true; } },
]);

export function NoteEditor({ value, onChange, path }: NoteEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const tree = useVault((s) => s.tree);
  const selectPath = useVault((s) => s.selectPath);
  const setView = useVault((s) => s.setView);
  const treeRef = useRef<typeof tree>(tree);
  treeRef.current = tree;

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
        ...wikilinks(
          { current: treeRef.current },
          (path) => { selectPath(path); setView("editor"); },
        ),
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

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} className="prose-editor" />;
}
