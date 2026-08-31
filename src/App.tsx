import { useEffect, useMemo } from "react";
import { VaultWindow } from "@/components/window/VaultWindow";
import { MainWindow } from "@/components/main/MainWindow";
import { SelectWorkflow } from "@/components/workflows/SelectWorkflow";
import { OverlayRoot } from "@/components/overlays/OverlayRoot";
import { ConflictDialog } from "@/components/safety/ConflictDialog";
import { Notices } from "@/components/notices/Notices";
import { useTheme } from "@/state/themeStore";
import { useVault } from "@/state/vaultStore";
import { useUpdates } from "@/state/updateStore";
import { useOverlay } from "@/state/overlayStore";
import { usePopout } from "@/state/popoutStore";
import { useShell } from "@/state/shellStore";
import { useGlobalShortcuts, type Shortcut, mod } from "@/lib/shortcuts";
import { getPopoutPath } from "@/lib/popout";
import { PopoutWindow } from "@/components/popout/PopoutWindow";

export default function App() {
  const { adoptWorkflow } = useTheme();
  const { current, setView, selectedPath, bootstrap, booted } = useVault();
  const overlay = useOverlay();
  const popout = usePopout();
  // Read imperatively rather than subscribing: App has no reason to re-render
  // on every pixel of a splitter drag, and these handlers only ever *write*.
  const shell = useShell.getState;
  const startUpdates = useUpdates((s) => s.start);
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
    { id: "search", combo: "⌘K", group: "navigation", label: "Focus the search capsule",
      match: (e) => mod(e) && e.key.toLowerCase() === "k",
      run: () => {
        // A collapsed sidebar makes the filter invisible, so ⌘K opens it.
        shell().setSidebarCollapsed(false);
        shell().focusSearch();
      } },
    { id: "sidebar", combo: "⌘\\", group: "view", label: "Show / hide the file sidebar",
      match: (e) => mod(e) && !e.altKey && e.key === "\\",
      run: () => shell().toggleSidebar() },
    { id: "rightpane", combo: "⌘⌥\\", group: "view", label: "Cycle the right pane",
      match: (e) => mod(e) && e.altKey && (e.key === "\\" || e.code === "Backslash"),
      run: () => shell().cycleRight() },
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
  ], [overlay, setView, popout, selectedPath, popoutPath, shell]);

  useGlobalShortcuts(shortcuts);

  // Popout child window: bypass all chrome, render the doc directly.
  if (popoutPath) {
    return <PopoutWindow path={popoutPath} />;
  }

  // Launch straight into the last workflow instead of the welcome screen.
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // One quiet look for a newer version, on AquariusOS only. It says nothing
  // unless it finds something, and nothing at all if it cannot reach GitHub.
  useEffect(() => {
    void startUpdates();
  }, [startUpdates]);

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

  // No status bar. Swift has none (SWIFT-AUDIT §1.3) and everything that used
  // to live in the port's went somewhere it reads better: the version number
  // is in Settings → About, "← workflows" is the sidebar's footer chip ("All
  // workflows"), the palette / graph / today / settings buttons are the
  // sidebar's bottom rail, and the theme and accent dropdowns were always a
  // duplicate of Settings → Appearance.
  return (
    <VaultWindow title="Aquarius" subtitle={current?.title}>
      {current ? <MainWindow /> : booted ? <SelectWorkflow /> : null}
      <OverlayRoot />
      <ConflictDialog />
      <Notices />
    </VaultWindow>
  );
}
