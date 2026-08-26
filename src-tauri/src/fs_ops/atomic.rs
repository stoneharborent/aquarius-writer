//! Saving a file without ever losing one.
//!
//! Two rules, both from the product contract:
//!
//! 1. **Atomic.** Write a temp file in the *same directory* (same filesystem,
//!    so `rename` is atomic), then rename over the target. A crash mid-save
//!    leaves either the old file or the new one — never a half-written one.
//! 2. **Byte-for-byte.** If the new content equals what is already on disk, we
//!    do not touch the file at all. No rewrite, no new mtime, no reformatting.
//!    This is what guarantees a file with no frontmatter never gains one just
//!    because the app opened it.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Prefix for our in-place temporaries. The watcher ignores anything starting
/// with it, so an atomic save never looks like an external edit.
pub const TMP_PREFIX: &str = ".aq-tmp-";

#[derive(Debug, PartialEq, Eq)]
pub enum WriteOutcome {
    /// Bytes were identical — the file was left completely alone.
    Unchanged,
    /// The file was replaced (or created) atomically.
    Written,
}

/// Write `bytes` to `target`, atomically, skipping the write when nothing
/// changed. Creates parent directories as needed.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<WriteOutcome> {
    if let Ok(existing) = fs::read(target) {
        if existing == bytes {
            return Ok(WriteOutcome::Unchanged);
        }
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = temp_sibling(target);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        // Flush to the device before the rename, so the rename can't publish an
        // empty file if the machine loses power right after it.
        f.sync_all()?;
    }
    match fs::rename(&tmp, target) {
        Ok(()) => Ok(WriteOutcome::Written),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// A unique sibling path for the temp file. Same directory keeps the rename on
/// one filesystem; the uuid keeps two concurrent saves from colliding.
fn temp_sibling(target: &Path) -> PathBuf {
    let dir = target.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    let stamp = uuid::Uuid::new_v4().simple().to_string();
    dir.join(format!("{TMP_PREFIX}{}", &stamp[..12]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn creates_the_file_and_parents() {
        let t = TempDir::new("atomic-create");
        let target = t.path().join("Drafts/Ch_01.md");
        let out = write_atomic(&target, b"hello").unwrap();
        assert_eq!(out, WriteOutcome::Written);
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
    }

    #[test]
    fn identical_content_does_not_touch_the_file() {
        let t = TempDir::new("atomic-unchanged");
        let target = t.path().join("note.md");
        // A file with NO frontmatter — the case the contract cares about most.
        let original = "Just prose. No fences, no keys.\n";
        fs::write(&target, original).unwrap();
        let before = fs::metadata(&target).unwrap().modified().unwrap();

        std::thread::sleep(std::time::Duration::from_millis(20));
        let out = write_atomic(&target, original.as_bytes()).unwrap();

        assert_eq!(out, WriteOutcome::Unchanged);
        assert_eq!(fs::read_to_string(&target).unwrap(), original,
            "content must be byte-identical, including the trailing newline");
        assert_eq!(fs::metadata(&target).unwrap().modified().unwrap(), before,
            "an unchanged save must not even bump mtime");
    }

    #[test]
    fn a_real_change_replaces_the_file_and_leaves_no_temp_behind() {
        let t = TempDir::new("atomic-replace");
        let target = t.path().join("note.md");
        fs::write(&target, "before").unwrap();
        assert_eq!(write_atomic(&target, b"after").unwrap(), WriteOutcome::Written);
        assert_eq!(fs::read_to_string(&target).unwrap(), "after");

        let leftovers: Vec<_> = fs::read_dir(t.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(TMP_PREFIX))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
    }

    #[test]
    fn binary_content_survives_exactly() {
        let t = TempDir::new("atomic-binary");
        let target = t.path().join("blob.bin");
        let bytes: Vec<u8> = (0u8..=255).collect();
        write_atomic(&target, &bytes).unwrap();
        assert_eq!(fs::read(&target).unwrap(), bytes);
        assert_eq!(write_atomic(&target, &bytes).unwrap(), WriteOutcome::Unchanged);
    }
}
