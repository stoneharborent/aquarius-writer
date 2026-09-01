//! Version history, comments and saved searches — on disk, in `.aquarius/`.
//!
//! Before Stage 2 all of this lived in `localStorage`, which meant a writer's
//! version trail was owned by a WebView profile rather than by the folder it
//! described. Copy the vault to another machine and the history stayed behind.
//! Now it travels with the work:
//!
//! ```text
//! .aquarius/
//!   snapshots/
//!     Drafts/Ch_03/
//!       index.json                     ← labels, timestamps, word counts
//!       2026-08-25T17-42-03.md         ← the text of that version
//!   comments.json                      ← { "Drafts/Ch_03.md": [ … ] }
//!   searches.json                      ← recent find queries
//!   favorites.json                     ← [ "Drafts/Ch_03.md", … ] starred rows
//!   sessions/2026-08-31.json           ← words written that day (`crate::sessions`)
//! ```
//!
//! The version *bodies* are plain markdown on purpose: a writer who loses the
//! app can still read every snapshot with any text editor.

use crate::fs_ops::atomic::write_atomic;
use crate::vault::paths::aq_dir;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Wire shape — mirrors `VersionEntry` in `src/lib/vault/aux.ts`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
    pub id: String,
    pub at: i64,
    pub label: String,
    pub named: bool,
    pub words: usize,
    #[serde(default)]
    pub body: String,
}

/// On-disk index row: everything but the text, which lives beside it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct VersionRow {
    id: String,
    at: i64,
    label: String,
    named: bool,
    words: usize,
    file: String,
}

/// Mirrors `CommentEntry` in aux.ts. Stored verbatim.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommentEntry {
    pub id: String,
    pub at: i64,
    pub anchor: String,
    pub text: String,
    pub resolved: bool,
}

/// Mirrors `TrashEntry` in aux.ts, rebuilt from the real trash on disk.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    pub path: String,
    pub deleted_at: i64,
    pub body: String,
}

/// Everything the renderer's synchronous aux API needs, in one hydration.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuxSnapshot {
    pub versions: BTreeMap<String, Vec<VersionEntry>>,
    pub comments: BTreeMap<String, Vec<CommentEntry>>,
    pub trash: Vec<TrashEntry>,
    pub searches: Vec<String>,
    /// Vault-relative paths the writer has starred, sorted.
    pub favorites: Vec<String>,
}

/// Ceiling on how much version text one hydration will carry into the
/// renderer. Past it, rows still list (label, time, word count) but their body
/// arrives empty — a diff against a very old version is worth losing before a
/// vault that takes ten seconds to open.
const HYDRATION_BUDGET_BYTES: usize = 48 * 1024 * 1024;

fn snapshots_dir(root: &Path) -> PathBuf {
    aq_dir(root).join("snapshots")
}

/// `Drafts/Ch_03.md` → `.aquarius/snapshots/Drafts/Ch_03/`
fn doc_dir(root: &Path, rel: &str) -> PathBuf {
    let p = Path::new(rel);
    let mut dir = snapshots_dir(root);
    if let Some(parent) = p.parent() {
        for comp in parent.components() {
            if let std::path::Component::Normal(c) = comp {
                dir.push(c);
            }
        }
    }
    dir.push(p.file_stem().map(|s| s.to_os_string()).unwrap_or_default());
    dir
}

/// `Drafts` → `.aquarius/snapshots/Drafts/` — the subtree holding every
/// snapshot for documents inside that folder.
fn folder_dir(root: &Path, rel: &str) -> PathBuf {
    let mut dir = snapshots_dir(root);
    for comp in Path::new(rel).components() {
        if let std::path::Component::Normal(c) = comp {
            dir.push(c);
        }
    }
    dir
}

fn comments_path(root: &Path) -> PathBuf {
    aq_dir(root).join("comments.json")
}

fn searches_path(root: &Path) -> PathBuf {
    aq_dir(root).join("searches.json")
}

fn favorites_path(root: &Path) -> PathBuf {
    aq_dir(root).join("favorites.json")
}

// ── versions ─────────────────────────────────────────────────────────────

fn read_rows(dir: &Path) -> Vec<VersionRow> {
    fs::read_to_string(dir.join("index.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<VersionRow>>(&t).ok())
        .unwrap_or_default()
}

pub fn list_versions(root: &Path, rel: &str, budget: &mut usize) -> Vec<VersionEntry> {
    let dir = doc_dir(root, rel);
    read_rows(&dir)
        .into_iter()
        .map(|row| {
            let body = if *budget == 0 {
                String::new()
            } else {
                let text = fs::read_to_string(dir.join(&row.file)).unwrap_or_default();
                *budget = budget.saturating_sub(text.len());
                text
            };
            VersionEntry {
                id: row.id,
                at: row.at,
                label: row.label,
                named: row.named,
                words: row.words,
                body,
            }
        })
        .collect()
}

/// Replace the version list for one document, **keeping named rows the caller
/// has not seen**.
///
/// The renderer always sends the complete desired list (it coalesces and
/// prunes on its side), so this is a set operation: write bodies for rows we
/// don't have yet, drop bodies for rows that are gone, rewrite the index.
///
/// The one exception is the reason this door and `replace_versions` are
/// different functions. The renderer is no longer the only writer of a version
/// trail: an MCP client's `write_document` takes a snapshot of the previous
/// text before it overwrites (docs/NOTES.md §13j), and it does so against a
/// cache the renderer hydrated when the vault opened. Without this, the
/// writer's very next autosave would send back the list it still remembers and
/// silently delete the snapshot that was protecting the AI's overwrite. So a
/// **named** row that is on disk and absent from `entries` is left alone.
/// Unnamed rows still obey the renderer's retention rules — that is how the
/// 25-autosave cap prunes anything at all.
pub fn save_versions(root: &Path, rel: &str, entries: &[VersionEntry]) -> std::io::Result<()> {
    write_versions(root, rel, entries, true)
}

/// A true replace: every row is exactly what was passed, named or not. The
/// backend's own door, used where the caller has just read the list it is
/// rewriting and is therefore not at risk of erasing something it never saw.
fn replace_versions(root: &Path, rel: &str, entries: &[VersionEntry]) -> std::io::Result<()> {
    write_versions(root, rel, entries, false)
}

fn write_versions(
    root: &Path,
    rel: &str,
    entries: &[VersionEntry],
    keep_unseen_named: bool,
) -> std::io::Result<()> {
    let dir = doc_dir(root, rel);
    fs::create_dir_all(&dir)?;
    let existing = read_rows(&dir);
    let ext = Path::new(rel)
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_else(|| "md".into());

    // Two snapshots can want the same file name. `stamp` has one-second
    // resolution and `short` keeps six characters of an id whose leading
    // characters are themselves a timestamp, so two backend snapshots of the
    // same document inside the same second used to land on the same file and
    // the second one overwrote the first one's *body* while both rows stayed
    // in the index — a version history that listed two entries and served the
    // same text for both. Names are de-duplicated instead.
    let mut taken: std::collections::HashSet<String> =
        existing.iter().map(|r| r.file.clone()).collect();

    let mut rows: Vec<VersionRow> = Vec::with_capacity(entries.len());
    for entry in entries {
        let file = match existing.iter().find(|r| r.id == entry.id) {
            Some(r) => r.file.clone(),
            None => {
                let base = format!("{}-{}", stamp(entry.at), short(&entry.id));
                let mut candidate = format!("{base}.{ext}");
                let mut n = 2;
                while taken.contains(&candidate) {
                    candidate = format!("{base}-{n}.{ext}");
                    n += 1;
                }
                candidate
            }
        };
        taken.insert(file.clone());
        write_atomic(&dir.join(&file), entry.body.as_bytes())?;
        rows.push(VersionRow {
            id: entry.id.clone(),
            at: entry.at,
            label: entry.label.clone(),
            named: entry.named,
            words: entry.words,
            file,
        });
    }

    // Named rows the caller's list never mentioned: kept, body untouched, and
    // slotted in by timestamp so the trail stays newest-first. The caller's
    // own ordering is never rearranged — it is the renderer's list and the
    // panels paint it in the order it arrives.
    if keep_unseen_named {
        for old in &existing {
            if old.named && !rows.iter().any(|r| r.id == old.id) {
                let at = rows.iter().position(|r| r.at < old.at).unwrap_or(rows.len());
                rows.insert(at, old.clone());
            }
        }
    }

    // Bodies whose row was pruned by the renderer's retention rules.
    for old in &existing {
        if !rows.iter().any(|r| r.id == old.id) {
            let _ = fs::remove_file(dir.join(&old.file));
        }
    }

    let json = serde_json::to_string_pretty(&rows).map_err(std::io::Error::other)?;
    write_atomic(&dir.join("index.json"), format!("{json}\n").as_bytes())?;
    Ok(())
}

/// The label every snapshot an MCP client's write leaves behind carries.
///
/// Named (so the renderer's 25-autosave retention never prunes it, and so
/// `save_versions` protects it), and recognisable in the Versions panel: the
/// row a writer looks for when they want yesterday's paragraph back after an
/// agent rewrote the chapter.
pub const AGENT_SNAPSHOT_LABEL: &str = "Before AI write";

/// How many of those to keep per document. Named rows are never pruned by the
/// renderer, so if nothing capped these a chatty agent would fill `.aquarius/`
/// with one copy of the chapter per tool call.
pub const MAX_AGENT_SNAPSHOTS: usize = 25;

/// Record one version of a document from the backend side.
///
/// The renderer's own trail is written by `save_versions` from a list it holds
/// in memory; this is for writers that have no such list — the MCP server,
/// which reads what is on disk, prepends, and saves. Returns the row it added.
pub fn snapshot_document(
    root: &Path,
    rel: &str,
    label: &str,
    body: &str,
    at_ms: i64,
) -> std::io::Result<VersionEntry> {
    let mut budget = usize::MAX;
    let mut all = list_versions(root, rel, &mut budget);
    let entry = VersionEntry {
        // `s` for snapshot, matching the renderer's `takeSnapshot` ids, plus a
        // short random tail so two writes in the same millisecond stay distinct.
        id: format!("s{:x}{}", at_ms.max(0), short(&uuid::Uuid::new_v4().simple().to_string())),
        at: at_ms,
        label: label.to_string(),
        named: true,
        words: body.split_whitespace().count(),
        body: body.to_string(),
    };
    all.insert(0, entry.clone());

    // Cap this label's rows, oldest dropped first. Only this label: a
    // snapshot the writer named themselves is theirs to delete.
    let mut kept = 0usize;
    all.retain(|v| {
        if v.label != label {
            return true;
        }
        kept += 1;
        kept <= MAX_AGENT_SNAPSHOTS
    });

    replace_versions(root, rel, &all)?;
    Ok(entry)
}

/// Every document that has a version trail, as vault-relative paths.
fn docs_with_versions(root: &Path) -> Vec<String> {
    let base = snapshots_dir(root);
    let mut out = Vec::new();
    collect_doc_dirs(&base, &base, &mut out);
    out
}

fn collect_doc_dirs(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.filter_map(Result::ok) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        if path.join("index.json").exists() {
            if let Some(rel) = path.strip_prefix(base).ok().map(|p| p.to_string_lossy().to_string()) {
                // The snapshot folder is the document path minus its extension;
                // the index rows carry the real filename.
                if let Some(row) = read_rows(&path).first() {
                    let ext = Path::new(&row.file)
                        .extension()
                        .map(|e| e.to_string_lossy().to_string())
                        .unwrap_or_else(|| "md".into());
                    out.push(format!("{}.{}", rel.replace('\\', "/"), ext));
                }
            }
        } else {
            collect_doc_dirs(base, &path, out);
        }
    }
}

// ── comments + searches ──────────────────────────────────────────────────

pub fn read_comments(root: &Path) -> BTreeMap<String, Vec<CommentEntry>> {
    fs::read_to_string(comments_path(root))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_comments(root: &Path, rel: &str, entries: Vec<CommentEntry>) -> std::io::Result<()> {
    let mut all = read_comments(root);
    if entries.is_empty() {
        all.remove(rel);
    } else {
        all.insert(rel.to_string(), entries);
    }
    write_comments(root, &all)
}

fn write_comments(root: &Path, all: &BTreeMap<String, Vec<CommentEntry>>) -> std::io::Result<()> {
    fs::create_dir_all(aq_dir(root))?;
    let json = serde_json::to_string_pretty(all).map_err(std::io::Error::other)?;
    write_atomic(&comments_path(root), format!("{json}\n").as_bytes())?;
    Ok(())
}

// ── favorites ────────────────────────────────────────────────────────────
//
// A flat array of vault-relative paths in `.aquarius/favorites.json`, the same
// shape and the same neighbourhood as `searches.json`. Kept sorted and
// duplicate-free so the file reads like a list rather than a log, and so two
// stars added in a different order produce the same bytes.
//
// Folders can be starred as well as documents — the Swift app stars any tree
// row (SWIFT-AUDIT §1.4) — which is why `forget` drops a whole subtree and the
// migrations rewrite prefixes as well as exact keys.

/// The starred paths for this vault, sorted.
pub fn read_favorites(root: &Path) -> Vec<String> {
    let mut list: Vec<String> = fs::read_to_string(favorites_path(root))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .unwrap_or_default();
    list.sort();
    list.dedup();
    list
}

/// Replace the starred list. Sorted and de-duplicated on the way in.
pub fn save_favorites(root: &Path, list: &[String]) -> std::io::Result<()> {
    let mut sorted: Vec<String> =
        list.iter().filter(|p| !p.is_empty()).cloned().collect();
    sorted.sort();
    sorted.dedup();
    fs::create_dir_all(aq_dir(root))?;
    let json = serde_json::to_string_pretty(&sorted).map_err(std::io::Error::other)?;
    write_atomic(&favorites_path(root), format!("{json}\n").as_bytes())?;
    Ok(())
}

pub fn is_favorite(root: &Path, rel: &str) -> bool {
    read_favorites(root).iter().any(|p| p == rel)
}

/// Star or unstar one path. Returns the state it ended in, so a caller that
/// asked for a toggle does not have to read the file again to find out.
pub fn set_favorite(root: &Path, rel: &str, starred: bool) -> std::io::Result<bool> {
    let mut list = read_favorites(root);
    let already = list.iter().any(|p| p == rel);
    if already == starred {
        return Ok(starred);
    }
    if starred {
        list.push(rel.to_string());
    } else {
        list.retain(|p| p != rel);
    }
    save_favorites(root, &list)?;
    Ok(starred)
}

/// Flip one path's star. Returns its new state.
pub fn toggle_favorite(root: &Path, rel: &str) -> std::io::Result<bool> {
    let next = !is_favorite(root, rel);
    set_favorite(root, rel, next)
}

/// Drop `rel` — and, if it is a folder, everything under it — from the starred
/// list. Called when something is trashed: a star pointing at a file that is no
/// longer in the tree would show up in the Starred quick view as a row that
/// cannot be opened.
pub fn forget_favorite(root: &Path, rel: &str) -> std::io::Result<()> {
    let prefix = format!("{rel}/");
    let list = read_favorites(root);
    let next: Vec<String> = list
        .iter()
        .filter(|p| p.as_str() != rel && !p.starts_with(&prefix))
        .cloned()
        .collect();
    if next.len() == list.len() {
        return Ok(());
    }
    save_favorites(root, &next)
}

/// Rewrite starred paths after a rename or move. `folder` widens the match to
/// everything inside the moved path as well as the path itself.
fn migrate_favorites(
    root: &Path,
    from_rel: &str,
    to_rel: &str,
    folder: bool,
) -> std::io::Result<()> {
    let prefix = format!("{from_rel}/");
    let list = read_favorites(root);
    let mut changed = false;
    let next: Vec<String> = list
        .iter()
        .map(|p| {
            if p == from_rel {
                changed = true;
                to_rel.to_string()
            } else if folder {
                match p.strip_prefix(&prefix) {
                    Some(rest) => {
                        changed = true;
                        format!("{to_rel}/{rest}")
                    }
                    None => p.clone(),
                }
            } else {
                p.clone()
            }
        })
        .collect();
    if changed {
        save_favorites(root, &next)?;
    }
    Ok(())
}

// ── following a file when it is renamed or moved ─────────────────────────
//
// Both stores are keyed by the document's *relative path*, so a rename that
// only touched the file would strand its whole history: the snapshot folder
// would sit under the old name forever and `comments.json` would keep pointing
// at a path that no longer exists. History belongs to the document, not to the
// name it happened to have, so `vault::ops` calls these in the same operation
// as the rename — see the aux-migration note there.

/// Move one document's snapshot folder, comment key and star to a new path.
pub fn migrate_document(root: &Path, from_rel: &str, to_rel: &str) -> std::io::Result<()> {
    if from_rel == to_rel {
        return Ok(());
    }
    move_tree(&doc_dir(root, from_rel), &doc_dir(root, to_rel))?;
    let mut all = read_comments(root);
    if let Some(entries) = all.remove(from_rel) {
        all.insert(to_rel.to_string(), entries);
        write_comments(root, &all)?;
    }
    migrate_favorites(root, from_rel, to_rel, false)?;
    crate::sessions::migrate_document(root, from_rel, to_rel)?;
    Ok(())
}

/// The same, for a folder: its whole snapshot subtree and every comment key
/// underneath it.
pub fn migrate_folder(root: &Path, from_rel: &str, to_rel: &str) -> std::io::Result<()> {
    if from_rel == to_rel || from_rel.is_empty() || to_rel.is_empty() {
        return Ok(());
    }
    move_tree(&folder_dir(root, from_rel), &folder_dir(root, to_rel))?;

    let prefix = format!("{from_rel}/");
    let mut next: BTreeMap<String, Vec<CommentEntry>> = BTreeMap::new();
    let mut changed = false;
    for (key, entries) in read_comments(root) {
        match key.strip_prefix(&prefix) {
            Some(rest) => {
                next.insert(format!("{to_rel}/{rest}"), entries);
                changed = true;
            }
            None => {
                next.insert(key, entries);
            }
        }
    }
    if changed {
        write_comments(root, &next)?;
    }
    migrate_favorites(root, from_rel, to_rel, true)?;
    crate::sessions::migrate_folder(root, from_rel, to_rel)?;
    Ok(())
}

/// Move a metadata folder, creating the destination's parents.
///
/// A folder already sitting at the destination is history for a document that
/// no longer exists there (the vault side de-duplicates names, so the new path
/// was free on disk). It is replaced rather than merged: two documents' trails
/// interleaved in one index would be worse than losing an orphan.
fn move_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if !from.exists() || from == to {
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    if to.exists() {
        fs::remove_dir_all(to)?;
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_tree(from, to)?;
    fs::remove_dir_all(from)
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)?.filter_map(Result::ok) {
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

pub fn read_searches(root: &Path) -> Vec<String> {
    fs::read_to_string(searches_path(root))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_searches(root: &Path, list: &[String]) -> std::io::Result<()> {
    fs::create_dir_all(aq_dir(root))?;
    let json = serde_json::to_string_pretty(list).map_err(std::io::Error::other)?;
    write_atomic(&searches_path(root), format!("{json}\n").as_bytes())?;
    Ok(())
}

// ── the one-shot hydration ───────────────────────────────────────────────

pub fn hydrate(root: &Path) -> AuxSnapshot {
    let mut budget = HYDRATION_BUDGET_BYTES;
    let mut versions = BTreeMap::new();
    for rel in docs_with_versions(root) {
        let list = list_versions(root, &rel, &mut budget);
        if !list.is_empty() {
            versions.insert(rel, list);
        }
    }

    AuxSnapshot {
        versions,
        comments: read_comments(root),
        trash: trash_entries(root),
        searches: read_searches(root),
        favorites: read_favorites(root),
    }
}

/// The Recently Deleted list, rebuilt from the real trash on disk.
pub fn trash_entries(root: &Path) -> Vec<TrashEntry> {
    crate::fs_ops::trash::read_index(root)
        .entries
        .into_iter()
        .map(|r| {
            let stored = crate::fs_ops::trash::trash_dir(root).join(&r.stored_as).join(&r.path);
            TrashEntry {
                id: r.id,
                path: r.path,
                deleted_at: r.deleted_at,
                // Best effort: a trashed image has no text body, and the
                // renderer only uses this for restore fallbacks.
                body: fs::read_to_string(&stored).unwrap_or_default(),
            }
        })
        .collect()
}

fn stamp(at_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(at_ms)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%dT%H-%M-%S").to_string())
        .unwrap_or_else(|| "unknown-time".into())
}

fn short(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric()).take(6).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn entry(id: &str, label: &str, named: bool, body: &str) -> VersionEntry {
        VersionEntry {
            id: id.into(),
            at: crate::vault::registry::now_ms(),
            label: label.into(),
            named,
            words: body.split_whitespace().count(),
            body: body.into(),
        }
    }

    #[test]
    fn versions_round_trip_through_disk() {
        let t = TempDir::new("aux-versions");
        let rel = "Drafts/Ch_03.md";
        let list = vec![entry("v2", "Auto", false, "second pass"), entry("v1", "Snapshot", true, "first pass")];
        save_versions(t.path(), rel, &list).unwrap();

        let mut budget = usize::MAX;
        let back = list_versions(t.path(), rel, &mut budget);
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].id, "v2");
        assert_eq!(back[0].body, "second pass");
        assert_eq!(back[1].label, "Snapshot");
        assert!(back[1].named);
    }

    #[test]
    fn version_bodies_are_readable_markdown_beside_the_index() {
        let t = TempDir::new("aux-readable");
        save_versions(t.path(), "Drafts/Ch_03.md", &[entry("v1", "Auto", false, "the text")]).unwrap();
        let dir = t.path().join(".aquarius/snapshots/Drafts/Ch_03");
        let files: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(files.iter().any(|f| f == "index.json"));
        let body_file = files.iter().find(|f| f.ends_with(".md")).expect("a .md snapshot");
        assert_eq!(fs::read_to_string(dir.join(body_file)).unwrap(), "the text");
    }

    #[test]
    fn pruned_versions_take_their_bodies_with_them() {
        let t = TempDir::new("aux-prune");
        let rel = "note.md";
        save_versions(t.path(), rel, &[entry("a", "Auto", false, "aaa"), entry("b", "Auto", false, "bbb")]).unwrap();
        save_versions(t.path(), rel, &[entry("b", "Auto", false, "bbb")]).unwrap();

        let dir = doc_dir(t.path(), rel);
        let bodies = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".md"))
            .count();
        assert_eq!(bodies, 1, "the dropped version's text is deleted too");
    }

    // ── snapshots taken from the backend side ────────────────────────────

    fn bodies(root: &Path, rel: &str) -> Vec<String> {
        let mut budget = usize::MAX;
        list_versions(root, rel, &mut budget).into_iter().map(|v| v.body).collect()
    }

    #[test]
    fn a_backend_snapshot_lands_at_the_top_of_the_trail() {
        let t = TempDir::new("aux-snapshot");
        let rel = "Drafts/Ch_01.md";
        save_versions(t.path(), rel, &[entry("v1", "Auto", false, "yesterday")]).unwrap();

        let taken = snapshot_document(t.path(), rel, AGENT_SNAPSHOT_LABEL, "today", 9_000).unwrap();
        assert_eq!(taken.label, AGENT_SNAPSHOT_LABEL);
        assert!(taken.named);
        assert_eq!(taken.words, 1);

        let all = bodies(t.path(), rel);
        assert_eq!(all, vec!["today", "yesterday"], "newest first, and the old trail is intact");
    }

    #[test]
    fn two_snapshots_in_the_same_second_keep_separate_bodies() {
        // `stamp` has one-second resolution and `short` keeps six characters of
        // an id that starts with the same timestamp, so both of these used to
        // resolve to one file: the trail listed two versions and handed back
        // the newer text for both of them, silently losing the older one.
        let t = TempDir::new("aux-snapshot-collision");
        let rel = "Drafts/Ch_01.md";
        snapshot_document(t.path(), rel, "v1", "the first text", 1_700_000_000_000).unwrap();
        snapshot_document(t.path(), rel, "v2", "the second text", 1_700_000_000_004).unwrap();

        assert_eq!(bodies(t.path(), rel), vec!["the second text", "the first text"]);
    }

    #[test]
    fn backend_snapshots_are_capped_so_a_chatty_agent_cannot_fill_the_vault() {
        let t = TempDir::new("aux-snapshot-cap");
        let rel = "note.md";
        // One the writer named themselves, which must survive the capping.
        save_versions(t.path(), rel, &[entry("mine", "Before the rewrite", true, "keep me")])
            .unwrap();

        for i in 0..(MAX_AGENT_SNAPSHOTS + 5) {
            snapshot_document(t.path(), rel, AGENT_SNAPSHOT_LABEL, &format!("pass {i}"), 100 + i as i64)
                .unwrap();
        }

        let mut budget = usize::MAX;
        let all = list_versions(t.path(), rel, &mut budget);
        let agent: Vec<&VersionEntry> =
            all.iter().filter(|v| v.label == AGENT_SNAPSHOT_LABEL).collect();
        assert_eq!(agent.len(), MAX_AGENT_SNAPSHOTS, "the oldest agent snapshots are dropped");
        assert_eq!(agent[0].body, format!("pass {}", MAX_AGENT_SNAPSHOTS + 4), "newest kept");
        assert!(
            all.iter().any(|v| v.label == "Before the rewrite"),
            "a snapshot the writer named is theirs, and the cap does not touch it"
        );
    }

    #[test]
    fn the_renderers_save_cannot_erase_a_snapshot_it_never_saw() {
        // The sequence this protects against, in order: the app opens a vault
        // and hydrates the version trail; an MCP client writes and snapshots
        // what it replaced; the writer types one word and autosaves, sending
        // back the list it hydrated. Without the rule the third step deletes
        // the second's safety net.
        let t = TempDir::new("aux-save-preserves");
        let rel = "Drafts/Ch_01.md";
        let hydrated = vec![entry("auto-1", "Auto", false, "what the editor had")];
        save_versions(t.path(), rel, &hydrated).unwrap();

        snapshot_document(t.path(), rel, AGENT_SNAPSHOT_LABEL, "what the agent replaced", 5_000)
            .unwrap();

        // The renderer autosaves, knowing nothing about the snapshot.
        let mut next = hydrated.clone();
        next.insert(0, entry("auto-2", "Auto", false, "one more word"));
        save_versions(t.path(), rel, &next).unwrap();

        let all = bodies(t.path(), rel);
        assert!(
            all.contains(&"what the agent replaced".to_string()),
            "the agent's snapshot survived the renderer's next save: {all:?}"
        );
        assert!(all.contains(&"one more word".to_string()));

        // Unnamed rows still obey the renderer — that is how pruning works.
        save_versions(t.path(), rel, &[entry("auto-2", "Auto", false, "one more word")]).unwrap();
        let pruned = bodies(t.path(), rel);
        assert!(!pruned.contains(&"what the editor had".to_string()), "autos still prune");
        assert!(pruned.contains(&"what the agent replaced".to_string()));
    }

    #[test]
    fn comments_and_searches_persist_per_document() {
        let t = TempDir::new("aux-comments");
        save_comments(
            t.path(),
            "Drafts/Ch_01.md",
            vec![CommentEntry {
                id: "c1".into(),
                at: 1,
                anchor: "the lamp".into(),
                text: "cut this".into(),
                resolved: false,
            }],
        )
        .unwrap();
        save_searches(t.path(), &["lantern".into(), "bell".into()]).unwrap();

        let all = read_comments(t.path());
        assert_eq!(all.get("Drafts/Ch_01.md").unwrap()[0].text, "cut this");
        assert_eq!(read_searches(t.path()), vec!["lantern", "bell"]);

        save_comments(t.path(), "Drafts/Ch_01.md", vec![]).unwrap();
        assert!(read_comments(t.path()).is_empty(), "clearing a doc's comments removes the key");
    }

    fn comment(text: &str) -> CommentEntry {
        CommentEntry {
            id: format!("c-{text}"),
            at: 1,
            anchor: "somewhere".into(),
            text: text.into(),
            resolved: false,
        }
    }

    #[test]
    fn a_renamed_document_keeps_its_versions_and_comments() {
        let t = TempDir::new("aux-migrate-doc");
        save_versions(t.path(), "Drafts/Ch_03.md", &[entry("v1", "Auto", false, "third pass")]).unwrap();
        save_comments(t.path(), "Drafts/Ch_03.md", vec![comment("tighten this")]).unwrap();

        migrate_document(t.path(), "Drafts/Ch_03.md", "Drafts/Helmreach in Rain.md").unwrap();

        let mut budget = usize::MAX;
        assert!(
            list_versions(t.path(), "Drafts/Ch_03.md", &mut budget).is_empty(),
            "the old path must not still own the trail"
        );
        let moved = list_versions(t.path(), "Drafts/Helmreach in Rain.md", &mut budget);
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].body, "third pass");

        let all = read_comments(t.path());
        assert!(all.get("Drafts/Ch_03.md").is_none());
        assert_eq!(all.get("Drafts/Helmreach in Rain.md").unwrap()[0].text, "tighten this");
    }

    #[test]
    fn a_moved_folder_takes_every_documents_history_with_it() {
        let t = TempDir::new("aux-migrate-folder");
        save_versions(t.path(), "Drafts/Ch_01.md", &[entry("v1", "Auto", false, "one")]).unwrap();
        save_versions(t.path(), "Drafts/Deep/Ch_02.md", &[entry("v2", "Auto", false, "two")]).unwrap();
        save_comments(t.path(), "Drafts/Ch_01.md", vec![comment("a")]).unwrap();
        save_comments(t.path(), "Drafts/Deep/Ch_02.md", vec![comment("b")]).unwrap();
        save_comments(t.path(), "Characters/Imogen.md", vec![comment("untouched")]).unwrap();

        migrate_folder(t.path(), "Drafts", "Archive/Drafts").unwrap();

        let mut budget = usize::MAX;
        assert_eq!(list_versions(t.path(), "Archive/Drafts/Ch_01.md", &mut budget)[0].body, "one");
        assert_eq!(list_versions(t.path(), "Archive/Drafts/Deep/Ch_02.md", &mut budget)[0].body, "two");
        assert!(list_versions(t.path(), "Drafts/Ch_01.md", &mut budget).is_empty());

        let all = read_comments(t.path());
        assert_eq!(all.get("Archive/Drafts/Ch_01.md").unwrap()[0].text, "a");
        assert_eq!(all.get("Archive/Drafts/Deep/Ch_02.md").unwrap()[0].text, "b");
        assert_eq!(
            all.get("Characters/Imogen.md").unwrap()[0].text,
            "untouched",
            "a key outside the moved folder is left alone"
        );
    }

    // ── favorites ────────────────────────────────────────────────────────

    #[test]
    fn stars_persist_sorted_and_never_twice() {
        let t = TempDir::new("aux-favorites");
        assert!(read_favorites(t.path()).is_empty(), "a fresh vault has no stars");

        assert!(set_favorite(t.path(), "Drafts/Ch_03.md", true).unwrap());
        assert!(set_favorite(t.path(), "Characters/Imogen.md", true).unwrap());
        // Starring the same path again is not an error and does not duplicate.
        assert!(set_favorite(t.path(), "Drafts/Ch_03.md", true).unwrap());

        assert_eq!(
            read_favorites(t.path()),
            vec!["Characters/Imogen.md", "Drafts/Ch_03.md"],
            "the file is a sorted set, not an append log"
        );
        assert!(is_favorite(t.path(), "Drafts/Ch_03.md"));
        assert!(!is_favorite(t.path(), "Drafts/Ch_04.md"));

        // The bytes on disk are plain JSON anyone can read.
        let raw = fs::read_to_string(t.path().join(".aquarius/favorites.json")).unwrap();
        assert!(raw.contains("Drafts/Ch_03.md"), "got {raw}");

        assert!(!set_favorite(t.path(), "Drafts/Ch_03.md", false).unwrap());
        assert_eq!(read_favorites(t.path()), vec!["Characters/Imogen.md"]);
    }

    #[test]
    fn toggling_a_star_reports_the_state_it_landed_in() {
        let t = TempDir::new("aux-favorites-toggle");
        assert!(toggle_favorite(t.path(), "note.md").unwrap());
        assert!(!toggle_favorite(t.path(), "note.md").unwrap());
        assert!(read_favorites(t.path()).is_empty());
    }

    #[test]
    fn trashing_something_drops_it_and_its_children_from_the_stars() {
        let t = TempDir::new("aux-favorites-forget");
        save_favorites(
            t.path(),
            &[
                "Drafts/Ch_01.md".into(),
                "Drafts/Deep/Ch_02.md".into(),
                "Characters/Imogen.md".into(),
            ],
        )
        .unwrap();

        forget_favorite(t.path(), "Drafts/Ch_01.md").unwrap();
        assert_eq!(
            read_favorites(t.path()),
            vec!["Characters/Imogen.md", "Drafts/Deep/Ch_02.md"]
        );

        // A folder takes everything under it.
        forget_favorite(t.path(), "Drafts").unwrap();
        assert_eq!(read_favorites(t.path()), vec!["Characters/Imogen.md"]);
    }

    #[test]
    fn a_renamed_document_keeps_its_star() {
        let t = TempDir::new("aux-favorites-rename");
        save_favorites(
            t.path(),
            &["Drafts/Ch_03.md".into(), "Drafts/Ch_03.md.bak".into()],
        )
        .unwrap();

        migrate_document(t.path(), "Drafts/Ch_03.md", "Drafts/Helmreach in Rain.md").unwrap();

        assert_eq!(
            read_favorites(t.path()),
            vec!["Drafts/Ch_03.md.bak", "Drafts/Helmreach in Rain.md"],
            "only the exact key moves — a path that merely starts the same is left alone"
        );
    }

    #[test]
    fn a_moved_folder_takes_every_star_underneath_it() {
        let t = TempDir::new("aux-favorites-move-folder");
        save_favorites(
            t.path(),
            &[
                "Drafts".into(),
                "Drafts/Ch_01.md".into(),
                "Drafts/Deep/Ch_02.md".into(),
                "Characters/Imogen.md".into(),
            ],
        )
        .unwrap();

        migrate_folder(t.path(), "Drafts", "Archive/Drafts").unwrap();

        assert_eq!(
            read_favorites(t.path()),
            vec![
                "Archive/Drafts",
                "Archive/Drafts/Ch_01.md",
                "Archive/Drafts/Deep/Ch_02.md",
                "Characters/Imogen.md",
            ],
            "the starred folder and everything starred inside it followed the move"
        );
    }

    #[test]
    fn hydration_finds_every_document_and_the_trash() {
        let t = TempDir::new("aux-hydrate");
        t.write("Drafts/Ch_01.md", "chapter one");
        t.write("Characters/Imogen.md", "imogen");
        save_versions(t.path(), "Drafts/Ch_01.md", &[entry("v1", "Auto", false, "chapter one")]).unwrap();
        save_versions(t.path(), "Characters/Imogen.md", &[entry("v9", "Auto", false, "imogen")]).unwrap();
        crate::fs_ops::trash::soft_delete(t.path(), "Characters/Imogen.md", crate::vault::registry::now_ms()).unwrap();
        set_favorite(t.path(), "Drafts/Ch_01.md", true).unwrap();

        let snap = hydrate(t.path());
        assert_eq!(snap.favorites, vec!["Drafts/Ch_01.md"], "stars ride along in the hydration");
        assert_eq!(snap.versions.len(), 2, "both documents' trails hydrate: {:?}", snap.versions.keys());
        assert_eq!(snap.versions.get("Drafts/Ch_01.md").unwrap()[0].body, "chapter one");
        assert_eq!(snap.trash.len(), 1);
        assert_eq!(snap.trash[0].path, "Characters/Imogen.md");
        assert_eq!(snap.trash[0].body, "imogen", "the trashed text is available for restore");
    }
}
