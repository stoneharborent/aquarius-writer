import { useEffect } from "react";

export interface Shortcut {
  id: string;
  /** Display key combo, e.g. "⌘P" */
  combo: string;
  /** Category for the cheat sheet */
  group: "navigation" | "view" | "editing" | "ai" | "system";
  label: string;
  /** Matcher tested against the raw KeyboardEvent. */
  match: (e: KeyboardEvent) => boolean;
  /** Handler — return false to bubble. */
  run: () => void;
}

export const SHORTCUTS: Shortcut[] = [];

export function registerShortcut(s: Shortcut) {
  SHORTCUTS.push(s);
}

export function useGlobalShortcuts(shortcuts: Shortcut[]) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // An editor keymap (e.g. the screenplay ⌘1–7 element commands) that
      // consumed the event wins over global shortcuts.
      if (e.defaultPrevented) return;
      // Skip when typing in an input/editor
      const t = e.target as HTMLElement;
      const editable =
        t?.tagName === "INPUT" ||
        t?.tagName === "TEXTAREA" ||
        t?.isContentEditable ||
        t?.closest(".cm-editor");
      // ESC and ⌘? always work; everything else respects editable focus
      const alwaysOn = e.key === "Escape" || (e.shiftKey && e.key === "?");
      if (editable && !alwaysOn && !e.metaKey && !e.ctrlKey) return;

      for (const s of shortcuts) {
        if (s.match(e)) {
          e.preventDefault();
          s.run();
          return;
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts]);
}

export const mod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;
