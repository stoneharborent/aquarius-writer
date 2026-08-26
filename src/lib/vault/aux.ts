// Versions, comments, trash, and workflow search — the web mirrors of the
// desktop's SnapshotStore / CommentStore / TrashStore / FindStore, built on
// top of the VaultService interface (no interface change: these persist in
// localStorage per workflow, so they work in both the browser preview and the
// Tauri shell until the Rust backend grows native equivalents).
import { vault } from "@/lib/vault";
import type { VaultNode } from "@/types/vault";

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage full / disabled — features degrade to session-only */ }
}

// ── versions ─────────────────────────────────────────────────────────────

export interface VersionEntry {
  id: string;
  at: number;          // epoch ms
  label: string;       // "Auto" or the snapshot name
  named: boolean;
  words: number;
  body: string;
}

const VKEY = (wf: string, path: string) => `aq.versions.${wf}.${path}`;
const AUTO_COALESCE_MS = 5 * 60_000;
const MAX_AUTO = 25;

function countWords(s: string): number {
  return (s.match(/\S+/g) ?? []).length;
}

export function listVersions(wf: string, path: string): VersionEntry[] {
  return readLS<VersionEntry[]>(VKEY(wf, path), []);
}

/** Record an autosave version. Coalesces: an unnamed version younger than
 * 5 minutes is replaced instead of stacking. Keeps the newest 25 autos. */
export function recordAutoVersion(wf: string, path: string, body: string) {
  const all = listVersions(wf, path);
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
    writeLS(VKEY(wf, path), all.filter((v) => !drop.has(v.id)));
  } else {
    writeLS(VKEY(wf, path), all);
  }
}

export function takeSnapshot(wf: string, path: string, label: string, body: string) {
  const all = listVersions(wf, path);
  all.unshift({
    id: `s${Date.now().toString(36)}`,
    at: Date.now(), label: label || "Snapshot", named: true,
    words: countWords(body), body,
  });
  writeLS(VKEY(wf, path), all);
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

export interface CommentEntry {
  id: string;
  at: number;
  /** Quoted anchor text (best-effort re-anchored on render). */
  anchor: string;
  text: string;
  resolved: boolean;
}

const CKEY = (wf: string, path: string) => `aq.comments.${wf}.${path}`;

export function listComments(wf: string, path: string): CommentEntry[] {
  return readLS<CommentEntry[]>(CKEY(wf, path), []);
}
export function addComment(wf: string, path: string, anchor: string, text: string) {
  const all = listComments(wf, path);
  all.unshift({ id: `c${Date.now().toString(36)}`, at: Date.now(), anchor, text, resolved: false });
  writeLS(CKEY(wf, path), all);
}
export function setCommentResolved(wf: string, path: string, id: string, resolved: boolean) {
  writeLS(CKEY(wf, path), listComments(wf, path)
    .map((c) => (c.id === id ? { ...c, resolved } : c)));
}
export function deleteComment(wf: string, path: string, id: string) {
  writeLS(CKEY(wf, path), listComments(wf, path).filter((c) => c.id !== id));
}

// ── trash ────────────────────────────────────────────────────────────────

export interface TrashEntry {
  id: string;
  path: string;
  deletedAt: number;
  body: string;
}

const TKEY = (wf: string) => `aq.trash.${wf}`;

export function listTrash(wf: string): TrashEntry[] {
  return readLS<TrashEntry[]>(TKEY(wf), []);
}

/** Soft-delete: capture content for restore, then delegate to the service. */
export async function trashFile(wf: string, path: string): Promise<void> {
  let body = "";
  try { body = await vault().readFile(wf, path); } catch { /* binary/unreadable */ }
  const all = listTrash(wf);
  all.unshift({ id: `t${Date.now().toString(36)}`, path, deletedAt: Date.now(), body });
  writeLS(TKEY(wf), all);
  await vault().softDelete(wf, path);
}

export async function restoreTrash(wf: string, id: string): Promise<string | null> {
  const entry = listTrash(wf).find((t) => t.id === id);
  if (!entry) return null;
  await vault().writeFile(wf, entry.path, entry.body);
  writeLS(TKEY(wf), listTrash(wf).filter((t) => t.id !== id));
  return entry.path;
}

export function purgeTrashEntry(wf: string, id: string) {
  writeLS(TKEY(wf), listTrash(wf).filter((t) => t.id !== id));
}

// ── workflow search ──────────────────────────────────────────────────────

export interface SearchHit {
  path: string;
  line: number;        // 0-based
  preview: string;
  count: number;       // matches in this file
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
