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
 *   4. The theme saved in the workflow being opened.
 *   5. Ice.
 *
 * Rule 2 beating rule 4 is the point: once someone has chosen a theme, opening
 * an older workflow must not silently change the app out from under them.
 *
 * Rule 3 beating rule 4 matters more than it looks. Every workflow.json ever
 * written says `theme: "parchment"` — it is the Rust struct's default and
 * nothing in the app has ever written a different value — so without this, a
 * fresh Linux install would open its first workflow and immediately drop out of
 * the OS skin. On macOS nothing changes: the platform default is Ice there
 * (and `"parchment"` migrates to Ice), so workflow themes behave exactly as
 * they always have.
 *
 * Every value read back — localStorage, the URL override, a workflow file —
 * goes through `normalizeTheme` / `normalizeAccent`, which map the retired
 * names (parchment / purple / sepia / sage) onto the current ones. Only the
 * new names are ever written.
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
  /**
   * Adopt a workflow's saved look — ignored once the writer has chosen. The
   * values come straight off disk, so they are `unknown` here and normalized
   * (retired names included) on the way in.
   */
  adoptWorkflow: (c: { theme?: unknown; accent?: unknown }) => void;
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

/** True on the OS itself, where the stock look is not a workflow file's call. */
const osSkinIsStock = defaultTheme() === "aquarius";

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
    if (s.explicit || osSkinIsStock) return;
    const theme = normalizeTheme(c.theme) ?? s.theme;
    const accent = normalizeAccent(c.accent) ?? s.accent;
    if (theme === s.theme && accent === s.accent) return;
    applyTheme(theme, accent);
    set({ theme, accent });
  },
}));
