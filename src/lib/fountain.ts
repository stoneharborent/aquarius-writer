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

/** Split off the title page block (everything up to the first blank line is
 * the title page if any line matches the title-page key pattern). */
export function splitTitlePage(text: string): { titlePage: TitlePage; body: string } {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) return { titlePage: {}, body: text };
  if (!TITLE_PAGE_KEYS.test(lines[i])) return { titlePage: {}, body: text };

  const headerLines: string[] = [];
  while (i < lines.length && lines[i].trim() !== "") {
    headerLines.push(lines[i]);
    i++;
  }
  // skip the blank separator
  while (i < lines.length && lines[i].trim() === "") i++;

  const titlePage: TitlePage = {};
  let currentKey: string | null = null;
  for (const line of headerLines) {
    const m = /^([A-Za-z][A-Za-z ]+):\s*(.*)$/.exec(line);
    if (m) {
      currentKey = m[1];
      titlePage[currentKey] = m[2].trim();
    } else if (currentKey) {
      titlePage[currentKey] = (titlePage[currentKey] ?? "") + " " + line.trim();
    }
  }
  return { titlePage, body: lines.slice(i).join("\n") };
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
