// The xterm.js instances, kept outside React.
//
// A terminal is not a view — it is a running process with scrollback, and the
// pane it lives in is collapsible. If the `Terminal` were owned by a component,
// hiding the right pane (⌘⌥\, or just clicking Comments) would dispose it and
// the writer's `claude` session would be gone with it. So the instances live in
// this module-level table and the component only *borrows* them: on mount it
// appends the entry's element to its host, on unmount it takes it back out.
// Nothing about the process changes either way.
//
// One consequence worth naming: output keeps arriving while the pane is
// hidden, into a terminal whose element is not in the document. xterm buffers
// it exactly as it buffers scrollback, so opening the pane again shows what
// happened — the same as switching desktops away from a terminal window.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  onPty,
  ptyAvailable,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from "@/lib/pty";
import { useTerminal } from "@/state/terminalStore";

export interface TerminalEntry {
  term: Terminal;
  fit: FitAddon;
  /** The element xterm draws into. Moved between hosts, never recreated. */
  el: HTMLDivElement;
  /** Detaches this session's pty event handlers. */
  detach: (() => void) | null;
  /** True once a PTY has been asked for, so a re-mount does not spawn a second. */
  launched: boolean;
}

const entries = new Map<string, TerminalEntry>();

/**
 * Where a terminal's element lives while no pane is showing it.
 *
 * It has to be *somewhere in the document*: xterm measures a character cell by
 * rendering into the DOM, and `open()` on a floating element it never sees
 * laid out produces a renderer with a zero-sized cell. So detached terminals
 * are parked off-screen at a plausible size instead of being orphaned. Nothing
 * fits to this box — `safeFit` is only ever called by the mounted view.
 */
let lot: HTMLDivElement | null = null;
function parkingLot(): HTMLDivElement {
  if (lot?.isConnected) return lot;
  lot = document.createElement("div");
  lot.setAttribute("aria-hidden", "true");
  lot.style.cssText =
    "position:fixed;left:-100000px;top:0;width:800px;height:600px;overflow:hidden;pointer-events:none";
  document.body.appendChild(lot);
  return lot;
}

/** Take the element out of whatever host it is in, without losing it. */
export function park(id: string) {
  const entry = entries.get(id);
  if (entry) parkingLot().appendChild(entry.el);
}

/** Read the live palette off `:root` so the terminal follows the app's theme. */
function paletteFromTokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const rgb = v("--accent-rgb", "44, 143, 196");
  return {
    background: v("--surface", "#F7FBFE"),
    foreground: v("--ink", "#16273A"),
    cursor: v("--accent", "#2C8FC4"),
    cursorAccent: v("--surface", "#F7FBFE"),
    selectionBackground: `rgba(${rgb}, 0.28)`,
  };
}

function fontStack(): string {
  const css = getComputedStyle(document.documentElement);
  return (
    css.getPropertyValue("--font-mono").trim() ||
    'ui-monospace, "SF Mono", Menlo, monospace'
  );
}

/** The instance for this session, created on first ask. */
export function ensureTerminal(id: string, fontSize: number): TerminalEntry {
  const existing = entries.get(id);
  if (existing) return existing;

  const el = document.createElement("div");
  el.className = "tm-xterm";
  parkingLot().appendChild(el);

  const term = new Terminal({
    fontFamily: fontStack(),
    fontSize,
    // Whole-pixel geometry, NOTES §1a: a fractional line height puts the cell
    // grid on half pixels and every glyph goes soft.
    lineHeight: 1,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
    theme: paletteFromTokens(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  const entry: TerminalEntry = { term, fit, el, detach: null, launched: false };
  entries.set(id, entry);

  // Keystrokes out. This is the only path from the keyboard to the shell, and
  // it is deliberately unfiltered — a terminal that rewrote what you typed
  // would be worse than no terminal.
  term.onData((data) => {
    if (!entry.launched) return;
    void ptyWrite(id, data).catch(() => {
      /* the shell died between keystroke and write; the exit event says so */
    });
  });

  term.onResize(({ cols, rows }) => {
    if (!entry.launched) return;
    void ptyResize(id, cols, rows).catch(() => {});
  });

  return entry;
}

export function getTerminal(id: string): TerminalEntry | undefined {
  return entries.get(id);
}

/** Re-read the CSS tokens — called when the theme or accent changes. */
export function repaint(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  entry.term.options.theme = paletteFromTokens();
  entry.term.options.fontFamily = fontStack();
}

export function setFontSize(id: string, size: number) {
  const entry = entries.get(id);
  if (!entry || entry.term.options.fontSize === size) return;
  entry.term.options.fontSize = size;
  safeFit(id);
}

/**
 * Fit the grid to the element — but only when the element is actually laid
 * out. `fit()` on a hidden div measures zero and would drive the PTY to a 1×1
 * grid, which the shell then redraws into for real.
 */
export function safeFit(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  const { width, height } = entry.el.getBoundingClientRect();
  if (width < 8 || height < 8) return;
  try {
    entry.fit.fit();
  } catch {
    /* xterm throws if the renderer is mid-teardown; the next resize retries */
  }
}

/**
 * Spawn the PTY behind this session.
 *
 * Idempotent: a session that has already launched is left alone, which is what
 * makes the mount effect safe under React's double-invoked effects in dev.
 */
export async function launch(id: string, workflowId: string | null, startup: string) {
  const entry = ensureTerminal(id, useTerminal.getState().sessions.find((s) => s.id === id)?.fontSize ?? 12);
  if (entry.launched) return;

  if (!ptyAvailable()) {
    useTerminal
      .getState()
      .markFailed(id, "The terminal needs the desktop app — there is no shell in a browser preview.");
    entry.term.writeln("\x1b[2mNo PTY here. Run the desktop app (npm run tauri:dev).\x1b[0m");
    return;
  }

  entry.launched = true;
  safeFit(id);
  const { cols, rows } = entry.term;

  entry.detach?.();
  entry.detach = onPty(
    id,
    (data) => entry.term.write(data),
    (code) => {
      entry.launched = false;
      useTerminal.getState().markExited(id, code);
      const label = code === null || code === 0 ? "exited" : `exited (${code})`;
      entry.term.writeln(`\r\n\x1b[2m[${label}]\x1b[0m`);
    },
  );

  try {
    const info = await ptySpawn({ id, workflowId, startup, cols, rows });
    useTerminal.getState().markLive(id, workflowId, info.cwd);
  } catch (e) {
    entry.launched = false;
    entry.detach?.();
    entry.detach = null;
    const message = e instanceof Error ? e.message : String(e);
    useTerminal.getState().markFailed(id, message);
    entry.term.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
  }
}

/** Kill the shell and throw away the screen. Only a closed tab does this. */
export function dispose(id: string) {
  const entry = entries.get(id);
  entries.delete(id);
  if (!entry) return;
  entry.detach?.();
  entry.term.dispose();
  entry.el.remove();
  if (ptyAvailable()) void ptyKill(id).catch(() => {});
}

/**
 * Kill this session's shell but keep the screen, then let the next launch
 * start a fresh one. Used by "Restart here" after a workflow switch — the
 * writer can still read what the old shell said.
 */
export async function restart(id: string, workflowId: string | null, startup: string) {
  const entry = entries.get(id);
  if (entry) {
    entry.detach?.();
    entry.detach = null;
    entry.launched = false;
    if (ptyAvailable()) await ptyKill(id).catch(() => {});
    entry.term.writeln("\r\n\x1b[2m[restarting…]\x1b[0m\r\n");
  }
  useTerminal.getState().relaunch(id);
  await launch(id, workflowId, startup);
}

/** Type a path into the shell — what a file dropped on the pane does. */
export function typePath(id: string, absolute: string) {
  const entry = entries.get(id);
  if (!entry?.launched) return;
  // Shell-quote only when it is needed, so the common case stays readable.
  const needsQuote = /[^\w@%+=:,./-]/.test(absolute);
  const text = needsQuote ? `'${absolute.replace(/'/g, `'\\''`)}' ` : `${absolute} `;
  void ptyWrite(id, text).catch(() => {});
  entry.term.focus();
}
