import { ReactNode, useEffect, useRef } from "react";
import { useOverlay } from "@/state/overlayStore";
import "./Overlay.css";

interface OverlayProps {
  title?: string;
  width?: number;
  children: ReactNode;
  onClose?: () => void;
}

export function Overlay({ title, width = 640, children, onClose }: OverlayProps) {
  const close = useOverlay((s) => s.close);
  const handleClose = onClose ?? close;
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  return (
    <div className="ov-backdrop" onClick={handleClose}>
      <div
        ref={ref}
        className="ov-panel"
        role="dialog"
        aria-label={title}
        tabIndex={-1}
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <header className="ov-head">
            <span className="ov-title">{title}</span>
            <button className="ov-close" onClick={handleClose} aria-label="Close">×</button>
          </header>
        )}
        <div className="ov-body">{children}</div>
      </div>
    </div>
  );
}
