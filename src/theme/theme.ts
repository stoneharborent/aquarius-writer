import { detectPlatform } from "@/lib/platform";

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
 * The platform check itself lives in `lib/platform.ts` — Stage 4's window
 * chrome asks the same question, so it is one function, not two.
 */
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
