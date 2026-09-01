// Per-document editor zoom — ⌘+ / ⌘− / ⌘0, persisted per path.
// PARITY row 14; the Swift behaviour is SWIFT-AUDIT §2.1 ("per-document zoom
// (⌘+/⌘−/⌘0, persisted per path)").
//
// This module owns three things and nothing else:
//   1. the persisted map, one localStorage key for the whole app;
//   2. the registry of editor panes currently on screen, and which of them is
//      the *active* one a keystroke should land on;
//   3. the "apply it" step, which is `applyEditorZoom` in theme.ts plus a
//      CodeMirror re-measure.
//
// THE METRICS CONTRACT (docs/NOTES.md §1a). A zoom step never reaches CSS as a
// multiplication. `applyEditorZoom` multiplies whole-pixel design constants by
// the step and rounds each product once, then writes the integers as scoped
// custom properties on the pane's host element. CodeMirror's height map is
// rebuilt from measurement afterwards (`requestMeasure`), so the map and the
// painted document agree at every zoom level — which is the whole reason the
// caret lands where it was clicked on WebKitGTK.

import type { EditorView } from "@codemirror/view";
import { applyEditorZoom, onProseBaseChange, type EditorZoomKind } from "@/theme/theme";

/**
 * The ladder, matching the Swift navigator/editor zoom range (0.8–1.8).
 * ⌘0 returns to 1.
 */
export const ZOOM_STEPS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8];
export const ZOOM_DEFAULT = 1;

/** One key for every document, so the map is inspectable in one place. */
const STORE_KEY = "aquarius.editorZoom";

/** `{ "Drafts/Ch_03.md": 1.25 }` — paths at the default are simply absent. */
type ZoomMap = Record<string, number>;

function readMap(): ZoomMap {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as ZoomMap;
  } catch {
    // A corrupt preference is not worth an error. It reads as "no zoom" and
    // the next write replaces it.
    return {};
  }
}

function writeMap(map: ZoomMap) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(map));
  } catch {
    // Private mode, quota, a webview with storage off — the zoom still works
    // for this session, it just will not be there next launch.
  }
}

/** Snap any stored number onto the ladder; anything unusable reads as 1. */
function nearestStep(v: number): number {
  if (!Number.isFinite(v)) return ZOOM_DEFAULT;
  let best = ZOOM_DEFAULT;
  let bestGap = Infinity;
  for (const step of ZOOM_STEPS) {
    const gap = Math.abs(step - v);
    if (gap < bestGap) { best = step; bestGap = gap; }
  }
  return best;
}

/** This document's zoom, restored from disk. 1 when it has never been zoomed. */
export function readZoom(path: string): number {
  const v = readMap()[path];
  return typeof v === "number" ? nearestStep(v) : ZOOM_DEFAULT;
}

/** Persist (or forget) one document's zoom. */
export function writeZoom(path: string, zoom: number) {
  const map = readMap();
  if (zoom === ZOOM_DEFAULT) delete map[path];
  else map[path] = zoom;
  writeMap(map);
}

/**
 * Follow a rename or a move, so a zoomed chapter does not silently snap back
 * to 100% because the sidebar renamed it. Exported for whoever wires the
 * rename path to it; nothing calls it yet.
 */
export function remapZoomPath(from: string, to: string) {
  const map = readMap();
  if (!(from in map)) return;
  map[to] = map[from];
  delete map[from];
  writeMap(map);
}

interface ZoomPane {
  path: string;
  kind: EditorZoomKind;
  /** The element the scoped custom properties are written on. */
  host: HTMLElement;
  view: EditorView;
}

/**
 * Live panes, in registration order. A path can be open twice (the split), and
 * both copies are zoomed together — they are the same document.
 */
const panes: ZoomPane[] = [];
let focusedPath: string | null = null;

function apply(pane: ZoomPane) {
  applyEditorZoom(pane.host, pane.kind, readZoom(pane.path));
  // The line box just changed. CodeMirror's height map is built from
  // measurement, so it has to be told to measure again — otherwise the caret
  // is computed against the *old* geometry, which is NOTES §1a all over again.
  pane.view.requestMeasure();
}

/** Register a pane and restore its saved zoom. Returns the unregister. */
export function registerZoomPane(pane: ZoomPane): () => void {
  panes.push(pane);
  apply(pane);
  return () => {
    const i = panes.indexOf(pane);
    if (i >= 0) panes.splice(i, 1);
    if (focusedPath === pane.path && !panes.some((p) => p.path === focusedPath)) {
      focusedPath = null;
    }
  };
}

/** The editor the writer is typing in — mirrors `formatBus.focus`. */
export function focusZoomPane(path: string) {
  focusedPath = path;
}

/**
 * Which pane a ⌘+ lands on: the focused document, else the most recently
 * mounted one (the primary pane in every layout the app has).
 */
function activePane(): ZoomPane | null {
  if (focusedPath) {
    for (let i = panes.length - 1; i >= 0; i--) {
      if (panes[i].path === focusedPath) return panes[i];
    }
  }
  return panes.length ? panes[panes.length - 1] : null;
}

/** The active document's zoom, for anything that wants to display it. */
export function activeZoom(): number | null {
  const pane = activePane();
  return pane ? readZoom(pane.path) : null;
}

/**
 * Move the active document one rung: `1` in, `-1` out, `0` back to 100%.
 * Returns false when there is no editor on screen to zoom.
 */
export function stepEditorZoom(delta: -1 | 0 | 1): boolean {
  const pane = activePane();
  if (!pane) return false;

  const current = readZoom(pane.path);
  let next = ZOOM_DEFAULT;
  if (delta !== 0) {
    const i = ZOOM_STEPS.indexOf(current);
    const at = i < 0 ? ZOOM_STEPS.indexOf(ZOOM_DEFAULT) : i;
    next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, at + delta))];
  }
  if (next === current) return true; // already at the end of the ladder

  writeZoom(pane.path, next);
  // Both halves of a split showing this document, not just the focused one.
  for (const p of panes) if (p.path === pane.path) apply(p);
  return true;
}

// Settings → Reading moved. Every zoomed pane's numbers are a product of the
// new base and have to be recomputed; an unzoomed one has no overrides and
// simply inherits the root the slider just rewrote.
onProseBaseChange(() => {
  for (const pane of panes) apply(pane);
});
