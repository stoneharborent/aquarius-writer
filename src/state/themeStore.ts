import { create } from "zustand";
import {
  AccentName,
  DEFAULT_ACCENT,
  ThemeName,
  applyTheme,
  defaultTheme,
  normalizeAccent,
  normalizeTheme,
  themeFromQuery,
} from "@/theme/theme";

/**
 * Who decides the theme, in order of authority:
 *
 *   1. `?theme=` in the URL — dev/screenshot override, this tab only.
 *   2. What the writer picked in Settings — saved here, wins forever after.
 *   3. On Linux, the OS skin. This app is AquariusOS's stock writing app; it
 *      boots looking like the OS unless the writer has said otherwise.
 *   4. Ice.
 *
 * **The theme is global, not per-workflow** — PARITY row 21, decided
 * 2026-08-31. There used to be a rule between 3 and 4: adopt the theme saved
 * in `workflow.json`. It went, because the Swift app has never had it. Swift
 * keeps the theme in `UserDefaults` under `aquarius.theme`, one value for the
 * app, and a workflow's own look is not a thing it has a concept of
 * (SWIFT-AUDIT §4). The port was reading a field that nothing — on either side
 * — has ever written, so the behavior it implemented could not be observed and
 * the only thing it could ever do was surprise someone.
 *
 * `settings.theme` and `settings.accent` are still tolerated on disk: the Rust
 * struct keeps them, `workflow.json` round-trips them, and an older file (or a
 * future Swift build that decides to write them) loses nothing. This app just
 * does not read them into the theme. **localStorage is the truth.**
 *
 * Every value read back — localStorage, the URL override — goes through
 * `normalizeTheme` / `normalizeAccent`, which map the retired names
 * (parchment / purple / sepia / sage) onto the current ones. Only the new
 * names are ever written.
 */

const KEY = "aquarius.theme";

interface Choice {
  theme: ThemeName;
  accent: AccentName;
}

interface Stored extends Choice {
  /** true once the writer has picked a theme themselves */
  explicit: boolean;
}

interface ThemeState extends Stored {
  setTheme: (t: ThemeName) => void;
  setAccent: (a: AccentName) => void;
}

function load(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Stored>;
      const theme = normalizeTheme(p.theme);
      const accent = normalizeAccent(p.accent);
      if (theme && accent) {
        return { theme, accent, explicit: p.explicit !== false };
      }
    }
  } catch {
    /* swallow — a broken preference must never stop the app booting */
  }
  return { theme: defaultTheme(), accent: DEFAULT_ACCENT, explicit: false };
}

function persist(s: Stored) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* swallow */
  }
}

const stored = load();
const override = themeFromQuery();

const initial: Stored = {
  theme: override.theme ?? stored.theme,
  accent: override.accent ?? stored.accent,
  // A URL override behaves like an explicit choice for this tab (nothing is
  // allowed to overwrite it) but is never written to disk.
  explicit: stored.explicit || override.theme !== undefined,
};

/** Put the theme on <html> before React's first render. */
export function bootTheme() {
  applyTheme(initial.theme, initial.accent);
}

export const useTheme = create<ThemeState>((set, get) => ({
  ...initial,

  setTheme(theme) {
    const next = { ...get(), theme, explicit: true };
    applyTheme(next.theme, next.accent);
    persist({ theme: next.theme, accent: next.accent, explicit: true });
    set({ theme, explicit: true });
  },

  setAccent(accent) {
    const next = { ...get(), accent, explicit: true };
    applyTheme(next.theme, next.accent);
    persist({ theme: next.theme, accent: next.accent, explicit: true });
    set({ accent, explicit: true });
  },
}));
