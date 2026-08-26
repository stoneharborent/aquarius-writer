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

fn comments_path(root: &Path) -> PathBuf {
    aq_dir(root).join("comments.json")
}

fn searches_path(root: &Path) -> PathBuf {
    aq_dir(root).join("searches.json")
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

/// Replace the version list for one document.
///
/// The renderer always sends the complete desired list (it coalesces and
/// prunes on its side), so this is a set operation: write bodies for rows we
/// don't have yet, drop bodies for rows that are gone, rewrite the index.
pub fn save_versions(root: &Path, rel: &str, entries: &[VersionEntry]) -> std::io::Result<()> {
    let dir = doc_dir(root, rel);
    fs::create_dir_all(&dir)?;
    let existing = read_rows(&dir);
    let ext = Path::new(rel)
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_else(|| "md".into());

    let mut rows: Vec<VersionRow> = Vec::with_capacity(entries.len());
    for entry in entries {
        let file = match existing.iter().find(|r| r.id == entry.id) {
            Some(r) => r.file.clone(),
            None => format!("{}-{}.{}", stamp(entry.at), short(&entry.id), ext),
        };
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
    fs::create_dir_all(aq_dir(root))?;
    let json = serde_json::to_string_pretty(&all).map_err(std::io::Error::other)?;
    write_atomic(&comments_path(root), format!("{json}\n").as_bytes())?;
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

    let trash = crate::fs_ops::trash::read_index(root)
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
        .collect();

    AuxSnapshot {
        versions,
        comments: read_comments(root),
        trash,
        searches: read_searches(root),
    }
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

    #[test]
    fn hydration_finds_every_document_and_the_trash() {
        let t = TempDir::new("aux-hydrate");
        t.write("Drafts/Ch_01.md", "chapter one");
        t.write("Characters/Imogen.md", "imogen");
        save_versions(t.path(), "Drafts/Ch_01.md", &[entry("v1", "Auto", false, "chapter one")]).unwrap();
        save_versions(t.path(), "Characters/Imogen.md", &[entry("v9", "Auto", false, "imogen")]).unwrap();
        crate::fs_ops::trash::soft_delete(t.path(), "Characters/Imogen.md", crate::vault::registry::now_ms()).unwrap();

        let snap = hydrate(t.path());
        assert_eq!(snap.versions.len(), 2, "both documents' trails hydrate: {:?}", snap.versions.keys());
        assert_eq!(snap.versions.get("Drafts/Ch_01.md").unwrap()[0].body, "chapter one");
        assert_eq!(snap.trash.len(), 1);
        assert_eq!(snap.trash[0].path, "Characters/Imogen.md");
        assert_eq!(snap.trash[0].body, "imogen", "the trashed text is available for restore");
    }
}
