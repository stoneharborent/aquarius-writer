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
use crate::fs_ops::watcher::SelfWrites;
use crate::model::Workflow;
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
fn dedupe(dir: &Path, stem: &str, ext: Option<&str>) -> String {
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
}
