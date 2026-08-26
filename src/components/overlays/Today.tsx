import { Overlay } from "./Overlay";
import { useVault } from "@/state/vaultStore";
import "./Today.css";

// Synthetic 14-day session data — HANDOFF §6 says real data comes from
// .aquarius/sessions/*.json; this is the same shape, just hand-tuned for the
// preview.
const TODAY = {
  date: "2026-05-20",
  goal: 1000,
  written: 712,
  streak: 6,
  spark14: [0, 220, 480, 350, 0, 0, 920, 1100, 980, 0, 450, 880, 1140, 712],
  deltas: [
    { docPath: "Drafts/Ch_03.md", words: 412 },
    { docPath: "Characters/Imogen.md", words: 180 },
    { docPath: "Worldbuilding/Helmreach.md", words: 120 },
  ],
};

export function Today() {
  const { selectPath, setView } = useVault();
  const pct = Math.min(1, TODAY.written / TODAY.goal);
  const C = 2 * Math.PI * 38; // circumference for r=38

  return (
    <Overlay title="Today" width={520}>
      <div className="td">
        <div className="td-hero">
          <svg width="96" height="96" viewBox="0 0 96 96" className="td-ring">
            <circle cx="48" cy="48" r="38" fill="none" stroke="var(--line-strong)" strokeWidth="6" />
            <circle
              cx="48"
              cy="48"
              r="38"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${C * pct} ${C}`}
              transform="rotate(-90 48 48)"
            />
          </svg>
          <div className="td-stats">
            <div className="td-written">{TODAY.written.toLocaleString()} <span>/ {TODAY.goal.toLocaleString()}</span></div>
            <div className="td-label">words written today</div>
            <div className="td-streak">🔥 {TODAY.streak}-day streak</div>
          </div>
        </div>

        <div className="td-section-head">Last 14 days</div>
        <div className="td-spark">
          {TODAY.spark14.map((v, i) => {
            const max = Math.max(...TODAY.spark14, TODAY.goal);
            const h = (v / max) * 56;
            const isToday = i === TODAY.spark14.length - 1;
            return (
              <div key={i} className={`td-bar${isToday ? " today" : ""}`} title={`${v} words`}>
                <div className="td-bar-fill" style={{ height: h }} />
              </div>
            );
          })}
        </div>

        <div className="td-section-head">Per document</div>
        <ul className="td-deltas">
          {TODAY.deltas.map((d) => (
            <li key={d.docPath}>
              <button
                className="td-delta"
                onClick={() => { selectPath(d.docPath); setView("editor"); }}
              >
                <span className="td-delta-path">{d.docPath}</span>
                <span className="td-delta-words">+{d.words.toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Overlay>
  );
}
