//! Wire types shared with the renderer.
//!
//! Every struct here mirrors a TypeScript type in `src/types/vault.ts`, field
//! for field, so `invoke()` results drop straight into the existing UI without
//! a translation layer. Serde renames to camelCase; the TS side is the contract.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ── workflow.json (HANDOFF §3) ───────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(default)]
    pub chapter_order: Vec<String>,
    /// The folder this draft's chapters come from, when it is a *folder-backed*
    /// draft — one a caller marked with `toggle_draft_folder`, the Swift app's
    /// `draftFolders` idea (SWIFT-AUDIT §2.8) mapped onto this side's richer
    /// `Draft`. `None` is the ordinary case: a draft that is just a named cut
    /// of the manuscript's chapters, which is what `workflow::infer` creates.
    ///
    /// It matters to `reconcile_chapter_order`: a folder-backed draft is
    /// reconciled against *its own* folder, never against the manuscript's, or
    /// the open-time pass would replace an alternate cut with the main one.
    /// The renderer does not read this key; it round-trips through the file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manuscript {
    pub id: String,
    pub title: String,
    /// Relative path of the folder inside the workflow.
    pub folder: String,
    #[serde(default)]
    pub chapter_order: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSettings {
    pub theme: String,
    pub accent: String,
    pub font_size: u32,
}

impl Default for WorkflowSettings {
    fn default() -> Self {
        Self { theme: "parchment".into(), accent: "blue".into(), font_size: 17 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Goals {
    pub daily_words: u32,
    pub kind: String,
}

impl Default for Goals {
    fn default() -> Self {
        Self { daily_words: 1000, kind: "daily".into() }
    }
}

/// The on-disk `.aquarius/workflow.json`. Unknown keys survive a round trip
/// through `extra` — we never drop something a future version wrote.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub title: String,
    pub kind: String,
    #[serde(default)]
    pub drafts: Vec<Draft>,
    #[serde(default)]
    pub manuscripts: Vec<Manuscript>,
    #[serde(default)]
    pub settings: WorkflowSettings,
    #[serde(default)]
    pub goals: Goals,
    #[serde(flatten, default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, serde_json::Value>,
}

// ── what the sidebar / picker consume ────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSummary {
    pub id: String,
    pub name: String,
    /// Display path — `~`-shortened absolute path.
    pub path: String,
    pub kind: String,
    pub items: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    pub color: String,
    /// Human string: "now" | "12m ago" | "yesterday" | "3d ago" | "Apr 12".
    pub updated: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultNode {
    pub name: String,
    /// Relative to the workflow root, `/`-separated. The root itself is "".
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<VaultNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frontmatter: Option<BTreeMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<usize>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoadedWorkflow {
    pub workflow: Workflow,
    pub tree: VaultNode,
}

// ── optimistic concurrency on the save path (PARITY row 9) ───────────────
//
// Three shapes, mirrored in `src/types/vault.ts`. Together they are the whole
// conflict contract: a read hands back a `FileStamp` alongside the text, the
// editor keeps it as that buffer's baseline, and a write that carries the
// baseline is refused if the file on disk has stopped matching it.

/// What the app last saw of a file on disk.
///
/// `hash` is the decision-maker — lowercase hex SHA-256 of the exact bytes.
/// `mtimeMs` and `bytes` are along for diagnostics and display; nothing is ever
/// refused because of them. `fs_ops::stamp` explains why at length (short
/// version: filesystems disagree about timestamp precision and iCloud re-stamps
/// files it did not rewrite).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    pub hash: String,
    /// Epoch milliseconds, or 0 when the filesystem would not say.
    pub mtime_ms: i64,
    pub bytes: usize,
}

/// A document's text plus the stamp of the bytes it was read from.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileRead {
    pub path: String,
    /// The file as it sits on disk, frontmatter included. Lossy UTF-8 — the
    /// stamp beside it describes the *real* bytes.
    pub content: String,
    pub stamp: FileStamp,
}

/// What came of a write.
///
/// A refused write is a `conflict` **result**, not a thrown error: the caller
/// needs the on-disk text to show a diff, and an error string cannot carry it.
/// Errors stay errors — a path outside the vault, a permission problem — and
/// still come back as `Err(String)`.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WriteResult {
    /// The bytes are on disk. `changed` is false when they were already
    /// identical and the file was not touched at all (mtime included).
    Written { path: String, changed: bool, stamp: FileStamp },
    /// Refused. The file no longer matches the stamp the caller was holding,
    /// so writing would have thrown away whatever changed it. `theirs` is the
    /// text that is on disk right now.
    Conflict { path: String, theirs: String, stamp: FileStamp },
}

impl WriteResult {
    /// True when the write was refused because the file had moved on.
    pub fn is_conflict(&self) -> bool {
        matches!(self, WriteResult::Conflict { .. })
    }
}

/// How the renderer should turn a binary asset into a URL.
///
/// `File` means "run this absolute path through `convertFileSrc`" — the
/// asset protocol streams it, which is what large PDFs and video need.
/// `Data` is the fallback for when the asset-protocol scope refused the
/// directory; the bytes come back inline as a data URL.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum AssetRef {
    File { path: String },
    Data { url: String },
}
