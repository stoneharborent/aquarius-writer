// CM6 extension that decorates [[wiki-link]] syntax and routes clicks.

import { EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { WIKILINK_REGEX, resolveName } from "@/lib/wikilinks";
import type { VaultNode } from "@/types/vault";
import { collectMarkdown } from "@/lib/wikilinks";

const RESOLVED = Decoration.mark({ class: "cm-wikilink" });
const UNRESOLVED = Decoration.mark({ class: "cm-wikilink unresolved" });

export function wikilinks(treeRef: { current: VaultNode | null }, onOpen: (path: string) => void) {
  const click = EditorView.domEventHandlers({
    click(e) {
      const target = e.target as HTMLElement;
      if (!target.classList.contains("cm-wikilink")) return false;
      const text = target.textContent ?? "";
      const name = text.replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
      const files = treeRef.current ? collectMarkdown(treeRef.current) : [];
      const path = resolveName(name, files);
      if (path) {
        onOpen(path);
        e.preventDefault();
        return true;
      }
      return false;
    },
  });

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      files: ReturnType<typeof collectMarkdown>;
      constructor(view: EditorView) {
        this.files = treeRef.current ? collectMarkdown(treeRef.current) : [];
        this.decorations = build(view.state, this.files);
      }
      update(u: ViewUpdate) {
        // refresh file list once per update — tree may have changed
        this.files = treeRef.current ? collectMarkdown(treeRef.current) : [];
        if (u.docChanged || u.viewportChanged) {
          this.decorations = build(u.state, this.files);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  return [plugin, click];
}

function build(state: EditorState, files: ReturnType<typeof collectMarkdown>): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const text = state.doc.toString();
  WIKILINK_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_REGEX.exec(text))) {
    const from = m.index;
    const to = from + m[0].length;
    const name = m[1].trim();
    const resolved = resolveName(name, files);
    b.add(from, to, resolved ? RESOLVED : UNRESOLVED);
  }
  return b.finish();
}
