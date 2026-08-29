import { useEffect, useMemo } from "react";
import { VaultWindow } from "@/components/window/VaultWindow";
import { MainWindow } from "@/components/main/MainWindow";
import { SelectWorkflow } from "@/components/workflows/SelectWorkflow";
import { OverlayRoot } from "@/components/overlays/OverlayRoot";
import { ConflictDialog } from "@/components/safety/ConflictDialog";
import { Notices } from "@/components/notices/Notices";
import {
  ACCENTS,
  AccentName,
  THEMES,
  THEME_LABEL,
  ThemeName,
  themeLocksAccent,
} from "@/theme/theme";
import { useTheme } from "@/state/themeStore";
import { useVault } from "@/state/vaultStore";
import { useOverlay } from "@/state/overlayStore";
import { usePopout } from "@/state/popoutStore";
import { CommandIcon, GraphIcon, SettingsIcon, SparkleIcon } from "@/icons";
import { useGlobalShortcuts, type Shortcut, mod } from "@/lib/shortcuts";
import { getPopoutPath } from "@/lib/popout";
import { PopoutWindow } from "@/components/popout/PopoutWindow";

export default function App() {
  const { theme, accent, setTheme, setAccent, adoptWorkflow } = useTheme();
  const { current, closeWorkflow, setView, selectedPath, bootstrap, booted } = useVault();
  const overlay = useOverlay();
  const popout = usePopout();
  const popoutPath = getPopoutPath();

  const shortcuts = useMemo<Shortcut[]>(() => [
    { id: "palette", combo: "⌘P", group: "navigation", label: "Command palette",
      match: (e) => mod(e) && e.key.toLowerCase() === "p" && !e.shiftKey,
      run: () => overlay.toggle("palette") },
    { id: "compile", combo: "⌘E", group: "system", label: "Compile / Export",
      match: (e) => mod(e) && e.key.toLowerCase() === "e",
      run: () => overlay.open("compile") },
    { id: "today", combo: "⌘T", group: "navigation", label: "Today",
      match: (e) => mod(e) && e.key.toLowerCase() === "t" && !e.shiftKey,
      run: () => overlay.open("today") },
    { id: "graph", combo: "⌘G", group: "view", label: "Graph",
      match: (e) => mod(e) && e.key.toLowerCase() === "g" && !e.shiftKey,
      run: () => overlay.open("graph") },
    { id: "settings", combo: "⌘,", group: "system", label: "Settings",
      match: (e) => mod(e) && e.key === ",",
      run: () => overlay.open("settings") },
    { id: "cheats", combo: "⌘?", group: "system", label: "Cheat sheet",
      match: (e) => (e.metaKey || e.ctrlKey || e.shiftKey) && e.key === "?",
      run: () => overlay.open("cheatsheet") },
    { id: "find", combo: "⇧⌘F", group: "navigation", label: "Find in workflow",
      match: (e) => mod(e) && e.shiftKey && e.key.toLowerCase() === "f",
      run: () => overlay.open("find") },
    { id: "view-editor", combo: "⌘1", group: "view", label: "Editor",
      match: (e) => mod(e) && e.key === "1", run: () => setView("editor") },
    { id: "view-outline", combo: "⌘2", group: "view", label: "Outline",
      match: (e) => mod(e) && e.key === "2", run: () => setView("outline") },
    { id: "view-corkboard", combo: "⌘3", group: "view", label: "Corkboard",
      match: (e) => mod(e) && e.key === "3", run: () => setView("corkboard") },
    { id: "popout", combo: "⌃⌘O", group: "navigation", label: "Pop out / reattach",
      match: (e) => mod(e) && e.ctrlKey && e.key.toLowerCase() === "o",
      run: () => {
        if (popoutPath) {
          window.close();
          return;
        }
        if (selectedPath) {
          if (popout.isPopped(selectedPath)) popout.reattach(selectedPath);
          else popout.popOut(selectedPath);
        }
      } },
  ], [overlay, setView, popout, selectedPath, popoutPath]);

  useGlobalShortcuts(shortcuts);

  // Popout child window: bypass all chrome, render the doc directly.
  if (popoutPath) {
    return <PopoutWindow path={popoutPath} />;
  }

  // Launch straight into the last workflow instead of the welcome screen.
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Adopt the workflow's own theme / accent on open — unless the writer has
  // picked a theme themselves, in which case their choice stands.
  useEffect(() => {
    if (current?.settings) {
      adoptWorkflow({
        theme: current.settings.theme,
        accent: current.settings.accent,
      });
    }
  }, [current?.id, current?.settings, adoptWorkflow]);

  return (
    <VaultWindow
      title="Aquarius"
      subtitle={current?.title}
      footerLeft={
        <>
          <span>v0.1.1</span>
          {current && (
            <button className="vw-link" onClick={closeWorkflow}>
              ← workflows
            </button>
          )}
        </>
      }
      footerRight={
        <>
          <button className="vw-icon-btn" title="Command palette (⌘P)" onClick={() => overlay.open("palette")}>
            <CommandIcon size={11} color="currentColor" />
          </button>
          <button className="vw-icon-btn" title="Graph (⌘G)" onClick={() => overlay.open("graph")}>
            <GraphIcon size={11} color="currentColor" />
          </button>
          <button className="vw-icon-btn" title="Today (⌘T)" onClick={() => overlay.open("today")}>
            <SparkleIcon size={11} color="currentColor" />
          </button>
          <button className="vw-icon-btn" title="Settings (⌘,)" onClick={() => overlay.open("settings")}>
            <SettingsIcon size={11} color="currentColor" />
          </button>
          <label className="vw-toggle">
            theme
            <select value={theme} onChange={(e) => setTheme(e.target.value as ThemeName)}>
              {THEMES.map((t) => <option key={t} value={t}>{THEME_LABEL[t]}</option>)}
            </select>
          </label>
          {/* AquariusOS locks the accent to starlight, so the picker has
              nothing to offer under it. */}
          {!themeLocksAccent(theme) && (
            <label className="vw-toggle">
              accent
              <select value={accent} onChange={(e) => setAccent(e.target.value as AccentName)}>
                {ACCENTS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
          )}
        </>
      }
    >
      {current ? <MainWindow /> : booted ? <SelectWorkflow /> : null}
      <OverlayRoot />
      <ConflictDialog />
      <Notices />
    </VaultWindow>
  );
}
