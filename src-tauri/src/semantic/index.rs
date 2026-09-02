//! The vectors on disk, and the scan that searches them.
//!
//! Everything in this file is pure: it reads and writes files and it does
//! arithmetic, and it never loads a model. That is deliberate — the format and
//! the ranking are the parts most likely to be got wrong, and they are the
//! parts a machine with no 34 MB download can still test.
//!
//! ## The shape on disk
//!
//! ```text
//! <vault>/.aquarius/semantic.nosync/
//!   <model-key>/                     ← one folder per model this machine used
//!     manifest.json                  ← what the folder was built with
//!     docs/<path-hash>.vec           ← one file per document
//! ```
//!
//! `.nosync` is the suffix iCloud Drive honours: on a Mac the folder stays on
//! the machine and is never uploaded. On Linux it means nothing, which is fine
//! — a vault carried between the two simply arrives with a cache the other
//! machine ignores, because the model key will not match.
//!
//! ## The five rules
//!
//! 1. **The index is a cache.** Anything may delete it at any moment and the
//!    only cost is a rebuild. Nothing in the vault ever depends on it, and a
//!    corrupt file is skipped and rebuilt rather than reported.
//! 2. **A key mismatch means rebuild, never reinterpret.** An app does not
//!    read a folder built by a model it is not holding.
//! 3. **A stamp mismatch re-embeds that one document.** That is the whole
//!    reason for one file per document.
//! 4. **Writes are atomic** — temp sibling, then rename — and `.aquarius/` is
//!    outside the watcher, so indexing never looks like an external edit.
//! 5. **Unknown keys survive** in both JSON layers, so a newer build of either
//!    app can add a field without this one destroying it.

use crate::fs_ops::atomic::write_atomic;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The folder inside `.aquarius/`. The suffix is load-bearing on macOS.
pub const SEMANTIC_DIR: &str = "semantic.nosync";
/// The format number in both the manifest and every `.vec` header.
pub const FORMAT: u32 = 1;
/// The first six bytes of every `.vec` file.
const MAGIC: &[u8; 6] = b"AQVEC\0";

// ---------------------------------------------------------------------------
// Where things live
// ---------------------------------------------------------------------------

/// `<publisher>--<model>--<first 12 hex of the model file's own hash>`.
///
/// The hash of the **file**, not a version string: two builds of "the same"
/// model are two models, and vectors from one must never be compared with
/// vectors from the other.
pub fn model_key(publisher: &str, model: &str, model_sha256: &str) -> String {
    let short: String = model_sha256.chars().take(12).collect();
    format!("{publisher}--{model}--{short}")
}

/// The folder this model's vectors live in.
pub fn index_dir(root: &Path, key: &str) -> PathBuf {
    crate::vault::paths::aq_dir(root).join(SEMANTIC_DIR).join(key)
}

/// A filename that is safe for any vault path, including one with a slash, a
/// colon or an emoji in it.
pub fn path_hash(rel: &str) -> String {
    let mut h = Sha256::new();
    h.update(rel.as_bytes());
    format!("{:x}", h.finalize())
}

fn vec_path(root: &Path, key: &str, rel: &str) -> PathBuf {
    index_dir(root, key).join("docs").join(format!("{}.vec", path_hash(rel)))
}

fn manifest_path(root: &Path, key: &str) -> PathBuf {
    index_dir(root, key).join("manifest.json")
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ModelDescriptor {
    pub id: String,
    pub file: String,
    pub sha256: String,
    pub dims: usize,
    pub normalized: bool,
    #[serde(rename = "queryPrefix", default)]
    pub query_prefix: String,
    /// Anything a newer build wrote that this one has never heard of.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Chunking {
    pub words: usize,
    #[serde(rename = "overlapWords")]
    pub overlap_words: usize,
    pub unit: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DocEntry {
    /// The document's content SHA-256 when it was embedded — the same
    /// `FileStamp.hash` the conflict guard already computes.
    pub stamp: String,
    pub chunks: usize,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Manifest {
    pub format: u32,
    pub model: ModelDescriptor,
    pub chunking: Chunking,
    /// Vault-relative path → what was indexed for it.
    pub docs: BTreeMap<String, DocEntry>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Manifest {
    pub fn new(model: ModelDescriptor) -> Self {
        Self {
            format: FORMAT,
            model,
            chunking: Chunking {
                words: super::chunk::CHUNK_WORDS,
                overlap_words: 0,
                unit: "paragraph-packed".to_string(),
                extra: Map::new(),
            },
            docs: BTreeMap::new(),
            extra: Map::new(),
        }
    }

    /// Whether this manifest was built by the model we are holding.
    ///
    /// Rule 2. A `false` here means throw the folder away, never convert it.
    pub fn matches(&self, model: &ModelDescriptor) -> bool {
        self.format == FORMAT
            && self.model.sha256 == model.sha256
            && self.model.dims == model.dims
            && self.chunking.words == super::chunk::CHUNK_WORDS
    }
}

/// Read a manifest. A missing, unreadable or unparseable file is `None` — rule
/// 1: a corrupt cache is an empty cache, not an error.
pub fn read_manifest(root: &Path, key: &str) -> Option<Manifest> {
    let bytes = std::fs::read(manifest_path(root, key)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn write_manifest(root: &Path, key: &str, manifest: &Manifest) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|e| format!("could not serialise the semantic manifest: {e}"))?;
    write_atomic(&manifest_path(root, key), &bytes)
        .map(|_| ())
        .map_err(|e| format!("could not write the semantic manifest: {e}"))
}

// ---------------------------------------------------------------------------
// One document's vectors
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ChunkHeader {
    pub line: usize,
    pub words: usize,
    pub preview: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct VecHeader {
    pub path: String,
    pub stamp: String,
    pub dims: usize,
    pub dtype: String,
    pub chunks: Vec<ChunkHeader>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DocVectors {
    pub header: VecHeader,
    /// `chunks × dims` floats, in header order.
    pub body: Vec<f32>,
}

/// `AQVEC\0` + u16 format + u32 header length + header JSON + f32 body.
pub fn encode(header: &VecHeader, body: &[f32]) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(header)
        .map_err(|e| format!("could not serialise a vector header: {e}"))?;
    let mut out = Vec::with_capacity(12 + json.len() + body.len() * 4);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(FORMAT as u16).to_le_bytes());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    for f in body {
        out.extend_from_slice(&f.to_le_bytes());
    }
    Ok(out)
}

/// The other half. Every failure is `None`, not an error — rule 1 again.
pub fn decode(bytes: &[u8]) -> Option<DocVectors> {
    if bytes.len() < 12 || &bytes[0..6] != MAGIC {
        return None;
    }
    let format = u16::from_le_bytes([bytes[6], bytes[7]]);
    if format as u32 != FORMAT {
        return None;
    }
    let len = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    let json_end = 12usize.checked_add(len)?;
    if bytes.len() < json_end {
        return None;
    }
    let header: VecHeader = serde_json::from_slice(&bytes[12..json_end]).ok()?;
    let rest = &bytes[json_end..];
    // A truncated body is a half-written file. It is not repairable and it is
    // not worth reporting: drop it and let the document be re-embedded.
    if header.dims == 0 || rest.len() != header.chunks.len() * header.dims * 4 {
        return None;
    }
    let mut body = Vec::with_capacity(rest.len() / 4);
    for quad in rest.chunks_exact(4) {
        body.push(f32::from_le_bytes([quad[0], quad[1], quad[2], quad[3]]));
    }
    Some(DocVectors { header, body })
}

pub fn write_doc(root: &Path, key: &str, doc: &DocVectors) -> Result<(), String> {
    let bytes = encode(&doc.header, &doc.body)?;
    write_atomic(&vec_path(root, key, &doc.header.path), &bytes)
        .map(|_| ())
        .map_err(|e| format!("could not write a vector file: {e}"))
}

pub fn read_doc(root: &Path, key: &str, rel: &str) -> Option<DocVectors> {
    decode(&std::fs::read(vec_path(root, key, rel)).ok()?)
}

pub fn remove_doc(root: &Path, key: &str, rel: &str) {
    let _ = std::fs::remove_file(vec_path(root, key, rel));
}

/// A rename keeps the vectors: the file is re-keyed and the header's path is
/// rewritten, exactly the way a session file is re-keyed.
pub fn rename_doc(root: &Path, key: &str, from: &str, to: &str) {
    if let Some(mut doc) = read_doc(root, key, from) {
        doc.header.path = to.to_string();
        if write_doc(root, key, &doc).is_ok() {
            remove_doc(root, key, from);
        }
    } else {
        remove_doc(root, key, from);
    }
}

/// Every document file in the index folder, decoded. Unreadable ones are
/// skipped in silence.
pub fn read_all(root: &Path, key: &str) -> Vec<DocVectors> {
    let dir = index_dir(root, key).join("docs");
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        if entry.path().extension().and_then(|e| e.to_str()) != Some("vec") {
            continue;
        }
        if let Ok(bytes) = std::fs::read(entry.path()) {
            if let Some(doc) = decode(&bytes) {
                out.push(doc);
            }
        }
    }
    out
}

/// Delete `.vec` files for documents the manifest no longer lists, and any
/// index folder built by a different model.
///
/// Both are the same rule read two ways: what is not accounted for is not kept.
pub fn prune(root: &Path, key: &str, manifest: &Manifest) {
    let keep: std::collections::HashSet<String> =
        manifest.docs.keys().map(|p| path_hash(p)).collect();
    let docs_dir = index_dir(root, key).join("docs");
    if let Ok(entries) = std::fs::read_dir(&docs_dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("vec") {
                continue;
            }
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if !keep.contains(&stem) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    // Folders for other models. Left alone rather than deleted would mean a
    // vault that has seen three models carries three copies of itself forever.
    let semantic = crate::vault::paths::aq_dir(root).join(SEMANTIC_DIR);
    if let Ok(entries) = std::fs::read_dir(&semantic) {
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name != key && entry.path().is_dir() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticHit {
    pub path: String,
    /// The best chunk's first body line, 0-based.
    pub line: usize,
    pub preview: String,
    /// Cosine similarity of the best chunk, −1 to 1.
    pub score: f32,
    /// How many chunks this document has in the index.
    pub chunks: usize,
}

/// Cosine similarity of two unit vectors, which is their dot product.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Rank documents against a query vector: best chunk per document wins, and
/// the winning chunk is what the hit describes.
pub fn rank(docs: &[DocVectors], query: &[f32], limit: usize) -> Vec<SemanticHit> {
    let mut hits: Vec<SemanticHit> = Vec::new();
    for doc in docs {
        let dims = doc.header.dims;
        if dims != query.len() {
            continue;
        }
        let mut best: Option<(usize, f32)> = None;
        for (i, chunk) in doc.header.chunks.iter().enumerate() {
            let start = i * dims;
            let Some(slice) = doc.body.get(start..start + dims) else { continue };
            let score = cosine(slice, query);
            let _ = chunk;
            if best.map(|(_, s)| score > s).unwrap_or(true) {
                best = Some((i, score));
            }
        }
        let Some((i, score)) = best else { continue };
        let chunk = &doc.header.chunks[i];
        hits.push(SemanticHit {
            path: doc.header.path.clone(),
            line: chunk.line,
            preview: chunk.preview.clone(),
            score,
            chunks: doc.header.chunks.len(),
        });
    }
    // Ties break on path so two identical searches agree — the same stability
    // rule the keyword search follows.
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.path.cmp(&b.path))
    });
    hits.truncate(limit);
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn descriptor(sha: &str) -> ModelDescriptor {
        ModelDescriptor {
            id: "BAAI/bge-small-en-v1.5".into(),
            file: "model_quantized.onnx".into(),
            sha256: sha.into(),
            dims: 4,
            normalized: true,
            query_prefix: "Represent this sentence: ".into(),
            extra: Map::new(),
        }
    }

    fn doc(path: &str, vectors: &[[f32; 4]]) -> DocVectors {
        DocVectors {
            header: VecHeader {
                path: path.into(),
                stamp: "c0ffee".into(),
                dims: 4,
                dtype: "f32".into(),
                chunks: vectors
                    .iter()
                    .enumerate()
                    .map(|(i, _)| ChunkHeader {
                        line: i * 10,
                        words: 180,
                        preview: format!("chunk {i} of {path}"),
                        extra: Map::new(),
                    })
                    .collect(),
                extra: Map::new(),
            },
            body: vectors.iter().flatten().copied().collect(),
        }
    }

    #[test]
    fn the_model_key_names_the_file_not_the_version() {
        let key = model_key("baai", "bge-small-en-v1.5", "3f9a1c0d2e7bdeadbeef");
        assert_eq!(key, "baai--bge-small-en-v1.5--3f9a1c0d2e7b");
    }

    #[test]
    fn a_vector_file_survives_a_round_trip() {
        let d = doc("Drafts/Ch_01.md", &[[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]]);
        let bytes = encode(&d.header, &d.body).unwrap();
        assert_eq!(&bytes[0..6], b"AQVEC\0");
        assert_eq!(decode(&bytes).unwrap(), d);
    }

    #[test]
    fn a_damaged_vector_file_is_skipped_rather_than_reported() {
        let d = doc("a.md", &[[1.0, 0.0, 0.0, 0.0]]);
        let bytes = encode(&d.header, &d.body).unwrap();
        assert!(decode(&bytes[..bytes.len() - 3]).is_none(), "a truncated body");
        assert!(decode(b"not a vector file at all").is_none());
        let mut wrong_magic = bytes.clone();
        wrong_magic[0] = b'X';
        assert!(decode(&wrong_magic).is_none());
        let mut wrong_format = bytes.clone();
        wrong_format[6] = 9;
        assert!(decode(&wrong_format).is_none(), "a format we do not know is not ours to read");
    }

    #[test]
    fn unknown_keys_survive_both_json_layers() {
        let raw = r#"{
          "format": 1,
          "model": {"id":"m","file":"f","sha256":"abc","dims":4,"normalized":true,
                    "queryPrefix":"","futureThing":42},
          "chunking": {"words":180,"overlapWords":0,"unit":"paragraph-packed","mood":"calm"},
          "docs": {"a.md": {"stamp":"s","chunks":2,"updatedAt":1,"note":"hi"}},
          "somethingElse": true
        }"#;
        let m: Manifest = serde_json::from_str(raw).unwrap();
        let back = serde_json::to_string(&m).unwrap();
        assert!(back.contains("futureThing"));
        assert!(back.contains("\"mood\":\"calm\""));
        assert!(back.contains("\"note\":\"hi\""));
        assert!(back.contains("somethingElse"));
    }

    #[test]
    fn a_manifest_matches_only_the_model_that_built_it() {
        let m = Manifest::new(descriptor("aaa"));
        assert!(m.matches(&descriptor("aaa")));
        assert!(!m.matches(&descriptor("bbb")), "a different model file is a different model");
        let mut other_dims = descriptor("aaa");
        other_dims.dims = 384;
        assert!(!m.matches(&other_dims));
        let mut stale = m.clone();
        stale.chunking.words = 90;
        assert!(!stale.matches(&descriptor("aaa")), "a different chunk size is a different index");
        let mut old_format = m.clone();
        old_format.format = 0;
        assert!(!old_format.matches(&descriptor("aaa")));
    }

    #[test]
    fn ranking_takes_the_best_chunk_per_document_and_sorts_by_score() {
        let docs = vec![
            doc("far.md", &[[0.0, 1.0, 0.0, 0.0]]),
            doc("near.md", &[[0.0, 0.0, 1.0, 0.0], [1.0, 0.0, 0.0, 0.0]]),
            doc("middling.md", &[[0.7071, 0.7071, 0.0, 0.0]]),
        ];
        let hits = rank(&docs, &[1.0, 0.0, 0.0, 0.0], 10);
        let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths, vec!["near.md", "middling.md", "far.md"]);
        assert!((hits[0].score - 1.0).abs() < 1e-5);
        assert_eq!(hits[0].line, 10, "the SECOND chunk won, and the hit says so");
        assert_eq!(hits[0].chunks, 2);
        assert_eq!(hits[0].preview, "chunk 1 of near.md");
        assert_eq!(rank(&docs, &[1.0, 0.0, 0.0, 0.0], 2).len(), 2, "limit caps the result");
    }

    #[test]
    fn a_document_embedded_at_another_size_is_ignored_rather_than_scored() {
        let docs = vec![doc("a.md", &[[1.0, 0.0, 0.0, 0.0]])];
        assert!(rank(&docs, &[1.0, 0.0], 10).is_empty());
    }

    #[test]
    fn writing_reading_renaming_and_pruning_a_real_folder() {
        let t = TempDir::new("semantic-index");
        let key = "baai--test--abc123456789";
        let d = doc("Drafts/Ch_01.md", &[[1.0, 0.0, 0.0, 0.0]]);
        write_doc(t.path(), key, &d).unwrap();
        assert_eq!(read_doc(t.path(), key, "Drafts/Ch_01.md").unwrap(), d);

        rename_doc(t.path(), key, "Drafts/Ch_01.md", "Drafts/Chapter One.md");
        assert!(read_doc(t.path(), key, "Drafts/Ch_01.md").is_none(), "the old key is gone");
        let moved = read_doc(t.path(), key, "Drafts/Chapter One.md").unwrap();
        assert_eq!(moved.header.path, "Drafts/Chapter One.md");
        assert_eq!(moved.body, d.body, "a rename does not re-embed anything");

        let mut manifest = Manifest::new(descriptor("abc123456789"));
        manifest.docs.insert(
            "Drafts/Chapter One.md".into(),
            DocEntry { stamp: "c0ffee".into(), chunks: 1, updated_at: 1, extra: Map::new() },
        );
        write_manifest(t.path(), key, &manifest).unwrap();
        assert_eq!(read_manifest(t.path(), key).unwrap(), manifest);

        // An orphan: a vector file for a document the manifest never heard of.
        write_doc(t.path(), key, &doc("Deleted.md", &[[0.0, 1.0, 0.0, 0.0]])).unwrap();
        // And a whole folder from some other model.
        write_doc(t.path(), "other--model--000000000000", &d).unwrap();

        prune(t.path(), key, &manifest);
        assert!(read_doc(t.path(), key, "Deleted.md").is_none(), "the orphan went");
        assert!(read_doc(t.path(), key, "Drafts/Chapter One.md").is_some(), "the live one stayed");
        assert!(
            !index_dir(t.path(), "other--model--000000000000").exists(),
            "another model's folder is not ours to keep"
        );
        assert_eq!(read_all(t.path(), key).len(), 1);
    }

    #[test]
    fn a_missing_index_is_an_empty_index_and_never_an_error() {
        let t = TempDir::new("semantic-empty");
        assert!(read_manifest(t.path(), "nope").is_none());
        assert!(read_doc(t.path(), "nope", "a.md").is_none());
        assert!(read_all(t.path(), "nope").is_empty());
        // Pruning something that does not exist must not panic.
        prune(t.path(), "nope", &Manifest::new(descriptor("x")));
    }

    #[test]
    fn any_path_gets_a_safe_filename() {
        for rel in ["a/b.md", "Drafts/Ch 01: the end.md", "notes/🕯️.md"] {
            let h = path_hash(rel);
            assert_eq!(h.len(), 64);
            assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
        }
        assert_ne!(path_hash("a.md"), path_hash("b.md"));
    }
}
