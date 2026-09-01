// The terminal pane's tabs.
//
// The split that matters here is **config vs process**:
//
//   • A session's CONFIG — its name, its font size, its startup command — is
//     the writer's setup and persists in localStorage. It survives a quit the
//     way a sidebar width does.
//   • A session's PROCESS is a real PTY in Rust and does not survive anything.
//     Nothing is persisted about it, nothing is restored, and a relaunched app
//     opens its tabs cold with a "Launch" button in each.
//
// Persisting a running shell would be a lie in both directions: the process is
// gone, and pretending otherwise would put a dead prompt on screen that
// silently swallows what the writer types. So the status below starts at
// "idle" every launch, on purpose.
//
// Swift's terminal (SWIFT-AUDIT §2.7) has more chrome than this — pinning and
// a model/effort chip belong to its embedded agent, which this app does not
// have (the agent is whatever the writer runs, over MCP). What is ported is
// the part that is about terminals: named sessions, the workflow's cwd, a
// configurable startup command, and an adjustable font size.

import { create } from "zustand";

/** Integer sizes only — NOTES §1a. A fractional cell grid blurs the glyphs. */
export const FONT_MIN = 9;
export const FONT_MAX = 24;
export const FONT_DEFAULT = 12;

/** What the writer set up. Persisted. */
export interface TerminalConfig {
  id: string;
  name: string;
  /** Typed into the shell on spawn. Empty = a plain shell. */
  startup: string;
  fontSize: number;
}

/** What is true right now. Never persisted. */
export type TerminalStatus = "idle" | "live" | "exited";

export interface TerminalRuntime {
  status: TerminalStatus;
  /** Set when the shell exits; null while it lives. */
  exitCode: number | null;
  /** The workflow the live shell was spawned in — not necessarily the current one. */
  workflowId: string | null;
  /** What the shell's cwd actually is, for the header. */
  cwd: string;
  /** A spawn that failed, verbatim. */
  error: string | null;
}

const K = {
  sessions: "aquarius.terminal.sessions",
  active: "aquarius.terminal.active",
} as const;

const IDLE: TerminalRuntime = {
  status: "idle",
  exitCode: null,
  workflowId: null,
  cwd: "",
  error: null,
};

function newId(): string {
  // Not a uuid: it only has to be unique among this machine's tabs, and it is
  // used as an object key and a DOM id.
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function clampFont(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return FONT_DEFAULT;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, v));
}

function load(): TerminalConfig[] {
  try {
    const raw = localStorage.getItem(K.sessions);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map((s) => ({
        id: typeof s.id === "string" && s.id ? s.id : newId(),
        name: typeof s.name === "string" && s.name.trim() ? s.name : "Terminal",
        // A startup command is executable content. It is only ever written by
        // the gear button in the pane header — see pty/mod.rs — so the only
        // job here is to make sure a corrupt value cannot become one.
        startup: typeof s.startup === "string" ? s.startup : "",
        fontSize: clampFont(s.fontSize),
      }))
      .slice(0, 24);
  } catch {
    return [];
  }
}

function persist(list: TerminalConfig[]) {
  try {
    localStorage.setItem(K.sessions, JSON.stringify(list));
  } catch {
    /* private mode — the tabs still work, they just will not come back */
  }
}

function persistActive(id: string | null) {
  try {
    if (id) localStorage.setItem(K.active, id);
    else localStorage.removeItem(K.active);
  } catch {
    /* swallow */
  }
}

interface TerminalState {
  sessions: TerminalConfig[];
  activeId: string | null;
  runtime: Record<string, TerminalRuntime>;

  /** Add a tab. `name` defaults to the workflow's name, the way Swift does. */
  add: (name?: string) => string;
  close: (id: string) => void;
  setActive: (id: string) => void;
  rename: (id: string, name: string) => void;
  setStartup: (id: string, startup: string) => void;
  /** +1 / −1 on the active tab's font, or 0 to go back to the default. */
  stepFont: (id: string, delta: number) => void;

  /** Called by the view as the PTY comes up, dies, or refuses to start. */
  markLive: (id: string, workflowId: string | null, cwd: string) => void;
  markExited: (id: string, code: number | null) => void;
  markFailed: (id: string, error: string) => void;
  /** Back to "idle" so the view's spawn effect runs again. */
  relaunch: (id: string) => void;

  runtimeOf: (id: string) => TerminalRuntime;
  /** Ensure at least one tab exists, and return the active one. */
  ensure: (name?: string) => string;
}

export const useTerminal = create<TerminalState>((set, get) => {
  const sessions = load();
  let activeId: string | null = null;
  try {
    const stored = localStorage.getItem(K.active);
    activeId = sessions.some((s) => s.id === stored) ? stored : (sessions[0]?.id ?? null);
  } catch {
    activeId = sessions[0]?.id ?? null;
  }

  return {
    sessions,
    activeId,
    runtime: {},

    add(name) {
      const id = newId();
      const next: TerminalConfig = {
        id,
        name: (name ?? "Terminal").trim() || "Terminal",
        startup: "",
        fontSize: FONT_DEFAULT,
      };
      const list = [...get().sessions, next];
      persist(list);
      persistActive(id);
      set({ sessions: list, activeId: id });
      return id;
    },

    close(id) {
      const list = get().sessions.filter((s) => s.id !== id);
      const wasActive = get().activeId === id;
      const nextActive = wasActive ? (list[list.length - 1]?.id ?? null) : get().activeId;
      const runtime = { ...get().runtime };
      delete runtime[id];
      persist(list);
      persistActive(nextActive);
      set({ sessions: list, activeId: nextActive, runtime });
    },

    setActive(id) {
      if (!get().sessions.some((s) => s.id === id)) return;
      persistActive(id);
      set({ activeId: id });
    },

    rename(id, name) {
      const clean = name.trim().slice(0, 40) || "Terminal";
      const list = get().sessions.map((s) => (s.id === id ? { ...s, name: clean } : s));
      persist(list);
      set({ sessions: list });
    },

    setStartup(id, startup) {
      const list = get().sessions.map((s) => (s.id === id ? { ...s, startup } : s));
      persist(list);
      set({ sessions: list });
    },

    stepFont(id, delta) {
      const list = get().sessions.map((s) => {
        if (s.id !== id) return s;
        const size = delta === 0 ? FONT_DEFAULT : clampFont(s.fontSize + delta);
        return { ...s, fontSize: size };
      });
      persist(list);
      set({ sessions: list });
    },

    markLive(id, workflowId, cwd) {
      set({
        runtime: {
          ...get().runtime,
          [id]: { status: "live", exitCode: null, workflowId, cwd, error: null },
        },
      });
    },

    markExited(id, code) {
      const prev = get().runtime[id] ?? IDLE;
      set({
        runtime: { ...get().runtime, [id]: { ...prev, status: "exited", exitCode: code } },
      });
    },

    markFailed(id, error) {
      const prev = get().runtime[id] ?? IDLE;
      set({
        runtime: { ...get().runtime, [id]: { ...prev, status: "exited", error } },
      });
    },

    relaunch(id) {
      set({ runtime: { ...get().runtime, [id]: { ...IDLE } } });
    },

    runtimeOf(id) {
      return get().runtime[id] ?? IDLE;
    },

    ensure(name) {
      const s = get();
      if (s.activeId && s.sessions.some((x) => x.id === s.activeId)) return s.activeId;
      if (s.sessions.length > 0) {
        const id = s.sessions[0].id;
        persistActive(id);
        set({ activeId: id });
        return id;
      }
      return s.add(name);
    },
  };
});
