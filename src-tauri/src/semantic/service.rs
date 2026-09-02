//! The live side: what the app is holding, what it is doing, and how a search
//! actually happens.
//!
//! `chunk`, `index` and `model` are pure enough to test on a machine with no
//! model on it. This file is the part that owns state — the loaded embedder,
//! the download's progress, and the background indexing — and it is the only
//! place in `semantic/` that knows what a Tauri `AppHandle` is.
//!
//! **Nothing here may ever run on the keystroke path.** Embedding a document
//! is tens of milliseconds per chunk; a chapter is a second's work. Every
//! entry point below either returns immediately or is already on a background
//! thread, and the one that saves a document hands the work to
//! `spawn_blocking` and returns before a single chunk is embedded. The rule is
//! NOTES §27l's: nothing O(document) between a key going down and a character
//! appearing.

use super::embed::{Embedder, FastEmbed};
use super::index::{self, DocVectors, SemanticHit, VecHeader};
use super::model;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// Emitted whenever the model's state or the indexing progress changes, so the
/// Find sheet and Settings redraw without polling. Same pattern as
/// `updater://state`.
pub const STATE_EVENT: &str = "semantic://state";

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// No model on this machine. The card offers a download.
    Absent,
    Downloading,
    /// Downloaded and loadable. Search works.
    Ready,
    /// Something went wrong; `message` says what, in a sentence.
    Error,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub done: usize,
    pub total: usize,
}

/// Everything the Find sheet and the Settings row need to draw themselves.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SemanticStatus {
    /// The one field a caller should branch on. True only when a query would
    /// actually be answered.
    pub available: bool,
    pub phase: Phase,
    pub model_id: String,
    pub model_licence: String,
    /// What the download costs, in bytes — the card turns it into "35 MB".
    pub download_bytes: u64,
    /// What it currently occupies. Zero when nothing is installed.
    pub bytes_on_disk: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Set while a vault is being indexed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexing: Option<IndexProgress>,
}

/// Why a search could not be answered, in a shape an agent can branch on
/// rather than parse. Mirrors `CompileError`'s code-plus-hint.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    /// Always false. Present so a client can check one field.
    pub available: bool,
    /// A stable machine-readable reason. `model-missing` today.
    pub reason: String,
    /// What a person would do about it.
    pub hint: String,
}

impl Refusal {
    pub fn model_missing() -> Self {
        Self {
            available: false,
            reason: "model-missing".into(),
            hint: "Search by meaning needs a one-time 35 MB model download. \
                   Open Find (Shift-Cmd-F), switch to By meaning and choose Download."
                .into(),
        }
    }

    pub fn model_broken(message: impl std::fmt::Display) -> Self {
        Self {
            available: false,
            reason: "model-unusable".into(),
            hint: format!(
                "The model is on this machine but would not load ({message}). \
                 Remove it in Settings and download it again."
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct SemanticState {
    /// Where models live. Resolved once at startup because `app_data_dir()`
    /// can fail, and a background thread is the wrong place to find that out.
    app_data_dir: PathBuf,
    /// Loaded on first use and kept. 34 MB of graph is not something to load
    /// per query.
    embedder: Mutex<Option<Arc<dyn Embedder>>>,
    phase: Mutex<(Phase, Option<u8>, Option<String>)>,
    /// Workflows with an index pass in flight, so two saves in a second do not
    /// start two passes over the same vault.
    busy: Mutex<HashSet<String>>,
    progress: Mutex<Option<IndexProgress>>,
}

impl SemanticState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let installed = model::is_installed(&app_data_dir);
        Self {
            app_data_dir,
            embedder: Mutex::new(None),
            phase: Mutex::new((
                if installed { Phase::Ready } else { Phase::Absent },
                None,
                None,
            )),
            busy: Mutex::new(HashSet::new()),
            progress: Mutex::new(None),
        }
    }

    /// A test-only constructor that starts with a given embedder already in
    /// hand, so the whole index-and-search path can be exercised without a
    /// 34 MB download.
    #[cfg(test)]
    pub fn with_embedder(app_data_dir: PathBuf, embedder: Arc<dyn Embedder>) -> Self {
        let s = Self::new(app_data_dir);
        *s.embedder.lock().unwrap() = Some(embedder);
        *s.phase.lock().unwrap() = (Phase::Ready, None, None);
        s
    }

    pub fn model_dir(&self) -> PathBuf {
        model::model_dir(&self.app_data_dir)
    }

    /// The loaded embedder, loading it if this is the first ask.
    ///
    /// Blocking, and slow the first time (the ONNX session is built here), so
    /// every caller of this is already on a background thread.
    fn embedder(&self) -> Result<Arc<dyn Embedder>, Refusal> {
        if let Some(e) = self.embedder.lock().unwrap().as_ref() {
            return Ok(e.clone());
        }
        if !model::is_installed(&self.app_data_dir) {
            return Err(Refusal::model_missing());
        }
        let loaded = FastEmbed::load(&self.model_dir()).map_err(Refusal::model_broken)?;
        let arc: Arc<dyn Embedder> = Arc::new(loaded);
        *self.embedder.lock().unwrap() = Some(arc.clone());
        Ok(arc)
    }

    /// Drop the loaded model — after a Remove, so the next search says
    /// "download me" instead of quietly answering from memory.
    fn forget(&self) {
        *self.embedder.lock().unwrap() = None;
    }

    pub fn status(&self) -> SemanticStatus {
        let (phase, percent, message) = self.phase.lock().unwrap().clone();
        // `Ready` is a claim about the disk, so it is re-checked rather than
        // remembered: someone can delete the folder underneath a running app.
        let phase = match phase {
            Phase::Ready if !model::is_installed(&self.app_data_dir) => Phase::Absent,
            other => other,
        };
        SemanticStatus {
            available: phase == Phase::Ready,
            phase,
            model_id: model::MODEL_ID.to_string(),
            model_licence: model::MODEL_LICENCE.to_string(),
            download_bytes: model::download_bytes(),
            bytes_on_disk: model::bytes_on_disk(&self.app_data_dir),
            percent,
            message,
            indexing: self.progress.lock().unwrap().clone(),
        }
    }

    fn set_phase(&self, phase: Phase, percent: Option<u8>, message: Option<String>) {
        *self.phase.lock().unwrap() = (phase, percent, message);
    }
}

fn state(app: &AppHandle) -> tauri::State<'_, SemanticState> {
    app.state::<SemanticState>()
}

/// Publish the current status to the window.
fn publish(app: &AppHandle) -> SemanticStatus {
    let status = state(app).status();
    let _ = app.emit(STATE_EVENT, &status);
    status
}

// ---------------------------------------------------------------------------
// The four commands behind the card
// ---------------------------------------------------------------------------

pub fn probe(app: &AppHandle) -> SemanticStatus {
    state(app).status()
}

/// Download the model. A human clicked something to get here.
pub async fn download(app: AppHandle) -> Result<SemanticStatus, String> {
    if state(&app).status().phase == Phase::Downloading {
        return Ok(publish(&app));
    }
    state(&app).set_phase(Phase::Downloading, Some(0), None);
    publish(&app);

    let handle = app.clone();
    let dir = state(&app).app_data_dir.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        model::download(&crate::updater::net::Network, &dir, &|percent| {
            // Only whole percents arrive here already; each one is one redraw.
            handle.state::<SemanticState>().set_phase(
                Phase::Downloading,
                Some(percent),
                None,
            );
            let _ = handle.emit(STATE_EVENT, handle.state::<SemanticState>().status());
        })
    })
    .await
    .map_err(|e| format!("The download stopped unexpectedly ({e})."))?;

    match outcome {
        Ok(()) => {
            state(&app).set_phase(Phase::Ready, None, None);
            Ok(publish(&app))
        }
        Err(message) => {
            state(&app).set_phase(Phase::Error, None, Some(message.clone()));
            publish(&app);
            Err(message)
        }
    }
}

/// Delete the model from this machine.
pub fn remove(app: &AppHandle) -> Result<SemanticStatus, String> {
    let dir = state(app).app_data_dir.clone();
    model::remove(&dir)?;
    state(app).forget();
    state(app).set_phase(Phase::Absent, None, None);
    Ok(publish(app))
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/// Files worth embedding. The same three extensions the keyword search reads,
/// so "by meaning" never covers less than "exact" does.
fn is_text(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".fountain")
        || lower.ends_with(".txt")
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) {
    if depth >= 16 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == crate::vault::paths::AQ_DIR || crate::vault::paths::is_ignored_name(&name) {
            continue;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            walk(root, &path, depth + 1, out);
        } else if ft.is_file() && is_text(&name) {
            if let Some(rel) = crate::vault::paths::rel_from_root(root, &path) {
                out.push(rel);
            }
        }
    }
}

/// Chunk one document and embed it, producing the file that goes on disk.
///
/// Pure apart from the embedder, so the whole shape can be tested with the fake
/// one.
pub fn embed_document(
    embedder: &dyn Embedder,
    rel: &str,
    text: &str,
    stamp: &str,
) -> Result<DocVectors, String> {
    let body = crate::vault::frontmatter::parse(text).body;
    let chunks = super::chunk::chunk_body(&body);
    let texts: Vec<String> = chunks.iter().map(|c| c.text.clone()).collect();
    let vectors = embedder.embed(&texts)?;
    let mut body_floats = Vec::with_capacity(vectors.len() * embedder.dims());
    for v in &vectors {
        body_floats.extend_from_slice(v);
    }
    Ok(DocVectors {
        header: VecHeader {
            path: rel.to_string(),
            stamp: stamp.to_string(),
            dims: embedder.dims(),
            dtype: "f32".into(),
            chunks: chunks
                .iter()
                .map(|c| index::ChunkHeader {
                    line: c.line,
                    words: c.words,
                    preview: c.preview.clone(),
                    extra: serde_json::Map::new(),
                })
                .collect(),
            extra: serde_json::Map::new(),
        },
        body: body_floats,
    })
}

/// Bring a whole vault's index up to date.
///
/// One pass over the tree comparing content hashes with the manifest. A
/// document whose hash still matches costs a read of a few KB and no model
/// work at all, so this is cheap to run on open and after any change.
///
/// Blocking. Callers are on a background thread.
pub fn sync_vault(
    embedder: &dyn Embedder,
    root: &Path,
    on_progress: &dyn Fn(usize, usize),
) -> Result<usize, String> {
    let key = model::model_key();
    let descriptor = model::descriptor();
    // Rule 2: a folder built by another model is not read, it is rebuilt.
    let mut manifest = match index::read_manifest(root, &key) {
        Some(m) if m.matches(&descriptor) => m,
        _ => index::Manifest::new(descriptor),
    };

    let mut paths = Vec::new();
    walk(root, root, 0, &mut paths);
    paths.sort();
    let present: std::collections::BTreeSet<String> = paths.iter().cloned().collect();

    // Documents that have gone lose their vectors. No orphans for a file that
    // is not there any more.
    let gone: Vec<String> =
        manifest.docs.keys().filter(|p| !present.contains(*p)).cloned().collect();
    for path in gone {
        manifest.docs.remove(&path);
        index::remove_doc(root, &key, &path);
    }

    let total = paths.len();
    let mut embedded = 0usize;
    for (i, rel) in paths.iter().enumerate() {
        on_progress(i, total);
        let Ok(abs) = crate::vault::paths::resolve_in_root(root, rel) else { continue };
        let Ok(bytes) = std::fs::read(&abs) else { continue };
        let stamp = crate::fs_ops::stamp::hash_bytes(&bytes);
        // Rule 3: a matching stamp means this document is already done — and
        // the vector file has to actually be there, or the manifest is lying.
        if manifest.docs.get(rel).map(|d| d.stamp == stamp).unwrap_or(false)
            && index::read_doc(root, &key, rel).is_some()
        {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes).to_string();
        let doc = embed_document(embedder, rel, &text, &stamp)?;
        let chunks = doc.header.chunks.len();
        index::write_doc(root, &key, &doc)?;
        manifest.docs.insert(
            rel.clone(),
            index::DocEntry {
                stamp,
                chunks,
                updated_at: chrono::Utc::now().timestamp_millis(),
                extra: serde_json::Map::new(),
            },
        );
        embedded += 1;
    }
    on_progress(total, total);
    index::write_manifest(root, &key, &manifest)?;
    index::prune(root, &key, &manifest);
    Ok(embedded)
}

/// Re-embed exactly one document, after a save.
pub fn sync_document(embedder: &dyn Embedder, root: &Path, rel: &str) -> Result<(), String> {
    let key = model::model_key();
    let descriptor = model::descriptor();
    let mut manifest = match index::read_manifest(root, &key) {
        Some(m) if m.matches(&descriptor) => m,
        // No usable index yet: one document is not worth building one around.
        // The next full pass will do it properly.
        _ => return Ok(()),
    };
    let abs = crate::vault::paths::resolve_in_root(root, rel).map_err(|e| e.to_string())?;
    let Ok(bytes) = std::fs::read(&abs) else {
        manifest.docs.remove(rel);
        index::remove_doc(root, &key, rel);
        return index::write_manifest(root, &key, &manifest);
    };
    let stamp = crate::fs_ops::stamp::hash_bytes(&bytes);
    if manifest.docs.get(rel).map(|d| d.stamp == stamp).unwrap_or(false)
        && index::read_doc(root, &key, rel).is_some()
    {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    let doc = embed_document(embedder, rel, &text, &stamp)?;
    let chunks = doc.header.chunks.len();
    index::write_doc(root, &key, &doc)?;
    manifest.docs.insert(
        rel.to_string(),
        index::DocEntry {
            stamp,
            chunks,
            updated_at: chrono::Utc::now().timestamp_millis(),
            extra: serde_json::Map::new(),
        },
    );
    index::write_manifest(root, &key, &manifest)
}

/// A document was renamed or moved: re-key its vectors rather than re-embed.
pub fn note_rename(root: &Path, from: &str, to: &str) {
    let key = model::model_key();
    index::rename_doc(root, &key, from, to);
    let Some(mut manifest) = index::read_manifest(root, &key) else { return };
    if let Some(entry) = manifest.docs.remove(from) {
        manifest.docs.insert(to.to_string(), entry);
        let _ = index::write_manifest(root, &key, &manifest);
    }
}

/// A document was trashed: its vectors go with it.
pub fn note_removed(root: &Path, rel: &str) {
    let key = model::model_key();
    index::remove_doc(root, &key, rel);
    let Some(mut manifest) = index::read_manifest(root, &key) else { return };
    if manifest.docs.remove(rel).is_some() {
        let _ = index::write_manifest(root, &key, &manifest);
    }
}

/// Start a full pass in the background, if the model is here and one is not
/// already running for this vault. Returns immediately; progress arrives on
/// `semantic://state`.
pub fn spawn_sync(app: &AppHandle, workflow_id: String, root: PathBuf) {
    if !model::is_installed(&state(app).app_data_dir) {
        return;
    }
    {
        let s = state(app);
        let mut busy = s.busy.lock().unwrap();
        if !busy.insert(workflow_id.clone()) {
            return;
        }
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = handle.state::<SemanticState>();
        let result = s.embedder().map_err(|r| r.hint).and_then(|embedder| {
            let h = handle.clone();
            sync_vault(embedder.as_ref(), &root, &|done, total| {
                *h.state::<SemanticState>().progress.lock().unwrap() =
                    Some(IndexProgress { done, total });
                let _ = h.emit(STATE_EVENT, h.state::<SemanticState>().status());
            })
        });
        *s.progress.lock().unwrap() = None;
        if let Err(message) = result {
            eprintln!("[semantic] indexing {workflow_id} stopped: {message}");
            s.set_phase(Phase::Error, None, Some(message));
        }
        s.busy.lock().unwrap().remove(&workflow_id);
        let _ = handle.emit(STATE_EVENT, handle.state::<SemanticState>().status());
    });
}

/// Re-embed one document in the background, after a save.
///
/// This is the call that sits on the save path, so it does exactly two things
/// on the calling thread: check a boolean and hand a closure to a thread pool.
pub fn spawn_document_sync(app: &AppHandle, root: PathBuf, rel: String) {
    if !model::is_installed(&state(app).app_data_dir) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = handle.state::<SemanticState>();
        let Ok(embedder) = s.embedder() else { return };
        if let Err(e) = sync_document(embedder.as_ref(), &root, &rel) {
            eprintln!("[semantic] could not re-embed {rel}: {e}");
        }
    });
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

/// Blocking: embeds the query, then scans every vector in the index.
///
/// The scan is brute force on purpose. At this vault's scale — hundreds of
/// documents, tens of thousands of chunks — it is a few milliseconds, and the
/// alternative is a vector database file inside a folder a sync daemon is
/// copying, which is the one thing both SQLite and Apple tell you not to do.
pub fn search_blocking(
    app: &AppHandle,
    root: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<SemanticHit>, Refusal> {
    let embedder = state(app).embedder()?;
    search_with(embedder.as_ref(), root, query, limit)
}

/// The same search against a given embedder — the seam the tests use.
pub fn search_with(
    embedder: &dyn Embedder,
    root: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<SemanticHit>, Refusal> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let key = model::model_key();
    // bge wants a prefix in front of a query and nothing in front of a
    // document. It is read from the descriptor rather than hard-coded here so
    // a model that wants a different one, or none, needs no change to this.
    let prefixed = format!("{}{}", model::descriptor().query_prefix, query);
    let vector = embedder
        .embed(&[prefixed])
        .map_err(Refusal::model_broken)?
        .pop()
        .ok_or_else(|| Refusal::model_broken("the model returned nothing"))?;
    let docs = index::read_all(root, &key);
    Ok(index::rank(&docs, &vector, limit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantic::embed::WordBagEmbedder;
    use crate::testutil::TempDir;

    #[test]
    fn embedding_a_document_skips_the_frontmatter_and_numbers_body_lines() {
        let text = "---\ntitle: Chapter One\nstatus: drafting\n---\nThe first body line.\n\nA second paragraph.";
        let doc = embed_document(&WordBagEmbedder, "a.md", text, "stamp1").unwrap();
        assert_eq!(doc.header.path, "a.md");
        assert_eq!(doc.header.stamp, "stamp1");
        assert_eq!(doc.header.dims, 384);
        assert_eq!(doc.header.chunks.len(), 1);
        assert_eq!(doc.header.chunks[0].line, 0, "line 0 is the first BODY line");
        assert!(
            !doc.header.chunks[0].preview.contains("status"),
            "frontmatter is not prose and is not searched: {:?}",
            doc.header.chunks[0].preview
        );
        assert_eq!(doc.body.len(), 384);
    }

    #[test]
    fn a_vault_is_indexed_once_and_the_second_pass_embeds_nothing() {
        let t = TempDir::new("semantic-sync");
        t.write("Drafts/Ch_01.md", "The lantern went out on the stairs.");
        t.write("Drafts/Ch_02.md", "She read the letter twice.");
        t.write("Research/photo.jpg", "not text");
        t.write(".aquarius/workflow.json", "{}");

        let embedded = sync_vault(&WordBagEmbedder, t.path(), &|_, _| {}).unwrap();
        assert_eq!(embedded, 2, "two documents; the image and the metadata are not prose");

        let key = model::model_key();
        let manifest = index::read_manifest(t.path(), &key).unwrap();
        assert_eq!(manifest.docs.len(), 2);
        assert!(manifest.docs.contains_key("Drafts/Ch_01.md"));

        assert_eq!(
            sync_vault(&WordBagEmbedder, t.path(), &|_, _| {}).unwrap(),
            0,
            "nothing changed, so nothing was re-embedded"
        );
    }

    #[test]
    fn an_edit_re_embeds_only_that_document() {
        let t = TempDir::new("semantic-edit");
        t.write("a.md", "the lantern");
        t.write("b.md", "the letter");
        sync_vault(&WordBagEmbedder, t.path(), &|_, _| {}).unwrap();
        let key = model::model_key();
        let b_before = index::read_doc(t.path(), &key, "b.md").unwrap();

        t.write("a.md", "the lantern and the long dark stairs");
        assert_eq!(sync_vault(&WordBagEmbedder, t.path(), &|_, _| {}).unwrap(), 1);
        assert_eq!(index::read_doc(t.path(), &key, "b.md").unwrap(), b_before, "b was untouched");
    }

    #[test]
    fn a_deleted_document_loses_its_vectors() {
        let t = TempDir::new("semantic-delete");
        t.write("a.md", "the lantern");
        t.write("b.md", "the letter");
        sync_vault(&WordBagEmbedder, t.path(), &|_, _| {}).unwrap();
        let key = model::model_key();

        std::fs::remove_file(t.path().join("b.md")).unwrap();
        sync_vault(&WordBagEmbedder, t.path(), &|_, _| {}).unwrap();
        assert!(index::read_doc(t.path(), &key, "b.md").is_none());
        assert!(!index::read_manifest(t.path(), &key).unwrap().docs.contains_key("b.md"));
    }

    #[test]
    fn a_rename_carries_the_vectors_across_without_re_embedding() {
        let t = TempDir::new("semantic-rename");
        t.write("a.md", "the lantern went out");
        sync_vault(&WordBagEmbedder, t.path(), &|_, _| {}).unwrap();
        let key = model::model_key();
        let before = index::read_doc(t.path(), &key, "a.md").unwrap();

        std::fs::rename(t.path().join("a.md"), t.path().join("b.md")).unwrap();
        note_rename(t.path(), "a.md", "b.md");

        let after = index::read_doc(t.path(), &key, "b.md").unwrap();
        assert_eq!(after.body, before.body);
        assert_eq!(after.header.path, "b.md");
        assert!(index::read_doc(t.path(), &key, "a.md").is_none());
        let manifest = index::read_manifest(t.path(), &key).unwrap();
        assert!(manifest.docs.contains_key("b.md") && !manifest.docs.contains_key("a.md"));

        // And the next pass agrees rather than doing the work again.
        assert_eq!(sync_vault(&WordBagEmbedder, t.path(), &|_, _| {}).unwrap(), 0);
    }

    #[test]
    fn a_search_ranks_documents_and_respects_the_limit() {
        let t = TempDir::new("semantic-search");
        t.write("lantern.md", "The lantern went out on the stairs.");
        t.write("letter.md", "She read the letter twice and burned it.");
        t.write("engine.md", "The carburettor needed a new gasket.");
        sync_vault(&WordBagEmbedder, t.path(), &|_, _| {}).unwrap();

        let hits = search_with(&WordBagEmbedder, t.path(), "lantern stairs", 10).unwrap();
        assert_eq!(hits[0].path, "lantern.md");
        assert!(hits[0].score > hits.last().unwrap().score);
        assert_eq!(hits[0].chunks, 1);
        assert_eq!(hits[0].line, 0);

        assert_eq!(search_with(&WordBagEmbedder, t.path(), "lantern", 1).unwrap().len(), 1);
        assert!(search_with(&WordBagEmbedder, t.path(), "   ", 10).unwrap().is_empty());
    }

    #[test]
    fn an_index_built_by_another_model_is_rebuilt_rather_than_read() {
        let t = TempDir::new("semantic-mismatch");
        t.write("a.md", "the lantern");
        sync_vault(&WordBagEmbedder, t.path(), &|_, _| {}).unwrap();
        let key = model::model_key();

        // Rewrite the manifest as if a different model file had built it.
        let mut manifest = index::read_manifest(t.path(), &key).unwrap();
        manifest.model.sha256 = "0".repeat(64);
        index::write_manifest(t.path(), &key, &manifest).unwrap();

        assert_eq!(
            sync_vault(&WordBagEmbedder, t.path(), &|_, _| {}).unwrap(),
            1,
            "a manifest this model did not write is not trusted"
        );
        assert_eq!(index::read_manifest(t.path(), &key).unwrap().model.sha256, model::model_sha256());
    }

    #[test]
    fn a_refusal_says_what_it_is_and_what_to_do() {
        let r = Refusal::model_missing();
        assert!(!r.available);
        assert_eq!(r.reason, "model-missing");
        assert!(r.hint.contains("Download"));
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"available\":false") && json.contains("model-missing"));
    }

    #[test]
    fn a_status_with_no_model_is_not_available() {
        let t = TempDir::new("semantic-status");
        let s = SemanticState::new(t.path().to_path_buf());
        let status = s.status();
        assert!(!status.available);
        assert_eq!(status.phase, Phase::Absent);
        assert_eq!(status.bytes_on_disk, 0);
        assert_eq!(status.model_id, "BAAI/bge-small-en-v1.5");
        assert!(status.download_bytes > 30_000_000);
    }
}
