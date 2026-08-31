import { useEffect, useRef, useState } from "react";
import { Overlay } from "./Overlay";
import { useSessions } from "@/state/sessionsStore";
import { useVault } from "@/state/vaultStore";
import { DEFAULT_GOAL } from "@/lib/vault/sessions";
import "./Today.css";

/**
 * Today — the goal ring, the streak, the fortnight, and where the words went.
 *
 * Every number here comes from `.aquarius/sessions/` (see docs/NOTES.md §21).
 * Until 2026-08-31 this panel was a hardcoded `const TODAY = {…}`, and so is
 * the Swift app's — whichever of the two built it first was going to set the
 * shared format, and this is it.
 */

/** How many documents the per-document list shows before it stops. */
const TOP_DOCS = 5;

export function Today() {
  const { selectPath, setView, current, setDailyGoal } = useVault();
  const today = useSessions((s) => s.today);
  const days = useSessions((s) => s.days);
  const streak = useSessions((s) => s.streak);
  const loading = useSessions((s) => s.loading);
  const refresh = useSessions((s) => s.refresh);

  // ⌘T (and the sidebar's quick view) can land here long after the last save,
  // and an MCP client may have been writing in the meantime.
  useEffect(() => { void refresh(); }, [refresh]);

  const goal = current?.goals?.dailyWords ?? today.goal ?? DEFAULT_GOAL;
  const written = today.written;
  const pct = goal > 0 ? Math.min(1, written / goal) : 0;
  const C = 2 * Math.PI * 38; // circumference for r=38
  const hitGoal = goal > 0 && written >= goal;

  const spark = days;
  const sparkMax = Math.max(goal, ...spark.map((d) => d.written), 1);
  const anyHistory = spark.some((d) => d.written > 0);
  const docs = today.docs.slice(0, TOP_DOCS);

  return (
    <Overlay title="Today" width={520}>
      <div className="td">
        <div className="td-hero">
          <svg width="96" height="96" viewBox="0 0 96 96" className="td-ring" aria-hidden>
            <circle cx="48" cy="48" r="38" fill="none" stroke="var(--line-strong)" strokeWidth="6" />
            <circle
              cx="48"
              cy="48"
              r="38"
              fill="none"
              stroke={hitGoal ? "var(--success)" : "var(--accent)"}
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${C * pct} ${C}`}
              transform="rotate(-90 48 48)"
            />
          </svg>
          <div className="td-stats">
            <div className="td-written">
              {written.toLocaleString()} <GoalField goal={goal} onSet={setDailyGoal} />
            </div>
            <div className="td-label">
              {written === 0
                ? loading ? "reading this week…" : "nothing written today yet"
                : hitGoal ? "words written today — goal met" : "words written today"}
            </div>
            {streak > 0 && (
              <div className="td-streak">
                <span aria-hidden>{"\u{1F525}"}</span> {streak}-day streak
                {written === 0 && <span className="td-streak-note"> · write today to keep it</span>}
              </div>
            )}
          </div>
        </div>

        <div className="td-section-head">Last {spark.length || 14} days</div>
        {anyHistory ? (
          <div className="td-spark">
            {spark.map((d, i) => {
              const h = (d.written / sparkMax) * 56;
              const isToday = i === spark.length - 1;
              return (
                <div
                  key={d.date}
                  className={`td-bar${isToday ? " today" : ""}`}
                  title={`${d.date} · ${d.written.toLocaleString()} words`}
                >
                  <div className="td-bar-fill" style={{ height: Math.max(h, d.written > 0 ? 2 : 1) }} />
                </div>
              );
            })}
          </div>
        ) : (
          <p className="td-empty">
            No sessions on record yet. The bars fill in as you write — one for each day.
          </p>
        )}

        <div className="td-section-head">Per document</div>
        {docs.length > 0 ? (
          <ul className="td-deltas">
            {docs.map((d) => (
              <li key={d.path}>
                <button
                  className="td-delta"
                  onClick={() => { selectPath(d.path); setView("editor"); }}
                >
                  <span className="td-delta-path">{d.path}</span>
                  <span className="td-delta-words">+{d.words.toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="td-empty">
            Nothing has grown today. Open a chapter and the ring starts filling.
          </p>
        )}
      </div>
    </Overlay>
  );
}

/**
 * The "/ 1,000" beside the day's count — a button until it is clicked, then a
 * number field that writes `goals.dailyWords` back to `workflow.json`.
 *
 * Editable in place rather than behind a Settings tab because this is the one
 * screen where the number means anything, and because a goal nothing could
 * ever change was the other half of this panel's pretend (PARITY row 10's
 * neighbour: `goals` was read and never written).
 */
function GoalField({ goal, onSet }: { goal: number; onSet: (n: number) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(goal));
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  function commit() {
    setEditing(false);
    const n = Math.round(Number(draft));
    if (Number.isFinite(n) && n > 0 && n !== goal) void onSet(n);
  }

  if (!editing) {
    return (
      <button
        className="td-goal"
        title="Set the daily word goal"
        onClick={() => { setDraft(String(goal)); setEditing(true); }}
      >
        / {goal.toLocaleString()}
      </button>
    );
  }

  return (
    <input
      ref={input}
      className="td-goal-input"
      type="number"
      min={1}
      max={1000000}
      value={draft}
      aria-label="Daily word goal"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      autoFocus
      onKeyDown={(e) => {
        // Escape belongs to the field first: cancelling a goal edit should not
        // also close the panel the goal is on.
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}
