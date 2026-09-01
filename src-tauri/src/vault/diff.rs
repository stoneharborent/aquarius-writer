//! A line diff, for telling a model what changed between two versions.
//!
//! `diff_version` is the one MCP tool whose whole output is *prose about a
//! change*, so the shape here is chosen for reading rather than for patching:
//! counts first, then the hunks, each one a run of removed lines followed by a
//! run of added lines with the line numbers they sat at. There is no unified
//! diff header, no context lines and no rename detection — a client that wants
//! the full text of either side already has `read_snapshot` and
//! `read_document`.
//!
//! Two limits are deliberate and both are reported in the result rather than
//! being silent:
//!
//! * **`approximate`** — the LCS table is quadratic, so two very large
//!   documents (past `MAX_CELLS`) are reported as one wholesale replacement of
//!   the middle instead of being matched line by line. The counts stay honest;
//!   the alignment is the thing that is lost.
//! * **`truncated`** — a diff with hundreds of scattered changes is not worth
//!   pouring into a model's context, so the hunk list stops at `MAX_HUNKS` and
//!   each side of a hunk stops at `MAX_HUNK_LINES`. The counts above it still
//!   describe the whole diff.

use serde::Serialize;

/// Past this many `old × new` cells the line-by-line match is skipped. 1M
/// cells is ~4MB of `u32` — a 1,000-line rewrite of a 1,000-line chapter,
/// which is far more than any real revision.
const MAX_CELLS: usize = 1_000_000;
const MAX_HUNKS: usize = 60;
const MAX_HUNK_LINES: usize = 40;

/// One run of change: the lines that went, and the lines that came.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// 1-based line in the old text where the removal starts. When nothing was
    /// removed this is where the insertion landed.
    pub old_line: usize,
    /// 1-based line in the new text where the addition starts.
    pub new_line: usize,
    pub removed: Vec<String>,
    pub added: Vec<String>,
    /// True when this hunk's `removed`/`added` lists were cut short.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub clipped: bool,
}

/// The whole comparison.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineDiff {
    pub added: usize,
    pub removed: usize,
    pub unchanged: usize,
    /// True when the two texts are identical.
    pub identical: bool,
    pub hunks: Vec<Hunk>,
    /// True when `hunks` does not list every change (the counts still do).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// True when the documents were too large to align line by line, so the
    /// middle is reported as one replacement.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub approximate: bool,
}

/// Compare two texts line by line.
pub fn diff(old: &str, new: &str) -> LineDiff {
    if old == new {
        let n = old.split('\n').count();
        return LineDiff {
            added: 0,
            removed: 0,
            unchanged: n,
            identical: true,
            hunks: Vec::new(),
            truncated: false,
            approximate: false,
        };
    }

    let a: Vec<&str> = old.split('\n').collect();
    let b: Vec<&str> = new.split('\n').collect();

    // Identical head and tail are the common case in a writing app — one
    // paragraph changed in a chapter — and trimming them is what keeps the
    // quadratic middle small enough to matter.
    let mut head = 0usize;
    while head < a.len() && head < b.len() && a[head] == b[head] {
        head += 1;
    }
    let mut tail = 0usize;
    while tail < a.len() - head && tail < b.len() - head && a[a.len() - 1 - tail] == b[b.len() - 1 - tail]
    {
        tail += 1;
    }
    let a_mid = &a[head..a.len() - tail];
    let b_mid = &b[head..b.len() - tail];

    let approximate = a_mid.len().saturating_mul(b_mid.len()) > MAX_CELLS;
    let ops = if approximate {
        // One wholesale replacement rather than a table we cannot afford.
        vec![(a_mid.len(), b_mid.len())]
    } else {
        align(a_mid, b_mid)
    };

    let mut hunks: Vec<Hunk> = Vec::new();
    let mut added = 0usize;
    let mut removed = 0usize;
    let mut unchanged = head + tail;
    let mut ai = head;
    let mut bi = head;
    let mut truncated = false;

    for (del, ins) in ops {
        // `(0, 0)` is the aligner's way of saying "one line matched".
        if del == 0 && ins == 0 {
            ai += 1;
            bi += 1;
            unchanged += 1;
            continue;
        }
        removed += del;
        added += ins;
        if hunks.len() < MAX_HUNKS {
            let take_del = del.min(MAX_HUNK_LINES);
            let take_ins = ins.min(MAX_HUNK_LINES);
            hunks.push(Hunk {
                old_line: ai + 1,
                new_line: bi + 1,
                removed: a[ai..ai + take_del].iter().map(|s| s.to_string()).collect(),
                added: b[bi..bi + take_ins].iter().map(|s| s.to_string()).collect(),
                clipped: take_del < del || take_ins < ins,
            });
        } else {
            truncated = true;
        }
        ai += del;
        bi += ins;
    }

    LineDiff { added, removed, unchanged, identical: false, hunks, truncated, approximate }
}

/// Align two line slices, returning `(removed, added)` pairs in order, with a
/// `(0, 0)` entry standing for a run of matched lines.
///
/// This walks a classic LCS table. The pairs are what the caller needs — it
/// tracks its own cursors — and building them here keeps the table's lifetime
/// inside this function.
fn align(a: &[&str], b: &[&str]) -> Vec<(usize, usize)> {
    let n = a.len();
    let m = b.len();
    if n == 0 || m == 0 {
        return vec![(n, m)];
    }

    let mut table = vec![0u32; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[at(i, j)] = if a[i] == b[j] {
                table[at(i + 1, j + 1)] + 1
            } else {
                table[at(i + 1, j)].max(table[at(i, j + 1)])
            };
        }
    }

    let mut out: Vec<(usize, usize)> = Vec::new();
    fn push(del: usize, ins: usize, out: &mut Vec<(usize, usize)>) {
        if del > 0 || ins > 0 {
            out.push((del, ins));
        }
    }

    let (mut i, mut j) = (0usize, 0usize);
    let (mut del, mut ins) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            push(del, ins, &mut out);
            del = 0;
            ins = 0;
            out.push((0, 0));
            i += 1;
            j += 1;
        } else if table[at(i + 1, j)] >= table[at(i, j + 1)] {
            del += 1;
            i += 1;
        } else {
            ins += 1;
            j += 1;
        }
    }
    del += n - i;
    ins += m - j;
    push(del, ins, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_text_is_reported_as_identical() {
        let d = diff("one\ntwo\nthree", "one\ntwo\nthree");
        assert!(d.identical);
        assert_eq!((d.added, d.removed, d.unchanged), (0, 0, 3));
        assert!(d.hunks.is_empty());
    }

    #[test]
    fn one_changed_line_in_the_middle_is_one_hunk() {
        let d = diff("one\ntwo\nthree", "one\nTWO\nthree");
        assert!(!d.identical);
        assert_eq!((d.added, d.removed, d.unchanged), (1, 1, 2));
        assert_eq!(d.hunks.len(), 1);
        assert_eq!(d.hunks[0].old_line, 2);
        assert_eq!(d.hunks[0].new_line, 2);
        assert_eq!(d.hunks[0].removed, vec!["two"]);
        assert_eq!(d.hunks[0].added, vec!["TWO"]);
    }

    #[test]
    fn a_pure_insertion_removes_nothing() {
        let d = diff("one\nthree", "one\ntwo\nthree");
        assert_eq!((d.added, d.removed, d.unchanged), (1, 0, 2));
        assert_eq!(d.hunks.len(), 1);
        assert!(d.hunks[0].removed.is_empty());
        assert_eq!(d.hunks[0].added, vec!["two"]);
        assert_eq!(d.hunks[0].old_line, 2, "it went in ahead of the old line 2");
    }

    #[test]
    fn a_pure_deletion_adds_nothing() {
        let d = diff("one\ntwo\nthree", "one\nthree");
        assert_eq!((d.added, d.removed, d.unchanged), (0, 1, 2));
        assert_eq!(d.hunks[0].removed, vec!["two"]);
        assert!(d.hunks[0].added.is_empty());
    }

    #[test]
    fn two_separate_edits_are_two_hunks_in_order() {
        let d = diff("a\nb\nc\nd\ne", "a\nB\nc\nd\nE");
        assert_eq!(d.hunks.len(), 2);
        assert_eq!(d.hunks[0].old_line, 2);
        assert_eq!(d.hunks[1].old_line, 5);
        assert_eq!((d.added, d.removed, d.unchanged), (2, 2, 3));
    }

    #[test]
    fn everything_replaced_is_one_hunk_and_no_matches() {
        let d = diff("one\ntwo", "alpha\nbeta\ngamma");
        assert_eq!((d.added, d.removed, d.unchanged), (3, 2, 0));
        assert_eq!(d.hunks.len(), 1);
    }

    #[test]
    fn an_empty_side_is_not_a_panic() {
        let grew = diff("", "one\ntwo");
        assert_eq!(grew.added, 2);
        // "" splits into one empty line, which is a real removal.
        assert_eq!(grew.removed, 1);

        let emptied = diff("one\ntwo", "");
        assert_eq!(emptied.removed, 2);
        assert_eq!(emptied.added, 1);
    }

    #[test]
    fn the_hunk_list_is_capped_but_the_counts_are_not() {
        // 200 scattered single-line edits: more hunks than anyone wants read
        // back to them, and the totals still have to be right.
        let old: Vec<String> = (0..400).map(|i| format!("line {i}")).collect();
        let new: Vec<String> = (0..400)
            .map(|i| if i % 2 == 0 { format!("line {i}") } else { format!("CHANGED {i}") })
            .collect();
        let d = diff(&old.join("\n"), &new.join("\n"));
        assert_eq!(d.added, 200);
        assert_eq!(d.removed, 200);
        assert_eq!(d.unchanged, 200);
        assert!(d.truncated);
        assert_eq!(d.hunks.len(), MAX_HUNKS);
    }

    #[test]
    fn a_long_hunk_is_clipped_and_says_so() {
        let old = "head\n".to_string() + &(0..100).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let new = "head\nreplaced".to_string();
        let d = diff(&old, &new);
        assert_eq!(d.removed, 100);
        assert_eq!(d.hunks[0].removed.len(), MAX_HUNK_LINES);
        assert!(d.hunks[0].clipped);
    }

    #[test]
    fn very_large_documents_fall_back_to_a_coarse_answer() {
        let old: Vec<String> = (0..1200).map(|i| format!("old {i}")).collect();
        let new: Vec<String> = (0..1200).map(|i| format!("new {i}")).collect();
        let d = diff(&old.join("\n"), &new.join("\n"));
        assert!(d.approximate, "1200 × 1200 is past the table budget");
        assert_eq!((d.added, d.removed), (1200, 1200));
        assert_eq!(d.hunks.len(), 1);
    }
}
