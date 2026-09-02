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
    /// The document being read right now, vault-relative. Empty on the last
    /// tick. The window shows the tail of it, which is the whole reason it is
    /// here: "Reading 857 of 858" says nothing, and "Reading 857 of 858 —
    /// DDCKey-Editor.txt" says everything.
    pub path: String,
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
    /// What the last finished pass did, so the window can say "Indexed 857
    /// documents, skipped 1" rather than going quiet and leaving the writer to
    /// wonder whether the number was meant to be 858.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<SyncReport>,
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
    /// What the most recent finished pass did. Survives the pass so the
    /// counts are still there to draw after the progress bar has gone.
    last_sync: Mutex<Option<SyncReport>>,
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
            last_sync: Mutex::new(None),
        }
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
        let loaded = FastEmbed::load(&self.model_dir()).map_err(|e| {
            // The usual reason a model that is present will not load is that
            // it is not all there. Re-hash it and say which file is wrong,
            // rather than handing the writer an ONNX parser's opinion.
            match model::verify_installed(&crate::updater::net::Network, &self.app_data_dir) {
                Err(detail) => Refusal::model_broken(detail),
                Ok(()) => Refusal::model_broken(e),
            }
        })?;
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
            last_sync: *self.last_sync.lock().unwrap(),
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
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        // The backfill embeds what this returns, so a dependency folder here
        // is 2,870 generated READMEs through a neural network.
        if crate::vault::paths::skip_entry(&name, ft.is_dir()) {
            continue;
        }
        if ft.is_dir() {
            walk(root, &path, depth + 1, out);
        } else if ft.is_file() && is_text(&name) {
            if let Some(rel) = crate::vault::paths::rel_from_root(root, &path) {
                out.push(rel);
            }
        }
    }
}

/// How many chunks go to the model in one call.
///
/// The ONNX session is behind a lock (see `embed::FastEmbed`), so the batch
/// size is also **how long a search waits behind a backfill**. Thirty-two
/// 180-word chunks is a few hundred milliseconds on this machine, which is
/// the longest a writer should ever wait for a query because indexing was
/// happening at the same moment. Smaller batches would cost throughput for no
/// felt gain; one big one per document would make a long chapter block a
/// query for a second or more.
const EMBED_BATCH: usize = 32;

/// What happened to one document.
#[derive(Debug, Clone)]
pub enum DocOutcome {
    /// It was chunked and embedded. `note` is set when something about the
    /// document was unusual enough to record — the chunk cap, so far.
    Embedded { doc: DocVectors, note: Option<String> },
    /// It was read, judged not to be prose, and deliberately not embedded.
    /// The sentence is what the manifest and the log carry.
    Skipped(String),
}

/// Chunk one document and embed it, producing the file that goes on disk.
///
/// Pure apart from the embedder, so the whole shape can be tested with the fake
/// one. It never returns an error for the *content* of a document: a file this
/// feature has no business embedding comes back as `Skipped`, which is a
/// decision, not a failure. An `Err` here means the model itself went wrong.
pub fn embed_document(
    embedder: &dyn Embedder,
    rel: &str,
    text: &str,
    stamp: &str,
) -> Result<DocOutcome, String> {
    let body = crate::vault::frontmatter::parse(text).body;
    // Asked before anything is chunked or tokenized: the whole point of the
    // guard is that the expensive answer is the cheap one to reach.
    if let Some(reason) = super::chunk::non_prose_reason(&body) {
        return Ok(DocOutcome::Skipped(reason));
    }
    let (chunks, note) = super::chunk::chunk_document(&body);
    let mut body_floats = Vec::with_capacity(chunks.len() * embedder.dims());
    for batch in chunks.chunks(EMBED_BATCH) {
        let texts: Vec<String> = batch.iter().map(|c| c.text.clone()).collect();
        for v in embedder.embed(&texts)? {
            body_floats.extend_from_slice(&v);
        }
    }
    Ok(DocOutcome::Embedded {
        note,
        doc: DocVectors {
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
        },
    })
}

/// What a whole-vault pass did. Counts, not a list: the list is the log.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// Documents whose vectors were written this pass.
    pub embedded: usize,
    /// Documents deliberately not embedded — not prose (NOTES §34).
    pub skipped: usize,
    /// Documents the model could not read this pass. Not recorded in the
    /// manifest, so the next pass tries them again.
    pub failed: usize,
}

/// Bring a whole vault's index up to date.
///
/// One pass over the tree comparing content hashes with the manifest. A
/// document whose hash still matches costs a read of a few KB and no model
/// work at all, so this is cheap to run on open and after any change.
///
/// **One document can never stop the pass.** Before §34 this loop used `?` on
/// the embed, so the single 3 MB shader key in Royce's vault ended the
/// backfill at document 858 of 858 — leaving the window saying "Reading 857
/// of 858…" with no manifest written and nothing on screen to say why. A
/// failure is now counted, logged with the document that caused it, and
/// stepped over; the manifest is written either way, so the 857 documents that
/// did work are not re-embedded on the next open.
///
/// Blocking. Callers are on a background thread.
pub fn sync_vault(
    embedder: &dyn Embedder,
    root: &Path,
    on_progress: &dyn Fn(usize, usize, &str),
) -> Result<SyncReport, String> {
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
    let mut report = SyncReport::default();
    for (i, rel) in paths.iter().enumerate() {
        // The path goes with the count, so a pass that is stuck says which
        // document it is stuck on. §34 would have been diagnosable from the
        // screen if this line had existed.
        on_progress(i, total, rel);
        let Ok(abs) = crate::vault::paths::resolve_in_root(root, rel) else { continue };
        let Ok(bytes) = std::fs::read(&abs) else { continue };
        let stamp = crate::fs_ops::stamp::hash_bytes(&bytes);
        // Rule 3: a matching stamp means this document is already settled —
        // either it was embedded and the vector file is really there, or it
        // was looked at and skipped, which is a decision worth remembering.
        // Editing the file changes the stamp, which re-opens the question.
        if let Some(entry) = manifest.docs.get(rel) {
            if entry.stamp == stamp
                && (!entry.has_vectors() || index::read_doc(root, &key, rel).is_some())
            {
                continue;
            }
        }
        let text = String::from_utf8_lossy(&bytes).to_string();
        match embed_document(embedder, rel, &text, &stamp) {
            Ok(DocOutcome::Embedded { doc, note }) => {
                if let Some(note) = &note {
                    eprintln!("[semantic] {rel}: {note}");
                }
                let chunks = doc.header.chunks.len();
                if let Err(e) = index::write_doc(root, &key, &doc) {
                    eprintln!("[semantic] skipped {rel}: {e}");
                    report.failed += 1;
                    continue;
                }
                let mut entry = index::DocEntry::embedded(stamp, chunks);
                entry.extra.extend(
                    note.map(|n| ("note".to_string(), serde_json::Value::String(n))),
                );
                manifest.docs.insert(rel.clone(), entry);
                report.embedded += 1;
            }
            Ok(DocOutcome::Skipped(reason)) => {
                eprintln!("[semantic] skipped {rel}: {reason}");
                // Whatever it used to be, it has no vectors now.
                index::remove_doc(root, &key, rel);
                manifest.docs.insert(rel.clone(), index::DocEntry::skipped(stamp, reason));
                report.skipped += 1;
            }
            Err(message) => {
                // The model, not the document. Nothing is written to the
                // manifest, so the next pass tries this one again — and the
                // pass carries on, because 857 good documents must not be
                // lost to one bad moment.
                eprintln!("[semantic] skipped {rel}: {message}");
                report.failed += 1;
            }
        }
    }
    on_progress(total, total, "");
    index::write_manifest(root, &key, &manifest)?;
    index::prune(root, &key, &manifest);
    Ok(report)
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
    if let Some(entry) = manifest.docs.get(rel) {
        if entry.stamp == stamp
            && (!entry.has_vectors() || index::read_doc(root, &key, rel).is_some())
        {
            return Ok(());
        }
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    match embed_document(embedder, rel, &text, &stamp)? {
        DocOutcome::Embedded { doc, note } => {
            if let Some(note) = &note {
                eprintln!("[semantic] {rel}: {note}");
            }
            let chunks = doc.header.chunks.len();
            index::write_doc(root, &key, &doc)?;
            manifest.docs.insert(rel.to_string(), index::DocEntry::embedded(stamp, chunks));
        }
        DocOutcome::Skipped(reason) => {
            eprintln!("[semantic] skipped {rel}: {reason}");
            index::remove_doc(root, &key, rel);
            manifest.docs.insert(rel.to_string(), index::DocEntry::skipped(stamp, reason));
        }
    }
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
            sync_vault(embedder.as_ref(), &root, &|done, total, path| {
                *h.state::<SemanticState>().progress.lock().unwrap() =
                    Some(IndexProgress { done, total, path: path.to_string() });
                let _ = h.emit(STATE_EVENT, h.state::<SemanticState>().status());
            })
        });
        *s.progress.lock().unwrap() = None;
        match result {
            Ok(report) => {
                eprintln!(
                    "[semantic] {workflow_id}: indexed {} documents, skipped {}, failed {}",
                    report.embedded, report.skipped, report.failed
                );
                *s.last_sync.lock().unwrap() = Some(report);
            }
            Err(message) => {
                eprintln!("[semantic] indexing {workflow_id} stopped: {message}");
                s.set_phase(Phase::Error, None, Some(message));
            }
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
    fn the_backfill_never_embeds_a_dependency_folder() {
        // The most expensive way to get this wrong: 2,870 generated READMEs
        // pushed through a neural network, once per vault open.
        let t = TempDir::new("semantic-walk");
        t.write("Drafts/Ch_01.md", "words");
        t.write("Research/Notes.md", "words");
        t.write("node_modules/react/README.md", "generated");
        t.write("node_modules/react/lib/README.md", "generated");
        t.write("Site/dist/index.md", "generated");
        t.write("Rust/target.nosync/debug/x.md", "generated");
        t.write(".aquarius/workflow.json", "{}");

        let mut paths = Vec::new();
        walk(t.path(), t.path(), 0, &mut paths);
        paths.sort();
        assert_eq!(paths, vec!["Drafts/Ch_01.md".to_string(), "Research/Notes.md".to_string()]);
    }

    /// An embedder that refuses one particular string, to stand in for the
    /// model having a bad moment on one document.
    struct FailsOn(&'static str);
    impl Embedder for FailsOn {
        fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
            if texts.iter().any(|t| t.contains(self.0)) {
                return Err("the model would not read that".into());
            }
            WordBagEmbedder.embed(texts)
        }
    }

    #[test]
    fn a_shader_key_is_recorded_as_skipped_and_never_embedded_twice() {
        let t = TempDir::new("semantic-hostile");
        t.write("Drafts/Ch_01.md", "The lantern went out on the stairs.");
        // 3 MB on one line, no spaces — the file from NOTES §34.
        t.write("Dump/key.txt", &"0123456789ABCDEF".repeat(200_000));

        let started = std::time::Instant::now();
        let report = sync_vault(&WordBagEmbedder, t.path(), &|_, _, _| {}).unwrap();
        assert_eq!(report.embedded, 1);
        assert_eq!(report.skipped, 1, "the dump is recorded, not embedded");
        assert_eq!(report.failed, 0);
        assert!(started.elapsed().as_secs() < 5, "the guard has to be the fast path");

        let key = model::model_key();
        let manifest = index::read_manifest(t.path(), &key).unwrap();
        let entry = manifest.docs.get("Dump/key.txt").expect("it is accounted for");
        assert!(entry.skipped.as_deref().unwrap_or("").starts_with("not prose:"));
        assert_eq!(entry.chunks, 0);
        assert!(index::read_doc(t.path(), &key, "Dump/key.txt").is_none(), "no vectors on disk");

        // And the decision sticks: the second pass does nothing at all.
        let again = sync_vault(&WordBagEmbedder, t.path(), &|_, _, _| {}).unwrap();
        assert_eq!((again.embedded, again.skipped), (0, 0));

        // Until the file changes, which re-opens the question.
        t.write("Dump/key.txt", "Actually this is a note now.");
        let after = sync_vault(&WordBagEmbedder, t.path(), &|_, _, _| {}).unwrap();
        assert_eq!((after.embedded, after.skipped), (1, 0));
        assert!(index::read_manifest(t.path(), &key).unwrap().docs["Dump/key.txt"].skipped.is_none());
    }

    #[test]
    fn one_document_the_model_refuses_does_not_stop_the_backfill() {
        // §34's actual failure: `?` on the embed ended the pass at document
        // 858 of 858 and wrote no manifest, so the 857 that worked were lost.
        let t = TempDir::new("semantic-continue");
        for i in 0..10 {
            t.write(&format!("Notes/Note {i:02}.md"), "the lantern went out");
        }
        t.write("Notes/Bad.md", "poison");

        let report = sync_vault(&FailsOn("poison"), t.path(), &|_, _, _| {}).unwrap();
        assert_eq!(report.embedded, 10, "every good document is indexed");
        assert_eq!(report.failed, 1);

        let key = model::model_key();
        let manifest = index::read_manifest(t.path(), &key).unwrap();
        assert_eq!(manifest.docs.len(), 10, "a failure is not recorded, so it is retried");
        assert!(!manifest.docs.contains_key("Notes/Bad.md"));
        // And the good work is kept: a second pass re-tries only the bad one.
        let again = sync_vault(&FailsOn("poison"), t.path(), &|_, _, _| {}).unwrap();
        assert_eq!((again.embedded, again.failed), (0, 1));
    }

    /// The §34 reproduction, against the real model rather than the fake one.
    ///
    /// The fake embedder cannot show this: the cost was always the *tokenizer*,
    /// and the fake has none. Skipped on a machine with no model, and a failure
    /// in CI where the model is downloaded — same rule as
    /// `embed::tests::a_real_model_embeds_one_string`.
    #[test]
    fn a_real_model_never_sees_the_shader_key() {
        let Some(dir) = std::env::var_os("AQ_SEMANTIC_MODEL_DIR") else {
            assert!(std::env::var_os("CI").is_none(), "AQ_SEMANTIC_MODEL_DIR is unset in CI");
            eprintln!("skipped: set AQ_SEMANTIC_MODEL_DIR to a bge-small folder to run this");
            return;
        };
        let embedder = super::FastEmbed::load(Path::new(&dir)).expect("load the model");

        let t = TempDir::new("semantic-hostile-real");
        for i in 0..50 {
            t.write(
                &format!("Notes/Note {i:02}.md"),
                "She counted the stairs on the way down and lost the number twice over.",
            );
        }
        t.write("Dump/DDCKey-Editor.txt", &"0123456789ABCDEF".repeat(200_000));

        let started = std::time::Instant::now();
        let report = sync_vault(&embedder, t.path(), &|_, _, _| {}).unwrap();
        let took = started.elapsed();
        assert_eq!(report.embedded, 50);
        assert_eq!(report.skipped, 1);
        assert_eq!(report.failed, 0);
        eprintln!("[bench] 50 notes + one 3 MB shader key: {took:?}");

        // And the model can still answer a question about the fifty.
        let hits = search_with(&embedder, t.path(), "counting steps downstairs", 5).unwrap();
        assert!(!hits.is_empty(), "the vault is searchable, dump and all");
        assert!(
            hits.iter().all(|h| !h.path.contains("DDCKey")),
            "a skipped document can never come back as a hit"
        );
    }

    #[test]
    fn progress_says_which_document_it_is_reading() {
        let t = TempDir::new("semantic-progress");
        t.write("Drafts/Ch_01.md", "the lantern");
        t.write("Drafts/Ch_02.md", "the letter");
        let seen = std::sync::Mutex::new(Vec::new());
        sync_vault(&WordBagEmbedder, t.path(), &|done, total, path| {
            seen.lock().unwrap().push((done, total, path.to_string()));
        })
        .unwrap();
        let seen = seen.into_inner().unwrap();
        assert_eq!(seen.first().unwrap(), &(0, 2, "Drafts/Ch_01.md".to_string()));
        assert_eq!(seen.last().unwrap(), &(2, 2, String::new()), "the last tick is the total");
    }

    #[test]
    fn embedding_a_document_skips_the_frontmatter_and_numbers_body_lines() {
        let text = "---\ntitle: Chapter One\nstatus: drafting\n---\nThe first body line.\n\nA second paragraph.";
        let DocOutcome::Embedded { doc, .. } =
            embed_document(&WordBagEmbedder, "a.md", text, "stamp1").unwrap()
        else {
            panic!("a note with two paragraphs in it is prose")
        };
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

        let report = sync_vault(&WordBagEmbedder, t.path(), &|_, _, _| {}).unwrap();
        assert_eq!(report.embedded, 2, "two documents; the image and the metadata are not prose");
        assert_eq!(report.skipped, 0);

        let key = model::model_key();
        let manifest = index::read_manifest(t.path(), &key).unwrap();
        assert_eq!(manifest.docs.len(), 2);
        assert!(manifest.docs.contains_key("Drafts/Ch_01.md"));

        assert_eq!(
            sync_vault(&WordBagEmbedder, t.path(), &|_, _, _| {}).unwrap().embedded,
            0,
            "nothing changed, so nothing was re-embedded"
        );
    }

    #[test]
    fn an_edit_re_embeds_only_that_document() {
        let t = TempDir::new("semantic-edit");
        t.write("a.md", "the lantern");
        t.write("b.md", "the letter");
        sync_vault(&WordBagEmbedder, t.path(), &|_, _, _| {}).unwrap();
        let key = model::model_key();
        let b_before = index::read_doc(t.path(), &key, "b.md").unwrap();

        t.write("a.md", "the lantern and the long dark stairs");
        assert_eq!(sync_vault(&WordBagEmbedder, t.path(), &|_, _, _| {}).unwrap().embedded, 1);
        assert_eq!(index::read_doc(t.path(), &key, "b.md").unwrap(), b_before, "b was untouched");
    }

    #[test]
    fn a_deleted_document_loses_its_vectors() {
        let t = TempDir::new("semantic-delete");
        t.write("a.md", "the lantern");
        t.write("b.md", "the letter");
        sync_vault(&WordBagEmbedder, t.path(), &|_, _, _| {}).unwrap();
        let key = model::model_key();

        std::fs::remove_file(t.path().join("b.md")).unwrap();
        sync_vault(&WordBagEmbedder, t.path(), &|_, _, _| {}).unwrap();
        assert!(index::read_doc(t.path(), &key, "b.md").is_none());
        assert!(!index::read_manifest(t.path(), &key).unwrap().docs.contains_key("b.md"));
    }

    #[test]
    fn a_rename_carries_the_vectors_across_without_re_embedding() {
        let t = TempDir::new("semantic-rename");
        t.write("a.md", "the lantern went out");
        sync_vault(&WordBagEmbedder, t.path(), &|_, _, _| {}).unwrap();
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
        assert_eq!(sync_vault(&WordBagEmbedder, t.path(), &|_, _, _| {}).unwrap().embedded, 0);
    }

    #[test]
    fn a_search_ranks_documents_and_respects_the_limit() {
        let t = TempDir::new("semantic-search");
        t.write("lantern.md", "The lantern went out on the stairs.");
        t.write("letter.md", "She read the letter twice and burned it.");
        t.write("engine.md", "The carburettor needed a new gasket.");
        sync_vault(&WordBagEmbedder, t.path(), &|_, _, _| {}).unwrap();

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
        sync_vault(&WordBagEmbedder, t.path(), &|_, _, _| {}).unwrap();
        let key = model::model_key();

        // Rewrite the manifest as if a different model file had built it.
        let mut manifest = index::read_manifest(t.path(), &key).unwrap();
        manifest.model.sha256 = "0".repeat(64);
        index::write_manifest(t.path(), &key, &manifest).unwrap();

        assert_eq!(
            sync_vault(&WordBagEmbedder, t.path(), &|_, _, _| {}).unwrap().embedded,
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
