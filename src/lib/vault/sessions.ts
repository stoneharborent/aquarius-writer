// Where the Today panel's numbers come from.
//
// Two backends behind one interface, chosen the way the vault service and the
// aux store are:
//
//  • **disk** — `.aquarius/sessions/YYYY-MM-DD.json` inside the vault, via the
//    Rust commands in `src-tauri/src/sessions.rs`. This is the real one, and
//    the format is documented there as the shared contract the Swift app can
//    adopt.
//  • **browser** — the same arithmetic over localStorage, so `npm run dev`
//    shows real behaviour (a ring that fills as you type in the preview)
//    rather than the hardcoded sample data this feature replaced.
//
// Unlike the aux store this API is entirely async. Nothing here is read during
// render: the Today panel is an overlay, and `sessionsStore` holds the last
// answer for it.

import { invoke } from "@tauri-apps/api/core";

/** One document's gain today. Mirrors `DocDelta` in `sessions.rs`. */
export interface DocDelta {
  path: string;
  words: number;
}

/** One calendar day. Mirrors `DaySummary` in `sessions.rs`. */
export interface DaySummary {
  /** `YYYY-MM-DD`, in the writer's own timezone. */
  date: string;
  goal: number;
  /** Σ max(0, latest − start) across the day's documents. */
  written: number;
  /** Biggest gain first; documents that stood still are not listed. */
  docs: DocDelta[];
}

/** Everything the Today panel needs. Mirrors `SessionsView` in `sessions.rs`. */
export interface SessionsView {
  today: DaySummary;
  /** Oldest first, gaps included, ending today. */
  days: DaySummary[];
  streak: number;
}

/** How many days the sparkline shows — matches `sessions::SPARK_DAYS`. */
export const SPARK_DAYS = 14;

export const DEFAULT_GOAL = 1000;

export interface SessionsBackend {
  /**
   * Record where a document's word count stands now, and answer with today.
   *
   * `goal` is only consulted by the browser backend; on disk the goal is read
   * from `workflow.json`, which is the one place it lives.
   */
  note(wf: string, path: string, words: number, goal: number): Promise<DaySummary>;
  today(wf: string, goal: number): Promise<DaySummary>;
  range(wf: string, days: number, goal: number): Promise<SessionsView>;
}

// ── browser: localStorage ────────────────────────────────────────────────
//
// One key per workflow holding `{ [date]: DaySession }` — the same day shape
// the Rust side writes, just all in one bag because localStorage has no
// folders. The rules (first observation is a baseline, a loss counts as zero,
// a streak may end yesterday) are re-implemented rather than shared, and the
// Rust tests are where they are actually pinned down.

interface DocWords {
  start: number;
  latest: number;
}

interface DaySession {
  date: string;
  goal: number;
  words: Record<string, DocWords>;
  updatedAt: number;
}

const KEY = (wf: string) => `aq.sessions.${wf}`;

function readAll(wf: string): Record<string, DaySession> {
  try {
    const raw = localStorage.getItem(KEY(wf));
    return raw ? (JSON.parse(raw) as Record<string, DaySession>) : {};
  } catch {
    return {};
  }
}

function writeAll(wf: string, all: Record<string, DaySession>) {
  try {
    localStorage.setItem(KEY(wf), JSON.stringify(all));
  } catch { /* storage full / disabled — the preview degrades to session-only */ }
}

/** `YYYY-MM-DD` for a local-time instant. */
function dateKey(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function daysBack(n: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0); // noon, so a DST shift cannot skip a day
  d.setDate(d.getDate() - n);
  return d;
}

function summarize(day: DaySession | undefined, date: string, fallbackGoal: number): DaySummary {
  const docs: DocDelta[] = Object.entries(day?.words ?? {})
    .map(([path, w]) => ({ path, words: Math.max(0, w.latest - w.start) }))
    .filter((d) => d.words > 0)
    .sort((a, b) => b.words - a.words || a.path.localeCompare(b.path));
  return {
    date,
    goal: day?.goal || fallbackGoal || DEFAULT_GOAL,
    written: docs.reduce((sum, d) => sum + d.words, 0),
    docs,
  };
}

function createBrowserSessionsBackend(): SessionsBackend {
  const summaryFor = (wf: string, date: string, goal: number) =>
    summarize(readAll(wf)[date], date, goal);

  return {
    async note(wf, path, words, goal) {
      const all = readAll(wf);
      const date = dateKey(new Date());
      const day: DaySession =
        all[date] ?? { date, goal: goal || DEFAULT_GOAL, words: {}, updatedAt: 0 };
      day.goal = goal || DEFAULT_GOAL;
      day.updatedAt = Date.now();
      const seen = day.words[path];
      // First sighting today is a baseline, not a gain — opening a 2,400-word
      // chapter must not read as having written 2,400 words.
      day.words[path] = seen ? { ...seen, latest: words } : { start: words, latest: words };
      all[date] = day;
      writeAll(wf, all);
      return summarize(day, date, goal);
    },

    async today(wf, goal) {
      return summaryFor(wf, dateKey(new Date()), goal);
    },

    async range(wf, days, goal) {
      const n = Math.max(1, Math.min(365, days));
      const list: DaySummary[] = [];
      for (let back = n - 1; back >= 0; back--) {
        list.push(summaryFor(wf, dateKey(daysBack(back)), goal));
      }
      const wrote = (back: number) => summaryFor(wf, dateKey(daysBack(back)), goal).written > 0;
      let streak = 0;
      // The run may end today or yesterday: not having started this morning
      // does not lose last night's work.
      let cursor = wrote(0) ? 0 : wrote(1) ? 1 : -1;
      if (cursor >= 0) {
        while (streak < 3660 && wrote(cursor)) {
          streak++;
          cursor++;
        }
      }
      return { today: list[list.length - 1], days: list, streak };
    },
  };
}

// ── desktop: .aquarius/sessions/ on disk ─────────────────────────────────

function createDiskSessionsBackend(): SessionsBackend {
  return {
    async note(wf, path, words) {
      return invoke<DaySummary>("session_note", { workflowId: wf, relPath: path, words });
    },
    async today(wf) {
      return invoke<DaySummary>("session_today", { workflowId: wf });
    },
    async range(wf, days) {
      return invoke<SessionsView>("session_range", { workflowId: wf, days });
    },
  };
}

let _backend: SessionsBackend | null = null;

export function sessionsBackend(): SessionsBackend {
  if (_backend) return _backend;
  const inTauri = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
  _backend = inTauri ? createDiskSessionsBackend() : createBrowserSessionsBackend();
  return _backend;
}

/** An empty day, for a panel that has not loaded yet or a vault with no history. */
export function emptyDay(goal: number): DaySummary {
  return { date: dateKey(new Date()), goal: goal || DEFAULT_GOAL, written: 0, docs: [] };
}
