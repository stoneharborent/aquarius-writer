// The renderer's half of the terminal pipe.
//
// Thin on purpose: five `invoke()`s and exactly one pair of event listeners
// for the whole app. `src-tauri/src/pty/mod.rs` is where the design and the
// security posture are written down — read that first.
//
// Everything here is a no-op outside Tauri. `npm run dev` in a browser has no
// PTY to talk to, and the pane says so rather than throwing.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const OUTPUT_EVENT = "pty://output";
export const EXIT_EVENT = "pty://exit";

export interface PtyInfo {
  /** Where the shell actually started. */
  cwd: string;
  /** Which program was spawned. */
  shell: string;
}

export interface SpawnOptions {
  id: string;
  workflowId: string | null;
  /** Typed into the shell once it is up. Empty = plain shell. */
  startup: string;
  cols: number;
  rows: number;
}

/** True when there is a Rust side to talk to at all. */
export function ptyAvailable(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

export function ptySpawn(o: SpawnOptions): Promise<PtyInfo> {
  return invoke<PtyInfo>("pty_spawn", {
    id: o.id,
    workflowId: o.workflowId,
    startup: o.startup.trim() ? o.startup : null,
    cols: Math.max(1, Math.round(o.cols)),
    rows: Math.max(1, Math.round(o.rows)),
  });
}

export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", {
    id,
    cols: Math.max(1, Math.round(cols)),
    rows: Math.max(1, Math.round(rows)),
  });
}

export function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

/** Vault-relative → absolute, for a file dragged out of the sidebar. */
export function ptyResolvePath(workflowId: string, relPath: string): Promise<string> {
  return invoke<string>("pty_resolve_path", { workflowId, relPath });
}

// ── the one subscription ─────────────────────────────────────────────────
//
// Sessions come and go and their views mount and unmount, so per-session
// `listen()` calls would leak: an unlisten that never runs because the pane
// was collapsed mid-stream leaves a handler writing into a disposed terminal.
// Instead there are two listeners for the life of the app and a table of
// handlers keyed by session id, which a view can add to and remove from
// synchronously.

type OutputHandler = (data: string) => void;
type ExitHandler = (code: number | null) => void;

const outputs = new Map<string, OutputHandler>();
const exits = new Map<string, ExitHandler>();

let wired: Promise<UnlistenFn[]> | null = null;

function ensureWired() {
  if (wired || !ptyAvailable()) return;
  wired = Promise.all([
    listen<{ id: string; data: string }>(OUTPUT_EVENT, (e) => {
      outputs.get(e.payload.id)?.(e.payload.data);
    }),
    listen<{ id: string; code: number | null }>(EXIT_EVENT, (e) => {
      exits.get(e.payload.id)?.(e.payload.code ?? null);
    }),
  ]);
}

/** Route this session's output and exit somewhere. Returns the detach. */
export function onPty(id: string, onOutput: OutputHandler, onExit: ExitHandler): () => void {
  ensureWired();
  outputs.set(id, onOutput);
  exits.set(id, onExit);
  return () => {
    outputs.delete(id);
    exits.delete(id);
  };
}
