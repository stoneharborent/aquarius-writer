//! Content fingerprints — how the app tells *"the file I read"* apart from
//! *"the file somebody else changed while I was typing"*.
//!
//! **The hash is the authority, not the mtime.** That is the whole design
//! decision here, and it is not theoretical:
//!
//! * Timestamp precision is per-filesystem. HFS+ stores whole seconds, APFS
//!   nanoseconds, ext4 nanoseconds-but-only-with-256-byte-inodes. A stamp taken
//!   on one and compared on another is a coin toss.
//! * **iCloud Drive touches mtimes.** This repo lives inside iCloud, and the
//!   File Provider re-materialises and re-stamps files whose bytes never
//!   changed (docs/NOTES.md §8). An mtime guard would raise a conflict dialog
//!   every time the sync daemon breathed, which is worse than no guard at all:
//!   a dialog the writer learns to dismiss protects nothing.
//! * A hash is immune to both. Same bytes, same answer, on every filesystem and
//!   after any number of sync round trips.
//!
//! The mtime still rides along in the stamp, because it is genuinely useful for
//! diagnostics and it is what a human recognises in a log line. It is *reported*
//! and never *decided on* — the one place it is consulted is
//! [`mtime_moved`], which downgrades "the clock jumped but the bytes are
//! identical" to a printed note instead of a refusal.

use crate::model::FileStamp;
use sha2::{Digest, Sha256};
use std::path::Path;

/// How far two mtimes may drift before it is worth mentioning.
///
/// Two seconds clears whole-second filesystems (HFS+, and ext4 without large
/// inodes) plus the rounding either side of them. Nothing is ever *refused* on
/// this number — see the module note.
pub const MTIME_TOLERANCE_MS: i64 = 2_000;

/// Lowercase hex SHA-256 of exactly these bytes.
///
/// Bytes, never a `String`: `fs_ops::read_text` is lossy, so a file with one
/// stray non-UTF-8 byte would hash differently going out than coming in, and
/// every save of that file would look like somebody else's edit.
pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// mtime in epoch milliseconds, or 0 when the filesystem will not say.
pub fn mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A stamp for bytes the caller already holds, dated from the file on disk.
pub fn stamp_for(path: &Path, bytes: &[u8]) -> FileStamp {
    FileStamp { hash: hash_bytes(bytes), mtime_ms: mtime_ms(path), bytes: bytes.len() }
}

/// The stamp of a file, read from disk. `None` when there is nothing there —
/// which is a real state, not an error: a document can be deleted underneath an
/// open editor.
pub fn stamp_of(path: &Path) -> Option<FileStamp> {
    let bytes = std::fs::read(path).ok()?;
    Some(stamp_for(path, &bytes))
}

/// True when two stamps' clocks disagree by more than the tolerance.
///
/// Diagnostic only. A `true` here alongside equal hashes is the iCloud case:
/// the file was re-stamped without being rewritten.
pub fn mtime_moved(a: &FileStamp, b: &FileStamp) -> bool {
    if a.mtime_ms == 0 || b.mtime_ms == 0 {
        return false;
    }
    (a.mtime_ms - b.mtime_ms).abs() > MTIME_TOLERANCE_MS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn hashes_match_the_reference_vectors() {
        // NIST's own two, so a future change to the hashing crate is caught
        // here rather than by a vault full of unopenable conflict dialogs.
        assert_eq!(
            hash_bytes(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hash_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn a_stamp_describes_the_bytes_on_disk() {
        let t = TempDir::new("stamp-read");
        let p = t.write("note.md", "rain on the cape\n");
        let stamp = stamp_of(&p).expect("the file is there");
        assert_eq!(stamp.hash, hash_bytes(b"rain on the cape\n"));
        assert_eq!(stamp.bytes, 17);
        assert!(stamp.mtime_ms > 0, "a real file has a real mtime");

        assert!(stamp_of(&t.path().join("gone.md")).is_none());
    }

    #[test]
    fn invalid_utf8_hashes_as_the_bytes_it_actually_is() {
        // `read_text` would turn 0xff into U+FFFD; hashing that instead of the
        // real byte would make every save of this file look like a conflict.
        let t = TempDir::new("stamp-lossy");
        let p = t.path().join("odd.md");
        std::fs::write(&p, [b'h', b'i', 0xff]).unwrap();
        let stamp = stamp_of(&p).unwrap();
        assert_eq!(stamp.hash, hash_bytes(&[b'h', b'i', 0xff]));
        assert_ne!(
            stamp.hash,
            hash_bytes(crate::fs_ops::read_text(&p).unwrap().as_bytes()),
            "the lossy text and the real bytes are different things, on purpose"
        );
    }

    #[test]
    fn an_mtime_that_moves_on_its_own_does_not_change_the_hash() {
        // The iCloud case, reproduced: the sync daemon re-stamps a file it did
        // not rewrite. The hash is what the conflict guard reads, and it is
        // unmoved — only the advisory `mtime_moved` notices.
        let t = TempDir::new("stamp-icloud");
        let p = t.write("note.md", "unchanged\n");
        let before = stamp_of(&p).unwrap();

        let touched = FileStamp { mtime_ms: before.mtime_ms + 60_000, ..before.clone() };
        assert_eq!(touched.hash, before.hash, "the bytes are the same bytes");
        assert!(mtime_moved(&touched, &before), "the clock did move, and we can say so");

        // A stamp with no mtime at all (a filesystem that would not say) is not
        // reported as movement in either direction.
        let unknown = FileStamp { mtime_ms: 0, ..before.clone() };
        assert!(!mtime_moved(&unknown, &before));
        assert!(!mtime_moved(&before, &unknown));

        // Inside the tolerance is not movement either.
        let jitter = FileStamp { mtime_ms: before.mtime_ms + MTIME_TOLERANCE_MS - 1, ..before };
        assert!(!mtime_moved(&jitter, &stamp_of(&p).unwrap()));
    }
}
