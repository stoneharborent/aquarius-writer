import { ReactNode } from "react";
import { WindowControls } from "./WindowControls";
import { detectPlatform } from "@/lib/platform";
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
  // On macOS the system draws the traffic lights over our title bar
  // (`titleBarStyle: "Overlay"`), so we draw nothing. On Linux nothing draws
  // them, so we do. See WindowControls.tsx.
  const linux = detectPlatform() === "linux";

  return (
    <div className="vault-window" data-platform={detectPlatform()}>
      {/* "deep" means a click anywhere in the bar starts a window drag —
          including on the title text — while Tauri's own handler still treats
          buttons and other interactive elements as clicks, never drags. It
          also gives us double-click-to-maximise for free. */}
      <header className="vw-titlebar" data-tauri-drag-region="deep">
        <div className="vw-title">
          <span className="vw-title-main">{title}</span>
          {subtitle && <span className="vw-title-sep">·</span>}
          {subtitle && <span className="vw-title-sub">{subtitle}</span>}
        </div>
        {linux && <WindowControls />}
      </header>

      <div className="vw-body">{children}</div>

      <footer className="vw-statusbar">
        <div className="vw-status-left">{footerLeft}</div>
        <div className="vw-status-right">{footerRight}</div>
      </footer>
    </div>
  );
}
