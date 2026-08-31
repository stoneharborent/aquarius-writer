// A draggable column divider.
//
// Sits in its own 1px grid column so dragging never changes the number of
// tracks — only the widths either side of it. The 7px hit area and the
// hairline-that-thickens-to-accent are SWIFT-AUDIT §1.3.
//
// Pointer capture rather than window listeners: the drag has to keep following
// the pointer when it leaves the 7px strip, which it does immediately.
import { useRef, useState } from "react";
import "./Splitter.css";

export function Splitter({
  onDrag,
  onReset,
  label,
}: {
  /** Called with the pointer's x in client coordinates during a drag. */
  onDrag: (clientX: number) => void;
  /** Double-click restores the default width. */
  onReset: () => void;
  label: string;
}) {
  const [dragging, setDragging] = useState(false);
  const active = useRef(false);

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-dragging={dragging || undefined}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        e.preventDefault();
        active.current = true;
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (active.current) onDrag(e.clientX);
      }}
      onPointerUp={(e) => {
        active.current = false;
        setDragging(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        active.current = false;
        setDragging(false);
      }}
    />
  );
}
