// Smart-type for the screenplay: character names and scene headings.
//
// PARITY row 12 / SWIFT-AUDIT §2.1 — "smart-type autocomplete for character
// names and scene headings". Same mechanism as the prose editor's `[[`
// completion (NOTES §22a): `@codemirror/autocomplete`, an `override` source so
// nothing else can appear in the popup, and the popover themed in tokens as
// chrome rather than as part of the manuscript.
//
// What it completes, and what it refuses to:
//
//   • **Character cues.** On a line that is a cue *position* — blank line
//     above, caret on a line of nothing but the name — every character who has
//     spoken in this script, most recent first. Recency, not the alphabet:
//     the person who just spoke is overwhelmingly the person about to.
//   • **Scene headings.** On a line that has started one, the six slug
//     prefixes, and then — once a prefix is typed — every location the script
//     has already used with that prefix, plus the time-of-day tails the script
//     has used. Typing `INT. K` offers `INT. KITCHEN - DAY` if the writer has
//     been there before.
//
// It never offers on a dialogue, action, parenthetical or transition line, and
// it never fires inside a word that already matches something exactly — a
// popup over a finished name is noise.

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { classifyLines } from "@/lib/markdown/fountain-pages";

/** The six slug prefixes the smart-typing engine and the classifier agree on. */
const SLUG_PREFIXES = ["INT.", "EXT.", "EST.", "INT./EXT.", "I/E.", "."] as const;

const SLUG_START = /^\s*(?:i|in|int|int\.|e|ex|est|est\.|ext|ext\.|i\/|i\/e|i\/e\.|int\.\/|int\.\/e|int\.\/ex|int\.\/ext|int\.\/ext\.|\.)/i;

/** A cue line is a bare, un-parenthesised name on its own after a blank. */
const CUE_TYPING = /^[\p{L}\p{N} .'\-]*$/u;

export interface ScriptVocabulary {
  /** Character names, most recently spoken first. */
  characters: string[];
  /** Full scene headings already used, most recent first. */
  headings: string[];
}

/**
 * Everything the completion knows, read straight off the document.
 *
 * Deliberately not cached anywhere: a screenplay is one file, `split("\n")`
 * over it is cheap, and a cache would be one more thing that can disagree with
 * the buffer. `classifyLines` is the same pass the decorations already run.
 */
export function scriptVocabulary(doc: string): ScriptVocabulary {
  const lines = doc.split("\n");
  const kinds = classifyLines(lines);
  const characters: string[] = [];
  const headings: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    if (kinds[i] === "character") {
      // Strip a `(V.O.)`-style extension and the `^` dual-dialogue mark: the
      // name is what completes, and the writer types the extension.
      const name = t.replace(/\^\s*$/, "").replace(/\s*\(.*\)\s*$/, "").trim();
      if (name && !characters.includes(name)) characters.push(name);
    } else if (kinds[i] === "scene-heading") {
      const slug = t.replace(/\s*#[^#]*#\s*$/, "").trim();
      if (slug && !headings.includes(slug)) headings.push(slug);
    }
  }
  return { characters, headings };
}

/** Recency as a `boost`: the last speaker outranks everyone, then down. */
function recencyBoost(index: number, total: number): number {
  if (total <= 1) return 50;
  return Math.round(50 - (index / (total - 1)) * 50);
}

function cueSource(ctx: CompletionContext, vocab: ScriptVocabulary): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  if (!CUE_TYPING.test(before)) return null;
  // A cue needs a blank line above it, which is also what makes the position
  // unambiguous — anything else here is dialogue or action.
  const prev = line.number > 1 ? ctx.state.doc.line(line.number - 1).text.trim() : "";
  if (prev !== "") return null;
  // Everything after the caret has to be empty too, or this is an edit in the
  // middle of a finished cue.
  if (line.text.slice(ctx.pos - line.from).trim() !== "") return null;

  const typed = before.trimStart();
  if (!ctx.explicit && typed.length === 0) return null;

  const options: Completion[] = vocab.characters.map((name, i) => ({
    label: name,
    type: "variable",
    boost: recencyBoost(i, vocab.characters.length),
  }));
  if (options.length === 0) return null;
  return {
    from: line.from + (before.length - typed.length),
    options,
    validFor: CUE_TYPING,
  };
}

function headingSource(ctx: CompletionContext, vocab: ScriptVocabulary): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  if (line.text.slice(ctx.pos - line.from).trim() !== "") return null;
  const typed = before.trimStart();
  const from = line.from + (before.length - typed.length);
  if (!ctx.explicit && !SLUG_START.test(typed)) return null;
  if (!ctx.explicit && typed.length === 0) return null;

  const options: Completion[] = [];
  const upper = typed.toUpperCase();

  // Past locations first — a heading the script already has is almost always
  // the one being typed again.
  vocab.headings.forEach((h, i) => {
    if (h.toUpperCase() === upper) return; // already written out in full
    options.push({
      label: h,
      type: "constant",
      detail: "used",
      boost: recencyBoost(i, vocab.headings.length),
    });
  });
  // Then the bare prefixes, so a brand-new location still gets its slug for
  // free. They sit below the real headings on purpose.
  for (const p of SLUG_PREFIXES) {
    if (p === ".") continue; // a forced heading is not a prefix anyone types
    if (options.some((o) => o.label === `${p} `)) continue;
    options.push({ label: `${p} `, type: "keyword", boost: -20 });
  }
  if (options.length === 0) return null;
  return { from, options, validFor: /^[^\n]*$/ };
}

/**
 * The one completion source the screenplay offers. It decides which of the two
 * kinds applies from the caret's position, so the popup can never show a
 * character name where a slug belongs.
 */
export function screenplayCompletionSource(ctx: CompletionContext): CompletionResult | null {
  const doc = ctx.state.doc.toString();
  const vocab = scriptVocabulary(doc);
  const line = ctx.state.doc.lineAt(ctx.pos);
  const typed = line.text.slice(0, ctx.pos - line.from).trimStart();

  // A slug is unambiguous the moment it starts; try it first.
  if (SLUG_START.test(typed) || (ctx.explicit && typed === "")) {
    const heading = headingSource(ctx, vocab);
    if (heading) return heading;
  }
  return cueSource(ctx, vocab);
}

/**
 * Popover chrome, in tokens — the same rules and the same idiom as the wiki
 * link popup (NOTES §22a), in the mono face because what it inserts is
 * screenplay text.
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
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    maxHeight: "220px",
    minWidth: "180px",
    maxWidth: "340px",
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
    fontWeight: "700",
    color: "var(--accent)",
  },
  ".cm-completionDetail": {
    flex: "0 0 auto",
    fontStyle: "normal",
    fontFamily: "var(--font-ui)",
    fontSize: "11px",
    color: "var(--ink-mute)",
  },
});

/**
 * Character-name and scene-heading completion for the screenplay editor.
 *
 * `override` is used for the same reason the prose editor uses it: this is the
 * only completion the surface offers, so nothing inherited can appear. Arrow
 * keys, Enter and Esc come from `autocompletion`'s own high-precedence keymap
 * — which is also why this extension must sit BEFORE the Fountain smart-typing
 * keymap in the extension list, or Enter would end the paragraph instead of
 * accepting the highlighted name.
 */
export function screenplayCompletion() {
  return [
    autocompletion({
      override: [screenplayCompletionSource],
      icons: false,
      activateOnTyping: true,
      closeOnBlur: true,
      aboveCursor: false,
    }),
    completionTheme,
  ];
}
