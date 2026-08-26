//! Filesystem operations on a vault: reading, writing, binaries, trash, watch.

pub mod atomic;
pub mod trash;
pub mod watcher;

use std::path::Path;

/// Read a text file as UTF-8.
///
/// Lossy on purpose: a stray invalid byte in an old note should show the note,
/// not an error dialog. Saving that note writes back what the editor holds,
/// and an untouched file is never rewritten (see `atomic::write_atomic`).
pub fn read_text(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn read_bytes(path: &Path) -> std::io::Result<Vec<u8>> {
    std::fs::read(path)
}

/// Content type for the data-URL fallback in `resolveAssetUrl`.
pub fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "pdf" => "application/pdf",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "html" | "htm" => "text/html",
        _ => "application/octet-stream",
    }
}

/// Base64 for the data-URL fallback. Small and dependency-free — the fallback
/// path is rare, and pulling a crate in for 20 lines isn't worth it.
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_reference_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn mime_covers_the_viewer_kinds() {
        assert_eq!(mime_for(Path::new("a/b.PDF")), "application/pdf");
        assert_eq!(mime_for(Path::new("Cathedral diagram.jpg")), "image/jpeg");
        assert_eq!(mime_for(Path::new("clip.mov")), "video/quicktime");
        assert_eq!(mime_for(Path::new("mystery.xyz")), "application/octet-stream");
    }

    #[test]
    fn reading_text_is_lossy_rather_than_fatal() {
        let t = crate::testutil::TempDir::new("read-lossy");
        let p = t.path().join("odd.md");
        std::fs::write(&p, [b'h', b'i', 0xff, b'!']).unwrap();
        assert!(read_text(&p).unwrap().starts_with("hi"));
    }
}
