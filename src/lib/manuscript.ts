// The manuscript rules that more than one screen needs, in one place — the
// TypeScript half of `src-tauri/src/vault/tree.rs`'s front-matter convention
// and of the page arithmetic every surface quotes.
//
// PARITY row 8. Anything here that decides what a *file* is has a Rust twin
// with the same name, because the backend seeds a manuscript's chapter order
// and the frontend paints it: if the two disagreed, a title page would be
// chapter one on one side and not on the other.

import type { ChapterStatus, VaultNode } from "@/types/vault";

/**
 * The three front-matter documents a manuscript folder can hold, by name.
 *
 * The Swift ChapterRail shows a FRONT MATTER section (SWIFT-AUDIT §2.2) and the
 * audit never says how those files are identified. This port settles it by
 * **convention**: a markdown file sitting directly in the manuscript's own
 * folder, named exactly one of these (case-insensitively, extension aside).
 * `Title Page.md`, `Dedication.md`, `Epigraph.md`.
 *
 * They are deliberately not chapters — `tree::chapter_paths_in` leaves them out
 * of the manuscript's chapter order, so a title page is never compiled as
 * chapter one and never counted in "N chapters".
 */
export const FRONT_MATTER_NAMES = ["Title Page", "Dedication", "Epigraph"] as const;

export type FrontMatterName = (typeof FRONT_MATTER_NAMES)[number];

/** The file name a front-matter slot is stored under. */
export const frontMatterFile = (label: FrontMatterName) => `${label}.md`;

const stemOf = (path: string) =>
  (path.split("/").pop() ?? path).replace(/\.(md|markdown)$/i, "");

/**
 * Is `path` one of `folder`'s front-matter documents? Strictly one level down:
 * `Book/Title Page.md` is, `Book/Part One/Title Page.md` is not.
 */
export function isFrontMatter(folder: string, path: string): boolean {
  const prefix = folder ? `${folder}/` : "";
  if (!path.startsWith(prefix)) return false;
  const name = path.slice(prefix.length);
  if (name.includes("/")) return false;
  if (!/\.(md|markdown)$/i.test(name)) return false;
  const stem = stemOf(name).toLowerCase();
  return FRONT_MATTER_NAMES.some((n) => n.toLowerCase() === stem);
}

/** Where a front-matter slot would live inside `folder`, whether or not it exists. */
export const frontMatterPath = (folder: string, label: FrontMatterName) =>
  folder ? `${folder}/${frontMatterFile(label)}` : frontMatterFile(label);

/** The front-matter slot a path fills, or null when it is an ordinary document. */
export function frontMatterLabel(folder: string, path: string): FrontMatterName | null {
  if (!isFrontMatter(folder, path)) return null;
  const stem = stemOf(path).toLowerCase();
  return FRONT_MATTER_NAMES.find((n) => n.toLowerCase() === stem) ?? null;
}

/**
 * Pages, the way the whole app estimates them: **one page per 250 words**,
 * rounded up. It is the paperback rule of thumb — 250 words is about what a
 * 6×9 trade page holds — and it is deliberately the same arithmetic in the
 * summary bar, the ManuscriptHome card, the chapter rail and the MCP
 * `list_manuscripts` tool, so no two of them can ever quote a different length
 * for the same book. Nothing here is the *screenplay's* page count: that one is
 * real pagination (`fountain-pages.ts`), because a script's page is a legal
 * unit rather than an estimate.
 */
export const WORDS_PER_PAGE = 250;
export const pagesFor = (words: number) => Math.ceil(words / WORDS_PER_PAGE);

export const STATUS_ORDER: ChapterStatus[] = ["outline", "drafting", "rev", "final"];

export const STATUS_LABEL: Record<ChapterStatus, string> = {
  final: "Final",
  drafting: "Drafting",
  rev: "Revising",
  outline: "Outline",
};

export const STATUS_COLOR: Record<ChapterStatus, string> = {
  final: "var(--success)",
  drafting: "var(--starred)",
  rev: "var(--warn)",
  outline: "var(--ink-mute)",
};

/** Find a node by path. The tree is small enough that a walk is the honest way. */
export function findNode(node: VaultNode | null, path: string): VaultNode | null {
  if (!node) return null;
  if (node.path === path) return node;
  if (!node.children) return null;
  for (const c of node.children) {
    const hit = findNode(c, path);
    if (hit) return hit;
  }
  return null;
}

/** A chapter's status, defaulting to "outline" the way every surface paints it. */
export const statusOf = (node: VaultNode | null): ChapterStatus =>
  (node?.frontmatter?.status as ChapterStatus | undefined) ?? "outline";

export interface ManuscriptStats {
  words: number;
  statusCounts: Record<ChapterStatus, number>;
}

/** Words and per-status counts for a list of chapters. */
export function collectStats(tree: VaultNode | null, chapters: string[]): ManuscriptStats {
  const statusCounts: Record<ChapterStatus, number> = {
    final: 0, drafting: 0, rev: 0, outline: 0,
  };
  let words = 0;
  for (const path of chapters) {
    const n = findNode(tree, path);
    if (!n) continue;
    words += n.words ?? 0;
    statusCounts[statusOf(n)]++;
  }
  return { words, statusCounts };
}

/**
 * Put a filtered chapter order back into the full one.
 *
 * The outline and the corkboard can be *filtered* by status while still being
 * draggable, and `reorderChapters` refuses anything that is not a permutation
 * of the whole order (it rearranges; it never adds or drops). So a drag inside
 * a filtered view rearranges only the slots the filter kept, and every hidden
 * chapter stays exactly where it was.
 */
export function spliceFiltered(
  full: string[],
  visible: string[],
  reordered: string[],
): string[] {
  const shown = new Set(visible);
  const next = reordered[Symbol.iterator]();
  return full.map((p) => (shown.has(p) ? (next.next().value ?? p) : p));
}
