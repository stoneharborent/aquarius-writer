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

use crate::aux_store;
use crate::fs_ops::atomic::{write_atomic, WriteOutcome};
use crate::fs_ops::stamp;
use crate::fs_ops::watcher::SelfWrites;
use crate::model::{FileRead, FileStamp, WriteResult, Workflow};
use crate::vault::{frontmatter, paths, scaffold, workflow};
use serde::Serialize;
use std::path::{Path, PathBuf};

pub type OpResult<T> = Result<T, String>;

fn resolve(root: &Path, rel: &str) -> OpResult<PathBuf> {
    paths::resolve_in_root(root, rel).map_err(|e| e.0)
}

/// Like `resolve`, but `""` means the vault root — the only path the renderer
/// ever sends for "the top of the tree".
fn resolve_dir(root: &Path, rel: &str) -> OpResult<PathBuf> {
    if rel.is_empty() {
        Ok(root.to_path_buf())
    } else {
        resolve(root, rel)
    }
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
    /// SHA-256 of the bytes this was read from. Hand it back as
    /// `expected_hash` on a write and the write is refused if anything else
    /// changed the file in between.
    pub hash: String,
}

pub fn read_document(root: &Path, rel: &str) -> OpResult<DocumentRead> {
    let read = read_file(root, rel)?;
    let parsed = frontmatter::parse(&read.content);
    Ok(DocumentRead {
        path: read.path,
        words: frontmatter::count_words(&parsed.body),
        body: parsed.body,
        frontmatter: parsed.frontmatter,
        content: read.content,
        hash: read.stamp.hash,
    })
}

/// A document's text and the stamp of the bytes it came from.
///
/// The stamp is computed from the raw bytes, not from `content` — `read_text`
/// is lossy, and a file with one invalid byte would otherwise hash differently
/// every time it went past the guard.
pub fn read_file(root: &Path, rel: &str) -> OpResult<FileRead> {
    let path = resolve(root, rel)?;
    if !path.is_file() {
        return Err(format!("no document at {rel}"));
    }
    let bytes = crate::fs_ops::read_bytes(&path).map_err(|e| format!("{rel}: {e}"))?;
    Ok(FileRead {
        path: rel.to_string(),
        content: String::from_utf8_lossy(&bytes).into_owned(),
        stamp: stamp::stamp_for(&path, &bytes),
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
///
/// **Unguarded.** This is the force-write: it wins over whatever is on disk.
/// Callers that hold a baseline — the editor's save path, an MCP client that
/// read the file first — want [`write_document_checked`] instead.
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

// ── the conflict guard (PARITY row 9) ────────────────────────────────────
//
// Until now a save always won. Open a chapter, let something else edit it —
// a sync client, a script, an MCP tool, the writer's own second window — and
// the next autosave wrote the editor's copy straight over it. The dialog for
// this existed in the UI from the start and nothing ever raised it
// (docs/NOTES.md §8).
//
// What raises it now is one rule: **a write that carries a baseline is refused
// when the file on disk has stopped matching it.** The baseline is a content
// hash, not an mtime — see `fs_ops::stamp` for the full argument, of which the
// short form is that this vault lives in iCloud and iCloud re-stamps files it
// did not rewrite.
//
// Three things the guard deliberately does *not* refuse:
//
// * **A write with no baseline.** Every existing caller (a restore, a
//   find-and-replace, `set_frontmatter_status`) passes `None` and behaves
//   exactly as it did before. Opting in is what makes this safe to land.
// * **A file that is gone.** Deleted underneath an open editor, the write
//   recreates it. There is nothing on disk to lose, and refusing would strand
//   the writer's text in a buffer with nowhere to go.
// * **Someone else having written the identical bytes.** Two routes to the
//   same text is not a disagreement; it is reported as an unchanged write.

/// Write `content` unless the file has moved out from under `expected`.
///
/// `expected` is the stamp from the `FileRead` the caller last saw. `None`
/// means "no baseline" and is an unconditional write. Only `expected.hash`
/// decides; a stamp carrying `mtimeMs: 0` (all an MCP client can supply) is
/// judged on its hash alone.
pub fn write_document_checked(
    root: &Path,
    rel: &str,
    content: &str,
    expected: Option<&FileStamp>,
    self_writes: &SelfWrites,
) -> OpResult<WriteResult> {
    write_guarded(root, rel, content, expected, None, self_writes)
}

/// The MCP server's door onto a write: guard first, then snapshot the text
/// that is about to be replaced, then write.
///
/// The snapshot is the fix for docs/NOTES.md §13j — an agent's overwrite used
/// to leave nothing behind, so "undo what the AI just did" meant hoping the
/// editor happened to have autosaved. It is taken only when the write is
/// actually going to change something: a refused write replaced nothing, and
/// neither did a byte-identical one.
pub fn agent_write_document(
    root: &Path,
    rel: &str,
    content: &str,
    expected_hash: Option<&str>,
    self_writes: &SelfWrites,
) -> OpResult<WriteResult> {
    // A client sends a hash, never a timestamp — it has no business knowing
    // one. `mtimeMs: 0` is "unknown", which the guard reads as "judge me on
    // the hash", which is what it does for everybody anyway.
    let expected =
        expected_hash.map(|h| FileStamp { hash: h.to_string(), mtime_ms: 0, bytes: 0 });
    write_guarded(
        root,
        rel,
        content,
        expected.as_ref(),
        Some(aux_store::AGENT_SNAPSHOT_LABEL),
        self_writes,
    )
}

fn write_guarded(
    root: &Path,
    rel: &str,
    content: &str,
    expected: Option<&FileStamp>,
    snapshot_label: Option<&str>,
    self_writes: &SelfWrites,
) -> OpResult<WriteResult> {
    let path = resolve(root, rel)?;
    let on_disk = stamp::stamp_of(&path);
    let next_hash = stamp::hash_bytes(content.as_bytes());

    if let (Some(expected), Some(current)) = (expected, on_disk.as_ref()) {
        if current.hash != expected.hash {
            // Already exactly what we were going to write. Somebody got there
            // first with the same text — nothing to disagree about.
            if current.hash == next_hash {
                return Ok(WriteResult::Written {
                    path: rel.to_string(),
                    changed: false,
                    stamp: current.clone(),
                });
            }
            let theirs = crate::fs_ops::read_text(&path).map_err(|e| format!("{rel}: {e}"))?;
            return Ok(WriteResult::Conflict {
                path: rel.to_string(),
                theirs,
                stamp: current.clone(),
            });
        }
        // Same bytes, different clock: the sync daemon touched the file
        // without rewriting it. Worth a line in the log for whoever goes
        // looking; never a reason to refuse the writer's save.
        if stamp::mtime_moved(current, expected) {
            eprintln!(
                "[vault] {rel}: mtime moved ({} → {}) but the bytes did not — writing anyway",
                expected.mtime_ms, current.mtime_ms
            );
        }
    }

    // Nothing is replaced by a write that changes nothing, so nothing needs
    // protecting from it.
    let replacing = on_disk.as_ref().filter(|s| s.hash != next_hash);
    if let (Some(label), Some(_)) = (snapshot_label, replacing) {
        let text = crate::fs_ops::read_text(&path).map_err(|e| format!("{rel}: {e}"))?;
        if let Err(e) =
            aux_store::snapshot_document(root, rel, label, &text, crate::vault::registry::now_ms())
        {
            // The snapshot is a safety net, not the operation. Say so and
            // carry on rather than refusing a write the caller is entitled
            // to make.
            eprintln!("[vault] {rel}: could not snapshot before the write: {e}");
        }
    }

    self_writes.record(&path);
    let outcome = write_atomic(&path, content.as_bytes()).map_err(|e| format!("{rel}: {e}"))?;
    Ok(WriteResult::Written {
        path: rel.to_string(),
        changed: outcome == WriteOutcome::Written,
        stamp: stamp::stamp_for(&path, content.as_bytes()),
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

// ── new files and folders, renaming, moving ──────────────────────────────
//
// Wave 1 rows 5–6 of docs/PARITY.md: until now an MCP client could create a
// document in the writer's vault and the writer could not, and neither could
// rename or move anything. All four operations live here so the sidebar's add
// menu and the `create_document` / `rename_document` / `move_document` tools
// are literally the same code.
//
// Three rules hold across all of them:
//
// * **One segment, never a path.** Names go through `scaffold::validate_name`,
//   which is the same check "Create new workflow" uses: no separators, no
//   `..`, no leading dot, no reserved characters. Where the entry *lands* is
//   the caller's separate `parent` argument, always resolved through
//   `paths::resolve_in_root`.
// * **A collision never overwrites.** "Chapter One" becomes "Chapter One 2",
//   then "Chapter One 3" — the Swift app's behaviour (SWIFT-AUDIT §1.4), and
//   the only one that can't silently eat a file.
// * **History follows the file.** A rename or move migrates the document's
//   snapshot folder and its `comments.json` key (`aux_store::migrate_*`) in
//   the same call, so version history is attached to the document rather than
//   to the name it used to have.

/// A file or folder after it was created, renamed or moved.
///
/// Enough for the renderer to patch its tree without a full reload: `kind`
/// matches `NodeKind` in `src/types/vault.ts`, and `name` is what the sidebar
/// paints — markdown drops its extension, everything else keeps it, the same
/// rule `vault::tree` follows.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntryReport {
    /// Where it is now, vault-relative.
    pub path: String,
    /// Display name for the tree row.
    pub name: String,
    /// "folder" | "markdown" | "fountain" | "image" | "pdf" | "other".
    pub kind: String,
    /// Where it was before a rename or move. `None` for a fresh create.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// True when the requested name was taken and a " 2"/" 3" suffix was used.
    pub renamed: bool,
}

/// The document kinds the add menu offers, and the extension each gets.
pub const NEW_FILE_KINDS: &[(&str, &str)] = &[("markdown", "md"), ("fountain", "fountain")];

fn extension_for(kind: &str) -> OpResult<&'static str> {
    NEW_FILE_KINDS
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, ext)| *ext)
        .ok_or_else(|| {
            format!(
                "unknown file kind \"{kind}\" — expected one of {}",
                NEW_FILE_KINDS.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", ")
            )
        })
}

/// The display name `vault::tree` would give this file — markdown without its
/// extension, everything else with.
fn display_name(file_name: &str, kind: &str) -> String {
    if kind == "markdown" {
        Path::new(file_name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| file_name.to_string())
    } else {
        file_name.to_string()
    }
}

/// `stem` (+ `.ext`), suffixed " 2", " 3", … until nothing is in the way.
///
/// `pub(crate)` since Compile: an export lands in a folder the writer chose,
/// and "never silently overwrite" has to mean the same thing there as it does
/// in the sidebar's add menu.
pub(crate) fn dedupe(dir: &Path, stem: &str, ext: Option<&str>) -> String {
    let build = |s: &str| match ext {
        Some(e) => format!("{s}.{e}"),
        None => s.to_string(),
    };
    let mut candidate = build(stem);
    let mut n = 2;
    // The ceiling is a guard against a pathological folder, not a real limit:
    // a thousand "Untitled" files in one place is already a different problem.
    while dir.join(&candidate).exists() && n < 1000 {
        candidate = build(&format!("{stem} {n}"));
        n += 1;
    }
    candidate
}

fn join_rel(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

/// Split a file name the way a rename needs it: (stem, extension).
fn split_name(file_name: &str) -> (String, Option<String>) {
    let p = Path::new(file_name);
    match (p.file_stem(), p.extension()) {
        (Some(stem), Some(ext)) => (
            stem.to_string_lossy().to_string(),
            Some(ext.to_string_lossy().to_string()),
        ),
        _ => (file_name.to_string(), None),
    }
}

/// Stamp every path in a subtree, so a folder move doesn't wake the watcher.
///
/// The ledger matches whole paths, and moving a folder emits an event for each
/// file inside it. Recording only the folder would leave every child looking
/// like an external edit — one spurious tree reload per move.
fn record_tree(self_writes: &SelfWrites, path: &Path) {
    self_writes.record(path);
    let Ok(entries) = std::fs::read_dir(path) else { return };
    for entry in entries.filter_map(Result::ok) {
        let child = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            record_tree(self_writes, &child);
        } else {
            self_writes.record(&child);
        }
    }
}

/// Starting text for a new document.
///
/// Mirrors what `scaffold::lay_out` writes for a brand-new workflow, so a file
/// made from the add menu opens looking like one the app made itself: markdown
/// gets a title/status frontmatter block and an H1, Fountain gets a title page
/// and a slug line.
fn seed_for(kind: &str, title: &str) -> String {
    match kind {
        "fountain" => format!(
            "Title: {title}\nCredit: Written by\nAuthor: \nDraft date: \n\nFADE IN:\n\nINT. SOMEWHERE — DAY\n\n"
        ),
        // Frontmatter only — the editor already shows `title`, so a body
        // heading would print the name twice (bench find, 2026-08-31).
        _ => format!("---\ntitle: {title}\nstatus: outline\n---\n\n"),
    }
}

/// Create a document in `parent` (`""` for the vault root).
///
/// `kind` is "markdown" or "fountain" — the two the sidebar's segmented picker
/// offers. The extension is ours to choose; a name that already carries the
/// right one is not given it twice.
pub fn create_file(
    root: &Path,
    parent: &str,
    name: &str,
    kind: &str,
    self_writes: &SelfWrites,
) -> OpResult<EntryReport> {
    let ext = extension_for(kind)?;
    let requested = scaffold::validate_name(name)?;
    // "Chapter One.md" and "Chapter One" both mean the same file.
    let stem = match requested.strip_suffix(&format!(".{ext}")) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => requested,
    };

    let dir = resolve_dir(root, parent)?;
    guard_not_metadata(root, &dir)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {parent}: {e}"))?;

    let file_name = dedupe(&dir, &stem, Some(ext));
    let target = dir.join(&file_name);
    // The de-duplicated stem, so a second "Chapter One" is titled
    // "Chapter One 2" inside the file as well as on disk.
    let title = split_name(&file_name).0;

    self_writes.record(&target);
    write_atomic(&target, seed_for(kind, &title).as_bytes())
        .map_err(|e| format!("could not create {file_name}: {e}"))?;

    Ok(EntryReport {
        path: join_rel(parent, &file_name),
        name: display_name(&file_name, kind),
        kind: kind.to_string(),
        from: None,
        renamed: file_name != format!("{stem}.{ext}"),
    })
}

/// Create an empty folder in `parent` (`""` for the vault root).
pub fn create_folder(
    root: &Path,
    parent: &str,
    name: &str,
    self_writes: &SelfWrites,
) -> OpResult<EntryReport> {
    let requested = scaffold::validate_name(name)?;
    let dir = resolve_dir(root, parent)?;
    guard_not_metadata(root, &dir)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {parent}: {e}"))?;

    let folder_name = dedupe(&dir, &requested, None);
    let target = dir.join(&folder_name);
    self_writes.record(&target);
    std::fs::create_dir(&target).map_err(|e| format!("could not create {folder_name}: {e}"))?;

    Ok(EntryReport {
        path: join_rel(parent, &folder_name),
        name: folder_name.clone(),
        kind: "folder".into(),
        from: None,
        renamed: folder_name != requested,
    })
}

/// Rename a file or folder in place.
///
/// A file keeps its extension unless the new name carries one: renaming
/// "Ch_03.md" to "Helmreach in Rain" gives "Helmreach in Rain.md", which is
/// what a writer typing over a tree row means.
pub fn rename_entry(
    root: &Path,
    rel: &str,
    new_name: &str,
    self_writes: &SelfWrites,
) -> OpResult<EntryReport> {
    let source = resolve(root, rel)?;
    guard_movable(root, rel, &source)?;
    let parent_rel = parent_of(rel);
    let dir = source
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("{rel} has no parent folder"))?;

    let is_dir = source.is_dir();
    let requested = scaffold::validate_name(new_name)?;
    let (mut stem, mut ext) = split_name(&requested);
    if !is_dir && ext.is_none() {
        // No extension typed: keep the one the file already has.
        ext = split_name(&file_name_of(rel)).1;
    }
    if is_dir {
        stem = requested.clone();
        ext = None;
    }

    let target_name = match &ext {
        Some(e) => format!("{stem}.{e}"),
        None => stem.clone(),
    };
    if target_name == file_name_of(rel) {
        // Nothing to do, and renaming a path onto itself would trip the
        // de-duplicator into inventing a " 2".
        return Ok(unchanged_report(root, rel, is_dir));
    }

    let final_name = dedupe(&dir, &stem, ext.as_deref());
    let dest_rel = join_rel(&parent_rel, &final_name);
    finish_move(root, rel, &dest_rel, &source, &dir.join(&final_name), is_dir, self_writes)?;
    Ok(move_report(rel, &dest_rel, &final_name, is_dir, final_name != target_name))
}

/// Move a file or folder into `dest_folder` (`""` for the vault root), keeping
/// its name.
pub fn move_entry(
    root: &Path,
    rel: &str,
    dest_folder: &str,
    self_writes: &SelfWrites,
) -> OpResult<EntryReport> {
    let source = resolve(root, rel)?;
    guard_movable(root, rel, &source)?;
    let dir = resolve_dir(root, dest_folder)?;
    guard_not_metadata(root, &dir)?;
    if !dir.is_dir() {
        return Err(format!("no folder at {}", if dest_folder.is_empty() { "the vault root" } else { dest_folder }));
    }

    let is_dir = source.is_dir();
    // Moving a folder into itself (or into one of its own children) would
    // detach the whole subtree from the vault.
    if is_dir && (dest_folder == rel || dest_folder.starts_with(&format!("{rel}/"))) {
        return Err(format!("cannot move \"{rel}\" inside itself"));
    }
    if parent_of(rel) == dest_folder {
        return Ok(unchanged_report(root, rel, is_dir));
    }

    let name = file_name_of(rel);
    let (stem, ext) = if is_dir { (name.clone(), None) } else { split_name(&name) };
    let final_name = dedupe(&dir, &stem, ext.as_deref());
    let dest_rel = join_rel(dest_folder, &final_name);
    finish_move(root, rel, &dest_rel, &source, &dir.join(&final_name), is_dir, self_writes)?;
    Ok(move_report(rel, &dest_rel, &final_name, is_dir, final_name != name))
}

/// The shared tail of rename and move: stamp the ledger, move the bytes, carry
/// the aux data across.
fn finish_move(
    root: &Path,
    from_rel: &str,
    to_rel: &str,
    source: &Path,
    target: &Path,
    is_dir: bool,
    self_writes: &SelfWrites,
) -> OpResult<()> {
    // Both ends, and the whole subtree, before the move — after it the source
    // paths no longer exist to walk.
    if is_dir {
        record_tree(self_writes, source);
    } else {
        self_writes.record(source);
    }
    self_writes.record(target);

    // `rename` keeps the bytes exactly as they are, which is what makes a move
    // of a frontmatter-less file byte-identical: nothing reads or rewrites the
    // content at any point in this path.
    if std::fs::rename(source, target).is_err() {
        // Different filesystem (a vault spanning a mount point). Copy, verify
        // the copy landed, then drop the original.
        if is_dir {
            copy_dir(source, target).map_err(|e| format!("could not move {from_rel}: {e}"))?;
            std::fs::remove_dir_all(source).map_err(|e| format!("could not remove {from_rel}: {e}"))?;
        } else {
            std::fs::copy(source, target).map_err(|e| format!("could not move {from_rel}: {e}"))?;
            std::fs::remove_file(source).map_err(|e| format!("could not remove {from_rel}: {e}"))?;
        }
    }
    if is_dir {
        record_tree(self_writes, target);
    }

    // History follows the file. A failure here has not lost anything — the
    // document is at its new path either way — so it is reported, not fatal.
    let migrated = if is_dir {
        aux_store::migrate_folder(root, from_rel, to_rel)
    } else {
        aux_store::migrate_document(root, from_rel, to_rel)
    };
    if let Err(e) = migrated {
        eprintln!("[vault] {from_rel} → {to_rel}: version history did not follow it: {e}");
    }
    if let Err(e) = follow_in_workflow(root, from_rel, to_rel, self_writes) {
        eprintln!("[vault] {from_rel} → {to_rel}: workflow.json not updated: {e}");
    }
    Ok(())
}

/// Point `workflow.json` at the new path.
///
/// Manuscripts address their chapters by path. Without this a renamed chapter
/// would fall out of the manuscript order, and `reconcile_chapter_order` would
/// re-append it at the *end* on the next open — a rename would silently
/// reorder the book.
fn follow_in_workflow(
    root: &Path,
    from_rel: &str,
    to_rel: &str,
    self_writes: &SelfWrites,
) -> OpResult<()> {
    let (mut wf, _) = workflow::read_or_create(root).map_err(|e| e.to_string())?;
    let prefix = format!("{from_rel}/");
    let remap = |p: &str| -> Option<String> {
        if p == from_rel {
            Some(to_rel.to_string())
        } else {
            p.strip_prefix(&prefix).map(|rest| format!("{to_rel}/{rest}"))
        }
    };

    let mut changed = false;
    for manuscript in wf.manuscripts.iter_mut() {
        if let Some(next) = remap(&manuscript.folder) {
            manuscript.folder = next;
            changed = true;
        }
        for chapter in manuscript.chapter_order.iter_mut() {
            if let Some(next) = remap(chapter) {
                *chapter = next;
                changed = true;
            }
        }
    }
    for draft in wf.drafts.iter_mut() {
        if let Some(folder) = draft.folder.as_deref().and_then(remap) {
            draft.folder = Some(folder);
            changed = true;
        }
        for chapter in draft.chapter_order.iter_mut() {
            if let Some(next) = remap(chapter) {
                *chapter = next;
                changed = true;
            }
        }
    }
    if changed {
        save_workflow(root, &wf, self_writes)?;
    }
    Ok(())
}

fn move_report(from: &str, to: &str, name: &str, is_dir: bool, renamed: bool) -> EntryReport {
    let kind = if is_dir { "folder".to_string() } else { crate::vault::tree::kind_for(name).to_string() };
    EntryReport {
        path: to.to_string(),
        name: display_name(name, &kind),
        kind,
        from: Some(from.to_string()),
        renamed,
    }
}

fn unchanged_report(_root: &Path, rel: &str, is_dir: bool) -> EntryReport {
    let name = file_name_of(rel);
    let kind = if is_dir { "folder".to_string() } else { crate::vault::tree::kind_for(&name).to_string() };
    EntryReport {
        path: rel.to_string(),
        name: display_name(&name, &kind),
        kind,
        from: Some(rel.to_string()),
        renamed: false,
    }
}

fn file_name_of(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).to_string()
}

fn parent_of(rel: &str) -> String {
    match rel.rfind('/') {
        Some(i) => rel[..i].to_string(),
        None => String::new(),
    }
}

/// Refuse anything that would reach into `.aquarius/`. The metadata folder is
/// never in the tree, so a path pointing at it came from a caller inventing
/// one, and letting a move land there could scramble the trash index or a
/// snapshot trail.
fn guard_not_metadata(root: &Path, path: &Path) -> OpResult<()> {
    if paths::is_metadata(root, path) {
        return Err("that path is inside the app's .aquarius/ folder".into());
    }
    Ok(())
}

fn guard_movable(root: &Path, rel: &str, source: &Path) -> OpResult<()> {
    if rel.is_empty() {
        return Err("the vault root itself cannot be renamed or moved".into());
    }
    guard_not_metadata(root, source)?;
    if paths::is_ignored_name(&file_name_of(rel)) {
        return Err(format!("{rel}: that name is reserved for app temporaries"));
    }
    if !source.exists() {
        return Err(format!("nothing at {rel}"));
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)?.filter_map(Result::ok) {
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

// ── stars and soft delete ────────────────────────────────────────────────
//
// Wave 1 row 4 of docs/PARITY.md. A star is metadata about a tree row, not a
// property of the file, so it lives in `.aquarius/favorites.json` and never
// touches the document's bytes — the same reasoning that keeps snapshots and
// comments out of the file.

/// A row's star after it was flipped.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StarReport {
    pub path: String,
    pub starred: bool,
}

/// Star, unstar, or flip a file or folder.
///
/// `starred` is `None` for a toggle. The path has to exist: a star on a row
/// that isn't in the tree would sit in the Starred quick view as something the
/// writer cannot open, and is almost always a caller's typo.
pub fn set_star(root: &Path, rel: &str, starred: Option<bool>) -> OpResult<StarReport> {
    if rel.is_empty() {
        return Err("the vault root itself cannot be starred".into());
    }
    let target = resolve(root, rel)?;
    guard_not_metadata(root, &target)?;
    if !target.exists() {
        return Err(format!("nothing at {rel}"));
    }
    let next = match starred {
        Some(want) => aux_store::set_favorite(root, rel, want),
        None => aux_store::toggle_favorite(root, rel),
    }
    .map_err(|e| format!("{rel}: could not save the star: {e}"))?;
    Ok(StarReport { path: rel.to_string(), starred: next })
}

/// The starred rows in this vault, sorted.
pub fn list_stars(root: &Path) -> Vec<String> {
    aux_store::read_favorites(root)
}

/// Move a file or folder into `.aquarius/trash/`.
///
/// Both doors go through here so that the star bookkeeping cannot be forgotten
/// on one of them: a trashed row loses its star (and, for a folder, so does
/// everything inside it) in the same call.
pub fn trash_entry(
    root: &Path,
    rel: &str,
    self_writes: &SelfWrites,
) -> OpResult<crate::fs_ops::trash::TrashRecord> {
    let target = resolve(root, rel)?;
    guard_not_metadata(root, &target)?;
    self_writes.record(&target);
    let record = crate::fs_ops::trash::soft_delete(root, rel, crate::vault::registry::now_ms())
        .map_err(|e| format!("{rel}: {e}"))?;
    // The file is already in the trash; a star left behind is untidy, not
    // dangerous, so this is reported rather than fatal.
    if let Err(e) = aux_store::forget_favorite(root, rel) {
        eprintln!("[vault] {rel}: could not drop its star: {e}");
    }
    Ok(record)
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

/// Set a document's `synopsis` frontmatter key.
///
/// The corkboard card and the outline row both read this key, and it is the
/// one value a writer routinely gives more than one line — so a value with a
/// newline in it is written as a `key: |` block rather than being flattened.
/// Everything else in the file, frontmatter included, survives byte for byte
/// (`frontmatter::upsert` is line surgery, not a reserialise).
pub fn set_synopsis(
    root: &Path,
    rel: &str,
    text: &str,
    self_writes: &SelfWrites,
) -> OpResult<WriteReport> {
    set_frontmatter(root, rel, "synopsis", text, self_writes)
}

// ── line-addressed edits (PARITY row 17) ─────────────────────────────────
//
// `write_document` replaces a whole file, which is the honest primitive but a
// wasteful one: rewriting a 4,000-word chapter to change a sentence sends the
// chapter twice and gives the guard the whole file to disagree about. These
// three do the splice on this side.
//
// **Line numbers count body lines, not file lines.** A document's frontmatter
// is metadata the writer does not see in the editor, and a client that counted
// it would be off by the height of a block it never asked about. So line 1 is
// the first line of the body, `frontmatter::parse`'s definition of body, and
// the frontmatter block is carried across untouched. `fountain::collect_scenes`
// numbers scenes the same way, which is what lets a scene's range be handed
// straight to `replace_lines`.
//
// All three go through `agent_write_document`, so they get the same
// auto-snapshot, the same optional `expected_hash` guard and the same ledger
// stamping a full `write_document` does.

/// Split a document into its frontmatter block and its body.
///
/// `prefix + body == content`, byte for byte: `body` is a suffix of `content`
/// (the parser only ever drops leading lines), so the split is arithmetic
/// rather than a re-render. `("", content)` when there is no frontmatter.
pub fn split_body(content: &str) -> (&str, &str) {
    let body_len = frontmatter::parse(content).body.len();
    let cut = content.len() - body_len;
    debug_assert_eq!(&content[cut..], frontmatter::parse(content).body);
    (&content[..cut], &content[cut..])
}

/// Read a document and hand back its frontmatter prefix and body lines.
fn body_lines(root: &Path, rel: &str) -> OpResult<(String, Vec<String>)> {
    let content = read_file(root, rel)?.content;
    let (prefix, body) = split_body(&content);
    let lines = body.split('\n').map(str::to_string).collect();
    Ok((prefix.to_string(), lines))
}

/// Insert `text` after body line `after_line` (1-based; 0 means the top).
///
/// `after_line` past the end of the document appends — a client that means
/// "at the end" and guesses the line count high should not get an error for it.
pub fn insert_text(
    root: &Path,
    rel: &str,
    after_line: usize,
    text: &str,
    expected_hash: Option<&str>,
    self_writes: &SelfWrites,
) -> OpResult<WriteResult> {
    let (prefix, mut lines) = body_lines(root, rel)?;
    let at = after_line.min(lines.len());
    let inserted: Vec<String> = text.split('\n').map(str::to_string).collect();
    lines.splice(at..at, inserted);
    agent_write_document(root, rel, &format!("{prefix}{}", lines.join("\n")), expected_hash, self_writes)
}

/// Replace body lines `from_line..=to_line` (1-based, inclusive) with `text`.
///
/// The range has to start inside the document; `to_line` past the end is
/// clamped to it, so "replace from here to the end" does not need an exact
/// line count. A `from_line` past the end is refused rather than treated as an
/// append — that is `insert_text`, and guessing between the two would be a way
/// to lose an edit silently.
pub fn replace_lines(
    root: &Path,
    rel: &str,
    from_line: usize,
    to_line: usize,
    text: &str,
    expected_hash: Option<&str>,
    self_writes: &SelfWrites,
) -> OpResult<WriteResult> {
    let (prefix, mut lines) = body_lines(root, rel)?;
    if from_line < 1 {
        return Err("from_line is 1-based — the first line of the body is 1".into());
    }
    if to_line < from_line {
        return Err(format!("to_line ({to_line}) is before from_line ({from_line})"));
    }
    if from_line > lines.len() {
        return Err(format!(
            "{rel} has {} body lines, so there is no line {from_line} to replace — use insert_text to add to the end",
            lines.len()
        ));
    }
    let lo = from_line - 1;
    let hi = to_line.min(lines.len());
    let replacement: Vec<String> = text.split('\n').map(str::to_string).collect();
    lines.splice(lo..hi, replacement);
    agent_write_document(root, rel, &format!("{prefix}{}", lines.join("\n")), expected_hash, self_writes)
}

/// What a find-and-replace did.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceReport {
    /// How many occurrences were replaced. Zero is a valid answer and not an
    /// error: the file is left exactly as it was.
    pub replacements: usize,
    pub result: WriteResult,
}

/// Plain-string find and replace across a whole document.
///
/// Not a regular expression — "." and "*" match themselves, the same promise
/// `search` makes. `all` replaces every occurrence; `false` replaces only the
/// first. The search covers the whole file including the frontmatter block,
/// because a client renaming a character wants the `title:` key changed too.
pub fn replace_in_document(
    root: &Path,
    rel: &str,
    find: &str,
    replace: &str,
    all: bool,
    expected_hash: Option<&str>,
    self_writes: &SelfWrites,
) -> OpResult<ReplaceReport> {
    if find.is_empty() {
        return Err("the text to find cannot be empty".into());
    }
    let content = read_file(root, rel)?.content;
    let count = content.matches(find).count();
    let replacements = if all { count } else { count.min(1) };
    let next =
        if all { content.replace(find, replace) } else { content.replacen(find, replace, 1) };
    // Zero occurrences still goes through the write path: it is byte-identical,
    // so `write_atomic` leaves the file alone and no snapshot is taken, and the
    // caller still gets the guard's verdict and the current stamp.
    let result = agent_write_document(root, rel, &next, expected_hash, self_writes)?;
    Ok(ReplaceReport { replacements, result })
}

// ── version history: naming one, and reading the difference ──────────────

/// A snapshot row, without its body.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotReport {
    pub path: String,
    pub id: String,
    pub at: i64,
    pub label: String,
    pub words: usize,
}

/// The default label, when a caller does not name the snapshot.
pub const DEFAULT_SNAPSHOT_LABEL: &str = "Snapshot";

/// Save a named version of a document as it is on disk right now.
///
/// This is the writer's own "Save a version" button, reachable from a tool: it
/// records, it does not change the document. Named rows survive the renderer's
/// autosave retention, so a snapshot taken here is still there tomorrow.
pub fn take_snapshot(root: &Path, rel: &str, label: Option<&str>) -> OpResult<SnapshotReport> {
    let content = read_file(root, rel)?.content;
    let label = label.map(str::trim).filter(|l| !l.is_empty()).unwrap_or(DEFAULT_SNAPSHOT_LABEL);
    let entry =
        aux_store::snapshot_document(root, rel, label, &content, crate::vault::registry::now_ms())
            .map_err(|e| format!("{rel}: could not save the snapshot: {e}"))?;
    Ok(SnapshotReport {
        path: rel.to_string(),
        id: entry.id,
        at: entry.at,
        label: entry.label,
        words: entry.words,
    })
}

/// One end of a diff.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffSide {
    /// The snapshot's id, or "current" for the document as it is on disk.
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    pub words: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffReport {
    pub path: String,
    pub from: DiffSide,
    pub to: DiffSide,
    #[serde(flatten)]
    pub diff: crate::vault::diff::LineDiff,
}

fn snapshot_side(root: &Path, rel: &str, id: &str) -> OpResult<(DiffSide, String)> {
    let mut budget = usize::MAX;
    let found = aux_store::list_versions(root, rel, &mut budget)
        .into_iter()
        .find(|v| v.id == id)
        .ok_or_else(|| format!("{rel} has no snapshot {id}"))?;
    Ok((
        DiffSide { id: found.id, label: found.label, at: Some(found.at), words: found.words },
        found.body,
    ))
}

/// Compare a snapshot with the document as it is now, or with another snapshot.
///
/// `to_snapshot_id` omitted means "the current document" — the usual question,
/// which is "what has the writer done since this version".
pub fn diff_version(
    root: &Path,
    rel: &str,
    snapshot_id: &str,
    to_snapshot_id: Option<&str>,
) -> OpResult<DiffReport> {
    let (from, from_text) = snapshot_side(root, rel, snapshot_id)?;
    let (to, to_text) = match to_snapshot_id {
        Some(id) => snapshot_side(root, rel, id)?,
        None => {
            let content = read_file(root, rel)?.content;
            let words = frontmatter::count_words(&frontmatter::parse(&content).body);
            (
                DiffSide { id: "current".into(), label: "Current document".into(), at: None, words },
                content,
            )
        }
    };
    Ok(DiffReport {
        path: rel.to_string(),
        from,
        to,
        diff: crate::vault::diff::diff(&from_text, &to_text),
    })
}

// ── scenes in a screenplay ───────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReorderScenesReport {
    pub path: String,
    /// The scene index list that was applied.
    pub order: Vec<usize>,
    pub scenes: Vec<crate::vault::fountain::Scene>,
    pub result: WriteResult,
}

/// Index a screenplay's scenes.
///
/// Line numbers are body lines, matching `insert_text` / `replace_lines`.
pub fn list_scenes(root: &Path, rel: &str) -> OpResult<Vec<crate::vault::fountain::Scene>> {
    let content = read_file(root, rel)?.content;
    Ok(crate::vault::fountain::collect_scenes(split_body(&content).1))
}

/// Rearrange a screenplay's scenes and write the result.
///
/// `order` is a permutation of the scene indices `list_scenes` reported —
/// every index once, none invented — and anything else is refused rather than
/// half-applied. Everything above the first scene heading (the Fountain title
/// page, an opening FADE IN:) does not move, and the frontmatter block, if the
/// file has one, is carried across untouched.
pub fn reorder_scenes(
    root: &Path,
    rel: &str,
    order: &[usize],
    expected_hash: Option<&str>,
    self_writes: &SelfWrites,
) -> OpResult<ReorderScenesReport> {
    let content = read_file(root, rel)?.content;
    let (prefix, body) = split_body(&content);
    let next_body = crate::vault::fountain::reorder_scenes(body, order)?;
    let next = format!("{prefix}{next_body}");
    let result = agent_write_document(root, rel, &next, expected_hash, self_writes)?;
    Ok(ReorderScenesReport {
        path: rel.to_string(),
        order: order.to_vec(),
        scenes: crate::vault::fountain::collect_scenes(&next_body),
        result,
    })
}

// ── manuscript and draft folders ─────────────────────────────────────────
//
// The Swift app stores these as two flat lists of folder paths
// (`manuscriptFolders` / `draftFolders`, SWIFT-AUDIT §2.8). This side has a
// richer manifest — a `Manuscript` carries a title and a chapter order, a
// `Draft` carries a name and a cut — so "mark this folder" means building or
// removing one of those records rather than adding a string to a set.
//
// Two rules come across from Swift unchanged:
//
// * **A draft folder needs a manuscript above it.** A draft is an alternate cut
//   *of something*, and one floating at the top of a vault has nothing to be a
//   cut of. The refusal names the fix.
// * **Unmarking a manuscript takes its draft folders with it.** They were only
//   drafts by virtue of sitting under it. Drafts that are *not* folder-backed
//   are left alone: those are the writer's own named cuts and have nothing to
//   do with the folder mark.

/// A folder's role after the mark was flipped.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderRoleReport {
    pub path: String,
    /// "manuscript" or "draft".
    pub role: String,
    /// True when the folder now has the role, false when the mark was removed.
    pub marked: bool,
    /// The manifest record's id, when there is one now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The chapter order the record ended up with.
    pub chapters: Vec<String>,
}

/// The folder a role can be put on: it has to exist, be a folder, and be
/// inside the vault proper.
fn markable_folder(root: &Path, rel: &str) -> OpResult<()> {
    if rel.is_empty() {
        return Err("name a folder inside the vault — the vault root cannot be marked".into());
    }
    let dir = resolve(root, rel)?;
    guard_not_metadata(root, &dir)?;
    if !dir.is_dir() {
        return Err(format!("no folder at {rel}"));
    }
    Ok(())
}

/// The display title for a folder-derived record: its last path segment.
fn folder_title(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).to_string()
}

/// Mark or unmark a folder as a manuscript.
pub fn toggle_manuscript_folder(
    root: &Path,
    rel: &str,
    self_writes: &SelfWrites,
) -> OpResult<FolderRoleReport> {
    markable_folder(root, rel)?;
    let (mut wf, _) = workflow::read_or_create(root).map_err(|e| e.to_string())?;

    let report = match wf.manuscripts.iter().position(|m| m.folder == rel) {
        Some(i) => {
            wf.manuscripts.remove(i);
            // Drafts that were only drafts because they sat under it.
            let prefix = format!("{rel}/");
            wf.drafts.retain(|d| !d.folder.as_deref().is_some_and(|f| f.starts_with(&prefix)));
            ensure_one_active_draft(&mut wf);
            FolderRoleReport {
                path: rel.to_string(),
                role: "manuscript".into(),
                marked: false,
                id: None,
                chapters: Vec::new(),
            }
        }
        None => {
            let chapters = crate::vault::tree::markdown_paths_in(root, rel);
            let id = workflow::new_id();
            wf.manuscripts.push(crate::model::Manuscript {
                id: id.clone(),
                title: folder_title(rel),
                folder: rel.to_string(),
                chapter_order: chapters.clone(),
            });
            FolderRoleReport {
                path: rel.to_string(),
                role: "manuscript".into(),
                marked: true,
                id: Some(id),
                chapters,
            }
        }
    };
    save_workflow(root, &wf, self_writes)?;
    Ok(report)
}

/// Mark or unmark a folder as a draft.
pub fn toggle_draft_folder(
    root: &Path,
    rel: &str,
    self_writes: &SelfWrites,
) -> OpResult<FolderRoleReport> {
    markable_folder(root, rel)?;
    let (mut wf, _) = workflow::read_or_create(root).map_err(|e| e.to_string())?;

    let report = match wf.drafts.iter().position(|d| d.folder.as_deref() == Some(rel)) {
        Some(i) => {
            wf.drafts.remove(i);
            ensure_one_active_draft(&mut wf);
            FolderRoleReport {
                path: rel.to_string(),
                role: "draft".into(),
                marked: false,
                id: None,
                chapters: Vec::new(),
            }
        }
        None => {
            // A draft is an alternate cut of a manuscript, so one has to be
            // above it. Strictly above: marking the manuscript folder itself as
            // its own draft would make the two records fight over the same
            // chapters on every reconcile.
            let has_manuscript = wf
                .manuscripts
                .iter()
                .any(|m| !m.folder.is_empty() && rel.starts_with(&format!("{}/", m.folder)));
            if !has_manuscript {
                return Err(format!(
                    "{rel} is not inside a manuscript folder — mark its parent as a manuscript first (toggle_manuscript_folder), then mark this as a draft"
                ));
            }
            let chapters = crate::vault::tree::markdown_paths_in(root, rel);
            let id = workflow::new_id();
            wf.drafts.push(crate::model::Draft {
                id: id.clone(),
                name: folder_title(rel),
                active: None,
                chapter_order: chapters.clone(),
                folder: Some(rel.to_string()),
            });
            FolderRoleReport {
                path: rel.to_string(),
                role: "draft".into(),
                marked: true,
                id: Some(id),
                chapters,
            }
        }
    };
    save_workflow(root, &wf, self_writes)?;
    Ok(report)
}

/// Leave exactly one draft flagged active, if there are any at all.
///
/// Removing the active draft would otherwise leave the manifest with no active
/// cut, and Compile's "the active draft" would have nothing to point at.
fn ensure_one_active_draft(wf: &mut Workflow) {
    if wf.drafts.is_empty() || wf.drafts.iter().any(|d| d.active == Some(true)) {
        return;
    }
    wf.drafts[0].active = Some(true);
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
    // A folder-backed draft is a cut of its own folder, not of this
    // manuscript's order, so it does not follow even if the two happen to
    // match right now.
    for draft in wf.drafts.iter_mut().filter(|d| d.folder.is_none()) {
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

    // ── the conflict guard ───────────────────────────────────────────────

    /// The stamp the guard would accept for what is on disk right now.
    fn baseline(root: &Path, rel: &str) -> FileStamp {
        read_file(root, rel).unwrap().stamp
    }

    fn expect_written(result: &WriteResult) -> (&bool, &FileStamp) {
        match result {
            WriteResult::Written { changed, stamp, .. } => (changed, stamp),
            WriteResult::Conflict { theirs, .. } => {
                panic!("expected a write, got a conflict against {theirs:?}")
            }
        }
    }

    fn expect_conflict(result: &WriteResult) -> &str {
        match result {
            WriteResult::Conflict { theirs, .. } => theirs,
            WriteResult::Written { .. } => panic!("expected a refusal, the write went through"),
        }
    }

    #[test]
    fn reading_a_document_stamps_the_bytes_it_came_from() {
        let t = TempDir::new("ops-read-stamp");
        t.write("Drafts/Ch_01.md", "---\nstatus: drafting\n---\n\nrain");

        let read = read_file(t.path(), "Drafts/Ch_01.md").unwrap();
        assert_eq!(read.path, "Drafts/Ch_01.md");
        assert_eq!(read.content, "---\nstatus: drafting\n---\n\nrain");
        assert_eq!(read.stamp.bytes, read.content.len());
        assert!(read.stamp.mtime_ms > 0);

        // read_document carries the same fingerprint, so an MCP client can
        // hand it straight back as expected_hash.
        assert_eq!(read_document(t.path(), "Drafts/Ch_01.md").unwrap().hash, read.stamp.hash);
        assert!(read_file(t.path(), "Drafts/nope.md").is_err());
        assert!(read_file(t.path(), "../escape.md").is_err());
    }

    #[test]
    fn a_write_that_matches_its_baseline_goes_through() {
        let t = TempDir::new("guard-match");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "before");
        let base = baseline(t.path(), "Drafts/Ch_01.md");

        let result =
            write_document_checked(t.path(), "Drafts/Ch_01.md", "after", Some(&base), &writes)
                .unwrap();
        let (changed, stamp) = expect_written(&result);
        assert!(*changed);
        assert_eq!(
            std::fs::read_to_string(t.path().join("Drafts/Ch_01.md")).unwrap(),
            "after"
        );
        assert_eq!(
            *stamp,
            baseline(t.path(), "Drafts/Ch_01.md"),
            "the answer carries the new baseline, so the buffer needs no re-read"
        );
        assert!(
            writes.is_own(&t.path().join("Drafts/Ch_01.md")),
            "a guarded write is still stamped, or the watcher reports our own save"
        );
    }

    #[test]
    fn a_write_against_a_stale_baseline_is_refused_with_the_text_on_disk() {
        let t = TempDir::new("guard-mismatch");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "opened as this");
        let base = baseline(t.path(), "Drafts/Ch_01.md");

        // Somebody else — a sync client, a script, an MCP tool — gets there
        // while the buffer is dirty.
        t.write("Drafts/Ch_01.md", "changed underneath");

        let result = write_document_checked(
            t.path(), "Drafts/Ch_01.md", "my unsaved paragraph", Some(&base), &writes,
        )
        .unwrap();
        assert_eq!(expect_conflict(&result), "changed underneath");
        assert_eq!(
            std::fs::read_to_string(t.path().join("Drafts/Ch_01.md")).unwrap(),
            "changed underneath",
            "a refused write must not have written anything"
        );

        // Keep Mine: the same call without a baseline is the force-write.
        let forced =
            write_document_checked(t.path(), "Drafts/Ch_01.md", "my unsaved paragraph", None, &writes)
                .unwrap();
        assert!(*expect_written(&forced).0);
        assert_eq!(
            std::fs::read_to_string(t.path().join("Drafts/Ch_01.md")).unwrap(),
            "my unsaved paragraph"
        );
    }

    #[test]
    fn an_mtime_that_moved_on_its_own_is_not_a_conflict() {
        // The iCloud case (docs/NOTES.md §8): the File Provider re-stamps a
        // file whose bytes it never touched. An mtime guard would raise a
        // dialog here; a content hash does not notice.
        let t = TempDir::new("guard-icloud");
        let writes = sw();
        let path = t.write("Drafts/Ch_01.md", "untouched text");
        let stale = FileStamp {
            mtime_ms: baseline(t.path(), "Drafts/Ch_01.md").mtime_ms - 600_000,
            ..baseline(t.path(), "Drafts/Ch_01.md")
        };
        assert!(
            crate::fs_ops::stamp::mtime_moved(&baseline(t.path(), "Drafts/Ch_01.md"), &stale),
            "the fixture really is outside the tolerance"
        );

        let result =
            write_document_checked(t.path(), "Drafts/Ch_01.md", "my edit", Some(&stale), &writes)
                .unwrap();
        assert!(*expect_written(&result).0, "ten minutes of clock drift is not an edit");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "my edit");
    }

    #[test]
    fn the_guard_lets_through_the_two_cases_that_lose_nothing() {
        let t = TempDir::new("guard-harmless");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "shared text");
        let base = baseline(t.path(), "Drafts/Ch_01.md");

        // 1. Somebody else wrote *exactly* what we were about to write. Two
        //    routes to the same text is not a disagreement.
        t.write("Drafts/Ch_01.md", "the same conclusion");
        let agreed = write_document_checked(
            t.path(), "Drafts/Ch_01.md", "the same conclusion", Some(&base), &writes,
        )
        .unwrap();
        assert!(!*expect_written(&agreed).0, "nothing to do, and nothing to argue about");

        // 2. The file was deleted underneath the editor. Refusing would leave
        //    the writer's text in a buffer with nowhere to go.
        std::fs::remove_file(t.path().join("Drafts/Ch_01.md")).unwrap();
        let recreated = write_document_checked(
            t.path(), "Drafts/Ch_01.md", "still mine", Some(&base), &writes,
        )
        .unwrap();
        assert!(*expect_written(&recreated).0);
        assert_eq!(
            std::fs::read_to_string(t.path().join("Drafts/Ch_01.md")).unwrap(),
            "still mine"
        );
    }

    #[test]
    fn a_guarded_write_of_identical_bytes_still_does_not_touch_the_file() {
        // The byte-for-byte rule survives the guard: a file with no
        // frontmatter must never gain one, or even a new mtime.
        let t = TempDir::new("guard-unchanged");
        let writes = sw();
        let plain = "Just prose. No fences, no keys.\n";
        let path = t.write("note.md", plain);
        let base = baseline(t.path(), "note.md");
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();

        std::thread::sleep(std::time::Duration::from_millis(20));
        let result = write_document_checked(t.path(), "note.md", plain, Some(&base), &writes).unwrap();

        assert!(!*expect_written(&result).0);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), plain);
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before);
    }

    // ── the MCP door: guarded, and it snapshots first ────────────────────

    fn versions_of(root: &Path, rel: &str) -> Vec<crate::aux_store::VersionEntry> {
        let mut budget = usize::MAX;
        crate::aux_store::list_versions(root, rel, &mut budget)
    }

    #[test]
    fn an_agent_write_snapshots_what_it_replaces() {
        // docs/NOTES.md §13j: before this, a client's write replaced a file
        // with nothing recorded, and "undo the AI's edit" was not one click.
        let t = TempDir::new("agent-snapshot");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "the writer's paragraph");

        let result =
            agent_write_document(t.path(), "Drafts/Ch_01.md", "the agent's rewrite", None, &writes)
                .unwrap();
        assert!(*expect_written(&result).0);

        let versions = versions_of(t.path(), "Drafts/Ch_01.md");
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].body, "the writer's paragraph", "the previous text is recoverable");
        assert_eq!(versions[0].label, crate::aux_store::AGENT_SNAPSHOT_LABEL);
        assert!(versions[0].named, "named, so the renderer's autosave retention never prunes it");
        assert_eq!(versions[0].words, 3);
    }

    #[test]
    fn an_agent_write_that_replaces_nothing_takes_no_snapshot() {
        let t = TempDir::new("agent-snapshot-noop");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "unchanged");

        // Byte-identical: nothing was replaced, so there is nothing to protect.
        agent_write_document(t.path(), "Drafts/Ch_01.md", "unchanged", None, &writes).unwrap();
        assert!(versions_of(t.path(), "Drafts/Ch_01.md").is_empty());

        // A brand-new file replaced nothing either.
        agent_write_document(t.path(), "Drafts/Ch_99.md", "fresh", None, &writes).unwrap();
        assert!(versions_of(t.path(), "Drafts/Ch_99.md").is_empty());

        // And a refused write did not get as far as replacing anything.
        let base = baseline(t.path(), "Drafts/Ch_01.md");
        t.write("Drafts/Ch_01.md", "moved on");
        let refused = agent_write_document(
            t.path(), "Drafts/Ch_01.md", "the agent's rewrite", Some(&base.hash), &writes,
        )
        .unwrap();
        assert_eq!(expect_conflict(&refused), "moved on");
        assert!(
            versions_of(t.path(), "Drafts/Ch_01.md").is_empty(),
            "a refusal is not an overwrite and leaves no snapshot behind"
        );
    }

    #[test]
    fn an_agent_write_honours_the_hash_it_was_given() {
        let t = TempDir::new("agent-guard");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "as the client read it");
        let hash = read_document(t.path(), "Drafts/Ch_01.md").unwrap().hash;

        // Nothing moved: the write lands.
        let ok =
            agent_write_document(t.path(), "Drafts/Ch_01.md", "v2", Some(&hash), &writes).unwrap();
        assert!(*expect_written(&ok).0);

        // The client's hash is now stale, and it is refused rather than
        // overwriting its own previous edit's successor.
        let stale =
            agent_write_document(t.path(), "Drafts/Ch_01.md", "v3", Some(&hash), &writes).unwrap();
        assert_eq!(expect_conflict(&stale), "v2");
        assert_eq!(std::fs::read_to_string(t.path().join("Drafts/Ch_01.md")).unwrap(), "v2");
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

    // ── create / rename / move ───────────────────────────────────────────

    #[test]
    fn creates_a_markdown_file_with_seeded_frontmatter() {
        let t = TempDir::new("ops-create-file");
        let writes = sw();
        let made = create_file(t.path(), "Drafts", "Chapter Five", "markdown", &writes).unwrap();

        assert_eq!(made.path, "Drafts/Chapter Five.md");
        assert_eq!(made.name, "Chapter Five", "markdown rows drop the extension");
        assert_eq!(made.kind, "markdown");
        assert!(!made.renamed);
        assert_eq!(
            std::fs::read_to_string(t.path().join("Drafts/Chapter Five.md")).unwrap(),
            "---\ntitle: Chapter Five\nstatus: outline\n---\n\n"
        );
        assert!(writes.is_own(&t.path().join("Drafts/Chapter Five.md")));
    }

    #[test]
    fn creates_a_screenplay_with_a_title_page_and_keeps_its_extension() {
        let t = TempDir::new("ops-create-fountain-file");
        let writes = sw();
        // The writer typed the extension themselves — it must not be doubled.
        let made = create_file(t.path(), "", "Pilot.fountain", "fountain", &writes).unwrap();
        assert_eq!(made.path, "Pilot.fountain");
        assert_eq!(made.name, "Pilot.fountain", "non-markdown rows keep the extension");
        let text = std::fs::read_to_string(t.path().join("Pilot.fountain")).unwrap();
        assert!(text.starts_with("Title: Pilot\n"), "got {text:?}");
        assert!(text.contains("INT. SOMEWHERE"));
    }

    #[test]
    fn a_taken_name_gets_a_numbered_suffix_rather_than_overwriting() {
        let t = TempDir::new("ops-dedupe");
        let writes = sw();
        t.write("Drafts/Chapter One.md", "the original");

        let second = create_file(t.path(), "Drafts", "Chapter One", "markdown", &writes).unwrap();
        assert_eq!(second.path, "Drafts/Chapter One 2.md");
        assert!(second.renamed);
        let third = create_file(t.path(), "Drafts", "Chapter One", "markdown", &writes).unwrap();
        assert_eq!(third.path, "Drafts/Chapter One 3.md");

        assert_eq!(
            std::fs::read_to_string(t.path().join("Drafts/Chapter One.md")).unwrap(),
            "the original",
            "the file that was already there is untouched"
        );
    }

    #[test]
    fn creates_folders_and_de_duplicates_them_too() {
        let t = TempDir::new("ops-create-folder");
        let writes = sw();
        let first = create_folder(t.path(), "", "Research", &writes).unwrap();
        assert_eq!(first.path, "Research");
        assert_eq!(first.kind, "folder");
        assert!(t.path().join("Research").is_dir());

        let second = create_folder(t.path(), "", "Research", &writes).unwrap();
        assert_eq!(second.path, "Research 2");
        assert!(second.renamed);

        let nested = create_folder(t.path(), "Research", "Bells", &writes).unwrap();
        assert_eq!(nested.path, "Research/Bells");
    }

    #[test]
    fn create_refuses_names_that_are_really_paths_and_unknown_kinds() {
        let t = TempDir::new("ops-create-guards");
        let writes = sw();
        assert!(create_file(t.path(), "", "Drafts/Sneaky", "markdown", &writes).is_err());
        assert!(create_file(t.path(), "", "../Sneaky", "markdown", &writes).is_err());
        assert!(create_file(t.path(), "", ".hidden", "markdown", &writes).is_err());
        assert!(create_file(t.path(), "", "  ", "markdown", &writes).is_err());
        assert!(create_file(t.path(), "", "Fine", "docx", &writes).is_err());
        assert!(create_file(t.path(), "../elsewhere", "Fine", "markdown", &writes).is_err());
        assert!(create_folder(t.path(), "", ".aquarius", &writes).is_err());
        assert!(create_folder(t.path(), ".aquarius", "sneaky", &writes).is_err());
    }

    #[test]
    fn renaming_a_document_keeps_its_extension_and_carries_its_history() {
        let t = TempDir::new("ops-rename");
        let writes = sw();
        t.write("Drafts/Ch_03.md", "---\ntitle: Old\n---\n\nrain");
        crate::aux_store::save_versions(
            t.path(),
            "Drafts/Ch_03.md",
            &[crate::aux_store::VersionEntry {
                id: "v1".into(), at: 1, label: "Auto".into(), named: false,
                words: 1, body: "rain".into(),
            }],
        )
        .unwrap();

        let report = rename_entry(t.path(), "Drafts/Ch_03.md", "Helmreach in Rain", &writes).unwrap();
        assert_eq!(report.path, "Drafts/Helmreach in Rain.md");
        assert_eq!(report.from.as_deref(), Some("Drafts/Ch_03.md"));
        assert_eq!(report.name, "Helmreach in Rain");
        assert!(!t.path().join("Drafts/Ch_03.md").exists());
        assert_eq!(
            std::fs::read_to_string(t.path().join("Drafts/Helmreach in Rain.md")).unwrap(),
            "---\ntitle: Old\n---\n\nrain",
            "a rename never rewrites the file"
        );

        let mut budget = usize::MAX;
        let versions =
            crate::aux_store::list_versions(t.path(), "Drafts/Helmreach in Rain.md", &mut budget);
        assert_eq!(versions.len(), 1, "version history followed the rename");
        assert!(writes.is_own(&t.path().join("Drafts/Helmreach in Rain.md")));
    }

    #[test]
    fn renaming_onto_a_taken_name_suffixes_instead_of_clobbering() {
        let t = TempDir::new("ops-rename-collide");
        let writes = sw();
        t.write("Drafts/One.md", "one");
        t.write("Drafts/Two.md", "two");
        let report = rename_entry(t.path(), "Drafts/Two.md", "One", &writes).unwrap();
        assert_eq!(report.path, "Drafts/One 2.md");
        assert!(report.renamed);
        assert_eq!(std::fs::read_to_string(t.path().join("Drafts/One.md")).unwrap(), "one");
    }

    #[test]
    fn renaming_to_the_same_name_is_a_no_op_not_a_numbered_copy() {
        let t = TempDir::new("ops-rename-same");
        let writes = sw();
        t.write("Notes.md", "x");
        let report = rename_entry(t.path(), "Notes.md", "Notes", &writes).unwrap();
        assert_eq!(report.path, "Notes.md");
        assert!(!t.path().join("Notes 2.md").exists());
    }

    #[test]
    fn moving_a_document_leaves_its_bytes_alone() {
        let t = TempDir::new("ops-move");
        let writes = sw();
        // No frontmatter at all — the case the byte-for-byte rule is about.
        let plain = "Just prose. No fences, no keys.\n";
        t.write("Inbox/note.md", plain);
        t.write("Characters/Imogen.md", "niece");

        let report = move_entry(t.path(), "Inbox/note.md", "Characters", &writes).unwrap();
        assert_eq!(report.path, "Characters/note.md");
        assert_eq!(report.from.as_deref(), Some("Inbox/note.md"));
        assert_eq!(
            std::fs::read_to_string(t.path().join("Characters/note.md")).unwrap(),
            plain,
            "a move must not add a frontmatter block or touch a byte"
        );
        assert!(!t.path().join("Inbox/note.md").exists());
    }

    #[test]
    fn moving_to_the_vault_root_and_back_works() {
        let t = TempDir::new("ops-move-root");
        let writes = sw();
        t.write("Drafts/loose.md", "x");
        assert_eq!(move_entry(t.path(), "Drafts/loose.md", "", &writes).unwrap().path, "loose.md");
        assert_eq!(
            move_entry(t.path(), "loose.md", "Drafts", &writes).unwrap().path,
            "Drafts/loose.md"
        );
    }

    #[test]
    fn moving_a_folder_takes_its_contents_and_its_history() {
        let t = TempDir::new("ops-move-folder");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "one");
        t.write("Drafts/Notes/aside.md", "aside");
        std::fs::create_dir_all(t.path().join("Archive")).unwrap();
        crate::aux_store::save_comments(
            t.path(),
            "Drafts/Ch_01.md",
            vec![crate::aux_store::CommentEntry {
                id: "c1".into(), at: 1, anchor: "one".into(),
                text: "keep".into(), resolved: false,
            }],
        )
        .unwrap();

        let report = move_entry(t.path(), "Drafts", "Archive", &writes).unwrap();
        assert_eq!(report.path, "Archive/Drafts");
        assert_eq!(report.kind, "folder");
        assert_eq!(std::fs::read_to_string(t.path().join("Archive/Drafts/Ch_01.md")).unwrap(), "one");
        assert_eq!(
            std::fs::read_to_string(t.path().join("Archive/Drafts/Notes/aside.md")).unwrap(),
            "aside"
        );
        assert!(!t.path().join("Drafts").exists());
        assert_eq!(
            crate::aux_store::read_comments(t.path())
                .get("Archive/Drafts/Ch_01.md")
                .unwrap()[0]
                .text,
            "keep"
        );
        assert!(
            writes.is_own(&t.path().join("Archive/Drafts/Ch_01.md")),
            "every moved child is stamped, or the watcher reloads the tree for our own move"
        );
    }

    #[test]
    fn move_and_rename_refuse_the_ways_they_could_lose_a_file() {
        let t = TempDir::new("ops-move-guards");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "one");
        t.write("Drafts/Inner/deep.md", "deep");

        // A folder inside itself would detach the whole subtree.
        assert!(move_entry(t.path(), "Drafts", "Drafts", &writes).is_err());
        assert!(move_entry(t.path(), "Drafts", "Drafts/Inner", &writes).is_err());
        // Out of the vault, into the metadata folder, or onto nothing.
        assert!(move_entry(t.path(), "Drafts/Ch_01.md", "../elsewhere", &writes).is_err());
        assert!(move_entry(t.path(), "Drafts/Ch_01.md", ".aquarius", &writes).is_err());
        assert!(move_entry(t.path(), "Drafts/Ch_01.md", "Nowhere", &writes).is_err());
        assert!(move_entry(t.path(), "missing.md", "Drafts", &writes).is_err());
        assert!(rename_entry(t.path(), "", "anything", &writes).is_err());
        assert!(rename_entry(t.path(), "Drafts/Ch_01.md", "Sub/dir", &writes).is_err());
        assert!(rename_entry(t.path(), "../outside.md", "x", &writes).is_err());

        // Nothing above moved anything.
        assert!(t.path().join("Drafts/Ch_01.md").exists());
        assert!(t.path().join("Drafts/Inner/deep.md").exists());
    }

    #[test]
    fn a_renamed_chapter_keeps_its_place_in_the_manuscript() {
        let t = TempDir::new("ops-rename-chapter");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "a");
        t.write("Drafts/Ch_02.md", "b");
        t.write("Drafts/Ch_03.md", "c");
        let (wf, _) = workflow::read_or_create(t.path()).unwrap();
        assert_eq!(wf.manuscripts[0].chapter_order.len(), 3);

        rename_entry(t.path(), "Drafts/Ch_02.md", "The Bell Ringer's Vow", &writes).unwrap();

        let (after, _) = workflow::read_or_create(t.path()).unwrap();
        assert_eq!(
            after.manuscripts[0].chapter_order,
            vec!["Drafts/Ch_01.md", "Drafts/The Bell Ringer's Vow.md", "Drafts/Ch_03.md"],
            "the chapter stays second instead of being re-appended at the end"
        );
        assert_eq!(after.drafts[0].chapter_order, after.manuscripts[0].chapter_order);
    }

    #[test]
    fn renaming_the_manuscript_folder_moves_the_manuscript_with_it() {
        let t = TempDir::new("ops-rename-ms-folder");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "a");
        workflow::read_or_create(t.path()).unwrap();

        rename_entry(t.path(), "Drafts", "Manuscript", &writes).unwrap();

        let (after, _) = workflow::read_or_create(t.path()).unwrap();
        assert_eq!(after.manuscripts[0].folder, "Manuscript");
        assert_eq!(after.manuscripts[0].chapter_order, vec!["Manuscript/Ch_01.md"]);
    }

    #[test]
    fn moving_a_document_does_not_disturb_the_trash() {
        let t = TempDir::new("ops-move-trash");
        let writes = sw();
        t.write("Drafts/gone.md", "gone");
        t.write("Drafts/here.md", "here");
        let rec = crate::fs_ops::trash::soft_delete(
            t.path(), "Drafts/gone.md", crate::vault::registry::now_ms(),
        )
        .unwrap();

        move_entry(t.path(), "Drafts/here.md", "", &writes).unwrap();

        let index = crate::fs_ops::trash::read_index(t.path());
        assert_eq!(index.entries.len(), 1);
        assert_eq!(index.entries[0].path, "Drafts/gone.md");
        let restored = crate::fs_ops::trash::restore(t.path(), &rec.id).unwrap();
        assert_eq!(restored.as_deref(), Some("Drafts/gone.md"));
        assert_eq!(std::fs::read_to_string(t.path().join("Drafts/gone.md")).unwrap(), "gone");
    }

    // ── stars ────────────────────────────────────────────────────────────

    #[test]
    fn starring_a_row_never_touches_the_document() {
        let t = TempDir::new("ops-star");
        let plain = "---\ntitle: One\n---\n\nbody\n";
        t.write("Drafts/Ch_01.md", plain);

        let on = set_star(t.path(), "Drafts/Ch_01.md", None).unwrap();
        assert!(on.starred);
        assert_eq!(on.path, "Drafts/Ch_01.md");
        assert_eq!(list_stars(t.path()), vec!["Drafts/Ch_01.md"]);
        assert_eq!(
            std::fs::read_to_string(t.path().join("Drafts/Ch_01.md")).unwrap(),
            plain,
            "a star is metadata — the file's bytes are not rewritten"
        );

        assert!(!set_star(t.path(), "Drafts/Ch_01.md", None).unwrap().starred);
        assert!(list_stars(t.path()).is_empty());

        // Explicit set is idempotent in both directions.
        assert!(set_star(t.path(), "Drafts/Ch_01.md", Some(true)).unwrap().starred);
        assert!(set_star(t.path(), "Drafts/Ch_01.md", Some(true)).unwrap().starred);
        assert_eq!(list_stars(t.path()).len(), 1);
    }

    #[test]
    fn a_folder_can_be_starred_but_nothing_outside_the_vault_can() {
        let t = TempDir::new("ops-star-guards");
        t.write("Drafts/Ch_01.md", "one");
        assert!(set_star(t.path(), "Drafts", None).unwrap().starred);

        assert!(set_star(t.path(), "", None).is_err(), "the vault root is not a row");
        assert!(set_star(t.path(), "../outside.md", None).is_err());
        assert!(set_star(t.path(), ".aquarius", None).is_err());
        assert!(set_star(t.path(), "Drafts/missing.md", None).is_err());
    }

    #[test]
    fn a_starred_document_keeps_its_star_through_a_rename_and_a_move() {
        let t = TempDir::new("ops-star-follows");
        let writes = sw();
        t.write("Drafts/Ch_03.md", "rain");
        std::fs::create_dir_all(t.path().join("Archive")).unwrap();
        set_star(t.path(), "Drafts/Ch_03.md", Some(true)).unwrap();

        rename_entry(t.path(), "Drafts/Ch_03.md", "Helmreach in Rain", &writes).unwrap();
        assert_eq!(list_stars(t.path()), vec!["Drafts/Helmreach in Rain.md"]);

        move_entry(t.path(), "Drafts/Helmreach in Rain.md", "Archive", &writes).unwrap();
        assert_eq!(list_stars(t.path()), vec!["Archive/Helmreach in Rain.md"]);
    }

    #[test]
    fn moving_a_folder_carries_the_stars_inside_it() {
        let t = TempDir::new("ops-star-folder-move");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "one");
        t.write("Drafts/Deep/Ch_02.md", "two");
        std::fs::create_dir_all(t.path().join("Archive")).unwrap();
        set_star(t.path(), "Drafts/Ch_01.md", Some(true)).unwrap();
        set_star(t.path(), "Drafts/Deep/Ch_02.md", Some(true)).unwrap();

        move_entry(t.path(), "Drafts", "Archive", &writes).unwrap();

        assert_eq!(
            list_stars(t.path()),
            vec!["Archive/Drafts/Ch_01.md", "Archive/Drafts/Deep/Ch_02.md"]
        );
    }

    #[test]
    fn trashing_a_row_takes_its_star_with_it() {
        let t = TempDir::new("ops-trash-star");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "one");
        t.write("Drafts/Ch_02.md", "two");
        set_star(t.path(), "Drafts/Ch_01.md", Some(true)).unwrap();
        set_star(t.path(), "Drafts/Ch_02.md", Some(true)).unwrap();

        let record = trash_entry(t.path(), "Drafts/Ch_01.md", &writes).unwrap();
        assert_eq!(record.path, "Drafts/Ch_01.md");
        assert!(!t.path().join("Drafts/Ch_01.md").exists());
        assert_eq!(
            list_stars(t.path()),
            vec!["Drafts/Ch_02.md"],
            "a star on a trashed row would be a quick-view entry that cannot be opened"
        );
        assert!(
            writes.is_own(&t.path().join("Drafts/Ch_01.md")),
            "the delete is stamped, or the watcher reloads the tree for our own delete"
        );

        // A starred folder loses its subtree's stars too.
        t.write("Notes/a.md", "a");
        set_star(t.path(), "Notes/a.md", Some(true)).unwrap();
        set_star(t.path(), "Notes", Some(true)).unwrap();
        trash_entry(t.path(), "Notes", &writes).unwrap();
        assert_eq!(list_stars(t.path()), vec!["Drafts/Ch_02.md"]);

        assert!(trash_entry(t.path(), "Drafts/nothing.md", &writes).is_err());
        assert!(trash_entry(t.path(), "../outside.md", &writes).is_err());
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

    // ── set_synopsis ─────────────────────────────────────────────────────

    #[test]
    fn set_synopsis_writes_the_key_and_leaves_unknown_frontmatter_alone() {
        let t = TempDir::new("ops-synopsis");
        let writes = sw();
        // Keys this side's parser does not model (a list, a nested map) plus
        // one it does, in an order that is not alphabetical.
        t.write(
            "Drafts/Ch_01.md",
            "---\ntitle: Helmreach\ntags:\n  - rain\n  - bells\nstatus: drafting\n---\n\nShe climbs.\n",
        );

        set_synopsis(t.path(), "Drafts/Ch_01.md", "She climbs the stair.", &writes).unwrap();
        assert_eq!(
            std::fs::read_to_string(t.path().join("Drafts/Ch_01.md")).unwrap(),
            "---\ntitle: Helmreach\ntags:\n  - rain\n  - bells\nstatus: drafting\nsynopsis: She climbs the stair.\n---\n\nShe climbs.\n",
            "the YAML list survives and the key order is the writer's, not alphabetical"
        );

        // Setting it again replaces the one line rather than appending a second.
        set_synopsis(t.path(), "Drafts/Ch_01.md", "The bell does not ring.", &writes).unwrap();
        let text = std::fs::read_to_string(t.path().join("Drafts/Ch_01.md")).unwrap();
        assert_eq!(text.matches("synopsis:").count(), 1);
        assert!(text.contains("synopsis: The bell does not ring."));
        assert!(text.contains("  - bells"));
    }

    #[test]
    fn a_multi_line_synopsis_round_trips_as_a_block() {
        let t = TempDir::new("ops-synopsis-block");
        let writes = sw();
        t.write("Notes/plain.md", "No frontmatter at all.\n");

        set_synopsis(t.path(), "Notes/plain.md", "Fifty-three letters\nfrom her grandfather.", &writes)
            .unwrap();
        let read = read_document(t.path(), "Notes/plain.md").unwrap();
        assert_eq!(
            read.frontmatter.get("synopsis").unwrap(),
            "Fifty-three letters\nfrom her grandfather."
        );
        assert_eq!(read.body, "No frontmatter at all.\n", "the body is untouched");

        // Blanking it leaves a readable, parseable empty value rather than
        // broken YAML.
        set_synopsis(t.path(), "Notes/plain.md", "", &writes).unwrap();
        let blanked = read_document(t.path(), "Notes/plain.md").unwrap();
        assert_eq!(blanked.frontmatter.get("synopsis").unwrap(), "");
        assert_eq!(blanked.body, "No frontmatter at all.\n");
    }

    // ── line-addressed edits ─────────────────────────────────────────────

    #[test]
    fn split_body_is_exact_with_and_without_frontmatter() {
        let with = "---\ntitle: T\n---\n\none\ntwo\n";
        let (prefix, body) = split_body(with);
        assert_eq!(prefix, "---\ntitle: T\n---\n\n");
        assert_eq!(body, "one\ntwo\n");
        assert_eq!(format!("{prefix}{body}"), with, "the split loses nothing");

        let without = "one\ntwo\n";
        assert_eq!(split_body(without), ("", without));
        assert_eq!(split_body(""), ("", ""));
    }

    fn text_of(t: &TempDir, rel: &str) -> String {
        std::fs::read_to_string(t.path().join(rel)).unwrap()
    }

    #[test]
    fn insert_text_counts_body_lines_and_zero_means_the_top() {
        let t = TempDir::new("ops-insert");
        let writes = sw();
        let src = "---\ntitle: T\nstatus: drafting\n---\n\none\ntwo\nthree\n";
        t.write("Ch.md", src);

        // 0 = the top of the *body*, which is below the frontmatter block.
        insert_text(t.path(), "Ch.md", 0, "zero", None, &writes).unwrap();
        assert_eq!(text_of(&t, "Ch.md"), "---\ntitle: T\nstatus: drafting\n---\n\nzero\none\ntwo\nthree\n");

        // 1-based: "after line 2" puts it between the old one and two.
        t.write("Ch.md", src);
        insert_text(t.path(), "Ch.md", 2, "one-and-a-half", None, &writes).unwrap();
        assert_eq!(
            text_of(&t, "Ch.md"),
            "---\ntitle: T\nstatus: drafting\n---\n\none\ntwo\none-and-a-half\nthree\n"
        );
        // NB: body line 1 is "one" and line 2 is "two", so this landed after
        // "two" — the frontmatter's three lines are not counted.

        // Multi-line insertions keep their shape.
        t.write("Ch.md", src);
        insert_text(t.path(), "Ch.md", 1, "a\nb", None, &writes).unwrap();
        assert_eq!(text_of(&t, "Ch.md"), "---\ntitle: T\nstatus: drafting\n---\n\none\na\nb\ntwo\nthree\n");
    }

    #[test]
    fn insert_text_past_the_end_appends_rather_than_failing() {
        let t = TempDir::new("ops-insert-end");
        let writes = sw();
        t.write("Ch.md", "one\ntwo");
        insert_text(t.path(), "Ch.md", 999, "three", None, &writes).unwrap();
        assert_eq!(text_of(&t, "Ch.md"), "one\ntwo\nthree");
    }

    #[test]
    fn insert_text_snapshots_and_honours_the_hash() {
        let t = TempDir::new("ops-insert-guard");
        let writes = sw();
        t.write("Ch.md", "one\ntwo\n");
        let hash = read_document(t.path(), "Ch.md").unwrap().hash;

        insert_text(t.path(), "Ch.md", 1, "inserted", Some(&hash), &writes).unwrap();
        let versions = versions_of(t.path(), "Ch.md");
        assert_eq!(versions.len(), 1, "the previous text is recoverable");
        assert_eq!(versions[0].body, "one\ntwo\n");
        assert_eq!(versions[0].label, crate::aux_store::AGENT_SNAPSHOT_LABEL);

        // The client's hash is stale now.
        let stale = insert_text(t.path(), "Ch.md", 1, "again", Some(&hash), &writes).unwrap();
        assert_eq!(expect_conflict(&stale), "one\ninserted\ntwo\n");
        assert_eq!(text_of(&t, "Ch.md"), "one\ninserted\ntwo\n", "a refusal wrote nothing");
    }

    #[test]
    fn replace_lines_is_inclusive_and_one_based() {
        let t = TempDir::new("ops-replace-lines");
        let writes = sw();
        let src = "one\ntwo\nthree\nfour\n";

        // A single line: 2..=2 replaces exactly "two".
        t.write("Ch.md", src);
        replace_lines(t.path(), "Ch.md", 2, 2, "TWO", None, &writes).unwrap();
        assert_eq!(text_of(&t, "Ch.md"), "one\nTWO\nthree\nfour\n");

        // The first line, and a range that spans.
        t.write("Ch.md", src);
        replace_lines(t.path(), "Ch.md", 1, 3, "X", None, &writes).unwrap();
        assert_eq!(text_of(&t, "Ch.md"), "X\nfour\n");

        // Replacing with several lines.
        t.write("Ch.md", src);
        replace_lines(t.path(), "Ch.md", 2, 3, "a\nb\nc", None, &writes).unwrap();
        assert_eq!(text_of(&t, "Ch.md"), "one\na\nb\nc\nfour\n");

        // to_line past the end is clamped: "from here to the end".
        t.write("Ch.md", src);
        replace_lines(t.path(), "Ch.md", 3, 900, "tail", None, &writes).unwrap();
        assert_eq!(text_of(&t, "Ch.md"), "one\ntwo\ntail");
    }

    #[test]
    fn replace_lines_skips_the_frontmatter_and_refuses_a_bad_range() {
        let t = TempDir::new("ops-replace-lines-guards");
        let writes = sw();
        let src = "---\ntitle: T\n---\n\nbody one\nbody two\n";
        t.write("Ch.md", src);

        replace_lines(t.path(), "Ch.md", 1, 1, "BODY ONE", None, &writes).unwrap();
        assert_eq!(
            text_of(&t, "Ch.md"),
            "---\ntitle: T\n---\n\nBODY ONE\nbody two\n",
            "line 1 is the first line of the body, not the opening fence"
        );

        t.write("Ch.md", src);
        assert!(replace_lines(t.path(), "Ch.md", 0, 1, "x", None, &writes).is_err(), "0 is not a line");
        assert!(replace_lines(t.path(), "Ch.md", 3, 2, "x", None, &writes).is_err(), "backwards range");
        let past = replace_lines(t.path(), "Ch.md", 50, 60, "x", None, &writes).unwrap_err();
        assert!(past.contains("insert_text"), "the refusal names the tool that does mean append: {past}");
        assert_eq!(text_of(&t, "Ch.md"), src, "no refusal wrote anything");
    }

    #[test]
    fn replace_in_document_counts_what_it_did() {
        let t = TempDir::new("ops-replace-in-doc");
        let writes = sw();
        let src = "---\ntitle: Imogen's Door\n---\n\nImogen waits. Imogen knocks.\n";
        t.write("Ch.md", src);

        let all = replace_in_document(t.path(), "Ch.md", "Imogen", "Neve", true, None, &writes).unwrap();
        assert_eq!(all.replacements, 3, "the frontmatter title counts too");
        assert_eq!(text_of(&t, "Ch.md"), "---\ntitle: Neve's Door\n---\n\nNeve waits. Neve knocks.\n");

        // First-only.
        t.write("Ch.md", src);
        let first =
            replace_in_document(t.path(), "Ch.md", "Imogen", "Neve", false, None, &writes).unwrap();
        assert_eq!(first.replacements, 1);
        assert_eq!(text_of(&t, "Ch.md"), "---\ntitle: Neve's Door\n---\n\nImogen waits. Imogen knocks.\n");

        // No occurrences: not an error, not a write, and no new snapshot.
        t.write("Ch.md", src);
        let before = versions_of(t.path(), "Ch.md").len();
        let none =
            replace_in_document(t.path(), "Ch.md", "Helmreach", "Sennet", true, None, &writes).unwrap();
        assert_eq!(none.replacements, 0);
        assert!(!*expect_written(&none.result).0, "nothing changed");
        assert_eq!(text_of(&t, "Ch.md"), src);
        assert_eq!(versions_of(t.path(), "Ch.md").len(), before, "a no-op takes no snapshot");

        assert!(replace_in_document(t.path(), "Ch.md", "", "x", true, None, &writes).is_err());
    }

    #[test]
    fn replace_in_document_is_a_plain_string_not_a_pattern() {
        let t = TempDir::new("ops-replace-literal");
        let writes = sw();
        t.write("Ch.md", "a.c and abc\n");
        let r = replace_in_document(t.path(), "Ch.md", "a.c", "X", true, None, &writes).unwrap();
        assert_eq!(r.replacements, 1, "\".\" matched a literal dot, not any character");
        assert_eq!(text_of(&t, "Ch.md"), "X and abc\n");
    }

    // ── snapshots and diffs ──────────────────────────────────────────────

    #[test]
    fn take_snapshot_records_the_current_text_without_changing_it() {
        let t = TempDir::new("ops-take-snapshot");
        let src = "---\ntitle: T\n---\n\none two three\n";
        t.write("Ch.md", src);

        let report = take_snapshot(t.path(), "Ch.md", Some("Before the cut")).unwrap();
        assert_eq!(report.label, "Before the cut");
        assert_eq!(report.words, 7, "the whole file is recorded, frontmatter included");
        assert_eq!(text_of(&t, "Ch.md"), src, "recording is not editing");

        let versions = versions_of(t.path(), "Ch.md");
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].id, report.id);
        assert_eq!(versions[0].body, src);
        assert!(versions[0].named, "named, so the renderer's retention never prunes it");

        // An empty or missing label falls back rather than writing a blank row.
        take_snapshot(t.path(), "Ch.md", Some("   ")).unwrap();
        take_snapshot(t.path(), "Ch.md", None).unwrap();
        let labels: Vec<String> =
            versions_of(t.path(), "Ch.md").into_iter().map(|v| v.label).collect();
        assert_eq!(labels, ["Snapshot", "Snapshot", "Before the cut"]);

        assert!(take_snapshot(t.path(), "missing.md", None).is_err());
    }

    #[test]
    fn diff_version_compares_a_snapshot_with_the_document_and_with_another_snapshot() {
        let t = TempDir::new("ops-diff");
        let writes = sw();
        t.write("Ch.md", "one\ntwo\nthree\n");
        let first = take_snapshot(t.path(), "Ch.md", Some("v1")).unwrap();

        write_document(t.path(), "Ch.md", "one\nTWO\nthree\n", &writes).unwrap();
        let second = take_snapshot(t.path(), "Ch.md", Some("v2")).unwrap();
        write_document(t.path(), "Ch.md", "one\nTWO\nthree\nfour\n", &writes).unwrap();

        // Snapshot → current.
        let d = diff_version(t.path(), "Ch.md", &first.id, None).unwrap();
        assert_eq!(d.from.id, first.id);
        assert_eq!(d.to.id, "current");
        assert_eq!((d.diff.added, d.diff.removed), (2, 1));
        assert!(!d.diff.identical);

        // Snapshot → snapshot.
        let between = diff_version(t.path(), "Ch.md", &first.id, Some(&second.id)).unwrap();
        assert_eq!(between.to.id, second.id);
        assert_eq!((between.diff.added, between.diff.removed), (1, 1));
        assert_eq!(between.diff.hunks[0].removed, vec!["two"]);
        assert_eq!(between.diff.hunks[0].added, vec!["TWO"]);

        // A snapshot compared with itself is identical.
        let same = diff_version(t.path(), "Ch.md", &first.id, Some(&first.id)).unwrap();
        assert!(same.diff.identical);

        assert!(diff_version(t.path(), "Ch.md", "nope", None).is_err());
        assert!(diff_version(t.path(), "Ch.md", &first.id, Some("nope")).is_err());
    }

    // ── scenes ───────────────────────────────────────────────────────────

    const SCREENPLAY: &str =
        "Title: Helmreach\n\nINT. LIGHTHOUSE - NIGHT\n\nShe climbs.\n\nEXT. CLIFF - DAY\n\nRain.\n";

    #[test]
    fn list_scenes_indexes_a_screenplay_in_body_lines() {
        let t = TempDir::new("ops-scenes");
        t.write("Pilot.fountain", SCREENPLAY);
        let scenes = list_scenes(t.path(), "Pilot.fountain").unwrap();
        assert_eq!(scenes.len(), 2);
        assert_eq!(scenes[0].slug, "INT. LIGHTHOUSE - NIGHT");
        assert_eq!((scenes[0].start_line, scenes[0].end_line), (3, 6));
        assert_eq!(scenes[1].slug, "EXT. CLIFF - DAY");

        // Prose has no scenes, and that is an empty list rather than an error.
        t.write("Ch.md", "Just prose.\n");
        assert!(list_scenes(t.path(), "Ch.md").unwrap().is_empty());
        assert!(list_scenes(t.path(), "missing.fountain").is_err());
    }

    #[test]
    fn reorder_scenes_rewrites_through_the_guarded_path_and_refuses_non_permutations() {
        let t = TempDir::new("ops-reorder-scenes");
        let writes = sw();
        t.write("Pilot.fountain", SCREENPLAY);

        let report = reorder_scenes(t.path(), "Pilot.fountain", &[1, 0], None, &writes).unwrap();
        assert_eq!(report.order, vec![1, 0]);
        assert_eq!(
            report.scenes.iter().map(|s| s.slug.as_str()).collect::<Vec<_>>(),
            ["EXT. CLIFF - DAY", "INT. LIGHTHOUSE - NIGHT"]
        );
        let text = text_of(&t, "Pilot.fountain");
        assert!(text.starts_with("Title: Helmreach\n\n"), "the title page did not move: {text:?}");
        assert!(text.find("EXT. CLIFF").unwrap() < text.find("INT. LIGHTHOUSE").unwrap());
        assert!(text.contains("Rain."));
        assert!(text.contains("She climbs."));

        // The previous script is recoverable.
        let versions = versions_of(t.path(), "Pilot.fountain");
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].body, SCREENPLAY);

        // Not a permutation: refused, and nothing written.
        let before = text_of(&t, "Pilot.fountain");
        for bad in [vec![0], vec![0, 0], vec![0, 1, 2], vec![]] {
            assert!(
                reorder_scenes(t.path(), "Pilot.fountain", &bad, None, &writes).is_err(),
                "{bad:?} is not a permutation of two scenes"
            );
        }
        assert_eq!(text_of(&t, "Pilot.fountain"), before);

        // A document with no headings has nothing to reorder.
        t.write("Ch.md", "Just prose.\n");
        assert!(reorder_scenes(t.path(), "Ch.md", &[0], None, &writes).is_err());
    }

    // ── manuscript and draft folders ─────────────────────────────────────

    #[test]
    fn marking_a_folder_as_a_manuscript_seeds_its_chapter_order() {
        let t = TempDir::new("ops-manuscript-mark");
        let writes = sw();
        t.write("Ideas.md", "notes");
        t.write("Book/Ch_01.md", "a");
        t.write("Book/Ch_02.md", "b");
        // A plain notes folder: nothing is inferred as a manuscript.
        let (before, _) = workflow::read_or_create(t.path()).unwrap();
        assert!(before.manuscripts.is_empty());

        let on = toggle_manuscript_folder(t.path(), "Book", &writes).unwrap();
        assert!(on.marked);
        assert_eq!(on.chapters, vec!["Book/Ch_01.md", "Book/Ch_02.md"]);
        let (after, _) = workflow::read_or_create(t.path()).unwrap();
        assert_eq!(after.manuscripts.len(), 1);
        assert_eq!(after.manuscripts[0].folder, "Book");
        assert_eq!(after.manuscripts[0].title, "Book");
        assert!(writes.is_own(&workflow::workflow_json_path(t.path())));

        // Toggling it off removes the record and leaves the files alone.
        let off = toggle_manuscript_folder(t.path(), "Book", &writes).unwrap();
        assert!(!off.marked);
        let (gone, _) = workflow::read_or_create(t.path()).unwrap();
        assert!(gone.manuscripts.is_empty());
        assert!(t.path().join("Book/Ch_01.md").exists(), "unmarking is not deleting");
    }

    #[test]
    fn a_draft_folder_needs_a_manuscript_above_it() {
        let t = TempDir::new("ops-draft-mark");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "a");
        t.write("Drafts/Second Pass/Ch_01.md", "a2");
        t.write("Loose/note.md", "x");
        workflow::read_or_create(t.path()).unwrap(); // infers "Drafts" as the manuscript

        // Nothing above it.
        let err = toggle_draft_folder(t.path(), "Loose", &writes).unwrap_err();
        assert!(err.contains("toggle_manuscript_folder"), "the refusal names the fix: {err}");
        // The manuscript folder cannot be its own draft.
        assert!(toggle_draft_folder(t.path(), "Drafts", &writes).is_err());

        let on = toggle_draft_folder(t.path(), "Drafts/Second Pass", &writes).unwrap();
        assert!(on.marked);
        assert_eq!(on.chapters, vec!["Drafts/Second Pass/Ch_01.md"]);

        let (wf, _) = workflow::read_or_create(t.path()).unwrap();
        let draft = wf.drafts.iter().find(|d| d.folder.as_deref() == Some("Drafts/Second Pass")).unwrap();
        assert_eq!(draft.name, "Second Pass");
        assert_eq!(draft.chapter_order, vec!["Drafts/Second Pass/Ch_01.md"]);

        let off = toggle_draft_folder(t.path(), "Drafts/Second Pass", &writes).unwrap();
        assert!(!off.marked);
        let (after, _) = workflow::read_or_create(t.path()).unwrap();
        assert!(after.drafts.iter().all(|d| d.folder.is_none()));
        assert!(t.path().join("Drafts/Second Pass/Ch_01.md").exists());
    }

    #[test]
    fn a_folder_backed_draft_is_not_replaced_by_the_manuscripts_order_on_the_next_open() {
        // The hazard the `folder` field exists for. `reconcile_chapter_order`
        // reconciles every draft against the manuscript folder's listing, and
        // an alternate cut's chapters are not in that listing at all — so
        // without the exemption the open-time pass would throw the alternate
        // cut away and replace it with the main one.
        let t = TempDir::new("ops-draft-reconcile");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "a");
        t.write("Drafts/Ch_02.md", "b");
        t.write("Drafts/Second Pass/Ch_01.md", "a2");
        workflow::read_or_create(t.path()).unwrap();
        toggle_draft_folder(t.path(), "Drafts/Second Pass", &writes).unwrap();

        // Something changes on disk, so the reconcile actually runs.
        t.write("Drafts/Ch_03.md", "c");
        t.write("Drafts/Second Pass/Ch_02.md", "b2");
        let (mut wf, _) = workflow::read_or_create(t.path()).unwrap();
        assert!(workflow::reconcile_chapter_order(t.path(), &mut wf));

        let alt = wf.drafts.iter().find(|d| d.folder.as_deref() == Some("Drafts/Second Pass")).unwrap();
        assert_eq!(
            alt.chapter_order,
            vec!["Drafts/Second Pass/Ch_01.md", "Drafts/Second Pass/Ch_02.md"],
            "the alternate cut follows its own folder, new file included"
        );
        let working = wf.drafts.iter().find(|d| d.folder.is_none()).unwrap();
        assert_eq!(
            working.chapter_order,
            vec!["Drafts/Ch_01.md", "Drafts/Ch_02.md", "Drafts/Ch_03.md"],
            "and the manuscript's own cut still follows the manuscript"
        );

        // A reorder of the manuscript leaves the alternate cut alone as well.
        let next = vec![
            "Drafts/Ch_03.md".to_string(),
            "Drafts/Ch_01.md".to_string(),
            "Drafts/Ch_02.md".to_string(),
        ];
        save_workflow(t.path(), &wf, &writes).unwrap();
        reorder_chapters(t.path(), None, &next, &writes).unwrap();
        let (again, _) = workflow::read_or_create(t.path()).unwrap();
        assert_eq!(
            again.drafts.iter().find(|d| d.folder.is_some()).unwrap().chapter_order,
            vec!["Drafts/Second Pass/Ch_01.md", "Drafts/Second Pass/Ch_02.md"]
        );
        assert_eq!(again.drafts.iter().find(|d| d.folder.is_none()).unwrap().chapter_order, next);
    }

    #[test]
    fn unmarking_a_manuscript_takes_the_draft_folders_under_it() {
        let t = TempDir::new("ops-manuscript-unmark-drafts");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "a");
        t.write("Drafts/Second Pass/Ch_01.md", "a2");
        workflow::read_or_create(t.path()).unwrap();
        toggle_draft_folder(t.path(), "Drafts/Second Pass", &writes).unwrap();

        toggle_manuscript_folder(t.path(), "Drafts", &writes).unwrap();
        let (wf, _) = workflow::read_or_create(t.path()).unwrap();
        assert!(wf.manuscripts.is_empty());
        assert!(
            wf.drafts.iter().all(|d| d.folder.is_none()),
            "a draft folder was only a draft because of the manuscript above it"
        );
        assert!(
            wf.drafts.iter().any(|d| d.active == Some(true)),
            "something is still the active cut"
        );
    }

    #[test]
    fn folder_marks_refuse_the_paths_that_are_not_folders_in_the_vault() {
        let t = TempDir::new("ops-mark-guards");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "a");
        for bad in ["", "..", "../elsewhere", ".aquarius", "Nope", "Drafts/Ch_01.md"] {
            assert!(
                toggle_manuscript_folder(t.path(), bad, &writes).is_err(),
                "{bad:?} is not a folder that can hold a manuscript"
            );
            assert!(toggle_draft_folder(t.path(), bad, &writes).is_err());
        }
    }

    #[test]
    fn renaming_a_draft_folder_carries_its_mark() {
        let t = TempDir::new("ops-draft-rename");
        let writes = sw();
        t.write("Drafts/Ch_01.md", "a");
        t.write("Drafts/Second Pass/Ch_01.md", "a2");
        workflow::read_or_create(t.path()).unwrap();
        toggle_draft_folder(t.path(), "Drafts/Second Pass", &writes).unwrap();

        rename_entry(t.path(), "Drafts/Second Pass", "Polish", &writes).unwrap();
        let (wf, _) = workflow::read_or_create(t.path()).unwrap();
        let draft = wf.drafts.iter().find(|d| d.folder.is_some()).unwrap();
        assert_eq!(draft.folder.as_deref(), Some("Drafts/Polish"));
        assert_eq!(draft.chapter_order, vec!["Drafts/Polish/Ch_01.md"]);
    }

    #[test]
    fn a_reordered_manuscript_survives_the_next_open() {
        // What the chapter rail's drag actually has to guarantee (PARITY row
        // 10). Persisting the order is only half of it: `vault_load_workflow`
        // reconciles the manifest against the disk on every open, and if that
        // pass disagreed with what was just written the rail would snap back to
        // alphabetical the next time the vault opened.
        let t = TempDir::new("ops-reorder-reopen");
        t.write("Drafts/Ch_01.md", "a");
        t.write("Drafts/Ch_02.md", "b");
        t.write("Drafts/Ch_03.md", "c");
        let writes = sw();

        let next = vec![
            "Drafts/Ch_03.md".to_string(),
            "Drafts/Ch_01.md".to_string(),
            "Drafts/Ch_02.md".to_string(),
        ];
        reorder_chapters(t.path(), None, &next, &writes).unwrap();

        let (mut reopened, created) = workflow::read_or_create(t.path()).unwrap();
        assert!(!created);
        assert!(
            !workflow::reconcile_chapter_order(t.path(), &mut reopened),
            "the open-time reconcile must not disturb an order the writer chose"
        );
        assert_eq!(reopened.manuscripts[0].chapter_order, next);
        assert_eq!(reopened.drafts[0].chapter_order, next);

        // And a chapter added outside the app lands at the end rather than
        // re-sorting the writer's arrangement.
        t.write("Drafts/Ch_04.md", "d");
        let (mut later, _) = workflow::read_or_create(t.path()).unwrap();
        assert!(workflow::reconcile_chapter_order(t.path(), &mut later));
        assert_eq!(
            later.manuscripts[0].chapter_order,
            ["Drafts/Ch_03.md", "Drafts/Ch_01.md", "Drafts/Ch_02.md", "Drafts/Ch_04.md"],
        );
    }
}
