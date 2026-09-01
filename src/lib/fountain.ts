// Fountain helpers. Parsing delegates to `fountain-js` for full conformance
// (title page, dual dialogue, boneyard, etc.); regex helpers here are for the
// CM6 decoration plugin where we need fast incremental classification.

import { Fountain } from "fountain-js";

export interface SceneIndex {
  /** byte offset of the heading line */
  from: number;
  to: number;
  /** display label, e.g. "INT. LIGHTHOUSE — NIGHT" */
  label: string;
  /** the slug without scene number */
  slug: string;
  /** optional scene number suffix `#01#` if present */
  number?: string;
}

export interface TitlePage {
  Title?: string;
  Author?: string;
  Credit?: string;
  Source?: string;
  "Draft date"?: string;
  Contact?: string;
  [key: string]: string | undefined;
}

// Parity: swift/AquariusWriter/Lib/Fountain.swift predicates — Swift trims
// before matching, accepts a bare "INT. " slug prefix (the element-menu
// template), and allows a trailing "^" dual-dialogue mark on cues.
const SCENE_HEAD_RE = /^(INT\.|EXT\.|EST\.|INT\.\/EXT\.|I\/E\.)|^\.[^.\s].*$/;
const TRANSITION_RE = /^(?:[A-Z][A-Z0-9 ]+ TO:|>.*)$/;
const CHARACTER_RE = /^[A-Z][A-Z0-9 .'-]*(?:\s*\(.*\))?(?:\s*\^)?\s*$/;
const PAREN_RE = /^\s*\(.*\)\s*$/;
const SECTION_RE = /^(#{1,3})\s+(.+)$/;
const SYNOPSIS_RE = /^=(?!=)\s*(.+)$/;
const NOTE_RE = /\[\[.+?\]\]/g;

const TITLE_PAGE_KEYS = /^(?:Title|Credit|Author|Source|Draft date|Notes|Copyright|Contact|Revision)\s*:/i;

/** Cheap line-level classifier — used by the CM6 syntax plugin. */
export type FountainLineKind =
  | "scene-heading"
  | "transition"
  | "character"
  | "parenthetical"
  | "section"
  | "synopsis"
  | "dialogue"
  | "action"
  | "blank";

export function classify(line: string, prev: FountainLineKind, prevPrev: FountainLineKind): FountainLineKind {
  if (line.trim() === "") return "blank";
  // Fountain forced action ("!") — wins over every positional rule so an
  // element conversion out of a dialogue block sticks. Parity: Swift
  // Fountain.classify (July 2026 fix).
  if (line.trim().startsWith("!")) return "action";
  const t = line.trim();
  if (SCENE_HEAD_RE.test(t)) return "scene-heading";
  if (TRANSITION_RE.test(t)) return "transition";
  if (SECTION_RE.test(line)) return "section";
  if (SYNOPSIS_RE.test(line)) return "synopsis";
  if (PAREN_RE.test(line) && (prev === "character" || prev === "dialogue")) return "parenthetical";
  if (CHARACTER_RE.test(line) && prev === "blank" && line.length < 60) return "character";
  // A dialogue block continues until a blank line (parity: Swift dropped the
  // prevPrev guard in the July 2026 fix). prevPrev kept for API stability.
  if (prev === "character" || prev === "parenthetical" || prev === "dialogue") {
    return "dialogue";
  }
  void prevPrev;
  return "action";
}

/* ── the Fountain title block ─────────────────────────────────────────────
 *
 * PARITY row 12 / SWIFT-AUDIT §2.1: the Title Page is "a second tab on the
 * same .fountain file (Title/Credit/Author/Source/Draft date/Contact, written
 * into the Fountain title block)". No frontmatter is involved and none is
 * introduced — a `.fountain` file's metadata is its own title block, and the
 * editor writes it through the same buffer and the same guarded save path as
 * the script.
 *
 * Two rules the writer never sees but would notice if they broke:
 *
 *   • **Unknown keys survive.** Fountain's spec allows any `Key: value`, and
 *     writers use `Notes:`, `Copyright:`, `Revision:`, `WGA:`. The form edits
 *     six fields; everything else round-trips in its original position with
 *     its original spelling.
 *   • **A field is removed by emptying it**, not by writing an empty line.
 *     An `Author:` with nothing after it is a title page with a blank line on
 *     it, which is not what the writer meant.
 */

/** The six fields the Title Page tab edits, in the order it lays them out. */
export const TITLE_FIELDS = [
  "Title", "Credit", "Author", "Source", "Draft date", "Contact",
] as const;
export type TitleField = (typeof TITLE_FIELDS)[number];

/** One `Key: value` line of the block, in file order. */
export type TitleEntry = [key: string, value: string];

export interface TitleBlock {
  /** Every entry, in the order the file has them. */
  entries: TitleEntry[];
  /** Characters of the source the block occupies, blank separator included. */
  length: number;
  /** False when the file simply has no title block. */
  present: boolean;
}

const TITLE_KEY_RE = /^([A-Za-z][A-Za-z ]*[A-Za-z])\s*:\s?(.*)$/;

/** Match a written key against a known field, ignoring case and spacing. */
export function canonicalTitleField(key: string): TitleField | null {
  const k = key.trim().toLowerCase();
  return TITLE_FIELDS.find((f) => f.toLowerCase() === k) ?? null;
}

/**
 * Read the title block off the top of a Fountain file.
 *
 * A continuation line (indented, or simply not a `Key:` line) belongs to the
 * key above it and is joined with a newline rather than a space — a `Contact:`
 * is usually an address, and flattening it loses the address.
 */
export function parseTitleBlock(text: string): TitleBlock {
  // Read the HEAD of the file, not the whole of it. This used to
  // `text.split("\n")` the entire document to look at its first few lines —
  // one string allocated per line of a ninety-page script — on a function the
  // screenplay pane called twice per keystroke (docs/NOTES.md §27l).
  //
  // A title block is a run of `Key:` lines at the very top, terminated by a
  // blank line, so a fixed prefix always contains it. The guard is the
  // load-bearing part: if the prefix does not hold non-blank content followed
  // by a blank line, the block did not end inside it and we fall back to the
  // whole text rather than mis-read the file.
  const HEAD_CHARS = 4096;
  let scan = text.length <= HEAD_CHARS ? text : text.slice(0, HEAD_CHARS);
  if (scan.length < text.length && !/\S[\s\S]*?\r?\n[ \t]*\r?\n/.test(scan)) scan = text;

  const lines = scan.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || !TITLE_PAGE_KEYS.test(lines[i])) {
    return { entries: [], length: 0, present: false };
  }

  const head: string[] = [];
  while (i < lines.length && lines[i].trim() !== "") { head.push(lines[i]); i++; }
  while (i < lines.length && lines[i].trim() === "") i++; // the blank separator

  const entries: TitleEntry[] = [];
  for (const line of head) {
    const m = TITLE_KEY_RE.exec(line);
    if (m) {
      entries.push([m[1], m[2].trim()]);
    } else if (entries.length) {
      const last = entries[entries.length - 1];
      last[1] = last[1] ? `${last[1]}\n${line.trim()}` : line.trim();
    }
  }

  // Characters consumed up to line `i`, counting the "\n" that ended each.
  // Identical to the old `text.length - lines.slice(i).join("\n").length` —
  // both are sum(len(lines[k])) + i for k < i — but it does not depend on
  // `lines` covering the whole document, which it no longer does.
  let length = 0;
  for (let k = 0; k < i; k++) length += lines[k].length + 1;
  if (length > text.length) length = text.length;
  return { entries, length, present: true };
}

/** Render entries back to Fountain. Empty values are dropped, not emitted. */
export function serializeTitleBlock(entries: readonly TitleEntry[]): string {
  const out: string[] = [];
  for (const [key, value] of entries) {
    if (!value.trim()) continue;
    const [first, ...rest] = value.split("\n");
    out.push(`${key}: ${first}`.trimEnd());
    // Fountain's continuation is an indented line under its key.
    for (const line of rest) if (line.trim()) out.push(`    ${line.trim()}`);
  }
  return out.join("\n");
}

/**
 * Fold the form's six fields into a file's existing entries.
 *
 * An existing key keeps its position and its own spelling; a field the form
 * has emptied disappears; a field the file never had is inserted where the
 * canonical order says it belongs among the known keys, so a new `Title:`
 * lands at the top and not under someone's `Copyright:`.
 */
export function mergeTitleEntries(
  existing: readonly TitleEntry[],
  updates: Partial<Record<TitleField, string>>,
): TitleEntry[] {
  const result: TitleEntry[] = [];
  const handled = new Set<TitleField>();

  for (const [key, value] of existing) {
    const canon = canonicalTitleField(key);
    if (canon && canon in updates) {
      handled.add(canon);
      const next = updates[canon] ?? "";
      if (next.trim()) result.push([key, next]); // keep the file's own spelling
      continue;
    }
    result.push([key, value]);
  }

  for (const field of TITLE_FIELDS) {
    if (handled.has(field)) continue;
    const value = updates[field];
    if (!value || !value.trim()) continue;
    const at = result.findIndex(([k]) => {
      const c = canonicalTitleField(k);
      return c !== null && TITLE_FIELDS.indexOf(c) > TITLE_FIELDS.indexOf(field);
    });
    if (at < 0) result.push([field, value]);
    else result.splice(at, 0, [field, value]);
  }

  return result;
}

/** Replace (or remove, or create) the title block at the top of a file. */
export function withTitleBlock(text: string, entries: readonly TitleEntry[]): string {
  const { length } = parseTitleBlock(text);
  const body = text.slice(length);
  const block = serializeTitleBlock(entries);
  return block ? `${block}\n\n${body}` : body;
}

/** Split off the title page block (everything up to the first blank line is
 * the title page if any line matches the title-page key pattern). */
export function splitTitlePage(text: string): { titlePage: TitlePage; body: string } {
  const { entries, length, present } = parseTitleBlock(text);
  if (!present) return { titlePage: {}, body: text };
  const titlePage: TitlePage = {};
  for (const [key, value] of entries) titlePage[key] = value;
  return { titlePage, body: text.slice(length) };
}

/** Find every scene heading in the body. */
export function collectScenes(body: string): SceneIndex[] {
  const out: SceneIndex[] = [];
  let pos = 0;
  for (const line of body.split("\n")) {
    if (SCENE_HEAD_RE.test(line)) {
      const numMatch = /#([^#]+)#$/.exec(line);
      const slug = numMatch ? line.slice(0, numMatch.index).trim() : line.trim();
      out.push({
        from: pos,
        to: pos + line.length,
        label: line.trim(),
        slug: slug.replace(/^\.\s*/, ""),
        number: numMatch?.[1],
      });
    }
    pos += line.length + 1;
  }
  return out;
}

export function fullParse(text: string) {
  const f = new Fountain();
  return f.parse(text, true);
}

export { NOTE_RE };
