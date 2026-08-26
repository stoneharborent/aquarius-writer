//! Vault operations that more than one caller needs.
//!
//! `commands.rs` is the renderer's door and `mcp/` is the AI client's door.
//! Anything both doors can open lives here, once, so the two can never drift:
//! same path checks, same atomic writes, same self-write ledger stamping.
//!
//! Everything in this module takes a `root: &Path` and a `&SelfWrites` rather
//! than Tauri's `AppState`, which is what lets `cargo test` drive it against a
//! `TempDir` with no app running.
//!
//! **The ledger rule.** Every function here that writes into a vault stamps the
//! path with `SelfWrites::record` *before* the write. Without that the watcher
//! reports the app's own save as an external edit and the tree reloads on a
//! loop (docs/NOTES.md §3c). Notifying the UI that an MCP client changed
//! something is a separate, deliberate act — `mcp` emits `vault://changed`
//! itself, exactly once, instead of letting the watcher guess.

use crate::fs_ops::atomic::{write_atomic, WriteOutcome};
use crate::fs_ops::watcher::SelfWrites;
use crate::model::Workflow;
use crate::vault::{frontmatter, paths, workflow};
use serde::Serialize;
use std::path::{Path, PathBuf};

pub type OpResult<T> = Result<T, String>;

fn resolve(root: &Path, rel: &str) -> OpResult<PathBuf> {
    paths::resolve_in_root(root, rel).map_err(|e| e.0)
}

// ── reading ──────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRead {
    pub path: String,
    /// The file exactly as it sits on disk, frontmatter included.
    pub content: String,
    /// The body with the frontmatter block removed.
    pub body: String,
    /// Parsed frontmatter keys, empty when the file has none.
    pub frontmatter: std::collections::BTreeMap<String, serde_json::Value>,
    pub words: usize,
}

pub fn read_document(root: &Path, rel: &str) -> OpResult<DocumentRead> {
    let path = resolve(root, rel)?;
    if !path.is_file() {
        return Err(format!("no document at {rel}"));
    }
    let content = crate::fs_ops::read_text(&path).map_err(|e| format!("{rel}: {e}"))?;
    let parsed = frontmatter::parse(&content);
    Ok(DocumentRead {
        path: rel.to_string(),
        words: frontmatter::count_words(&parsed.body),
        body: parsed.body,
        frontmatter: parsed.frontmatter,
        content,
    })
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
    /// "folder" | "markdown" | "fountain" | "image" | "pdf" | "other"
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<usize>,
}

/// One level of a folder. `rel` is "" for the vault root.
pub fn list_folder(root: &Path, rel: &str) -> OpResult<Vec<FolderEntry>> {
    let dir = if rel.is_empty() { root.to_path_buf() } else { resolve(root, rel)? };
    if !dir.is_dir() {
        return Err(format!("no folder at {}", if rel.is_empty() { "the vault root" } else { rel }));
    }
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("{rel}: {e}"))?;
    let mut out = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == paths::AQ_DIR || paths::is_ignored_name(&name) {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        let Some(path) = paths::rel_from_root(root, &entry.path()) else { continue };
        if ft.is_dir() {
            out.push(FolderEntry { name, path, kind: "folder".into(), words: None });
        } else if ft.is_file() {
            let kind = crate::vault::tree::kind_for(&name);
            let words = (kind == "markdown" || kind == "fountain")
                .then(|| {
                    std::fs::read_to_string(entry.path())
                        .map(|t| frontmatter::count_words(&frontmatter::parse(&t).body))
                        .unwrap_or(0)
                });
            out.push(FolderEntry { name, path, kind: kind.into(), words });
        }
    }
    out.sort_by(|a, b| {
        let a_dir = a.kind == "folder";
        let b_dir = b.kind == "folder";
        b_dir.cmp(&a_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

// ── writing ──────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WriteReport {
    pub path: String,
    /// False when the bytes were already identical and the file was left
    /// completely alone — mtime included.
    pub changed: bool,
    pub bytes: usize,
}

/// Replace a document's whole content. Creates parent folders if needed.
pub fn write_document(
    root: &Path,
    rel: &str,
    content: &str,
    self_writes: &SelfWrites,
) -> OpResult<WriteReport> {
    let path = resolve(root, rel)?;
    self_writes.record(&path);
    let outcome = write_atomic(&path, content.as_bytes()).map_err(|e| format!("{rel}: {e}"))?;
    Ok(WriteReport {
        path: rel.to_string(),
        changed: outcome == WriteOutcome::Written,
        bytes: content.len(),
    })
}

/// Extensions a document may have. Anything else is almost certainly a mistake
/// on the caller's side (an MCP client inventing `.docx`, say), and a vault of
/// stray files is worse than a refused call.
pub const DOCUMENT_EXTENSIONS: &[&str] = &["md", "markdown", "fountain", "txt"];

/// Create a document that does not exist yet.
///
/// Refuses to overwrite: an existing path is an error, not a silent replace.
/// That is the whole difference from `write_document`, and it matters most for
/// a caller that cannot see the folder it is writing into.
pub fn create_document(
    root: &Path,
    rel: &str,
    content: &str,
    self_writes: &SelfWrites,
) -> OpResult<WriteReport> {
    let path = resolve(root, rel)?;
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !DOCUMENT_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "{rel}: a document must end in one of {} — got {}",
            DOCUMENT_EXTENSIONS.join(", "),
            if ext.is_empty() { "no extension".into() } else { format!(".{ext}") }
        ));
    }
    if let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) {
        if paths::is_ignored_name(&name) {
            return Err(format!("{rel}: that name is reserved for app temporaries"));
        }
    }
    if path.exists() {
        return Err(format!("{rel} already exists — use write_document to replace it"));
    }
    self_writes.record(&path);
    write_atomic(&path, content.as_bytes()).map_err(|e| format!("{rel}: {e}"))?;
    Ok(WriteReport { path: rel.to_string(), changed: true, bytes: content.len() })
}

/// Set (or add) one frontmatter key on a document.
///
/// Everything else in the file survives byte for byte — see
/// `vault::frontmatter::upsert`.
pub fn set_frontmatter(
    root: &Path,
    rel: &str,
    key: &str,
    value: &str,
    self_writes: &SelfWrites,
) -> OpResult<WriteReport> {
    let doc = read_document(root, rel)?;
    let next = frontmatter::upsert(&doc.content, key, value);
    write_document(root, rel, &next, self_writes)
}

/// Statuses the UI knows how to paint (`ChapterStatus` in `src/types/vault.ts`).
/// A status outside this set would render as an unstyled chip, so it is refused
/// rather than written.
pub const CHAPTER_STATUSES: &[&str] = &["final", "drafting", "rev", "outline"];

pub fn set_status(
    root: &Path,
    rel: &str,
    status: &str,
    self_writes: &SelfWrites,
) -> OpResult<WriteReport> {
    if !CHAPTER_STATUSES.contains(&status) {
        return Err(format!(
            "unknown status \"{status}\" — expected one of {}",
            CHAPTER_STATUSES.join(", ")
        ));
    }
    set_frontmatter(root, rel, "status", status, self_writes)
}

// ── chapter order ────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReorderReport {
    pub manuscript_id: String,
    pub order: Vec<String>,
}

/// Rewrite a manuscript's chapter order in `.aquarius/workflow.json`.
///
/// The new order must be a permutation of the current one: every path present
/// exactly once, nothing invented, nothing dropped. Reordering is a rearrange,
/// and a caller that meant to add or remove a chapter should create or trash
/// the file instead — this refuses rather than silently doing half of it.
///
/// Drafts whose order mirrored the manuscript follow it, the same rule
/// `workflow::reconcile_chapter_order` uses.
pub fn reorder_chapters(
    root: &Path,
    manuscript_id: Option<&str>,
    order: &[String],
    self_writes: &SelfWrites,
) -> OpResult<ReorderReport> {
    let (mut wf, _) = workflow::read_or_create(root).map_err(|e| e.to_string())?;
    if wf.manuscripts.is_empty() {
        return Err("this workflow has no manuscript to reorder".into());
    }
    let idx = match manuscript_id {
        Some(id) => wf
            .manuscripts
            .iter()
            .position(|m| m.id == id)
            .ok_or_else(|| format!("unknown manuscript: {id}"))?,
        None => 0,
    };

    let current = wf.manuscripts[idx].chapter_order.clone();
    let mut a = current.clone();
    let mut b = order.to_vec();
    a.sort();
    b.sort();
    if a != b {
        let missing: Vec<&String> = current.iter().filter(|p| !order.contains(p)).collect();
        let extra: Vec<&String> = order.iter().filter(|p| !current.contains(p)).collect();
        return Err(format!(
            "the new order must be a permutation of the current {} chapters (missing: {missing:?}, unknown: {extra:?})",
            current.len()
        ));
    }

    let old = current;
    wf.manuscripts[idx].chapter_order = order.to_vec();
    for draft in wf.drafts.iter_mut() {
        if draft.chapter_order == old {
            draft.chapter_order = order.to_vec();
        }
    }
    save_workflow(root, &wf, self_writes)?;
    Ok(ReorderReport {
        manuscript_id: wf.manuscripts[idx].id.clone(),
        order: order.to_vec(),
    })
}

/// Write `workflow.json`, stamping the ledger first.
pub fn save_workflow(root: &Path, wf: &Workflow, self_writes: &SelfWrites) -> OpResult<()> {
    self_writes.record(&workflow::workflow_json_path(root));
    workflow::save(root, wf).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn sw() -> SelfWrites {
        SelfWrites::default()
    }

    #[test]
    fn reads_a_document_with_and_without_frontmatter() {
        let t = TempDir::new("ops-read");
        t.write("Drafts/Ch_01.md", "---\nstatus: drafting\n---\n\none two three");
        t.write("Notes/plain.md", "four five");

        let ch1 = read_document(t.path(), "Drafts/Ch_01.md").unwrap();
        assert_eq!(ch1.words, 3);
        assert_eq!(ch1.body, "one two three");
        assert_eq!(ch1.frontmatter.get("status").unwrap(), "drafting");
        assert!(ch1.content.starts_with("---"), "content is the raw file");

        let plain = read_document(t.path(), "Notes/plain.md").unwrap();
        assert!(plain.frontmatter.is_empty());
        assert_eq!(plain.words, 2);

        assert!(read_document(t.path(), "Notes/nope.md").is_err());
        assert!(read_document(t.path(), "../escape.md").is_err());
    }

    #[test]
    fn lists_one_level_folders_first() {
        let t = TempDir::new("ops-list");
        t.write("Drafts/Ch_01.md", "a b");
        t.write("zebra.md", "x");
        t.write("Art/cover.png", "png");
        t.write(".aquarius/workflow.json", "{}");
        t.write(".DS_Store", "junk");

        let top = list_folder(t.path(), "").unwrap();
        let names: Vec<&str> = top.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Art", "Drafts", "zebra.md"]);
        assert_eq!(top[2].kind, "markdown");
        assert_eq!(top[2].words, Some(1));

        let drafts = list_folder(t.path(), "Drafts").unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].path, "Drafts/Ch_01.md");
        assert!(list_folder(t.path(), "Nope").is_err());
    }

    #[test]
    fn writing_stamps_the_ledger_before_it_touches_disk() {
        let t = TempDir::new("ops-write");
        t.write("Drafts/Ch_01.md", "before");
        let writes = sw();

        let r = write_document(t.path(), "Drafts/Ch_01.md", "after", &writes).unwrap();
        assert!(r.changed);
        assert!(
            writes.is_own(&t.path().join("Drafts/Ch_01.md")),
            "an unstamped write would make the watcher reload the tree forever"
        );
        assert_eq!(std::fs::read_to_string(t.path().join("Drafts/Ch_01.md")).unwrap(), "after");

        // Byte-identical content is not a write at all.
        let again = write_document(t.path(), "Drafts/Ch_01.md", "after", &writes).unwrap();
        assert!(!again.changed);
    }

    #[test]
    fn create_refuses_to_overwrite_and_checks_the_extension() {
        let t = TempDir::new("ops-create");
        let writes = sw();

        let made = create_document(t.path(), "Drafts/Ch_09.md", "# New\n", &writes).unwrap();
        assert!(made.changed);
        assert_eq!(std::fs::read_to_string(t.path().join("Drafts/Ch_09.md")).unwrap(), "# New\n");
        assert!(writes.is_own(&t.path().join("Drafts/Ch_09.md")));

        let dup = create_document(t.path(), "Drafts/Ch_09.md", "x", &writes).unwrap_err();
        assert!(dup.contains("already exists"), "got {dup}");

        assert!(create_document(t.path(), "Drafts/Ch_10.docx", "x", &writes).is_err());
        assert!(create_document(t.path(), "Drafts/Ch_10", "x", &writes).is_err());
        assert!(create_document(t.path(), "../outside.md", "x", &writes).is_err());
        assert!(create_document(t.path(), "Drafts/.hidden.md", "x", &writes).is_err());
    }

    #[test]
    fn creating_a_fountain_file_is_allowed() {
        let t = TempDir::new("ops-create-fountain");
        assert!(create_document(t.path(), "Episodes/Pilot.fountain", "INT.", &sw()).is_ok());
    }

    #[test]
    fn set_status_writes_the_key_and_refuses_unknown_values() {
        let t = TempDir::new("ops-status");
        t.write("Drafts/Ch_01.md", "---\ntitle: One\nstatus: drafting\n---\n\nbody\n");
        let writes = sw();

        set_status(t.path(), "Drafts/Ch_01.md", "final", &writes).unwrap();
        assert_eq!(
            std::fs::read_to_string(t.path().join("Drafts/Ch_01.md")).unwrap(),
            "---\ntitle: One\nstatus: final\n---\n\nbody\n"
        );

        let bad = set_status(t.path(), "Drafts/Ch_01.md", "sparkling", &writes).unwrap_err();
        assert!(bad.contains("unknown status"), "got {bad}");
    }

    #[test]
    fn reorder_requires_a_permutation_and_persists_it() {
        let t = TempDir::new("ops-reorder");
        t.write("Drafts/Ch_01.md", "a");
        t.write("Drafts/Ch_02.md", "b");
        t.write("Drafts/Ch_03.md", "c");
        let writes = sw();
        let (wf, _) = workflow::read_or_create(t.path()).unwrap();
        assert_eq!(wf.manuscripts[0].chapter_order.len(), 3);

        let next = vec![
            "Drafts/Ch_03.md".to_string(),
            "Drafts/Ch_01.md".to_string(),
            "Drafts/Ch_02.md".to_string(),
        ];
        let report = reorder_chapters(t.path(), None, &next, &writes).unwrap();
        assert_eq!(report.order, next);

        let (again, _) = workflow::read_or_create(t.path()).unwrap();
        assert_eq!(again.manuscripts[0].chapter_order, next, "the order survived the round trip");
        assert_eq!(again.drafts[0].chapter_order, next, "the mirroring draft followed it");
        assert!(writes.is_own(&workflow::workflow_json_path(t.path())));

        // Dropping a chapter, inventing one, or naming a missing manuscript.
        assert!(reorder_chapters(t.path(), None, &next[..2], &writes).is_err());
        let invented = vec!["Drafts/Ch_99.md".to_string()];
        assert!(reorder_chapters(t.path(), None, &invented, &writes).is_err());
        assert!(reorder_chapters(t.path(), Some("nope"), &next, &writes).is_err());
    }
}
