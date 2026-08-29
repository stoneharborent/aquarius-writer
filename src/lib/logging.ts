/**
 * Getting what the renderer knows into a log a human can read.
 *
 * The WebView's console is invisible from a shell. That is fine on a Mac, where
 * devtools are one shortcut away, and it was not fine on the first Linux boot:
 * three buttons on the welcome screen did nothing, and the OS launcher's stderr
 * showed a completely clean start. A failure the log cannot see is a failure
 * nobody can fix from a bug report.
 *
 * So, inside the desktop shell:
 *
 *   - uncaught errors and unhandled promise rejections are **always** forwarded
 *     to the Rust side, which prints them to stderr as `[webview:error] …`;
 *   - with `AQ_WRITER_DEBUG=1` in the environment, `console.error` and
 *     `console.warn` are mirrored there too.
 *
 * In the browser preview none of this runs — there is no Tauri to invoke and
 * the console is right there.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauriShell } from "@/lib/platform";

type Level = "error" | "warn" | "info";

let send: ((level: Level, message: string) => void) | null = null;

/** Format anything a console call or an error handler can hand us. */
function render(parts: unknown[]): string {
  return parts
    .map((p) => {
      if (p instanceof Error) return `${p.name}: ${p.message}${p.stack ? `\n${p.stack}` : ""}`;
      if (typeof p === "string") return p;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(" ");
}

/**
 * Forward one line to the terminal that launched the app.
 *
 * Safe to call from anywhere at any time: before the bridge is installed, or
 * in the browser preview, it is a no-op.
 */
export function logToShell(level: Level, ...parts: unknown[]): void {
  send?.(level, render(parts));
}

/** Install the bridge. Call once, as early as possible. */
export function installLogBridge(): void {
  if (!isTauriShell()) return;

  send = (level, message) => {
    // A failing logger must never become the thing that breaks the app.
    void invoke("app_log", { level, message }).catch(() => {});
  };

  window.addEventListener("error", (e) => {
    logToShell("error", "uncaught:", e.error ?? e.message, `(${e.filename}:${e.lineno})`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    logToShell("error", "unhandled rejection:", e.reason);
  });

  void (async () => {
    let debug = false;
    try {
      const ctx = await invoke<{ debug?: boolean }>("dev_context");
      debug = ctx.debug === true;
    } catch {
      /* older shell, or the command is gone — errors still forward */
    }
    if (!debug) return;

    for (const level of ["error", "warn"] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        original(...args);
        logToShell(level, ...args);
      };
    }
    logToShell("info", "AQ_WRITER_DEBUG=1 — mirroring console.error and console.warn to stderr");
  })();
}
