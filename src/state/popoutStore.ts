import { create } from "zustand";
import { detectPlatform, isTauriShell } from "@/lib/platform";
import { useNotices } from "@/state/noticeStore";

/**
 * Popped-out documents (⌃⌘O). A document detaches into its own window and a
 * ghost placeholder holds its slot in the host — Swift's design, SWIFT-AUDIT
 * §2.6.
 *
 * **In the real shell this was permission-blocked until 2026-08-31.**
 * `new WebviewWindow(...)` is `plugin:webview|create_webview_window`, which
 * Tauri 2 refuses unless a capability names it; nothing did, so ⌃⌘O flipped
 * the ghost on and then quietly failed (NOTES §15d). Two things fixed it, and
 * both matter:
 *
 * 1. `capabilities/default.json` grants `core:webview:allow-create-webview-window`.
 * 2. That file's `windows` list covers `aquarius-*` as well as `main`. A
 *    capability applies to the windows it names, so without the glob the
 *    popout would open and then be a window with no permissions at all — no
 *    event listener, no `data-tauri-drag-region`, no reattach button that
 *    works. The labels below are what the glob has to match; change one and
 *    change the other.
 *
 * The ghost also no longer lies. `popped` flips only once the window is
 * actually up, so a refusal leaves the host exactly as it was and says so.
 */

interface PopoutState {
  /** Paths currently popped out into detached windows. */
  popped: Set<string>;
  /** Browser preview: path -> the `window.open` handle. */
  windows: Map<string, Window>;
  /** Real shell: path -> the WebviewWindow, so reattach can close it. */
  native: Map<string, { close: () => Promise<void> }>;

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

/**
 * The window label, and the shape `capabilities/default.json` globs on.
 *
 * Labels may only contain alphanumerics, `-`, `/`, `:` and `_`, so the path is
 * flattened. Two documents whose names differ only in punctuation would
 * collide after 64 characters, which Tauri answers with "a window with this
 * label already exists" — caught below and shown, rather than swallowed.
 */
export function popoutLabel(path: string): string {
  return `aquarius-${path.replace(/[^A-Za-z0-9]/g, "-")}`.slice(0, 64);
}

export const usePopout = create<PopoutState>((set, get) => ({
  popped: new Set<string>(),
  windows: new Map<string, Window>(),
  native: new Map<string, { close: () => Promise<void> }>(),

  popOut(path) {
    if (get().popped.has(path)) return;

    const mark = () => {
      const next = new Set(get().popped);
      next.add(path);
      set({ popped: next });
    };

    if (isTauriShell()) {
      // Only marked once the window exists — see the note above.
      void openTauriWindow(path)
        .then((w) => {
          get().native.set(path, w);
          mark();
        })
        .catch((e) => {
          useNotices.getState().fail("Could not pop this document out", e);
        });
      return;
    }

    const url = `${location.origin}/?popout=${encodeURIComponent(path)}`;
    const w = window.open(url, popoutLabel(path), "width=720,height=820,menubar=no,toolbar=no");
    if (!w) {
      useNotices.getState().fail("The browser blocked the popout window");
      return;
    }
    get().windows.set(path, w);
    w.addEventListener("beforeunload", () => {
      // Auto-reattach when the user closes the popout window manually.
      get().reattach(path);
    });
    mark();
  },

  reattach(path) {
    const w = get().windows.get(path);
    try { w?.close(); } catch { /* no-op */ }
    get().windows.delete(path);

    const native = get().native.get(path);
    // `close()` is `core:window:allow-close`, which the title bar's own close
    // button already needs — nothing new was granted for this.
    void native?.close().catch(() => { /* already gone */ });
    get().native.delete(path);

    const next = new Set(get().popped);
    next.delete(path);
    set({ popped: next });
  },

  isPopped(path) {
    return get().popped.has(path);
  },
}));

/**
 * Open the detached window, and resolve only when Tauri says it is up.
 *
 * The chrome matches the platform's main window rather than being hardcoded:
 * macOS gets native decorations and an opaque window (NOTES §6, §15c), Linux
 * draws its own. `dragDropEnabled: false` is mandatory on both — with Tauri's
 * native file-drop handler on, WKWebView eats `dragover`/`drop` before the
 * page sees them and every HTML5 drag inside the popout goes dead (NOTES §18a).
 */
async function openTauriWindow(path: string): Promise<{ close: () => Promise<void> }> {
  // Dynamic import keeps the browser bundle from pulling in Tauri APIs.
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const mac = detectPlatform() === "macos";
  const w = new WebviewWindow(popoutLabel(path), {
    url: `/?popout=${encodeURIComponent(path)}`,
    title: path,
    width: 800,
    height: 640,
    decorations: mac,
    transparent: !mac,
    dragDropEnabled: false,
  });

  // `tauri://created` or `tauri://error`, whichever arrives. A refusal — a
  // missing permission, a label already taken — comes back on the second one,
  // and it is the case this whole function exists to stop swallowing.
  return new Promise((resolve, reject) => {
    let settled = false;
    const offs: Array<() => void> = [];
    const settle = (act: () => void) => {
      if (settled) return;
      settled = true;
      for (const off of offs) off();
      act();
    };
    void w.once("tauri://created", () => settle(() => resolve(w))).then((off) => offs.push(off));
    void w
      .once("tauri://error", (e) =>
        settle(() => reject(new Error(String(e.payload ?? "the window was refused")))))
      .then((off) => offs.push(off));
  });
}
