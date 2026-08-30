import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import pkg from "./package.json";

// Tauri expects a fixed port; fail if it can't be claimed.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  // The version, from the one file that already declares it. The About panel
  // and the status bar used to hardcode "v0.1.2" and were duly forgotten at
  // the next release; CI checks package.json, tauri.conf.json and Cargo.toml
  // against the tag, so reading it from here means the UI cannot drift either.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    include: ["react", "react-dom", "react-dom/client", "zustand", "use-sync-external-store/shim/with-selector.js"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
