export type ThemeName = "parchment" | "midnight" | "aquarius";
export type AccentName = "blue" | "purple" | "sepia" | "sage";

export const THEMES: ThemeName[] = ["parchment", "midnight", "aquarius"];
export const ACCENTS: AccentName[] = ["blue", "purple", "sepia", "sage"];

export const THEME_LABEL: Record<ThemeName, string> = {
  parchment: "Parchment",
  midnight: "Midnight",
  aquarius: "AquariusOS",
};

export const ACCENT_LABEL: Record<AccentName, string> = {
  blue: "Blue",
  purple: "Muted purple",
  sepia: "Sepia",
  sage: "Sage",
};

/** AquariusOS locks the accent to starlight — see tokens.css. */
export function themeLocksAccent(theme: ThemeName): boolean {
  return theme === "aquarius";
}

export function isThemeName(v: unknown): v is ThemeName {
  return typeof v === "string" && (THEMES as string[]).includes(v);
}

export function isAccentName(v: unknown): v is AccentName {
  return typeof v === "string" && (ACCENTS as string[]).includes(v);
}

/**
 * Which theme this machine gets when the writer has never chosen one.
 *
 * Linux means "running on AquariusOS" for our purposes — the app is the OS's
 * stock writing app and should look like the OS on first boot. Everywhere else
 * keeps Parchment, exactly as the design handoff intends.
 *
 * Detection is deliberately the user-agent string rather than a Rust call:
 * the theme has to be on the <html> element before the first paint, an
 * `invoke()` is a promise, and this same check works in the browser preview
 * (`npm run dev`) where there is no Tauri at all.
 */
export function detectPlatform(): "linux" | "macos" | "windows" | "other" {
  if (typeof navigator === "undefined") return "other";
  const ua = `${navigator.userAgent} ${navigator.platform ?? ""}`;
  if (/android/i.test(ua)) return "other";
  if (/linux|x11|cros/i.test(ua)) return "linux";
  if (/mac/i.test(ua)) return "macos";
  if (/win/i.test(ua)) return "windows";
  return "other";
}

export function defaultTheme(): ThemeName {
  return detectPlatform() === "linux" ? "aquarius" : "parchment";
}

export const DEFAULT_ACCENT: AccentName = "blue";

/**
 * `?theme=aquarius&accent=sage` — a dev/screenshot override. It wins over the
 * saved preference for the life of the tab and is never written back to disk,
 * so opening a link like that can't change what the writer sees next launch.
 */
export function themeFromQuery(): { theme?: ThemeName; accent?: AccentName } {
  if (typeof window === "undefined") return {};
  try {
    const q = new URLSearchParams(window.location.search);
    const theme = q.get("theme");
    const accent = q.get("accent");
    return {
      theme: isThemeName(theme) ? theme : undefined,
      accent: isAccentName(accent) ? accent : undefined,
    };
  } catch {
    return {};
  }
}

export function applyTheme(theme: ThemeName, accent: AccentName) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.accent = accent;
}

export function readTheme(): { theme: ThemeName; accent: AccentName } {
  const root = document.documentElement;
  const theme = root.dataset.theme;
  const accent = root.dataset.accent;
  return {
    theme: isThemeName(theme) ? theme : defaultTheme(),
    accent: isAccentName(accent) ? accent : DEFAULT_ACCENT,
  };
}
