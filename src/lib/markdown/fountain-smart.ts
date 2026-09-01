// Final Draft smart-typing for the screenplay CodeMirror editor.
//
// PARITY NOTE: this is a port of the Swift engine —
// `swift/AquariusWriter/Lib/TextStyling/FountainStyler.swift` (+ the July 2026
// fixes: forced-`!` action, dialogue-heal, shot escape) and the classify rules
// in `swift/AquariusWriter/Lib/Fountain.swift`. Change the Swift side first,
// then mirror here. `classify` itself lives in `src/lib/fountain.ts`.
import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { type FountainLineKind } from "@/lib/fountain";
import {
  classifyLines,
  isShotLine,
  paginate,
  type Pagination,
} from "@/lib/markdown/fountain-pages";

// The classifier helpers and the page model moved to `fountain-pages.ts` when
// the estimate became a real pagination engine (PARITY row 12). They are
// re-exported here because half the app imports them from this module, and a
// rename across six files buys nothing.
export { classifyLines, isShotLine, estimatePages, paginate } from "@/lib/markdown/fountain-pages";
export type { PageEstimate, Pagination, Page } from "@/lib/markdown/fountain-pages";

export type FountainElement =
  | "scene" | "action" | "character" | "parenthetical"
  | "dialogue" | "transition" | "shot";

const CUE_KINDS: FountainLineKind[] = ["character", "parenthetical", "dialogue"];

export function effectiveElement(
  lines: readonly string[],
  kinds: readonly FountainLineKind[],
  i: number,
  pending: FountainElement | null,
): FountainElement {
  if (pending) return pending;
  const k = kinds[i] ?? "blank";
  if (k === "action" && isShotLine(lines[i] ?? "")) return "shot";
  switch (k) {
    case "scene-heading": return "scene";
    case "character": return "character";
    case "parenthetical": return "parenthetical";
    case "dialogue": return "dialogue";
    case "transition": return "transition";
    default: return "action";
  }
}

/** Enter flow — the FD rhythm; blanks keep the Fountain text spec-correct. */
export function enterDecision(
  lineText: string,
  element: FountainElement,
): { next: FountainElement; blanks: 1 | 2 } {
  if (lineText.trim() === "") return { next: "action", blanks: 1 };
  switch (element) {
    case "scene":         return { next: "action",    blanks: 2 };
    case "character":     return { next: "dialogue",  blanks: 1 };
    case "parenthetical": return { next: "dialogue",  blanks: 1 };
    case "dialogue":      return { next: "character", blanks: 2 };
    case "transition":    return { next: "scene",     blanks: 2 };
    default:              return { next: "action",    blanks: 2 };
  }
}

export function tabTarget(cur: FountainElement, reverse: boolean): FountainElement {
  if (reverse) {
    return ({ action: "scene", shot: "scene", scene: "transition",
      transition: "character", character: "action", dialogue: "action",
      parenthetical: "action" } as const)[cur];
  }
  return ({ action: "character", shot: "character", character: "transition",
    transition: "scene", scene: "action", dialogue: "parenthetical",
    parenthetical: "dialogue" } as const)[cur];
}

/** Template seeded onto an EMPTY line when the user picks an element. */
export function templateText(el: FountainElement): string | null {
  return ({ scene: "INT. ", transition: "CUT TO:", shot: "CLOSE ON — ",
    parenthetical: "()" } as Partial<Record<FountainElement, string>>)[el] ?? null;
}

export interface ConversionResult {
  lines: string[];
  caretLine: number;
}

/** Convert line `i` in place — parity with FountainStyler.conversionEdit. */
export function convertLine(
  input: readonly string[],
  kinds: readonly FountainLineKind[],
  i: number,
  el: FountainElement,
): ConversionResult | null {
  const lines = [...input];
  const text = lines[i] ?? "";
  const trimmed = text.trim();
  const k = kinds[i];
  let nl = text;
  switch (el) {
    case "scene": {
      nl = trimmed.toUpperCase();
      const slugs = ["INT.", "EXT.", "EST.", "I/E.", "INT./EXT."];
      if (!slugs.some((s) => nl.startsWith(s)) && !nl.startsWith(".")) nl = "." + nl;
      break;
    }
    case "character": nl = trimmed.toUpperCase(); break;
    case "transition":
      nl = trimmed.toUpperCase();
      if (!nl.endsWith("TO:") && !nl.startsWith(">")) nl = "> " + nl;
      break;
    case "action":
      if (k !== "action") nl = "!" + trimmed; // Fountain forced action
      break;
    case "shot":
      nl = trimmed.toUpperCase();
      if (!isShotLine(nl)) nl = "CLOSE ON — " + nl;
      // Inside a dialogue block the positional rule would recapture the
      // line as dialogue — force action; isShotLine sees through the "!".
      if (i > 0 && CUE_KINDS.includes(kinds[i - 1])) nl = "!" + nl;
      break;
    case "parenthetical":
      if (!(trimmed.startsWith("(") && trimmed.endsWith(")"))) nl = "(" + trimmed + ")";
      break;
    case "dialogue":
      // The one convertible case: cue/dialogue above with a single stray
      // blank between — delete the blank so the line rejoins the block.
      if (k !== "dialogue" && i >= 2 && kinds[i - 1] === "blank"
          && CUE_KINDS.includes(kinds[i - 2])) {
        lines.splice(i - 1, 1);
        return { lines, caretLine: i - 1 };
      }
      return null;
  }
  if (el === "character" && i > 0 && kinds[i - 1] !== "blank") {
    lines[i] = nl;
    lines.splice(i, 0, ""); // cues need a blank before
    return { lines, caretLine: i + 1 };
  }
  if (nl === text) return null;
  lines[i] = nl;
  return { lines, caretLine: i };
}

const SLUG_RE = /^\s*(int|ext|est|i\/e|int\.\/ext)\./i;

export function shouldAutoCap(pending: FountainElement | null, lineText: string): boolean {
  if (pending) return ["character", "scene", "transition", "shot"].includes(pending);
  const t = lineText.trim();
  return SLUG_RE.test(t) || t.endsWith("TO:") || t.startsWith(">");
}

// ── CM state: armed element ──────────────────────────────────────────────

export const setPendingElement = StateEffect.define<FountainElement | null>();

export const pendingElementField = StateField.define<FountainElement | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPendingElement)) return e.value;
    // Leaving the armed paragraph disarms (parity: textViewDidChangeSelection).
    if (tr.selection && !tr.docChanged) {
      const before = tr.startState.doc.lineAt(tr.startState.selection.main.head).number;
      const after = tr.newDoc.lineAt(tr.newSelection.main.head).number;
      if (before !== after) return null;
    }
    return value;
  },
});

function docLines(state: EditorState): string[] {
  return state.doc.toString().split("\n");
}

function caretLine(state: EditorState): number {
  return state.doc.lineAt(state.selection.main.head).number - 1; // 0-based
}

/** Replace the whole doc with `lines`, caret to end of `caretLineIdx`. */
function dispatchLines(view: EditorView, lines: string[], caretLineIdx: number,
                       caretCol?: number) {
  const doc = lines.join("\n");
  let pos = 0;
  for (let i = 0; i < caretLineIdx; i++) pos += lines[i].length + 1;
  pos += caretCol ?? lines[caretLineIdx]?.length ?? 0;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: doc },
    selection: { anchor: Math.min(pos, doc.length) },
    userEvent: "input.aq-element",
  });
}

/** Toolbar/⌘n entry point — convert or arm the caret line's element. */
export function applyElement(view: EditorView, el: FountainElement): void {
  const lines = docLines(view.state);
  const kinds = classifyLines(lines);
  const i = caretLine(view.state);
  if ((lines[i] ?? "").trim() === "") {
    const tpl = templateText(el);
    const effects = [setPendingElement.of(el === "action" ? null : el)];
    if (tpl !== null) {
      const next = [...lines];
      next[i] = tpl;
      const col = el === "parenthetical" ? 1 : tpl.length;
      const doc = next.join("\n");
      let pos = 0;
      for (let j = 0; j < i; j++) pos += next[j].length + 1;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        selection: { anchor: pos + col },
        effects,
        userEvent: "input.aq-element",
      });
    } else {
      view.dispatch({ effects });
    }
    view.focus();
    return;
  }
  const res = convertLine(lines, kinds, i, el);
  if (res) dispatchLines(view, res.lines, res.caretLine);
  view.dispatch({ effects: setPendingElement.of(null) });
  view.focus();
}

function handleEnter(view: EditorView): boolean {
  const state = view.state;
  const lines = docLines(state);
  const kinds = classifyLines(lines);
  const i = caretLine(state);
  const pending = state.field(pendingElementField);
  const el = effectiveElement(lines, kinds, i,
    lines[i].trim() === "" ? null : pending);
  const d = enterDecision(lines[i] ?? "", el);
  const insert = d.blanks === 2 ? "\n\n" : "\n";
  const sel = state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
    effects: setPendingElement.of(d.next === "action" ? null : d.next),
    userEvent: "input",
  });
  return true;
}

function handleTab(view: EditorView, reverse: boolean): boolean {
  const lines = docLines(view.state);
  const kinds = classifyLines(lines);
  const i = caretLine(view.state);
  const pending = view.state.field(pendingElementField);
  const target = tabTarget(effectiveElement(lines, kinds, i, pending), reverse);
  applyElement(view, target);
  return true;
}

const ELEMENT_ORDER: FountainElement[] = [
  "scene", "action", "character", "parenthetical", "dialogue", "transition", "shot",
];

/** Auto-caps + slug snap, applied as the user types (never on programmatic edits). */
function autoCapsFilter(tr: Transaction): TransactionSpec | readonly TransactionSpec[] {
  if (!tr.docChanged || !tr.isUserEvent("input.type")) return tr;
  const state = tr.startState;
  const pending = state.field(pendingElementField, false) ?? null;
  let lower = false;
  tr.changes.iterChanges((_f, _t, _f2, _t2, ins) => {
    if (/[a-z]/.test(ins.toString())) lower = true;
  });
  if (!lower) return tr;
  const pos = tr.newSelection.main.head;
  const line = tr.newDoc.lineAt(pos);
  const text = line.text;
  const capsByPending = shouldAutoCap(pending, text);
  const isSlug = SLUG_RE.test(text.trim());
  if (!capsByPending && !isSlug) return tr;
  const upper = text.toUpperCase();
  if (upper === text) return tr;
  return [tr, {
    changes: { from: line.from, to: line.to, insert: upper },
    selection: { anchor: pos },
    sequential: true,
  }];
}

/** Mirror the caret's element out to React (element pill bar). */
export function fountainSmartTyping(
  onElement?: (el: FountainElement) => void,
): Extension {
  return [
    pendingElementField,
    EditorState.transactionFilter.of(autoCapsFilter),
    keymap.of([
      { key: "Enter", run: handleEnter },
      { key: "Tab", run: (v) => handleTab(v, false) },
      { key: "Shift-Tab", run: (v) => handleTab(v, true) },
      ...ELEMENT_ORDER.map((el, n) => ({
        key: `Mod-${n + 1}`,
        run: (v: EditorView) => { applyElement(v, el); return true; },
      })),
    ]),
    EditorView.updateListener.of((u) => {
      if (!onElement || (!u.selectionSet && !u.docChanged)) return;
      const lines = docLines(u.state);
      const kinds = classifyLines(lines);
      onElement(effectiveElement(
        lines, kinds, caretLine(u.state), u.state.field(pendingElementField)));
    }),
  ];
}

// ── the page model, pushed out to React ───────────────────────────────────

/**
 * Report the live pagination to the host on every document change.
 *
 * The visible page-break rules render as **line decorations** inside
 * `fountainDecorations` (fountain-ext.ts) — widget decorations wedged CM's
 * viewport updates in this nested-scroll embed — and the sheets themselves are
 * a repeating background, so nothing here paints. What the host needs is the
 * page count for the footer and `tailRows` for the canvas's bottom padding.
 */
export function pageBreaks(onPages?: (p: Pagination) => void): Extension {
  return EditorView.updateListener.of((u) => {
    if (!onPages || !u.docChanged) return;
    onPages(paginate(u.state.doc.toString().split("\n")));
  });
}
