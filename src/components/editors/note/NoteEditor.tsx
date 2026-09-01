import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { proseTheme, wysiwygDecorations } from "@/lib/markdown/wysiwyg";
import { wikilinks, wikilinkCompletion } from "@/lib/markdown/wikilink-ext";
import { focusZoomPane, registerZoomPane } from "@/lib/markdown/editor-zoom";
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
  /** Reference mode — the split pane's read-only half (SWIFT-AUDIT §2.1). */
  readOnly?: boolean;
  /**
   * Where a `[[wiki-link]]` click goes.
   *
   * Defaults to the window's selection, which is the primary pane. The split's
   * secondary pane passes its own opener so a link followed over there stays
   * over there instead of yanking the document out from under the other pane.
   */
  onNavigate?: (path: string) => void;
}

const mdShortcutKeymap = keymap.of([
  { key: "Mod-b", run: (v) => { applyMdCommand(v, "bold"); return true; } },
  { key: "Mod-i", run: (v) => { applyMdCommand(v, "italic"); return true; } },
  { key: "Mod-Shift-x", run: (v) => { applyMdCommand(v, "strike"); return true; } },
]);

export function NoteEditor({
  value, onChange, path, readOnly = false, onNavigate,
}: NoteEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const tree = useVault((s) => s.tree);
  const selectPath = useVault((s) => s.selectPath);
  const setView = useVault((s) => s.setView);
  const treeRef = useRef<typeof tree>(tree);
  treeRef.current = tree;

  // The click handler is baked into the CodeMirror extension at mount, so it
  // goes through a ref — otherwise a pane that changes where its links lead
  // (opened in the split, then closed) would keep the first answer forever.
  const navRef = useRef<(target: string) => void>(() => {});
  navRef.current = onNavigate ?? ((target: string) => { selectPath(target); setView("editor"); });

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
          (target) => navRef.current(target),
        ),
        ...wikilinkCompletion(treeRef, path),
        proseTheme,
        // Reference mode — see ProseEditor for why it takes both facets.
        ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    if (path && !readOnly) formatBus.register(path, view);
    const unwatchScroll = watchAncestorScroll(view);
    const focusPath = path;
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
