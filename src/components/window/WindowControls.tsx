import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriShell } from "@/lib/platform";
import "./WindowControls.css";

/**
 * Minimise / maximise / close, drawn by us, for Linux only.
 *
 * Why this has to exist: `tauri.conf.json` sets `decorations: false`, so the
 * window manager draws no title bar and no buttons. On macOS that is fine —
 * `titleBarStyle: "Overlay"` keeps the system traffic lights floating over our
 * chrome. On Linux there is no equivalent: without this component the window
 * genuinely has no way to be closed except a keyboard shortcut.
 *
 * Deliberately *not* here:
 *
 *   - **Dragging.** The title bar carries `data-tauri-drag-region="deep"` and
 *     Tauri's own injected handler does the rest. It also treats `<button>` as
 *     a click, never a drag, so these three are excluded automatically.
 *   - **Double-click to maximise.** The same Tauri handler already toggles
 *     maximise on a double click anywhere in the drag region (on Linux it fires
 *     on mousedown; on macOS on mouseup). Adding our own listener would toggle
 *     it twice and land back where it started.
 *   - **Edge resizing.** tao hit-tests a 5px border on undecorated *resizable*
 *     windows and starts a GTK resize drag itself, cursor included. That is why
 *     `resizable: true` in the config is load-bearing on Linux, not decoration.
 *
 * The look is Breeze/GNOME-adjacent on purpose: quiet glyphs in `text-2`, a
 * plain hover fill, and only the close button turning `danger`. No coloured
 * circles (that is macOS) and no tall full-height wedges (that is Windows).
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  // Keep the maximise glyph honest: the window can also be maximised by
  // double-clicking the title bar, by a keyboard shortcut, or by the window
  // manager itself, none of which come through this component.
  useEffect(() => {
    if (!isTauriShell()) return;
    const win = getCurrentWindow();
    let alive = true;
    void win.isMaximized().then((m) => alive && setMaximized(m));
    const off = win.onResized(() => {
      void win.isMaximized().then((m) => alive && setMaximized(m));
    });
    return () => {
      alive = false;
      void off.then((unlisten) => unlisten());
    };
  }, []);

  const minimize = useCallback(() => {
    if (isTauriShell()) void getCurrentWindow().minimize();
  }, []);

  const toggleMaximize = useCallback(() => {
    if (isTauriShell()) void getCurrentWindow().toggleMaximize();
  }, []);

  const close = useCallback(() => {
    if (isTauriShell()) void getCurrentWindow().close();
  }, []);

  return (
    <div className="wc-controls" role="group" aria-label="Window">
      <button
        className="wc-btn"
        type="button"
        onClick={minimize}
        title="Minimise"
        aria-label="Minimise"
      >
        <MinimizeGlyph />
      </button>
      <button
        className="wc-btn"
        type="button"
        onClick={toggleMaximize}
        title={maximized ? "Restore" : "Maximise"}
        aria-label={maximized ? "Restore" : "Maximise"}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button
        className="wc-btn wc-close"
        type="button"
        onClick={close}
        title="Close"
        aria-label="Close"
      >
        <CloseGlyph />
      </button>
    </div>
  );
}

/* The glyphs are 10×10 inside a 16×16 box so the three read as one optical
   size. Stroke 1.3 matches the rest of the icon set (see `icons/Icon.tsx`);
   they are inline rather than in the shared glyph set because nothing else in
   the app draws window furniture. */

const glyph = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.3,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
};

const MinimizeGlyph = () => (
  <svg {...glyph}>
    <path d="M3.5 8h9" />
  </svg>
);

const MaximizeGlyph = () => (
  <svg {...glyph}>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1.2" />
  </svg>
);

const RestoreGlyph = () => (
  <svg {...glyph}>
    <rect x="3.5" y="5.5" width="7" height="7" rx="1.2" />
    <path d="M5.9 5.5V4.7a1.2 1.2 0 011.2-1.2h4.2a1.2 1.2 0 011.2 1.2v4.2a1.2 1.2 0 01-1.2 1.2h-.8" />
  </svg>
);

const CloseGlyph = () => (
  <svg {...glyph}>
    <path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" />
  </svg>
);
