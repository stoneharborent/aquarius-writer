import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { fountainDecorations, fountainTheme } from "@/lib/markdown/fountain-ext";
import {
  fountainSmartTyping,
  pageBreaks,
  type FountainElement,
} from "@/lib/markdown/fountain-smart";
import { focusZoomPane, registerZoomPane } from "@/lib/markdown/editor-zoom";
import { formatBus } from "@/lib/format/formatBus";
import { watchAncestorScroll } from "@/lib/cm-embed";
import "./ScreenplayEditor.css";

interface Props {
  value: string;
  onChange: (v: string) => void;
  scrollToScene?: number; // scene index to scroll to
  /** Document path — registers the view on the formatBus for the toolbar. */
  path?: string;
  /** Caret element mirror for the toolbar's element pills. */
  onElement?: (el: FountainElement) => void;
  onPageCount?: (n: number) => void;
  /** Reference mode — the split pane's read-only half (SWIFT-AUDIT §2.1). */
  readOnly?: boolean;
}

export function ScreenplayEditor({
  value, onChange, path, onElement, onPageCount, readOnly = false,
}: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onElementRef = useRef(onElement);
  onElementRef.current = onElement;
  const onPageCountRef = useRef(onPageCount);
  onPageCountRef.current = onPageCount;

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        // Smart typing first: its Enter/Tab/⌘n bindings outrank the defaults.
        fountainSmartTyping((el) => onElementRef.current?.(el)),
        pageBreaks((n) => onPageCountRef.current?.(n)),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        fountainDecorations(),
        fountainTheme,
        // Reference mode — see ProseEditor for why it takes both facets. The
        // smart-typing keymap above is a command set, so `readOnly` disarms it
        // the same way it disarms the defaults.
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
    // The screenplay zooms its whole grid — type, line box, the element
    // indents — not just the font, so a page stays a page at every step.
    const unzoom = focusPath
      ? registerZoomPane({ path: focusPath, kind: "screenplay", host: host.current, view })
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

  function scrollTo(from: number) {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: EditorView.scrollIntoView(from, { y: "start" }),
      selection: { anchor: from, head: from },
    });
    view.focus();
  }

  // Expose imperatively via a ref hook would be cleaner; the scenes rail uses
  // the (from) position so the parent passes it through via a callback prop.
  // We attach scrollTo to the DOM node for the rail to access without ceremony.
  useEffect(() => {
    if (host.current) {
      (host.current as HTMLDivElement & { __screenplayScroll?: typeof scrollTo }).__screenplayScroll = scrollTo;
    }
  });

  return <div ref={host} className="screenplay-editor" />;
}

export interface ScreenplayPaneHandle {
  scrollToOffset: (from: number) => void;
}
