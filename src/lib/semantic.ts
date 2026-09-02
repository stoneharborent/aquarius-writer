/**
 * The renderer's door onto `src-tauri/src/semantic/` — search by meaning.
 *
 * Like `compile.ts` this is deliberately *not* part of `VaultService`: that
 * interface is the vault seam, and this is a model.
 *
 * Unlike compile, this one **does** have an honest mock. Compile's fake would
 * have to pretend to have produced an EPUB, which is a lie about a file on
 * disk. A search does not write anything, so the browser preview can run a
 * real — if crude — meaning-ish search over the mock vault, and every part of
 * the UI is exercisable in `npm run dev`: the toggle, the results, the
 * grouped previews, and (with `?semantic=absent`) the download card.
 *
 * The mock scores by shared words, which is emphatically NOT what the app
 * does: it has no idea that "left him" and "walked out of the marriage" mean
 * the same thing. It exists so the layout can be reviewed in a tab, and it
 * says so on screen.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriShell } from "@/lib/platform";
import { vault } from "@/lib/vault";
import type { VaultNode } from "@/types/vault";

export type SemanticPhase = "absent" | "downloading" | "ready" | "error";

export interface SemanticStatus {
  available: boolean;
  phase: SemanticPhase;
  modelId: string;
  modelLicence: string;
  downloadBytes: number;
  bytesOnDisk: number;
  percent?: number;
  message?: string;
  indexing?: { done: number; total: number };
}

export interface SemanticHit {
  path: string;
  line: number;
  preview: string;
  score: number;
  chunks: number;
}

/** What a search answers with when it cannot run. Never an exception. */
export interface SemanticRefusal {
  available: false;
  reason: string;
  hint: string;
}

export function isRefusal(v: unknown): v is SemanticRefusal {
  return !!v && typeof v === "object" && (v as SemanticRefusal).available === false;
}

export const SEMANTIC_STATE_EVENT = "semantic://state";

// ── the preview's stand-in ───────────────────────────────────────────────

/** `?semantic=absent` forces the download card in the browser preview. */
function previewPhase(): SemanticPhase {
  if (typeof window === "undefined") return "ready";
  try {
    const q = new URLSearchParams(window.location.search).get("semantic");
    if (q === "absent" || q === "downloading" || q === "error") return q;
  } catch { /* no window.location in a worker */ }
  return "ready";
}

function mockStatus(): SemanticStatus {
  const phase = previewPhase();
  return {
    available: phase === "ready",
    phase,
    modelId: "BAAI/bge-small-en-v1.5",
    modelLicence: "MIT",
    downloadBytes: 34_728_348,
    bytesOnDisk: phase === "ready" ? 34_728_348 : 0,
    percent: phase === "downloading" ? 42 : undefined,
    message: phase === "error" ? "The download did not finish." : undefined,
  };
}

function textFiles(node: VaultNode, out: string[] = []): string[] {
  if (node.path && /\.(md|markdown|fountain|txt)$/i.test(node.path)) out.push(node.path);
  for (const child of node.children ?? []) textFiles(child, out);
  return out;
}

const WORDS = /[a-z0-9']+/g;

function bag(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of text.toLowerCase().match(WORDS) ?? []) {
    if (w.length < 3) continue;
    out.set(w, (out.get(w) ?? 0) + 1);
  }
  return out;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  for (const [w, n] of a) dot += n * (b.get(w) ?? 0);
  const norm = (m: Map<string, number>) =>
    Math.sqrt([...m.values()].reduce((s, n) => s + n * n, 0));
  const d = norm(a) * norm(b);
  return d === 0 ? 0 : dot / d;
}

/** Chunk the same way the Rust side does — whole paragraphs up to 180 words. */
function chunks(body: string): { line: number; text: string }[] {
  const lines = body.split("\n");
  const out: { line: number; text: string }[] = [];
  let start = 0;
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.join("\n");
    const last = out[out.length - 1];
    const words = (n: string) => n.split(/\s+/).filter(Boolean).length;
    if (last && words(last.text) + words(text) <= 180) last.text += "\n\n" + text;
    else out.push({ line: start, text });
    buffer = [];
  };
  lines.forEach((line, i) => {
    if (line.trim() === "") { flush(); return; }
    if (buffer.length === 0) start = i;
    buffer.push(line);
  });
  flush();
  return out;
}

async function mockSearch(
  workflowId: string, tree: VaultNode, query: string, limit: number,
): Promise<SemanticHit[]> {
  if (previewPhase() !== "ready") {
    return Promise.reject<SemanticHit[]>({
      available: false,
      reason: "model-missing",
      hint: "This is the browser preview with ?semantic=absent.",
    } satisfies SemanticRefusal);
  }
  const q = bag(query);
  const hits: SemanticHit[] = [];
  for (const path of textFiles(tree)) {
    let body: string;
    try { body = await vault().readFile(workflowId, path); } catch { continue; }
    const pieces = chunks(body.replace(/^---\n[\s\S]*?\n---\n?/, ""));
    let best: SemanticHit | null = null;
    for (const piece of pieces) {
      const score = cosine(q, bag(piece.text));
      if (!best || score > best.score) {
        best = {
          path,
          line: piece.line,
          preview: piece.text.replace(/\s+/g, " ").slice(0, 200),
          score,
          chunks: pieces.length,
        };
      }
    }
    if (best && best.score > 0) hits.push(best);
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── the real thing ───────────────────────────────────────────────────────

export async function probeSemantic(): Promise<SemanticStatus> {
  if (!isTauriShell()) return mockStatus();
  return invoke<SemanticStatus>("semantic_probe");
}

/** Only ever called from a button a person pressed. */
export async function downloadSemanticModel(): Promise<SemanticStatus> {
  if (!isTauriShell()) return mockStatus();
  return invoke<SemanticStatus>("semantic_download");
}

export async function removeSemanticModel(): Promise<SemanticStatus> {
  if (!isTauriShell()) return mockStatus();
  return invoke<SemanticStatus>("semantic_remove");
}

export async function reindexSemantic(workflowId: string): Promise<void> {
  if (!isTauriShell()) return;
  await invoke("semantic_reindex", { workflowId });
}

/**
 * Rejects with a `SemanticRefusal` when the model is not here — run the
 * rejection through `isRefusal`. The `tree` is only used by the browser mock.
 */
export async function searchSemantic(
  workflowId: string, tree: VaultNode, query: string, limit = 50,
): Promise<SemanticHit[]> {
  if (!isTauriShell()) return mockSearch(workflowId, tree, query, limit);
  return invoke<SemanticHit[]>("semantic_search", { workflowId, query, limit });
}

/** Redraw whenever the model's state or the indexing progress changes. */
export function onSemanticState(fn: (s: SemanticStatus) => void): () => void {
  if (!isTauriShell()) return () => {};
  const stop = listen<SemanticStatus>(SEMANTIC_STATE_EVENT, (e) => fn(e.payload));
  return () => { void stop.then((f) => f()); };
}

/** "35 MB" — what the card promises before anything is downloaded. */
export function formatModelSize(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
