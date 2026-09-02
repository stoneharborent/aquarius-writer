//! Workflow-wide text search — a Rust mirror of `searchWorkflow` in
//! `src/lib/vault/aux.ts`.
//!
//! The renderer's Find-in-workflow reads every text file through `invoke` and
//! scans it in JavaScript. That is fine for a human typing in a dialog and
//! wrong for an MCP client, which would have to pull whole files across the
//! wire to find a line. So the same algorithm lives here too, and the two are
//! deliberately identical:
//!
//! * case-insensitive **substring** match, not a regex — a query with `.` or
//!   `*` in it means those characters;
//! * only markdown, fountain and `.txt` files are scanned;
//! * a hit reports the first matching line (0-based) and a trimmed preview,
//!   plus the total number of matches in that file;
//! * results sort by match count, descending.
//!
//! If one side's behaviour changes, change the other in the same commit —
//! the same parity rule `vault::frontmatter` carries.

use super::paths::skip_entry;
use serde::Serialize;
use std::fs;
use std::path::Path;

/// Files larger than this are skipped rather than scanned. Same reasoning as
/// the tree walk's scan ceiling: a 4 MB "chapter" is a pathology.
const MAX_SCAN_BYTES: u64 = 4 * 1024 * 1024;
const MAX_DEPTH: usize = 16;
const PREVIEW_CHARS: usize = 120;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// Vault-relative path of the file the match is in.
    pub path: String,
    /// 0-based index of the first matching line.
    pub line: usize,
    /// That line, trimmed and clipped.
    pub preview: String,
    /// How many times the query occurs in this file.
    pub count: usize,
}

fn is_text(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".fountain")
        || lower.ends_with(".txt")
}

/// Search every text file under `root`. `limit` caps the number of files
/// reported (not the number scanned) so a huge vault can't return a huge
/// payload; pass `usize::MAX` for everything.
pub fn search(root: &Path, query: &str, limit: usize) -> Vec<SearchHit> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    walk(root, root, 0, &needle, &mut hits);
    // Ties keep a stable order so two identical searches agree.
    hits.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.path.cmp(&b.path)));
    hits.truncate(limit);
    hits
}

fn walk(root: &Path, dir: &Path, depth: usize, needle: &str, out: &mut Vec<SearchHit>) {
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        // Not `metadata()`: `file_type()` leaves symlinks unfollowed, so a
        // symlinked `node_modules` is neither dir nor file here and falls out.
        let Ok(ft) = entry.file_type() else { continue };
        if skip_entry(&name, ft.is_dir()) {
            continue;
        }
        if ft.is_dir() {
            walk(root, &path, depth + 1, needle, out);
            continue;
        }
        if !ft.is_file() || !is_text(&name) {
            continue;
        }
        if entry.metadata().map(|m| m.len() > MAX_SCAN_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(body) = fs::read_to_string(&path) else { continue };
        let Some(rel) = super::paths::rel_from_root(root, &path) else { continue };
        if let Some(hit) = scan(&rel, &body, needle) {
            out.push(hit);
        }
    }
}

/// The scan itself, split out so it can be tested without a filesystem.
pub fn scan(rel: &str, body: &str, needle: &str) -> Option<SearchHit> {
    let mut count = 0usize;
    let mut first: Option<(usize, String)> = None;
    for (i, line) in body.split('\n').enumerate() {
        let lower = line.to_lowercase();
        let in_line = lower.matches(needle).count();
        if in_line == 0 {
            continue;
        }
        count += in_line;
        if first.is_none() {
            first = Some((i, line.trim().chars().take(PREVIEW_CHARS).collect()));
        }
    }
    let (line, preview) = first?;
    Some(SearchHit { path: rel.to_string(), line, preview, count })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn counts_every_occurrence_and_reports_the_first_line() {
        let hit = scan("a.md", "nothing\nlantern and lantern\nLantern again", "lantern").unwrap();
        assert_eq!(hit.line, 1);
        assert_eq!(hit.count, 3, "two on line 1, one on line 2, case-insensitively");
        assert_eq!(hit.preview, "lantern and lantern");
    }

    #[test]
    fn a_query_is_a_substring_not_a_regex() {
        assert!(scan("a.md", "the end.", "d.").is_some());
        assert!(scan("a.md", "the end.", "x.").is_none(), "`.` must not match any char");
    }

    #[test]
    fn searches_the_whole_vault_and_ranks_by_count() {
        let t = TempDir::new("search");
        t.write("Drafts/Ch_01.md", "a bell rang\nthe bell again");
        t.write("Drafts/Ch_02.md", "one bell");
        t.write("Episodes/Pilot.fountain", "INT. BELL TOWER");
        t.write("Research/diagram.jpg", "bell bell bell");
        t.write(".aquarius/workflow.json", "{\"bell\":1}");

        let hits = search(t.path(), "bell", usize::MAX);
        let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths, vec!["Drafts/Ch_01.md", "Drafts/Ch_02.md", "Episodes/Pilot.fountain"]);
        assert_eq!(hits[0].count, 2);
        assert!(!paths.iter().any(|p| p.ends_with(".jpg")), "binaries are not scanned");
        assert!(!paths.iter().any(|p| p.starts_with(".aquarius")), "metadata is not scanned");
    }

    #[test]
    fn build_folders_are_not_searched_and_a_symlink_is_not_followed() {
        let t = TempDir::new("search-ignore");
        t.write("Drafts/Ch_01.md", "a bell rang");
        t.write("node_modules/react/README.md", "bell bell bell bell");
        t.write("app/target/debug/notes.md", "bell");
        t.write("Tooling/node_modules.nosync/a/README.md", "bell bell");
        t.write("Scripts/__pycache__/x.md", "bell");
        // The Mac convention this project uses itself: the real folder is
        // `.nosync`, and the name everything else expects is a symlink at it.
        // Following it would scan the same tree twice; a link pointing upwards
        // would not terminate at all.
        #[cfg(unix)]
        std::os::unix::fs::symlink("node_modules.nosync", t.path().join("Tooling/node_modules"))
            .unwrap();

        let hits = search(t.path(), "bell", usize::MAX);
        let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths, vec!["Drafts/Ch_01.md"], "only the writer's own file");
    }

    #[test]
    fn an_empty_query_finds_nothing_and_limit_caps_the_result() {
        let t = TempDir::new("search-limit");
        t.write("a.md", "x");
        t.write("b.md", "x");
        assert!(search(t.path(), "   ", usize::MAX).is_empty());
        assert_eq!(search(t.path(), "x", 1).len(), 1);
    }
}
