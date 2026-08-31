// The one collapsed-pane shape in the app.
//
// SWIFT-AUDIT §1.3 calls it a signature move: *everything* that collapses —
// sidebar, right pane, chapter rail, scenes rail — becomes the same 28px strip
// of `--bg-soft` with a hairline and the pane's name set sideways in heavy,
// letter-tracked 10px caps. Clicking anywhere on the strip reopens the pane.
import "./Gutter.css";

export function Gutter({
  label,
  side,
  onOpen,
}: {
  /** Shown rotated −90°; written in caps by the CSS, not by the caller. */
  label: string;
  /** Which edge the hairline sits on — the side facing the editor. */
  side: "left" | "right";
  onOpen: () => void;
}) {
  return (
    <button
      className={`gutter gutter-${side}`}
      title={`Show ${label.toLowerCase()}`}
      aria-label={`Show ${label.toLowerCase()}`}
      onClick={onOpen}
    >
      <span className="gutter-label">{label}</span>
    </button>
  );
}
