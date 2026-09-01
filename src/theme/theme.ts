import { detectPlatform } from "@/lib/platform";
import {
  BASE_LINE_PX as SP_BASE_LINE,
  screenplayMetrics,
} from "@/lib/markdown/screenplay-metrics";

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

/** The three whole-pixel numbers the prose content path actually reads. */
export interface ProseMetrics {
  /** `--prose-size` */
  sizePx: number;
  /** `--prose-line-px` */
  linePx: number;
  /** `--prose-para-gap` */
  gapPx: number;
}

/**
 * Body size × leading → whole pixels. **The only place that product is
 * rounded**, and therefore the only place it is allowed to be fractional.
 *
 * `sizePx` may arrive unrounded (a zoom step multiplies the slider's integer
 * by 1.25 and hands the result straight in). The line box is computed from the
 * *unrounded* size so the ratio is honoured before rounding, exactly as it was
 * when only the sliders called this: 17 × 1.65 = 28.05 → 28px.
 */
export function proseMetrics(sizePx: number, leading: number): ProseMetrics {
  return {
    sizePx: Math.max(1, Math.round(sizePx)),
    // Guard the floor: a 0px line box would make every line coincide.
    linePx: Math.max(1, Math.round(sizePx * leading)),
    // The paragraph gap tracked the body size as 0.55em; keep the relationship
    // and round it the same way.
    gapPx: Math.max(0, Math.round(sizePx * 0.55)),
  };
}

/**
 * The global reading preference, as the Settings sliders last left it.
 *
 * Per-document zoom (`applyEditorZoom`) is a *multiplier on this*, not a
 * replacement for it, so it has to be readable after the fact — and an open
 * editor at 125% has to recompute when the slider moves underneath it, which
 * is what the listener set is for.
 */
let proseBase = { size: 17, leading: 1.65 };
const proseBaseListeners = new Set<() => void>();

export function readProseBase(): { size: number; leading: number } {
  return proseBase;
}

/** Subscribe to Settings → Reading changes. Returns the unsubscribe. */
export function onProseBaseChange(fn: () => void): () => void {
  proseBaseListeners.add(fn);
  return () => { proseBaseListeners.delete(fn); };
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
  const m = proseMetrics(sizePx, leading);
  root.style.setProperty("--prose-size", `${m.sizePx}px`);
  root.style.setProperty("--prose-leading", String(leading));
  root.style.setProperty("--prose-line-px", `${m.linePx}px`);
  root.style.setProperty("--prose-para-gap", `${m.gapPx}px`);
  proseBase = { size: sizePx, leading };
  proseBaseListeners.forEach((fn) => fn());
}

/* ─── Per-document zoom (PARITY row 14) ───────────────────────────────────
 *
 * ⌘+ / ⌘− / ⌘0 scale ONE document's text. The mechanism is deliberately the
 * same one §1a laid down for the sliders: a zoom step is a multiplier, every
 * length it touches is a design-time whole pixel, and the product is rounded
 * ONCE — here — before it is written as a scoped CSS custom property on that
 * editor's host element. CSS cannot round, so CSS never sees a multiplication.
 *
 * A fractional computed line height is the v0.3.0 caret bug. There is exactly
 * one arithmetic path to the DOM below and it ends in `Math.round`.
 *
 * The variables are *scoped to the host element*, so they cascade into that
 * one editor and nothing else — the page canvas, the sheet's title and every
 * other pane keep the global values. That is also why the sheet width does not
 * move when the text does.
 */

export type EditorZoomKind = "prose" | "screenplay";

/** Prose lengths the sliders do NOT drive — headings and inline code. */
const PROSE_SCALED: ReadonlyArray<readonly [string, number]> = [
  ["--prose-h1-size", 31], ["--prose-h1-line", 37], ["--prose-h1-pt", 34], ["--prose-h1-pb", 15],
  ["--prose-h2-size", 25], ["--prose-h2-line", 30], ["--prose-h2-pt", 26], ["--prose-h2-pb", 12],
  ["--prose-h3-size", 20], ["--prose-h3-line", 24], ["--prose-h3-pt", 20], ["--prose-h3-pb", 10],
  ["--prose-h4-size", 18], ["--prose-h4-line", 21], ["--prose-h4-pt", 16], ["--prose-h4-pb", 9],
  ["--prose-code-size", 14],
];

/** The prose lengths that ARE slider-driven, listed so a reset can clear them. */
const PROSE_BASE_VARS = ["--prose-size", "--prose-line-px", "--prose-para-gap"] as const;

/**
 * The screenplay grid, since PARITY row 12 (NOTES §27).
 *
 * This one is NOT a list of constants to multiply. A screenplay page is a
 * geometry, and its parts have to stay consistent with each other or the paged
 * canvas comes apart: the sheets are painted as a repeating background, so
 * `page height == top margin + 54 × line + bottom margin` has to hold exactly
 * at every rung of the ladder, not approximately.
 *
 * So the zoom scales ONE number — the line box — and `screenplayMetrics`
 * derives the rest from it. Every vertical point value in the format is a
 * multiple of 12, so every derived vertical length is an exact integer
 * multiple of the (integer) line box. Nothing is rounded twice, and nothing
 * can round out of agreement with anything else.
 */
function screenplayVars(zoom: number): Array<readonly [string, string]> {
  const m = screenplayMetrics(Math.max(1, Math.round(SP_BASE_LINE * zoom)));
  return [
    ["--screenplay-size", `${m.line}px`],
    ["--screenplay-line-px", `${m.line}px`],
    ["--sp-line", `${m.line}px`],
    ["--sp-page-w", `${m.pageW}px`],
    ["--sp-page-h", `${m.pageH}px`],
    ["--sp-margin-t", `${m.marginT}px`],
    ["--sp-margin-b", `${m.marginB}px`],
    ["--sp-margin-l", `${m.marginL}px`],
    ["--sp-margin-r", `${m.marginR}px`],
    ["--sp-gap", `${m.gap}px`],
    ["--sp-pagenum-top", `${m.pagenumTop}px`],
    ["--fnt-character-indent", `${m.charIndent}px`],
    ["--fnt-character-pr", `${m.charPr}px`],
    ["--fnt-paren-indent", `${m.parenIndent}px`],
    ["--fnt-paren-pr", `${m.parenPr}px`],
    ["--fnt-dialogue-indent", `${m.dialogueIndent}px`],
    ["--fnt-dialogue-pr", `${m.dialoguePr}px`],
    ["--fnt-transition-pr", `${m.transitionPr}px`],
  ];
}

/**
 * Write (or clear) one editor's zoom on its host element.
 *
 * At zoom 1 every override is *removed* rather than re-stated, so an unzoomed
 * document is byte-for-byte the cascade it was before this feature existed —
 * the CSS rules all carry the pre-zoom literal as their `var()` fallback.
 */
export function applyEditorZoom(el: HTMLElement, kind: EditorZoomKind, zoom: number) {
  const s = el.style;

  if (kind === "screenplay") {
    const vars = screenplayVars(zoom);
    if (zoom === 1) {
      // The 100% values are the global tokens in tokens.css; removing the
      // overrides restores them, so an unzoomed page is the cascade the app
      // ships with rather than a restatement of it.
      for (const [name] of vars) s.removeProperty(name);
      return;
    }
    for (const [name, value] of vars) s.setProperty(name, value);
    return;
  }

  const scaled = PROSE_SCALED;

  if (zoom === 1) {
    for (const [name] of scaled) s.removeProperty(name);
    for (const name of PROSE_BASE_VARS) s.removeProperty(name);
    return;
  }

  {
    // Composes with the sliders: the zoom multiplies the *body size*, and the
    // leading ratio is then applied to that product and rounded once.
    const m = proseMetrics(proseBase.size * zoom, proseBase.leading);
    s.setProperty("--prose-size", `${m.sizePx}px`);
    s.setProperty("--prose-line-px", `${m.linePx}px`);
    s.setProperty("--prose-para-gap", `${m.gapPx}px`);
  }
  for (const [name, px] of scaled) {
    s.setProperty(name, `${Math.max(0, Math.round(px * zoom))}px`);
  }
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
