import { create } from "zustand";
import {
  AccentName,
  DEFAULT_ACCENT,
  ThemeName,
  applyTheme,
  defaultTheme,
  isAccentName,
  isThemeName,
  themeFromQuery,
} from "@/theme/theme";

/**
 * Who decides the theme, in order of authority:
 *
 *   1. `?theme=` in the URL — dev/screenshot override, this tab only.
 *   2. What the writer picked in Settings — saved here, wins forever after.
 *   3. The theme saved in the workflow being opened.
 *   4. The platform default: AquariusOS on Linux, Parchment everywhere else.
 *
 * Rule 2 beating rule 3 is the point: once someone has chosen a theme, opening
 * an older workflow must not silently change the app out from under them.
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
  /** Adopt a workflow's saved look — ignored once the writer has chosen. */
  adoptWorkflow: (c: Partial<Choice>) => void;
}

function load(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Stored>;
      if (isThemeName(p.theme) && isAccentName(p.accent)) {
        return { theme: p.theme, accent: p.accent, explicit: p.explicit !== false };
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

  adoptWorkflow(c) {
    const s = get();
    if (s.explicit) return;
    const theme = isThemeName(c.theme) ? c.theme : s.theme;
    const accent = isAccentName(c.accent) ? c.accent : s.accent;
    if (theme === s.theme && accent === s.accent) return;
    applyTheme(theme, accent);
    set({ theme, accent });
  },
}));
