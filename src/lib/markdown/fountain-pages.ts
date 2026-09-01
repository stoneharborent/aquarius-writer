// The pagination engine — where the page breaks fall, and how much blank is
// left under each one.
//
// PARITY row 12 / SWIFT-AUDIT §2.1: "a PAGED canvas with real page breaks…
// ~55 lines/page estimate". The old `estimatePages` was an *estimate* in the
// honest sense — it counted a fixed number of virtual blank rows before scene
// headings and characters on top of the blank lines the Fountain source
// already contains, so it double-counted every one of them and was reliably
// long. This engine is line-accurate: one source line is one or more grid
// rows and nothing else, exactly as the canvas paints it.
//
// ── THE RULES, in full ────────────────────────────────────────────────────
//
//  1. **A page is 54 rows.** 648pt of text block ÷ a 12pt line
//     (`screenplay-metrics.ts`). Not "about 55".
//
//  2. **A row is a wrapped visual row of one source line.** A blank source
//     line is one row. Wrapping is greedy word wrapping at that element's
//     column count (60 action · 37 character · 25 parenthetical · 35 dialogue),
//     which is what CSS `white-space: pre-wrap` does inside a block of exactly
//     that width in a monospace face — so the model and the paint agree.
//     A word longer than the column count sits alone on its row and overhangs,
//     the same way the browser overhangs it.
//
//  3. **Nothing is added for element spacing.** Fountain's blank lines *are*
//     the spacing, they are in the document, and they are counted as rows like
//     any other line. The canvas therefore carries no element padding either
//     (see `fountainTheme`) — a screenplay is set solid on a 12pt grid.
//
//  4. **A break falls between source lines, never inside one.** If a line's
//     rows do not fit in what is left of the page, the whole line moves down.
//     A line taller than a whole page starts a fresh page and overhangs.
//
//  5. **Orphan control moves a break EARLIER, never later.** A page may not
//     end on a scene heading, on a scene heading and its blank, on a character
//     cue, or on a cue and its parenthetical. The offending lines travel to the
//     next page. The break is never pulled back past the page's first line.
//
//  6. **Blank lines at a break stay on the page above.** A page never opens on
//     a blank row. Those lines are already blank, so letting one or two of them
//     sit in the bottom margin costs nothing visually — and it keeps the break
//     on a line the reader can see.
//
//  7. **`fill` is `54 − used`, and it is SIGNED.** It is what the canvas turns
//     into padding so that every sheet is exactly the same painted height —
//     which is the whole reason the sheets can be a repeating background
//     instead of a measured layout. Rule 6 can push a page to 55 or 56 rows, so
//     `fill` goes negative there and the padding under that page shrinks by
//     exactly the rows that overhung it. Clamping it at zero would have looked
//     harmless and walked every page below down by 16px per absorbed blank,
//     which is the one bug this whole file is arranged to make impossible. The
//     CSS clamps the resulting *padding* at zero, not the row count.
//
// Rule 3 is also why this file replaced the old `SPACE_BEFORE` table rather
// than fixing it: with the source blanks counted, there is nothing left for it
// to add.

import { classify, type FountainLineKind } from "@/lib/fountain";
import { COLS, ROWS_PER_PAGE } from "@/lib/markdown/screenplay-metrics";

/** A shot is an action line that opens with a camera direction. */
export function isShotLine(line: string): boolean {
  let u = line.trim().toUpperCase();
  if (u.startsWith("!")) u = u.slice(1); // see through a forced-action mark
  return ["CLOSE ON", "ANGLE ON", "POV", "INSERT", "ESTABLISHING SHOT"]
    .some((p) => u.startsWith(p));
}

/** Classify every line of the doc (classification is backward-looking only). */
export function classifyLines(lines: readonly string[]): FountainLineKind[] {
  const kinds: FountainLineKind[] = new Array(lines.length);
  let prev: FountainLineKind = "blank";
  let prevPrev: FountainLineKind = "blank";
  for (let i = 0; i < lines.length; i++) {
    kinds[i] = classify(lines[i], prev, prevPrev);
    prevPrev = prev;
    prev = kinds[i];
  }
  return kinds;
}

/** Columns available to a line of this kind. */
export function colsForKind(kind: FountainLineKind): number {
  switch (kind) {
    case "character": return COLS.character;
    case "parenthetical": return COLS.parenthetical;
    case "dialogue": return COLS.dialogue;
    case "transition": return COLS.transition;
    default: return COLS.action; // scene-heading, action, section, synopsis, blank
  }
}

/**
 * How many grid rows one source line occupies.
 *
 * Greedy word wrap, which is what the browser does to `pre-wrap` text in a box
 * `cols` glyphs wide — the same algorithm, so the count and the paint agree.
 *
 * The over-long-word case is not hypothetical and is not guessed at:
 * `EditorView.lineWrapping` sets `overflow-wrap: anywhere` (plus
 * `word-break: break-word` for Safari) on `.cm-content`. Per spec that breaks a
 * word only when it will not fit on a line of its own, so a monster URL in a
 * note line takes `ceil(len / cols)` rows here exactly as it does on screen.
 */
export function wrapRows(text: string, cols: number): number {
  const t = text.trim();
  if (t === "") return 1;
  if (t.length <= cols) return 1;
  let rows = 1;
  let used = 0;
  for (const word of t.split(/\s+/)) {
    if (used > 0) {
      if (used + 1 + word.length <= cols) { used += 1 + word.length; continue; }
      rows++;      // the word does not fit here; start a fresh row for it
      used = 0;
    }
    if (word.length <= cols) { used = word.length; continue; }
    // Too long even for an empty row: `overflow-wrap: anywhere` chops it.
    const extra = Math.ceil(word.length / cols) - 1;
    rows += extra;
    used = word.length - extra * cols;
  }
  return rows;
}

export interface Page {
  /** 1-based page number. */
  number: number;
  /** First source line on this page (0-based, inclusive). */
  start: number;
  /** One past the last source line on this page. */
  end: number;
  /** Grid rows this page's lines occupy. May exceed 54 by a blank or two. */
  used: number;
  /** `54 − used`. Signed: negative when rule 6 pushed the page over. */
  fill: number;
}

export interface Pagination {
  pageCount: number;
  pages: Page[];
  /** 0-based source-line indices that START a page (pages 2+). */
  breaks: number[];
  /** `fill` of the page ABOVE each break, index-aligned with `breaks`. */
  breakFill: number[];
  /** Blank rows left on the last page — the canvas's bottom padding. */
  tailRows: number;
  /** Rows per source line, index-aligned with the input. */
  rows: number[];
}

/**
 * Pull a break earlier so a page cannot end on something that has to be read
 * with what follows it. Bounded, and never past the page's first line — a page
 * that contained nothing would not be a page.
 */
function avoidOrphan(at: number, kinds: readonly FountainLineKind[], pageStart: number): number {
  let i = at;
  for (let guard = 0; guard < 4; guard++) {
    if (i <= pageStart + 1) break;
    const prev = kinds[i - 1];
    const prev2 = i >= 2 ? kinds[i - 2] : "blank";
    // A heading or a cue as the last line on a page.
    if (prev === "scene-heading" || prev === "character") { i -= 1; continue; }
    // A heading and the blank under it.
    if (prev === "blank" && prev2 === "scene-heading") { i -= 2; continue; }
    // A cue and its parenthetical, with the dialogue overleaf.
    if (prev === "parenthetical" && prev2 === "character") { i -= 2; continue; }
    break;
  }
  return Math.max(pageStart + 1, i);
}

/** Lay a script out on 54-row pages. `lines` is BODY text — no title block. */
export function paginate(lines: readonly string[]): Pagination {
  const kinds = classifyLines(lines);
  const rows = lines.map((text, i) => wrapRows(text, colsForKind(kinds[i])));
  const sum = (from: number, to: number) => {
    let n = 0;
    for (let i = from; i < to; i++) n += rows[i];
    return n;
  };

  const pages: Page[] = [];
  let start = 0;
  let used = 0;
  let i = 0;

  while (i < lines.length) {
    if (used > 0 && used + rows[i] > ROWS_PER_PAGE) {
      let brk = avoidOrphan(i, kinds, start);
      // Rule 6: a page never opens on a blank row.
      while (brk < lines.length && kinds[brk] === "blank") brk++;
      if (brk >= lines.length) break; // only blanks left — no new page for them
      const u = sum(start, brk);
      pages.push({
        number: pages.length + 1,
        start,
        end: brk,
        used: u,
        fill: ROWS_PER_PAGE - u, // signed — see rule 7
      });
      start = brk;
      i = brk;
      used = 0;
      continue;
    }
    used += rows[i];
    i++;
  }

  const lastUsed = sum(start, lines.length);
  pages.push({
    number: pages.length + 1,
    start,
    end: lines.length,
    used: lastUsed,
    fill: ROWS_PER_PAGE - lastUsed,
  });

  return {
    pageCount: pages.length,
    pages,
    breaks: pages.slice(1).map((p) => p.start),
    breakFill: pages.slice(0, -1).map((p) => p.fill),
    tailRows: pages[pages.length - 1].fill,
    rows,
  };
}

/* ── one-entry memo (NOTES §27k) ──────────────────────────────────────────
 *
 * Two independent consumers paginate the same buffer on the same keystroke:
 * `fountainDecorations` needs the break positions and their fill, and
 * `pageBreaks` needs the page count and the tail rows. Before the memo that
 * was two full passes over the script per edit.
 *
 * A single entry is the right size: there is one screenplay open per editor
 * and the question is always "again, for the document I just asked about".
 * The key is the document text, so the cache cannot go stale — a miss costs
 * one string comparison, which V8 settles on the length or the first
 * differing byte long before `paginate` would have finished a line.
 */
let memoKey: string | null = null;
let memoValue: Pagination | null = null;

/** `paginate`, memoised on the document text. Prefer this from a CM plugin. */
export function paginateDoc(text: string): Pagination {
  if (memoKey === text && memoValue) return memoValue;
  memoValue = paginate(text.split("\n"));
  memoKey = text;
  return memoValue;
}

export interface PageEstimate {
  pageCount: number;
  /** 0-based line indices that START a new page (page 2+). */
  breaks: number[];
}

/**
 * The old name, kept because three call sites and the footer badge use it.
 * It is no longer an estimate.
 */
export function estimatePages(lines: readonly string[]): PageEstimate {
  const p = paginate(lines);
  return { pageCount: p.pageCount, breaks: p.breaks };
}
