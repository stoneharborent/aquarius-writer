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
