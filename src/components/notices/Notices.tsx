import { useNotices } from "@/state/noticeStore";
import "./Notices.css";

/**
 * The failure surface. Bottom-right, above everything, dismissible.
 *
 * Rendered once at the app root so it works on the welcome screen as well as
 * inside a workflow — the three dead buttons of v0.1.0 were all on the welcome
 * screen, which is the one place the app had no chrome to complain in.
 */
export function Notices() {
  const { notices, dismiss } = useNotices();
  if (notices.length === 0) return null;

  return (
    <div className="nt-stack" role="status" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`nt-item ${n.tone}`}>
          <div className="nt-body">
            <div className="nt-title">{n.title}</div>
            {n.detail && <div className="nt-detail">{n.detail}</div>}
          </div>
          <button className="nt-close" onClick={() => dismiss(n.id)} title="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
