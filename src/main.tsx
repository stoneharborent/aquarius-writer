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
// Parchment on a machine whose default is AquariusOS.
bootTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

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
