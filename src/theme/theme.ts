import { detectPlatform } from "@/lib/platform";

export type ThemeName = "ice" | "midnight" | "aquarius";
export type AccentName = "blue" | "indigo" | "turquoise" | "aquamarine";

export const THEMES: ThemeName[] = ["ice", "midnight", "aquarius"];
export const ACCENTS: AccentName[] = ["blue", "indigo", "turquoise", "aquamarine"];

export const THEME_LABEL: Record<ThemeName, string> = {
  ice: "Ice",
  midnight: "Midnight",
  aquarius: "AquariusOS",
};

export const ACCENT_LABEL: Record<AccentName, string> = {
  blue: "Aquarius Blue",
  indigo: "Indigo",
  turquoise: "Turquoise",
  aquamarine: "Aquamarine",
};

/* ─── Migration ───────────────────────────────────────────────────────────
 *
 * The palette was replaced on 2026-08-30 to match the Swift app (SWIFT-AUDIT
 * §1.1): Parchment became Ice, and the accents became the four Aqua colours.
 * Preferences written before that day are still on disk — in localStorage, in
 * every `workflow.json` ever saved, and in the Rust struct's default, which
 * still writes `"parchment"`. The Swift app has the same history and simply
 * kept `"parchment"` as Ice's stored value forever (SWIFT-AUDIT §4).
 *
 * So: read the old names, write only the new ones. Every read site goes
 * through `normalizeTheme` / `normalizeAccent` below — that is the only place
 * the retired names are allowed to appear.
 */

const THEME_ALIAS: Record<string, ThemeName> = {
  parchment: "ice",
};

const ACCENT_ALIAS: Record<string, AccentName> = {
  purple: "indigo",
  sepia: "turquoise",
  sage: "aquamarine",
};

/** A stored/URL theme value → a current theme id, or undefined if unusable. */
export function normalizeTheme(v: unknown): ThemeName | undefined {
  if (typeof v !== "string") return undefined;
  const k = v.toLowerCase();
  if ((THEMES as string[]).includes(k)) return k as ThemeName;
  return THEME_ALIAS[k];
}

/** A stored/URL accent value → a current accent id, or undefined if unusable. */
export function normalizeAccent(v: unknown): AccentName | undefined {
  if (typeof v !== "string") return undefined;
  const k = v.toLowerCase();
  if ((ACCENTS as string[]).includes(k)) return k as AccentName;
  return ACCENT_ALIAS[k];
}

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
 * gets Ice, the Swift app's light theme.
 *
 * The platform check itself lives in `lib/platform.ts` — Stage 4's window
 * chrome asks the same question, so it is one function, not two.
 */
export function defaultTheme(): ThemeName {
  return detectPlatform() === "linux" ? "aquarius" : "ice";
}

export const DEFAULT_ACCENT: AccentName = "blue";

/**
 * `?theme=aquarius&accent=turquoise` — a dev/screenshot override. It wins over
 * the saved preference for the life of the tab and is never written back to
 * disk, so opening a link like that can't change what the writer sees next
 * launch. Retired names still work here too (`?theme=parchment` → Ice), so old
 * screenshot scripts and bookmarks keep resolving to something real.
 */
export function themeFromQuery(): { theme?: ThemeName; accent?: AccentName } {
  if (typeof window === "undefined") return {};
  try {
    const q = new URLSearchParams(window.location.search);
    return {
      theme: normalizeTheme(q.get("theme")),
      accent: normalizeAccent(q.get("accent")),
    };
  } catch {
    return {};
  }
}

/**
 * Reading preferences → editor content metrics, rounded to whole pixels.
 *
 * The Settings "Body size" and "Line height" sliders used to write
 * `--prose-size` and `--prose-leading` straight onto the root, and the editor
 * multiplied them at paint time. That is how the shipped default became a
 * 28.05px line box, which desynchronised CodeMirror's height map from the
 * painted document on WebKitGTK and put the caret on the wrong line
 * (docs/NOTES.md §1a).
 *
 * The rounding therefore has to happen HERE, once, at the only place the two
 * numbers meet — not in CSS, which cannot round. `--prose-line-px` and
 * `--prose-para-gap` are what the editor actually reads; `--prose-leading` is
 * still written for chrome that wants the ratio.
 *
 * @param sizePx  body size in whole pixels (the slider is integer-stepped)
 * @param leading unrounded ratio, e.g. 1.65
 */
export function applyProseMetrics(sizePx: number, leading: number) {
  const root = document.documentElement;
  // Guard the floor: a 0px line box would make every line coincide.
  const linePx = Math.max(1, Math.round(sizePx * leading));
  // The paragraph gap tracked the body size as 0.55em; keep the relationship
  // and round it the same way.
  const gapPx = Math.max(0, Math.round(sizePx * 0.55));
  root.style.setProperty("--prose-size", `${Math.round(sizePx)}px`);
  root.style.setProperty("--prose-leading", String(leading));
  root.style.setProperty("--prose-line-px", `${linePx}px`);
  root.style.setProperty("--prose-para-gap", `${gapPx}px`);
}

export function applyTheme(theme: ThemeName, accent: AccentName) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.accent = accent;
}

export function readTheme(): { theme: ThemeName; accent: AccentName } {
  const root = document.documentElement;
  return {
    theme: normalizeTheme(root.dataset.theme) ?? defaultTheme(),
    accent: normalizeAccent(root.dataset.accent) ?? DEFAULT_ACCENT,
  };
}
