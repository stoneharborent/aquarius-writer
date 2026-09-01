import React from "react";
import ReactDOM from "react-dom/client";
import "@/fonts/fonts.css";
import "@/theme/tokens.css";
import "./app.css";
import App from "./App";
import { bootTheme } from "@/state/themeStore";
import { installLogBridge } from "@/lib/logging";

// Send what the renderer knows to the terminal that launched the app. First,
// so an error thrown during the very first render still reaches a log.
installLogBridge();

// Put the theme on <html> before the first render, so the app never flashes
// Ice on a machine whose default is AquariusOS.
bootTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

/**
 * The frame meter — `AQ_PERF=1`, or `?perf=1` in the browser preview.
 *
 * NOT behind `import.meta.env.DEV`, unlike the smoke passes below: the whole
 * point is to measure the SHIPPED AppImage on the Linux machine that feels
 * slow (docs/NOTES.md §27k). Bench command:
 *
 *     AQ_PERF=1 ./AquariusWriter*.AppImage
 *
 * Zero cost when it is off. The query check is one `URLSearchParams` read, the
 * `dev_context` invoke is the one `installLogBridge` already makes, and the
 * meter itself is a dynamic `import()` — its own chunk, never fetched unless
 * the flag is set.
 */
void (async () => {
  if (typeof window === "undefined") return;
  let on = false;
  try {
    on = new URLSearchParams(window.location.search).get("perf") === "1";
  } catch { /* no location — nothing to read */ }
  if (!on && window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const ctx = await invoke<{ perf?: boolean }>("dev_context");
      on = ctx.perf === true;
    } catch { /* older shell without the field — leave it off */ }
  }
  if (!on) return;
  const { startPerfMeter } = await import("@/lib/dev/perf-meter");
  startPerfMeter();
})();

// Development-only backend check. Runs when the shell was started with
// AQ_DEV_VAULT + AQ_DEV_SMOKE=1 (see src/lib/dev/smoke.ts); the dynamic import
// inside the DEV guard keeps it out of production bundles entirely.
if (import.meta.env.DEV && typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
  void (async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      const ctx = await invoke<{
        workflowId: string | null;
        smoke: boolean;
        smokeWelcome: boolean;
      }>("dev_context");
      if (ctx.smoke && ctx.workflowId) {
        const { runDevSmoke } = await import("@/lib/dev/smoke");
        await runDevSmoke(ctx.workflowId);
      }
      // The welcome-screen pass needs no vault: making one is the point.
      if (ctx.smokeWelcome) {
        const { runWelcomeSmoke } = await import("@/lib/dev/welcome-smoke");
        await runWelcomeSmoke();
      }
    } catch { /* not a dev shell — nothing to do */ }
  })();
}
