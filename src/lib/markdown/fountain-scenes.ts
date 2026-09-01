// Moving a scene, on the renderer side.
//
// PARITY row 12 / SWIFT-AUDIT §2.1 — "drag-reorder scenes rewrites the
// script". The MCP tool `reorder_scenes` has done this since Wave 3's tool
// catch-up; this is the same rewrite, for the scenes rail's drag.
//
// **This is a deliberate mirror of `src-tauri/src/vault/fountain.rs`.** The
// two must agree, because they are the same operation reached through two
// doors — the writer's drag and an agent's tool call — and a script that came
// out differently depending on which one moved the scene would be a very
// unpleasant surprise. The Rust file is the reference; change it first, then
// mirror here. Its tests (`reordering_moves_whole_scenes_and_leaves_the_title_
// page_alone`, `moving_the_last_scene_up_keeps_the_blank_line_a_heading_needs`)
// pin the two behaviours below that are easy to get wrong.
//
// One asymmetry is inherited on purpose: the Rust scanner matches slug
// prefixes case-insensitively and the renderer's `SCENE_HEAD_RE` does not, so
// Rust sees a lowercase `int. kitchen` the highlighter paints as action. This
// module follows the RUST rule, not the regex — the rail must be able to drag
// every scene the tool can see, and a heading the writer can read is a heading.

const SLUG_PREFIXES = ["INT./EXT.", "INT/EXT.", "I/E.", "INT.", "EXT.", "EST."];

/** Mirror of `vault::fountain::is_scene_heading`. */
export function isSceneHeading(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith(".")) {
    const rest = t.slice(1);
    // `..` is Fountain's escape for a literal dot; `. ` is just punctuation.
    return rest.length > 0 && !rest.startsWith(".") && !/^\s/.test(rest);
  }
  const upper = t.toUpperCase();
  return SLUG_PREFIXES.some((p) => upper.startsWith(p));
}

export interface SceneBlock {
  index: number;
  heading: string;
  /** 0-based line of the heading. */
  startLine: number;
  /** 0-based line of the last line this scene owns. */
  endLine: number;
}

/** Mirror of `vault::fountain::collect_scenes`, in line indices. */
export function collectSceneBlocks(body: string): SceneBlock[] {
  const lines = body.split("\n");
  const heads: number[] = [];
  for (let i = 0; i < lines.length; i++) if (isSceneHeading(lines[i])) heads.push(i);
  return heads.map((start, index) => ({
    index,
    heading: lines[start].trim(),
    startLine: start,
    endLine: index + 1 < heads.length ? heads[index + 1] - 1 : lines.length - 1,
  }));
}

/**
 * Rewrite `body` with its scenes in the order `order` names.
 *
 * `order` is a permutation of `0..sceneCount`. Anything else is refused rather
 * than half-applied — a "reorder" that silently dropped a scene would take a
 * chunk of the script with it. Returns the new text, or an error string.
 */
export function reorderScenes(
  body: string,
  order: readonly number[],
): { text: string } | { error: string } {
  const scenes = collectSceneBlocks(body);
  if (scenes.length === 0) {
    return { error: "no scene headings in this document — nothing to reorder" };
  }

  const seen = new Array<boolean>(scenes.length).fill(false);
  for (const i of order) {
    if (i < 0 || i >= scenes.length) {
      return { error: `there is no scene ${i} — this script has ${scenes.length}` };
    }
    if (seen[i]) return { error: `scene ${i} appears twice in the new order` };
    seen[i] = true;
  }
  const missing = seen.indexOf(false);
  if (missing >= 0) {
    return {
      error: `the new order must list all ${scenes.length} scenes, each once — scene ${missing} is missing`,
    };
  }

  // A trailing newline belongs to the file, not to the last scene: split it
  // off so a move cannot carry it into the middle of the script.
  const hasTail = body.endsWith("\n");
  const core = hasTail ? body.slice(0, -1) : body;
  const lines = core.split("\n");
  const first = scenes[0].startLine;

  // Whatever sits above the first heading does not move — in a screenplay
  // that is the title block and any opening FADE IN:.
  const out: string[] = lines.slice(0, first);
  for (const i of order) {
    const s = scenes[i];
    // Fountain wants a blank line above a scene heading. Scene blocks usually
    // end with one, but the LAST scene in a script does not — so moving it
    // anywhere but the end would glue its heading onto the line above and the
    // heading would stop being a heading. One blank line is inserted only
    // where that would happen, which leaves an identity permutation
    // byte-identical.
    const last = out[out.length - 1];
    if (out.length > 0 && last !== undefined && last.trim() !== "") out.push("");
    const end = Math.min(s.endLine, lines.length - 1);
    for (let n = s.startLine; n <= end; n++) out.push(lines[n]);
  }

  return { text: out.join("\n") + (hasTail ? "\n" : "") };
}

/** The permutation a drag from `from` to `to` describes. */
export function movePermutation(count: number, from: number, to: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  if (from < 0 || from >= count || to < 0 || to >= count) return order;
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  return order;
}
