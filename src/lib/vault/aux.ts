// Versions, comments, trash, and workflow search — the web mirrors of the
// desktop's SnapshotStore / CommentStore / TrashStore / FindStore.
//
// The rules (coalescing, retention counts, restore-snapshots-first) live here.
// *Where the bytes land* lives in `aux-store.ts`: `.aquarius/` on disk in the
// Tauri shell, localStorage in the browser preview. Same exported API either
// way — nothing that calls into this file needs to know which is running.
import { vault } from "@/lib/vault";
import { auxBackend } from "./aux-store";
import type { VaultNode } from "@/types/vault";

export type { VersionEntry, CommentEntry, TrashEntry } from "./aux-store";
import type { CommentEntry, TrashEntry, VersionEntry } from "./aux-store";

/** Load a workflow's version/comment/trash state. Called when one opens. */
export function hydrateAux(wf: string): Promise<void> {
  return auxBackend().hydrate(wf);
}

// ── versions ─────────────────────────────────────────────────────────────

const AUTO_COALESCE_MS = 5 * 60_000;
const MAX_AUTO = 25;

function countWords(s: string): number {
  return (s.match(/\S+/g) ?? []).length;
}

export function listVersions(wf: string, path: string): VersionEntry[] {
  return auxBackend().listVersions(wf, path);
}

/** Record an autosave version. Coalesces: an unnamed version younger than
 * 5 minutes is replaced instead of stacking. Keeps the newest 25 autos. */
export function recordAutoVersion(wf: string, path: string, body: string) {
  const all = [...listVersions(wf, path)];
  const now = Date.now();
  const head = all[0];
  if (head && !head.named && now - head.at < AUTO_COALESCE_MS) {
    all[0] = { ...head, at: now, body, words: countWords(body) };
  } else {
    all.unshift({
      id: `v${now.toString(36)}`,
      at: now, label: "Auto", named: false,
      words: countWords(body), body,
    });
  }
  const autos = all.filter((v) => !v.named);
  if (autos.length > MAX_AUTO) {
    const drop = new Set(autos.slice(MAX_AUTO).map((v) => v.id));
    auxBackend().saveVersions(wf, path, all.filter((v) => !drop.has(v.id)));
  } else {
    auxBackend().saveVersions(wf, path, all);
  }
}

export function takeSnapshot(wf: string, path: string, label: string, body: string) {
  const all = [...listVersions(wf, path)];
  all.unshift({
    id: `s${Date.now().toString(36)}`,
    at: Date.now(), label: label || "Snapshot", named: true,
    words: countWords(body), body,
  });
  auxBackend().saveVersions(wf, path, all);
}

/** Restore `versionId`; the current text is snapshotted first (desktop rule). */
export async function restoreVersion(
  wf: string, path: string, versionId: string, currentBody: string,
): Promise<string | null> {
  const v = listVersions(wf, path).find((x) => x.id === versionId);
  if (!v) return null;
  takeSnapshot(wf, path, "Before restore", currentBody);
  await vault().writeFile(wf, path, v.body);
  return v.body;
}

// ── comments ─────────────────────────────────────────────────────────────

export function listComments(wf: string, path: string): CommentEntry[] {
  return auxBackend().listComments(wf, path);
}
export function addComment(wf: string, path: string, anchor: string, text: string) {
  const all = [...listComments(wf, path)];
  all.unshift({ id: `c${Date.now().toString(36)}`, at: Date.now(), anchor, text, resolved: false });
  auxBackend().saveComments(wf, path, all);
}
export function setCommentResolved(wf: string, path: string, id: string, resolved: boolean) {
  auxBackend().saveComments(wf, path, listComments(wf, path)
    .map((c) => (c.id === id ? { ...c, resolved } : c)));
}
export function deleteComment(wf: string, path: string, id: string) {
  auxBackend().saveComments(wf, path, listComments(wf, path).filter((c) => c.id !== id));
}

// ── favorites ────────────────────────────────────────────────────────────
//
// Thin by design: unlike versions there is no rule to apply here — a star is
// on or it is off. The *reactive* copy lives in `state/favoritesStore.ts`,
// which is what the sidebar reads; these are the plumbing it calls.

/** Starred paths for this workflow, sorted. */
export function listFavorites(wf: string): string[] {
  return auxBackend().listFavorites(wf);
}

/** Re-read the starred list — an MCP client may have changed it. */
export function refreshFavorites(wf: string): Promise<string[]> {
  return auxBackend().refreshFavorites(wf);
}

/** Star, unstar (`starred`), or flip (omit it). Resolves to the new state. */
export function setFavorite(wf: string, path: string, starred?: boolean): Promise<boolean> {
  return auxBackend().setFavorite(wf, path, starred);
}

/** Carry stars across a rename or move. Resolves to the list as it now is. */
export function migrateFavorites(wf: string, from: string, to: string): Promise<string[]> {
  return auxBackend().migrateFavorites(wf, from, to);
}

// ── trash ────────────────────────────────────────────────────────────────

export function listTrash(wf: string): TrashEntry[] {
  return auxBackend().listTrash(wf);
}

/** Soft-delete: capture content for restore, then hand off to the backend. */
export async function trashFile(wf: string, path: string): Promise<void> {
  let body = "";
  try { body = await vault().readFile(wf, path); } catch { /* binary/unreadable */ }
  await auxBackend().trashFile(wf, path, body);
}

export async function restoreTrash(wf: string, id: string): Promise<string | null> {
  return auxBackend().restoreTrash(wf, id);
}

export function purgeTrashEntry(wf: string, id: string) {
  auxBackend().purgeTrash(wf, id);
}

// ── workflow search ──────────────────────────────────────────────────────

export interface SearchHit {
  path: string;
  line: number;        // 0-based
  preview: string;
  count: number;       // matches in this file
}

const MAX_RECENT_SEARCHES = 20;

/** Recent find queries for this workflow, newest first. */
export function listRecentSearches(wf: string): string[] {
  return auxBackend().listSearches(wf);
}

function rememberSearch(wf: string, query: string) {
  const q = query.trim();
  if (!q) return;
  const next = [q, ...listRecentSearches(wf).filter((x) => x !== q)].slice(0, MAX_RECENT_SEARCHES);
  auxBackend().saveSearches(wf, next);
}

function textFiles(node: VaultNode, out: string[] = []): string[] {
  if (node.kind === "markdown" || node.kind === "fountain"
      || /\.(md|fountain|txt)$/i.test(node.path ?? "")) {
    if (node.path) out.push(node.path);
  }
  for (const child of node.children ?? []) textFiles(child, out);
  return out;
}

export async function searchWorkflow(
  wf: string, tree: VaultNode, query: string,
): Promise<SearchHit[]> {
  const q = query.toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const path of textFiles(tree)) {
    let body: string;
    try { body = await vault().readFile(wf, path); } catch { continue; }
    const lines = body.split("\n");
    let count = 0;
    let first: { line: number; preview: string } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].toLowerCase().indexOf(q);
      if (idx >= 0) {
        count += lines[i].toLowerCase().split(q).length - 1;
        if (!first) first = { line: i, preview: lines[i].trim().slice(0, 120) };
      }
    }
    if (count > 0 && first) hits.push({ path, ...first, count });
  }
  rememberSearch(wf, query);
  return hits.sort((a, b) => b.count - a.count);
}

export async function replaceInFile(
  wf: string, path: string, find: string, replace: string,
): Promise<{ body: string; replaced: number } | null> {
  let body: string;
  try { body = await vault().readFile(wf, path); } catch { return null; }
  // Case-insensitive, matching what searchWorkflow counted — a replace that
  // touches fewer hits than the search reported would be a lie.
  const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let replaced = 0;
  const next = body.replace(re, () => { replaced++; return replace; });
  if (replaced === 0) return { body, replaced: 0 };
  await vault().writeFile(wf, path, next);
  return { body: next, replaced };
}
