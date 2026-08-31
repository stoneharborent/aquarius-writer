import { create } from "zustand";
import {
  DEFAULT_GOAL,
  SPARK_DAYS,
  emptyDay,
  sessionsBackend,
  type DaySummary,
} from "@/lib/vault/sessions";

/**
 * Today's words, the last fortnight, and the streak — the reactive half of
 * `.aquarius/sessions/`.
 *
 * Thin on purpose. The arithmetic (a first sighting is a baseline, a deletion
 * counts as zero, a streak may end yesterday) lives in `sessions.rs`, where it
 * is tested; this holds the last answer so the Today panel can paint it, and
 * writes through on every save.
 *
 * It deliberately does **not** import `vaultStore`. The save path is
 * `vaultStore → editorStore → here`, and reaching back for the open workflow's
 * goal would close that circle — so the goal is pushed in instead, by
 * `openWorkflow` and by `setDailyGoal`.
 */
interface SessionsState {
  /** Which workflow the numbers below describe. Null before one is open. */
  workflowId: string | null;
  /** The vault's daily word goal, as `workflow.json` last reported it. */
  goal: number;
  today: DaySummary;
  /** Oldest first, one entry per day including the empty ones, ending today. */
  days: DaySummary[];
  streak: number;
  /** True while the first read for this workflow is in flight. */
  loading: boolean;

  /** Adopt a workflow and read its history. Called when one opens. */
  load: (workflowId: string, goal: number) => Promise<void>;
  /** Re-read from disk — the Today panel does this when it opens. */
  refresh: () => Promise<void>;
  /** Forget everything (the workflow closed). */
  clear: () => void;
  /** The goal changed in `workflow.json`; keep the number we record with it. */
  setGoal: (goal: number) => void;
  /**
   * Record a document's word count after a successful save.
   *
   * Called from `editorStore.flushSave`, which is already debounced — this is
   * never per keystroke.
   */
  note: (workflowId: string, path: string, words: number) => Promise<void>;
}

const blank = (goal: number) => ({
  today: emptyDay(goal),
  days: [] as DaySummary[],
  streak: 0,
});

export const useSessions = create<SessionsState>((set, get) => ({
  workflowId: null,
  goal: DEFAULT_GOAL,
  ...blank(DEFAULT_GOAL),
  loading: false,

  async load(workflowId, goal) {
    set({ workflowId, goal: goal || DEFAULT_GOAL, ...blank(goal), loading: true });
    await get().refresh();
  },

  async refresh() {
    const { workflowId, goal } = get();
    if (!workflowId) return;
    try {
      const view = await sessionsBackend().range(workflowId, SPARK_DAYS, goal);
      // The workflow may have closed while this was in flight.
      if (get().workflowId !== workflowId) return;
      set({ today: view.today, days: view.days, streak: view.streak, loading: false });
    } catch (e) {
      // A history that did not load is a panel with nothing in it, not a
      // reason to interrupt someone who is writing.
      console.error("could not read the writing sessions:", e);
      set({ loading: false });
    }
  },

  clear() {
    set({ workflowId: null, goal: DEFAULT_GOAL, ...blank(DEFAULT_GOAL), loading: false });
  },

  setGoal(goal) {
    const next = goal || DEFAULT_GOAL;
    set({
      goal: next,
      today: { ...get().today, goal: next },
      days: get().days.map((d, i, all) => (i === all.length - 1 ? { ...d, goal: next } : d)),
    });
  },

  async note(workflowId, path, words) {
    if (get().workflowId !== workflowId) return;
    const before = get().today.written;
    try {
      const today = await sessionsBackend().note(workflowId, path, words, get().goal);
      if (get().workflowId !== workflowId) return;
      // Crossing zero is the one thing that can change the streak, and it is
      // worth one extra read a day to have the flame appear the moment the
      // first words land.
      if (before === 0 && today.written > 0) {
        set({ today });
        await get().refresh();
        return;
      }
      const days = get().days.slice();
      if (days.length > 0 && days[days.length - 1].date === today.date) {
        days[days.length - 1] = today;
      }
      set({ today, days });
    } catch (e) {
      console.error("could not record the session:", e);
    }
  },
}));
