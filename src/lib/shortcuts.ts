import { useEffect } from "react";
import { detectPlatform } from "@/lib/platform";

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

/**
 * ⌘1–⌘7 belong to the screenplay while a screenplay has the caret.
 *
 * The app binds ⌘1 / ⌘2 / ⌘3 to Editor / Outline / Corkboard, and the
 * screenplay's element keymap binds Mod-1…Mod-7 to Scene / Action / Character
 * / Paren / Dialogue / Transition / Shot. Both are real bindings on the same
 * keys, and the collision is settled at the WINDOW listener, not inside
 * CodeMirror — CM's element keymap is already `Prec.highest` in its own editor
 * and cannot outrank a listener it never sees.
 *
 * In theory the `e.defaultPrevented` guard above resolves it: CM's keymap
 * handler is on `contentDOM`, the listener here is on `window` in the bubble
 * phase, so CM runs first and calls `preventDefault()`. In practice it does
 * not hold in one case that matters, and it is the case a writer hits: when a
 * keystroke arrives while the view is mid-update, CodeMirror's DOM observer
 * defers `runHandlers` to a microtask (`Promise.resolve().then(…)`) — and a
 * microtask runs AFTER the whole synchronous dispatch of the event, i.e. after
 * this listener has already switched the view out from under the editor. On a
 * paged screenplay, where every keystroke schedules measure work, "mid-update"
 * is most of the time.
 *
 * So the digits yield explicitly. The test is deliberately narrow — an
 * EDITABLE screenplay content box has the caret — so the read-only reference
 * pane, the rails, the sidebar and every prose editor are untouched, and ⌘0
 * (zoom reset) and ⌘8/⌘9 (unbound) are untouched too.
 */
function screenplayOwnsDigit(e: KeyboardEvent, t: HTMLElement | null): boolean {
  if (!mod(e) || e.altKey || e.shiftKey) return false;
  if (e.key < "1" || e.key > "7") return false;
  return !!t?.isContentEditable && !!t.closest(".screenplay-editor");
}

export function useGlobalShortcuts(shortcuts: Shortcut[]) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // An editor keymap (e.g. the screenplay ⌘1–7 element commands) that
      // consumed the event wins over global shortcuts.
      if (e.defaultPrevented) return;
      // Skip when typing in an input/editor
      const t = e.target as HTMLElement;
      if (screenplayOwnsDigit(e, t)) return;
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

/**
 * The command modifier. ⌘ on macOS, Ctrl everywhere else — and it accepts
 * EITHER on both, deliberately: a Linux user with a Mac keyboard, and the
 * `?platform=` preview, both want the other one to work rather than to be
 * told it is the wrong desktop. CodeMirror's `Mod-` resolves the same way.
 */
export const mod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;

/**
 * Render a combo the way this desktop writes it.
 *
 * Every combo in the app is authored in the macOS glyphs (`⌘⌥⇧⌃`) because
 * that is what the Swift app shows and what SWIFT-AUDIT quotes. On Linux and
 * Windows those glyphs are meaningless, and the keys genuinely are different
 * ones, so the strings are rewritten at render time rather than duplicated:
 *
 *   ⌘E   → Ctrl+E        ⇧⌘F  → Ctrl+Shift+F
 *   ⌘⌥\  → Ctrl+Alt+\    ⌃⌘O  → Ctrl+O   (⌃ and ⌘ are the same key here, and
 *                                         `mod()` above is satisfied by it)
 *
 * Non-modifier text ("Esc", "[[") passes through untouched.
 */
const MODS: Array<[string, string]> = [
  ["⌘", "Ctrl"], ["⌃", "Ctrl"], ["⌥", "Alt"], ["⇧", "Shift"],
];

export function comboLabel(combo: string): string {
  if (detectPlatform() === "macos") return combo;
  const parts: string[] = [];
  let rest = combo;
  // Modifiers are always a prefix, in whatever order the string wrote them.
  for (;;) {
    const hit = MODS.find(([glyph]) => rest.startsWith(glyph));
    if (!hit) break;
    if (!parts.includes(hit[1])) parts.push(hit[1]);
    rest = rest.slice(hit[0].length);
  }
  if (!parts.length) return combo;
  // Ctrl before Alt before Shift, the order every Linux menu writes.
  const order = ["Ctrl", "Alt", "Shift"];
  parts.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return rest ? [...parts, rest].join("+") : parts.join("+");
}
