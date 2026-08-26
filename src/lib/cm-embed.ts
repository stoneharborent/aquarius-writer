// Shared fix for CM-in-scrolling-article embeds: the editors grow with their
// content and the surrounding article scrolls. CodeMirror registers ancestor
// scroll listeners at construction — before the article has overflow — so it
// never re-measures its viewport when the article scrolls and stops rendering
// lines below the initial fold. A capture-phase document scroll listener
// nudges the measure cycle on any ancestor scroll.
import type { EditorView } from "@codemirror/view";

export function watchAncestorScroll(view: EditorView): () => void {
  const onScroll = (e: Event) => {
    if (e.target instanceof Node && e.target.contains(view.dom)) {
      view.requestMeasure();
    }
  };
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => document.removeEventListener("scroll", onScroll, { capture: true });
}
