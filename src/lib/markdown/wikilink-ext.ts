// CM6 extension that decorates [[wiki-link]] syntax, routes clicks, and
// completes a name while the writer is typing one.

import { EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
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

  /* Two scroll taxes were paid here, and both are gone (NOTES §27k):
     `collectMarkdown` walked the entire vault tree on EVERY update — every
     scroll-driven measure, every caret move — and `build` re-scanned the whole
     document whenever the viewport moved. `build` covers the whole document,
     so a viewport change has nothing to recompute; and the vault tree is an
     immutable object replaced wholesale by the store, so an identity compare
     is an exact test for "the file list could have changed". */
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      files: ReturnType<typeof collectMarkdown>;
      tree: VaultNode | null;
      constructor(view: EditorView) {
        this.tree = treeRef.current;
        this.files = this.tree ? collectMarkdown(this.tree) : [];
        this.decorations = build(view.state, this.files);
      }
      update(u: ViewUpdate) {
        const treeChanged = treeRef.current !== this.tree;
        if (treeChanged) {
          this.tree = treeRef.current;
          this.files = this.tree ? collectMarkdown(this.tree) : [];
        }
        if (u.docChanged || treeChanged) {
          this.decorations = build(u.state, this.files);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  return [plugin, click];
}

/* ─── Autocomplete (PARITY row 13) ────────────────────────────────────────
 *
 * Caret inside an unclosed `[[` → the vault's markdown documents, by display
 * name. Prose and note editors only; a screenplay has no wiki links.
 *
 * Nothing here touches the decorations above. `Decoration.replace` hiding in
 * wysiwyg.ts and the plain `Decoration.mark` here are the two things NOTES §1a
 * found innocent, and the completion source is a pure read of the document —
 * it adds no decoration, no widget and no styling to the content path. The
 * popup is a CodeMirror tooltip, which lives outside `.cm-content` entirely.
 */

/** How far back a `[[` may sit and still count as "the caret is inside it". */
const MAX_QUERY = 120;

/** `Drafts/Ch_03.md` → `Drafts` — the disambiguator on a duplicate name. */
function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * The completion source. `treeRef` is read on every invocation rather than
 * captured, so a file created since the editor mounted is offered immediately.
 */
function wikilinkSource(
  treeRef: { current: VaultNode | null },
  currentPath?: string,
) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);

    const open = before.lastIndexOf("[[");
    if (open < 0) return null;

    const query = before.slice(open + 2);
    // Bail out of anything that means the caret is not inside an open link:
    // a link that already closed, a fresh `[` after the opener, a newline
    // (links do not wrap), or the alias half of `[[Name|alias]]`.
    if (query.length > MAX_QUERY) return null;
    if (/[[\]|\n]/.test(query)) return null;

    const files = treeRef.current ? collectMarkdown(treeRef.current) : [];
    // A document never offers itself.
    const candidates = files.filter((f) => f.path !== currentPath);
    if (!candidates.length) return null;

    // Two files can share a display name; show the folder so they can be told
    // apart, and only then.
    const seen = new Map<string, number>();
    for (const f of candidates) {
      seen.set(f.name.toLowerCase(), (seen.get(f.name.toLowerCase()) ?? 0) + 1);
    }

    const needle = query.trim().toLowerCase();
    const options: Completion[] = candidates.map((f) => ({
      label: f.name,
      // CodeMirror's own matcher scores prefix > word-boundary > fuzzy and
      // highlights the matched characters; the boost only breaks its ties, so
      // a true prefix hit sits above a scattered subsequence match.
      boost: needle && f.name.toLowerCase().startsWith(needle) ? 1 : 0,
      detail: (seen.get(f.name.toLowerCase()) ?? 0) > 1 ? parentOf(f.path) : undefined,
      apply: (view, _c, from, to) => {
        // Do not double the closer: the writer may be re-editing the name
        // inside a link that already has its `]]`.
        const tail = view.state.sliceDoc(to, Math.min(to + 2, view.state.doc.length));
        const closing = tail === "]]" ? "" : "]]";
        const insert = f.name + closing;
        view.dispatch({
          changes: { from, to, insert },
          // Land after the `]]` either way, so the writer keeps typing prose.
          selection: { anchor: from + insert.length + (closing ? 0 : 2) },
          userEvent: "input.complete",
          scrollIntoView: true,
        });
      },
    }));

    return {
      from: line.from + open + 2,
      options,
      // Keep the same result alive while the name is still being typed.
      validFor: /^[^[\]|\n]*$/,
    };
  };
}

/**
 * Popover chrome, in tokens. Deliberately the app's menu idiom (`--surface` on
 * a `--line` border, `--accent-soft` for the selected row) rather than
 * CodeMirror's default, and in the UI font — it is chrome floating over the
 * page, not part of the manuscript.
 */
const completionTheme = EditorView.theme({
  ".cm-tooltip.cm-tooltip-autocomplete": {
    background: "var(--surface)",
    border: "1px solid var(--line)",
    borderRadius: "8px",
    boxShadow: "0 8px 28px rgba(0, 0, 0, 0.18)",
    padding: "4px",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-ui)",
    fontSize: "12px",
    maxHeight: "220px",
    minWidth: "180px",
    maxWidth: "320px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    padding: "6px 8px",
    borderRadius: "5px",
    color: "var(--ink)",
    lineHeight: "16px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "var(--accent-soft)",
    color: "var(--ink)",
  },
  ".cm-completionLabel": { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-completionMatchedText": {
    textDecoration: "none",
    fontWeight: "600",
    color: "var(--accent)",
  },
  ".cm-completionDetail": {
    flex: "0 0 auto",
    fontStyle: "normal",
    fontSize: "11px",
    color: "var(--ink-mute)",
  },
});

/**
 * `[[` autocompletion for the prose and note editors.
 *
 * `override` is used on purpose: this is the only completion the writing
 * surface offers, so the popup can never appear for anything else (the
 * markdown language package ships HTML completions it would otherwise
 * inherit inside embedded blocks).
 *
 * Keyboard nav, Enter to accept and Esc to dismiss come from
 * `autocompletion`'s own high-precedence keymap, which is why this extension
 * can go after the editors' `defaultKeymap` without losing Escape.
 */
export function wikilinkCompletion(
  treeRef: { current: VaultNode | null },
  currentPath?: string,
) {
  return [
    autocompletion({
      override: [wikilinkSource(treeRef, currentPath)],
      icons: false,
      // Offer as soon as `[[` is typed; the source itself is the gate.
      activateOnTyping: true,
      closeOnBlur: true,
      aboveCursor: false,
    }),
    completionTheme,
  ];
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
