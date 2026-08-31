// The shell's own state: column widths, what is collapsed, which right-pane
// tab is showing, and the top bar's search text.
//
// It lives in a store rather than in MainWindow because three unrelated places
// need to reach it — the top bar's Files / Comments / Versions buttons, the
// ⌘\ and ⌘⌥\ shortcuts in App.tsx, and the collapse gutters themselves — and
// threading callbacks through the column grid to all of them was the shape the
// old fixed layout had.
//
// Widths and collapse persist, the way Swift persists them in UserDefaults
// (`aquarius.sidebarWidth`, `aquarius.rightpane.width`, `.rightpane.mode` —
// SWIFT-AUDIT §4). The search text deliberately does not: a filter that
// survived a restart would look like a broken file tree.
import { create } from "zustand";

/** Column geometry, from SWIFT-AUDIT §1.3. */
export const SIDEBAR_DEFAULT = 248;
export const SIDEBAR_MIN = 190;
export const SIDEBAR_MAX = 560;
export const RIGHT_DEFAULT = 360;
export const RIGHT_MIN = 280;
/** The editor never gets squeezed below this by a splitter drag. */
export const EDITOR_MIN = 320;
/** Every collapsed pane in the app is this wide. */
export const GUTTER = 28;

export type RightTab = "comments" | "versions";

const K = {
  sidebarWidth: "aquarius.sidebarWidth",
  sidebarCollapsed: "aquarius.sidebarCollapsed",
  rightWidth: "aquarius.rightpane.width",
  rightCollapsed: "aquarius.rightpane.collapsed",
  rightTab: "aquarius.rightpane.mode",
} as const;

function num(key: string, fallback: number, lo: number, hi: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  } catch {
    return fallback;
  }
}

function bool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "true";
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode — fine */ }
}

interface ShellState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  rightWidth: number;
  rightCollapsed: boolean;
  rightTab: RightTab;
  /** The top bar's search text — filters the file tree while it is non-empty. */
  query: string;
  /** Bumped by ⌘K; the search capsule focuses itself when it changes. */
  focusTick: number;

  setSidebarWidth: (px: number) => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;

  setRightWidth: (px: number) => void;
  setRightCollapsed: (v: boolean) => void;
  /** Switch tabs inside an open pane. */
  setRightTab: (tab: RightTab) => void;
  /**
   * The top bar's buttons: show `tab`, or — when that tab is already the one
   * showing — put the pane away. One button, both directions.
   */
  toggleRightTab: (tab: RightTab) => void;
  /** ⌘⌥\ — comments → versions → hidden → comments. */
  cycleRight: () => void;

  setQuery: (q: string) => void;
  focusSearch: () => void;
}

export const useShell = create<ShellState>((set, get) => ({
  sidebarWidth: num(K.sidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX),
  sidebarCollapsed: bool(K.sidebarCollapsed, false),
  rightWidth: num(K.rightWidth, RIGHT_DEFAULT, RIGHT_MIN, 4000),
  rightCollapsed: bool(K.rightCollapsed, false),
  rightTab: (() => {
    try {
      return localStorage.getItem(K.rightTab) === "versions" ? "versions" : "comments";
    } catch { return "comments"; }
  })(),
  query: "",
  focusTick: 0,

  setSidebarWidth(px) {
    const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
    write(K.sidebarWidth, String(w));
    set({ sidebarWidth: w });
  },
  setSidebarCollapsed(v) {
    write(K.sidebarCollapsed, String(v));
    set({ sidebarCollapsed: v });
  },
  toggleSidebar() {
    get().setSidebarCollapsed(!get().sidebarCollapsed);
  },

  setRightWidth(px) {
    const w = Math.max(RIGHT_MIN, Math.round(px));
    write(K.rightWidth, String(w));
    set({ rightWidth: w });
  },
  setRightCollapsed(v) {
    write(K.rightCollapsed, String(v));
    set({ rightCollapsed: v });
  },
  setRightTab(tab) {
    write(K.rightTab, tab);
    set({ rightTab: tab });
  },
  toggleRightTab(tab) {
    const s = get();
    if (!s.rightCollapsed && s.rightTab === tab) {
      s.setRightCollapsed(true);
      return;
    }
    s.setRightTab(tab);
    if (s.rightCollapsed) s.setRightCollapsed(false);
  },
  cycleRight() {
    const s = get();
    if (s.rightCollapsed) {
      s.setRightTab("comments");
      s.setRightCollapsed(false);
      return;
    }
    if (s.rightTab === "comments") {
      s.setRightTab("versions");
      return;
    }
    s.setRightCollapsed(true);
  },

  setQuery(q) { set({ query: q }); },
  focusSearch() { set({ focusTick: get().focusTick + 1 }); },
}));
