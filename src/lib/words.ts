/**
 * How Aquarius counts words. One definition, shared.
 *
 * Runs of non-whitespace, which is what `EditorFooterStats.swift` does and what
 * the Rust side's `split_whitespace().count()` does. It matters that this is
 * *one* function rather than three near-identical ones: the footer's number,
 * the version trail's `words` and the Today panel's daily total are all the
 * same claim about the same text, and a writer who saw them disagree would be
 * right to stop trusting all three.
 *
 * Count the document's **body** — the text without its frontmatter block —
 * everywhere. Counting the raw file would make a chapter gain words when its
 * status chip changed.
 */
export function countWords(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}
