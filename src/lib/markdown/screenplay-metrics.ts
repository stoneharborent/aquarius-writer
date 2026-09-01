// The screenplay page, in numbers. One module, no imports, so both the
// pagination engine and the theme layer read the same geometry.
//
// PARITY: SWIFT-AUDIT §2.1 — "industry-exact page geometry (612×792pt US
// Letter, text block 72–720pt, Courier 12pt on 12pt lines; element margins in
// points: scene heading/action 108→540, character 252→522, parenthetical
// 216→396, dialogue 180→432, transition right-aligned ending 510.98, shot
// 108→540)".
//
// ── Why 4/3 and not 1/1 ──────────────────────────────────────────────────
// The Wave-3 brief said "mapped to px at 1pt=1px baseline zoom". CSS defines
// 1pt as exactly 4/3 px (a point is 1/72", a CSS pixel is 1/96"), so 1pt=1px
// is not the identity mapping — it is a 25% shrink, and it lands the body on a
// **12px** line box that nobody can draft on. At 4/3:
//
//   • the page is 816 × 1056 px — a US Letter sheet at 96dpi, exactly;
//   • the line box is 16px and the type is 16px Courier, which is what
//     12pt-on-12pt *is*;
//   • every vertical length stays a whole pixel at every zoom rung, because
//     each one is an integer multiple of the line (see `screenplayMetrics`).
//
// The print preview overlay still renders at 1pt = 1px, because that sheet is
// a picture of the PDF rather than a writing surface.
//
// ── Why every vertical number is a multiple of the line ──────────────────
// docs/NOTES.md §1a: CodeMirror's height map is built by measuring border
// boxes, and a fractional line box desynchronises it from the painted document
// on WebKitGTK. The paged canvas leans on that even harder than the old
// continuous one did — the sheets are painted as a *repeating background* with
// no measurement at all, so the arithmetic here and the layout the browser
// paints have to agree to the pixel or the pages drift off the text.
//
// 792 = 72 + 648 + 72 and 648 = 54 × 12, so at a line box of `L` the page is
// 66L tall, the margins are 6L, and the body is exactly 54L. Never fractional,
// at any L.

/** Page, in points. */
export const PAGE_W_PT = 612;
export const PAGE_H_PT = 792;

/** The text block, in points: 72pt from the top, ending at 720pt. */
export const TEXT_TOP_PT = 72;
export const TEXT_BOTTOM_PT = 720;

/** Courier 12 on 12: one body line is 12pt tall and one glyph is 7.2pt wide. */
export const LINE_PT = 12;
export const CHAR_PT = 7.2;

/** 648pt of text block ÷ a 12pt line. The Swift badge says "~55"; 54 is what
 *  the geometry actually gives, and it is the number Final Draft prints. */
export const ROWS_PER_PAGE = (TEXT_BOTTOM_PT - TEXT_TOP_PT) / LINE_PT; // 54

/** Left and right edges of each element's text block, in points. */
export const BLOCK_PT = {
  action: { left: 108, right: 540 },
  scene: { left: 108, right: 540 },
  shot: { left: 108, right: 540 },
  character: { left: 252, right: 522 },
  parenthetical: { left: 216, right: 396 },
  dialogue: { left: 180, right: 432 },
  /** Right-aligned; `end` is where the longest transition finishes. */
  transition: { left: 108, right: 540, end: 510.98 },
} as const;

export type BlockName = keyof typeof BLOCK_PT;

/** Characters that fit on one row of an element's block. */
export function colsFor(block: BlockName): number {
  const b = BLOCK_PT[block];
  return Math.floor((b.right - b.left) / CHAR_PT);
}

/**
 * The column counts, resolved once. 60 / 37 / 25 / 35 — these are the numbers
 * a Fountain renderer wraps at, and the ones `paginate` counts rows with.
 */
export const COLS = {
  action: colsFor("action"),
  scene: colsFor("scene"),
  shot: colsFor("shot"),
  character: colsFor("character"),
  parenthetical: colsFor("parenthetical"),
  dialogue: colsFor("dialogue"),
  transition: colsFor("transition"),
} as const;

/** The line box at 100%: 12pt × 4/3. Every other length derives from it. */
export const BASE_LINE_PX = Math.round((LINE_PT * 4) / 3); // 16

export interface ScreenplayMetrics {
  /** Line box AND type size — a screenplay is set solid. */
  line: number;
  pageW: number;
  pageH: number;
  marginT: number;
  marginB: number;
  marginL: number;
  marginR: number;
  /** Desk showing between two sheets. */
  gap: number;
  /** Distance from the page's top edge down to the page number. */
  pagenumTop: number;
  charIndent: number;
  charPr: number;
  parenIndent: number;
  parenPr: number;
  dialogueIndent: number;
  dialoguePr: number;
  transitionPr: number;
}

/**
 * Every length the paged canvas needs, in whole pixels, for a given line box.
 *
 * `u(pt)` is the one conversion, and it rounds once. Feed it a line box that
 * is itself a whole pixel (`Math.round(BASE_LINE_PX * zoom)`) and every
 * vertical result is exact rather than rounded, because each vertical point
 * value is a multiple of 12.
 */
export function screenplayMetrics(line: number): ScreenplayMetrics {
  const u = (pt: number) => Math.round((pt * line) / LINE_PT);
  const B = BLOCK_PT;
  return {
    line,
    pageW: u(PAGE_W_PT), // 51 × line
    pageH: u(PAGE_H_PT), // 66 × line = marginT + 54×line + marginB
    marginT: u(TEXT_TOP_PT), // 6 × line
    marginB: u(PAGE_H_PT - TEXT_BOTTOM_PT), // 6 × line
    marginL: u(B.action.left), // 9 × line  (1.5" — the binding margin)
    marginR: u(PAGE_W_PT - B.action.right), // 6 × line (1")
    // Desk between sheets. Not derived from the page — it is chrome — but it
    // scales with the zoom so a stack looks the same at every rung.
    gap: Math.max(6, Math.round(line * 1.5)),
    pagenumTop: u(36), // 0.5" down from the page's top edge
    // Element indents are measured from the *text block's* left edge (108pt),
    // because that is where `.cm-content`'s padding already put the caret.
    charIndent: u(B.character.left - B.action.left),
    charPr: u(B.action.right - B.character.right),
    parenIndent: u(B.parenthetical.left - B.action.left),
    parenPr: u(B.action.right - B.parenthetical.right),
    dialogueIndent: u(B.dialogue.left - B.action.left),
    dialoguePr: u(B.action.right - B.dialogue.right),
    transitionPr: u(B.action.right - B.transition.end),
  };
}
