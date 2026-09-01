import { useEffect, useState } from "react";

/**
 * A settled copy of a string that changes on every keystroke.
 *
 * The rule from docs/NOTES.md §27k — "if the work is O(document), it belongs
 * behind `docChanged`" — has a sibling on the React side: **if the work is
 * O(document) and its result cannot visibly change mid-word, it does not
 * belong inside the keystroke at all.** A word count, a page count and a scene
 * rail are all of that kind. Recomputing them in the render that a keypress
 * triggers puts a full scan of the document on the typing path, which is what
 * made a ninety-page screenplay cost 6ms per character before paint (§27l).
 *
 * 150ms is chosen to sit under the 800ms autosave debounce, so every derived
 * number is settled well before a save records it, and above a fast typist's
 * inter-key gap (~120ms at 100wpm) so a burst of typing collapses to one
 * recompute rather than one per character.
 */
export const SETTLE_MS = 150;

export function useDeferredText(value: string, ms: number = SETTLE_MS): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === settled) return;
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, settled, ms]);
  return settled;
}
