import { useEffect, useMemo } from "react";
import { VaultWindow } from "@/components/window/VaultWindow";
import { MainWindow } from "@/components/main/MainWindow";
import { SelectWorkflow } from "@/components/workflows/SelectWorkflow";
import { OverlayRoot } from "@/components/overlays/OverlayRoot";
import { ConflictDialog } from "@/components/safety/ConflictDialog";
import { Notices } from "@/components/notices/Notices";
import { useVault } from "@/state/vaultStore";
import { useUpdates } from "@/state/updateStore";
import { useOverlay } from "@/state/overlayStore";
import { usePopout } from "@/state/popoutStore";
import { useShell } from "@/state/shellStore";
import { useGlobalShortcuts, type Shortcut, mod } from "@/lib/shortcuts";
import { stepEditorZoom } from "@/lib/markdown/editor-zoom";
import { getPopoutPath } from "@/lib/popout";
import { PopoutWindow } from "@/components/popout/PopoutWindow";

export default function App() {
  // One selector per field. `useVault()` with no selector re-rendered App —
  // and the whole window under it — on every vault change, including ones it
  // does not paint. App paints exactly two things: the workflow's title and
  // whether boot has finished.
  const current = useVault((s) => s.current);
  const booted = useVault((s) => s.booted);
  const setView = useVault((s) => s.setView);
  const bootstrap = useVault((s) => s.bootstrap);
  // Read imperatively rather than subscribing: App has no reason to re-render
  // on every pixel of a splitter drag, on every overlay that opens, or on
  // every pop-out — these handlers only ever *write*.
  const shell = useShell.getState;
  const overlay = useOverlay.getState;
  const popout = usePopout.getState;
  const vault = useVault.getState;
  const startUpdates = useUpdates((s) => s.start);
  const popoutPath = getPopoutPath();

  const shortcuts = useMemo<Shortcut[]>(() => [
    { id: "palette", combo: "⌘P", group: "navigation", label: "Command palette",
      match: (e) => mod(e) && e.key.toLowerCase() === "p" && !e.shiftKey,
      run: () => overlay().toggle("palette") },
    { id: "compile", combo: "⌘E", group: "system", label: "Compile / Export",
      match: (e) => mod(e) && e.key.toLowerCase() === "e",
      run: () => overlay().open("compile") },
    { id: "today", combo: "⌘T", group: "navigation", label: "Today",
      match: (e) => mod(e) && e.key.toLowerCase() === "t" && !e.shiftKey,
      run: () => overlay().open("today") },
    { id: "graph", combo: "⌘G", group: "view", label: "Graph",
      match: (e) => mod(e) && e.key.toLowerCase() === "g" && !e.shiftKey,
      run: () => overlay().open("graph") },
    { id: "settings", combo: "⌘,", group: "system", label: "Settings",
      match: (e) => mod(e) && e.key === ",",
      run: () => overlay().open("settings") },
    { id: "cheats", combo: "⌘?", group: "system", label: "Cheat sheet",
      match: (e) => (e.metaKey || e.ctrlKey || e.shiftKey) && e.key === "?",
      run: () => overlay().open("cheatsheet") },
    { id: "find", combo: "⇧⌘F", group: "navigation", label: "Find in workflow",
      match: (e) => mod(e) && e.shiftKey && e.key.toLowerCase() === "f",
      run: () => overlay().open("find") },
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
    /* The terminal gets its own key rather than only a place in the ⌘⌥\ cycle:
       it is the one right-pane tab a writer reaches for mid-thought, and
       cycling past Comments and Versions to get there is three presses. ⌘⇧J is
       free in this app (nothing else binds J at all) and is the shortcut the
       writer already has for a terminal drawer in VS Code. */
    { id: "terminal", combo: "⇧⌘J", group: "view", label: "Terminal",
      match: (e) => mod(e) && e.shiftKey && e.key.toLowerCase() === "j",
      run: () => shell().toggleRightTab("terminal") },
    { id: "rightpane", combo: "⌘⌥\\", group: "view", label: "Cycle the right pane",
      match: (e) => mod(e) && e.altKey && (e.key === "\\" || e.code === "Backslash"),
      run: () => shell().cycleRight() },
    { id: "view-editor", combo: "⌘1", group: "view", label: "Editor",
      match: (e) => mod(e) && e.key === "1", run: () => setView("editor") },
    { id: "view-outline", combo: "⌘2", group: "view", label: "Outline",
      match: (e) => mod(e) && e.key === "2", run: () => setView("outline") },
    { id: "view-corkboard", combo: "⌘3", group: "view", label: "Corkboard",
      match: (e) => mod(e) && e.key === "3", run: () => setView("corkboard") },
    /* Per-document zoom (PARITY row 14). `useGlobalShortcuts` calls
       `preventDefault()` on every match, which is what keeps the WEBVIEW from
       zooming instead — ⌘+ and ⌘− are its own default bindings, and once the
       whole page scales, the editor is no longer the whole-pixel surface
       NOTES §1a requires it to be. Matching goes through both `key` and `code`
       because ⌘+ is an unshifted `=` on a US layout, a shifted `+` on others,
       and a numpad key on a third. */
    { id: "zoom-in", combo: "⌘+", group: "view", label: "Zoom this document in",
      match: (e) => mod(e) && !e.altKey &&
        (e.key === "+" || e.key === "=" || e.code === "NumpadAdd"),
      run: () => { stepEditorZoom(1); } },
    { id: "zoom-out", combo: "⌘−", group: "view", label: "Zoom this document out",
      match: (e) => mod(e) && !e.altKey &&
        (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract"),
      run: () => { stepEditorZoom(-1); } },
    { id: "zoom-reset", combo: "⌘0", group: "view", label: "Reset this document's zoom",
      match: (e) => mod(e) && !e.altKey && (e.key === "0" || e.code === "Numpad0"),
      run: () => { stepEditorZoom(0); } },
    { id: "popout", combo: "⌃⌘O", group: "navigation", label: "Pop out / reattach",
      match: (e) => mod(e) && e.ctrlKey && e.key.toLowerCase() === "o",
      run: () => {
        if (popoutPath) {
          window.close();
          return;
        }
        const selectedPath = vault().selectedPath;
        if (selectedPath) {
          if (popout().isPopped(selectedPath)) popout().reattach(selectedPath);
          else popout().popOut(selectedPath);
        }
      } },
  ], [overlay, setView, popout, popoutPath, shell, vault]);

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

  // No theme adoption on open. The theme is global — Swift keeps one value in
  // UserDefaults and has no per-workflow look at all (SWIFT-AUDIT §4) — so
  // opening a workflow no longer changes how the app looks. PARITY row 21;
  // `settings.theme` / `settings.accent` still round-trip on disk, unread.

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
