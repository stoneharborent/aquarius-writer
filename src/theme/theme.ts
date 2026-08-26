export type ThemeName = "parchment" | "midnight";
export type AccentName = "blue" | "purple" | "sepia" | "sage";

export const THEMES: ThemeName[] = ["parchment", "midnight"];
export const ACCENTS: AccentName[] = ["blue", "purple", "sepia", "sage"];

export const ACCENT_LABEL: Record<AccentName, string> = {
  blue: "Blue",
  purple: "Muted purple",
  sepia: "Sepia",
  sage: "Sage",
};

export function applyTheme(theme: ThemeName, accent: AccentName) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.accent = accent;
}

export function readTheme(): { theme: ThemeName; accent: AccentName } {
  const root = document.documentElement;
  const theme = (root.dataset.theme as ThemeName) || "parchment";
  const accent = (root.dataset.accent as AccentName) || "blue";
  return { theme, accent };
}
