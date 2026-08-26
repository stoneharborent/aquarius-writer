/**
 * Which desktop this build is running on.
 *
 * Two things read this: the default theme (Linux boots in the AquariusOS skin —
 * see `state/themeStore.ts`) and the window chrome (Linux draws its own
 * minimise / maximise / close buttons, because `decorations: false` means the
 * window manager draws none — see `components/window/WindowControls.tsx`).
 *
 * Detection is the **user-agent string**, deliberately, not a Rust `invoke()`:
 *
 *   - the theme has to be on `<html>` before the first paint, and `invoke()` is
 *     a promise;
 *   - the same check has to work in `npm run dev`, the browser preview, where
 *     there is no Tauri at all;
 *   - on Linux the WebKitGTK user agent always says `X11` or `Linux`, so there
 *     is nothing to be clever about.
 *
 * `?platform=linux` in the URL forces the answer. That is a dev and screenshot
 * override — it is how the Linux window controls get reviewed from a Mac — and
 * it is never written anywhere. It is the same idea as `?theme=`.
 */

export type Platform = "linux" | "macos" | "windows" | "other";

const PLATFORMS: Platform[] = ["linux", "macos", "windows", "other"];

function isPlatform(v: unknown): v is Platform {
  return typeof v === "string" && (PLATFORMS as string[]).includes(v);
}

/** `?platform=linux` — dev/screenshot override, this tab only. */
export function platformFromQuery(): Platform | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const q = new URLSearchParams(window.location.search).get("platform");
    return isPlatform(q) ? q : undefined;
  } catch {
    return undefined;
  }
}

function fromUserAgent(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = `${navigator.userAgent} ${navigator.platform ?? ""}`;
  // Android reports "Linux" too, and it is not a desktop — check it first.
  if (/android/i.test(ua)) return "other";
  if (/linux|x11|cros/i.test(ua)) return "linux";
  if (/mac/i.test(ua)) return "macos";
  if (/win/i.test(ua)) return "windows";
  return "other";
}

let cached: Platform | null = null;

/**
 * The platform, resolved once. Cached because the theme store asks for it at
 * module load and the window chrome asks for it on every render — and because
 * the answer cannot change without a reload.
 */
export function detectPlatform(): Platform {
  if (cached === null) cached = platformFromQuery() ?? fromUserAgent();
  return cached;
}

/**
 * True inside the real desktop shell, false in the browser preview.
 *
 * Note this is a *different* question from `detectPlatform()`: with
 * `?platform=linux` the preview draws the Linux chrome while this stays false,
 * which is exactly what makes the screenshot review possible.
 */
export function isTauriShell(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}
