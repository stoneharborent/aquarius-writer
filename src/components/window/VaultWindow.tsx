import { ReactNode } from "react";
import { WindowControls } from "./WindowControls";
import { detectPlatform } from "@/lib/platform";
import "./VaultWindow.css";

export interface VaultWindowProps {
  title?: string;
  subtitle?: string;
  children?: ReactNode;
}

/**
 * Title strip + body. There is no status bar: Swift has none (SWIFT-AUDIT
 * §1.3), and the port's 26px one was carrying four kinds of thing that all
 * belonged elsewhere. See the note in App.tsx for where each went.
 *
 * The 38px title bar height is deliberately unchanged. The drag region and the
 * Linux window controls were the whole of v0.1.1/0.1.2 (NOTES §15) and their
 * hit targets are measured against this bar — slimming it is not worth
 * re-testing on the bench for 6px.
 */
export function VaultWindow({
  title = "Aquarius",
  subtitle,
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
    </div>
  );
}
