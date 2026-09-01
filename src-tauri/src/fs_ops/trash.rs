//! Soft delete — HANDOFF §3's `.aquarius/trash/` with 30-day retention.
//!
//! Deleting in Aquarius moves the file; it never unlinks it. The layout is
//! deliberately readable without the app:
//!
//! ```text
//! .aquarius/trash/
//!   index.json                       ← what was deleted, from where, when
//!   2026-08-25T17-42-03-abc123/      ← one folder per deletion
//!     Drafts/Ch_04.md                ← the file, at its original relative path
//! ```
//!
//! Restore puts the bytes back at the original path.
//!
//! **Nothing in here deletes anything the writer did not ask to delete.**
//! Until 2026-08-31 a sweep ran on every workflow load and unlinked whatever
//! was past 30 days, silently. The Swift app has never done that — it keeps
//! everything until someone confirms "Empty trash" (SWIFT-AUDIT §4) — and of
//! the two behaviors, the one that deletes a writer's chapter while they were
//! only opening a folder is the surprising one. So `RETENTION_DAYS` is now
//! **display only**: the Recently Deleted sheet reads it (over
//! `trash_retention_days`) to mark old rows, and `purge` / `purge_all` are the
//! only two functions in this file that destroy bytes, both reached from a
//! click the writer confirmed.

use super::atomic::write_atomic;
use crate::vault::paths::aq_dir;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// How long a deletion is considered "recent". Nothing acts on this — see the
/// module note. It exists so the sheet can say "kept since August" about a row
/// that has been sitting there a while, and so the number has one home.
pub const RETENTION_DAYS: i64 = 30;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashRecord {
    pub id: String,
    /// Original vault-relative path.
    pub path: String,
    /// Epoch milliseconds.
    pub deleted_at: i64,
    /// Folder name under `trash/` holding the payload.
    pub stored_as: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrashIndex {
    #[serde(default)]
    pub entries: Vec<TrashRecord>,
}

pub fn trash_dir(root: &Path) -> PathBuf {
    aq_dir(root).join("trash")
}

pub fn index_path(root: &Path) -> PathBuf {
    trash_dir(root).join("index.json")
}

pub fn read_index(root: &Path) -> TrashIndex {
    fs::read_to_string(index_path(root))
        .ok()
        .and_then(|t| serde_json::from_str::<TrashIndex>(&t).ok())
        .unwrap_or_default()
}

pub fn write_index(root: &Path, index: &TrashIndex) -> std::io::Result<()> {
    fs::create_dir_all(trash_dir(root))?;
    let json = serde_json::to_string_pretty(index).map_err(std::io::Error::other)?;
    write_atomic(&index_path(root), format!("{json}\n").as_bytes())?;
    Ok(())
}

/// Move `rel` into the trash. Returns the record written to the index.
pub fn soft_delete(root: &Path, rel: &str, now_ms: i64) -> std::io::Result<TrashRecord> {
    let source = crate::vault::paths::resolve_in_root(root, rel)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e.0))?;
    if !source.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("nothing to delete at {rel}"),
        ));
    }

    let stored_as = format!("{}-{}", stamp(now_ms), short_id());
    let dest = trash_dir(root).join(&stored_as).join(rel);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }

    // Rename when we can (instant, preserves bytes exactly); fall back to
    // copy+remove when the trash lands on a different filesystem.
    if fs::rename(&source, &dest).is_err() {
        if source.is_dir() {
            copy_dir(&source, &dest)?;
            fs::remove_dir_all(&source)?;
        } else {
            fs::copy(&source, &dest)?;
            fs::remove_file(&source)?;
        }
    }

    let record = TrashRecord {
        id: format!("t{}", short_id()),
        path: rel.to_string(),
        deleted_at: now_ms,
        stored_as,
    };
    let mut index = read_index(root);
    index.entries.insert(0, record.clone());
    write_index(root, &index)?;
    Ok(record)
}

/// Move a trashed file back to where it came from. Returns its relative path.
pub fn restore(root: &Path, id: &str) -> std::io::Result<Option<String>> {
    let mut index = read_index(root);
    let Some(pos) = index.entries.iter().position(|e| e.id == id) else { return Ok(None) };
    let record = index.entries[pos].clone();
    let stored = trash_dir(root).join(&record.stored_as).join(&record.path);
    let dest = crate::vault::paths::resolve_in_root(root, &record.path)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e.0))?;

    if stored.exists() {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        if fs::rename(&stored, &dest).is_err() {
            fs::copy(&stored, &dest)?;
            fs::remove_file(&stored)?;
        }
    }
    let _ = fs::remove_dir_all(trash_dir(root).join(&record.stored_as));
    index.entries.remove(pos);
    write_index(root, &index)?;
    Ok(Some(record.path))
}

/// Delete a trashed file for good.
pub fn purge(root: &Path, id: &str) -> std::io::Result<()> {
    let mut index = read_index(root);
    if let Some(pos) = index.entries.iter().position(|e| e.id == id) {
        let record = index.entries.remove(pos);
        let _ = fs::remove_dir_all(trash_dir(root).join(&record.stored_as));
        write_index(root, &index)?;
    }
    Ok(())
}

/// Empty the whole trash. The one bulk destruction in the app, and it is only
/// ever reached from a confirmed click in Recently Deleted. Returns how many
/// deletions were destroyed.
///
/// The index is rewritten *after* the payload folders are gone, so a crash
/// half way through leaves rows that still point at something (restorable, or
/// at worst empty) rather than orphaned folders no UI can reach.
pub fn purge_all(root: &Path) -> std::io::Result<usize> {
    let index = read_index(root);
    if index.entries.is_empty() {
        return Ok(0);
    }
    for record in &index.entries {
        let _ = fs::remove_dir_all(trash_dir(root).join(&record.stored_as));
    }
    let n = index.entries.len();
    write_index(root, &TrashIndex::default())?;
    Ok(n)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)?.filter_map(Result::ok) {
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Local time, matching the snapshot folders — a writer looking in `trash/`
/// should see the hour they actually deleted something.
fn stamp(now_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(now_ms)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%dT%H-%M-%S").to_string())
        .unwrap_or_else(|| "unknown-time".into())
}

fn short_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    const DAY_MS: i64 = 24 * 60 * 60 * 1000;

    fn now() -> i64 {
        crate::vault::registry::now_ms()
    }

    #[test]
    fn moves_the_file_into_trash_and_records_it() {
        let t = TempDir::new("trash-move");
        t.write("Drafts/Ch_04.md", "the long echo");
        let rec = soft_delete(t.path(), "Drafts/Ch_04.md", now()).unwrap();

        assert!(!t.path().join("Drafts/Ch_04.md").exists(), "original is gone");
        let stored = trash_dir(t.path()).join(&rec.stored_as).join("Drafts/Ch_04.md");
        assert_eq!(fs::read_to_string(&stored).unwrap(), "the long echo",
            "bytes are preserved at the original relative path inside the trash");

        let index = read_index(t.path());
        assert_eq!(index.entries.len(), 1);
        assert_eq!(index.entries[0].path, "Drafts/Ch_04.md");
    }

    #[test]
    fn restores_to_the_original_path() {
        let t = TempDir::new("trash-restore");
        t.write("Characters/Imogen.md", "niece of Sennet");
        let rec = soft_delete(t.path(), "Characters/Imogen.md", now()).unwrap();

        let restored = restore(t.path(), &rec.id).unwrap();
        assert_eq!(restored.as_deref(), Some("Characters/Imogen.md"));
        assert_eq!(
            fs::read_to_string(t.path().join("Characters/Imogen.md")).unwrap(),
            "niece of Sennet"
        );
        assert!(read_index(t.path()).entries.is_empty());
        assert!(!trash_dir(t.path()).join(&rec.stored_as).exists(), "payload folder is cleaned up");
    }

    #[test]
    fn purge_removes_the_payload_for_good() {
        let t = TempDir::new("trash-purge");
        t.write("note.md", "x");
        let rec = soft_delete(t.path(), "note.md", now()).unwrap();
        purge(t.path(), &rec.id).unwrap();
        assert!(read_index(t.path()).entries.is_empty());
        assert!(!trash_dir(t.path()).join(&rec.stored_as).exists());
    }

    /// The behavior this file used to have, inverted. Nothing expires on its
    /// own any more: a deletion from last year is still there, still
    /// restorable, and only *marked* as past its window.
    #[test]
    fn age_alone_never_destroys_a_deletion() {
        let t = TempDir::new("trash-no-sweep");
        t.write("old.md", "old");
        t.write("recent.md", "recent");
        let now = now();
        let old = soft_delete(t.path(), "old.md", now - 400 * DAY_MS).unwrap();
        let recent = soft_delete(t.path(), "recent.md", now - 29 * DAY_MS).unwrap();

        // Reading the index — which is all opening a workflow does now — must
        // leave both payloads exactly where they were.
        let index = read_index(t.path());
        assert_eq!(index.entries.len(), 2, "nothing was dropped from the index");
        assert!(trash_dir(t.path()).join(&old.stored_as).exists(),
            "a year-old deletion is still on disk — only a confirmed empty removes it");
        assert!(trash_dir(t.path()).join(&recent.stored_as).exists());

        assert_eq!(restore(t.path(), &old.id).unwrap().as_deref(), Some("old.md"),
            "and it is still restorable");
    }

    /// The number is display-only now, so it can only be changed on purpose.
    #[test]
    fn the_retention_window_is_thirty_days() {
        assert_eq!(RETENTION_DAYS, 30);
    }

    #[test]
    fn empty_trash_destroys_everything_and_only_when_asked() {
        let t = TempDir::new("trash-empty");
        t.write("a.md", "a");
        t.write("b.md", "b");
        let now = now();
        let a = soft_delete(t.path(), "a.md", now).unwrap();
        let b = soft_delete(t.path(), "b.md", now - 90 * DAY_MS).unwrap();

        assert_eq!(purge_all(t.path()).unwrap(), 2);
        assert!(read_index(t.path()).entries.is_empty());
        assert!(!trash_dir(t.path()).join(&a.stored_as).exists());
        assert!(!trash_dir(t.path()).join(&b.stored_as).exists());
        assert_eq!(purge_all(t.path()).unwrap(), 0, "emptying an empty trash is a no-op");
    }

    #[test]
    fn deleting_a_missing_file_is_an_error_not_a_silent_success() {
        let t = TempDir::new("trash-missing");
        assert!(soft_delete(t.path(), "nope.md", now()).is_err());
    }

    #[test]
    fn refuses_to_delete_outside_the_vault() {
        let t = TempDir::new("trash-escape");
        assert!(soft_delete(t.path(), "../outside.md", now()).is_err());
    }
}
