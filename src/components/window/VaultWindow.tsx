import { ReactNode } from "react";
import "./VaultWindow.css";

export interface VaultWindowProps {
  title?: string;
  subtitle?: string;
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
  children?: ReactNode;
}

export function VaultWindow({
  title = "Aquarius",
  subtitle,
  footerLeft,
  footerRight,
  children,
}: VaultWindowProps) {
  return (
    <div className="vault-window">
      <header className="vw-titlebar" data-tauri-drag-region>
        <div className="vw-title">
          <span className="vw-title-main">{title}</span>
          {subtitle && <span className="vw-title-sep">·</span>}
          {subtitle && <span className="vw-title-sub">{subtitle}</span>}
        </div>
      </header>

      <div className="vw-body">{children}</div>

      <footer className="vw-statusbar">
        <div className="vw-status-left">{footerLeft}</div>
        <div className="vw-status-right">{footerRight}</div>
      </footer>
    </div>
  );
}
