import { create } from "zustand";

interface PopoutState {
  /** Paths currently popped out into detached windows. */
  popped: Set<string>;
  /** Channel name -> window reference (browser only). */
  windows: Map<string, Window>;

  popOut: (path: string) => void;
  reattach: (path: string) => void;
  isPopped: (path: string) => boolean;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __aquariusPopout?: string | null;
  }
}

function inTauri(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

export const usePopout = create<PopoutState>((set, get) => ({
  popped: new Set<string>(),
  windows: new Map<string, Window>(),

  popOut(path) {
    if (get().popped.has(path)) return;
    if (inTauri()) {
      // Tauri shell — use WebviewWindow. Stubbed; the real wiring lands once
      // tauri:dev is running. We still flip the ghost state for the host UI.
      void openTauriWindow(path).catch((e) => console.warn("popout:", e));
    } else {
      const url = `${location.origin}/?popout=${encodeURIComponent(path)}`;
      const w = window.open(url, `aquarius-${path}`, "width=720,height=820,menubar=no,toolbar=no");
      if (w) {
        get().windows.set(path, w);
        w.addEventListener("beforeunload", () => {
          // Auto-reattach when the user closes the popout window manually.
          get().reattach(path);
        });
      }
    }
    const next = new Set(get().popped);
    next.add(path);
    set({ popped: next });
  },

  reattach(path) {
    const w = get().windows.get(path);
    try { w?.close(); } catch { /* no-op */ }
    get().windows.delete(path);
    const next = new Set(get().popped);
    next.delete(path);
    set({ popped: next });
  },

  isPopped(path) {
    return get().popped.has(path);
  },
}));

async function openTauriWindow(path: string) {
  // Dynamic import keeps the browser bundle from pulling in Tauri APIs.
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const label = `aquarius-${path.replace(/[^A-Za-z0-9]/g, "-")}`.slice(0, 64);
  new WebviewWindow(label, {
    url: `/?popout=${encodeURIComponent(path)}`,
    title: path,
    width: 720,
    height: 820,
    decorations: false,
    transparent: true,
  });
}
