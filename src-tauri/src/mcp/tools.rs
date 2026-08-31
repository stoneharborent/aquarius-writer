//! The tool surface — what an AI client can do to a vault.
//!
//! The doctrine this stage set down: **if a human can do it in the app, an MCP
//! client can do it too.** Every tool here is a thin wrapper over the same
//! `vault::ops` / `fs_ops` functions the UI's Tauri commands call. Nothing in
//! this file implements a vault operation itself; if a tool needs behaviour
//! that does not exist yet, it goes into `vault::ops` where both doors can
//! reach it.
//!
//! Three conventions run through the whole surface:
//!
//! * **Every path is vault-relative**, `/`-separated, and checked by
//!   `vault::paths::resolve_in_root`. There is no way to name a file outside
//!   the workflow.
//! * **Every tool names its workflow explicitly.** There is no "current
//!   workflow" — the UI's open document and the MCP client's are unrelated, and
//!   a hidden shared cursor between them would be a source of very confusing
//!   bugs. Start with `list_workflows`.
//! * **Results come back as pretty-printed JSON in a text content block.**
//!   Structured content would be marginally nicer, but text JSON is what every
//!   MCP client reads today, and the shapes here are the same ones
//!   `src/types/vault.ts` describes.
//!
//! Deletion is soft and reversible (`trash_document` → `.aquarius/trash/`, 30-day
//! retention, `restore_document` puts it back). **Permanent deletion is
//! deliberately not exposed.** `trash::purge` exists in the backend for the UI's
//! Recently Deleted sheet, and an AI client has no business calling it.

use crate::aux_store;
use crate::fs_ops::trash;
use crate::mcp::McpState;
use crate::state::AppState;
use crate::vault::{self, ops};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::{tool, tool_handler, tool_router, ErrorData};
use schemars::JsonSchema;
use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

/// The MCP server's view of the app. Deliberately just a handle: every tool
/// reads the one live `AppState` through it, so the registry, the watcher
/// ledger and the asset scope are shared with the UI rather than duplicated.
#[derive(Clone)]
pub struct AquariusMcp {
    app: AppHandle,
}

impl AquariusMcp {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    fn root(&self, workflow_id: &str) -> Result<PathBuf, ErrorData> {
        self.state().root_for(workflow_id).map_err(invalid)
    }

    /// Tell the UI a workflow changed underneath it.
    ///
    /// Writes here stamp the self-write ledger (they must — see
    /// docs/NOTES.md §3c), which means the file watcher deliberately ignores
    /// them. So the notification is sent explicitly instead: exactly one event
    /// per tool call, no debounce race, no chance of the reload loop the
    /// ledger exists to prevent.
    fn notify(&self, workflow_id: &str) {
        let _ = self.app.emit(
            crate::commands::CHANGE_EVENT,
            serde_json::json!({ "workflowId": workflow_id }),
        );
    }
}

fn invalid(message: impl std::fmt::Display) -> ErrorData {
    ErrorData::invalid_params(message.to_string(), None)
}

fn internal(message: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(message.to_string(), None)
}

/// Every tool answers with pretty JSON, so a model reading the transcript sees
/// something it can quote back verbatim.
fn json(value: impl serde::Serialize) -> Result<String, ErrorData> {
    serde_json::to_string_pretty(&value).map_err(internal)
}

// ── parameters ───────────────────────────────────────────────────────────
// The doc comment on each field becomes its description in the JSON schema the
// client sees, so these are written for a model, not for us.

#[derive(Deserialize, JsonSchema)]
pub struct WorkflowParam {
    /// Workflow id, from `list_workflows`. Vaults are never addressed by path.
    pub workflow_id: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct DocumentParam {
    /// Workflow id, from `list_workflows`.
    pub workflow_id: String,
    /// Path to the document, relative to the vault root, `/`-separated —
    /// e.g. "Drafts/Ch_01.md". Never an absolute path.
    pub path: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct FolderParam {
    /// Workflow id, from `list_workflows`.
    pub workflow_id: String,
    /// Folder relative to the vault root, e.g. "Drafts". Omit or pass "" for
    /// the vault root itself.
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct WriteParam {
    /// Workflow id, from `list_workflows`.
    pub workflow_id: String,
    /// Path to the document, relative to the vault root.
    pub path: String,
    /// The complete new contents of the file, frontmatter included. This
    /// REPLACES the whole document — read it first and send back the full text
    /// with your edit applied, never just the changed part.
    pub content: String,
    /// The `hash` read_document gave you for this file. Send it and the write
    /// is refused if anything changed the document in the meantime — you get
    /// the current text back instead of overwriting it. Omit it to write
    /// regardless, which is what happens if you leave this out.
    #[serde(default)]
    pub expected_hash: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct CreateParam {
    /// Workflow id, from `list_workflows`.
    pub workflow_id: String,
    /// Path for the new document, relative to the vault root. Must end in
    /// .md, .markdown, .fountain or .txt. Missing folders are created.
    pub path: String,
    /// Starting contents. Defaults to an empty file.
    #[serde(default)]
    pub content: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct CreateFolderParam {
    /// Workflow id, from `list_workflows`.
    pub workflow_id: String,
    /// The folder to create it inside, relative to the vault root — e.g.
    /// "Drafts". Omit or pass "" for the vault root itself.
    #[serde(default)]
    pub parent: Option<String>,
    /// Name for the new folder. One name, not a path: no "/" and no "..".
    pub name: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct RenameParam {
    /// Workflow id, from `list_workflows`.
    pub workflow_id: String,
    /// The file or folder to rename, relative to the vault root.
    pub path: String,
    /// The new name. One name, not a path — to put the file somewhere else,
    /// use move_document. A document keeps its extension unless you give it a
    /// new one, so "Helmreach in Rain" renames "Ch_03.md" to
    /// "Helmreach in Rain.md".
    pub new_name: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct MoveParam {
    /// Workflow id, from `list_workflows`.
    pub workflow_id: String,
    /// The file or folder to move, relative to the vault root.
    pub path: String,
    /// The folder to move it into, relative to the vault root. Pass "" for the
    /// vault root. The folder must already exist — use create_folder first.
    pub destination_folder: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct SearchParam {
    /// Workflow id, from `list_workflows`.
    pub workflow_id: String,
    /// Text to look for. This is a plain case-insensitive substring, not a
    /// regular expression — "." and "*" match themselves.
    pub query: String,
    /// Most files to report. Defaults to 50.
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
pub struct StatusParam {
    /// Workflow id, from `list_workflows`.
    pub workflow_id: String,
    /// Path to the document, relative to the vault root.
    pub path: String,
    /// One of: final, drafting, rev, outline. Anything else is refused.
    pub status: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct ReorderParam {
    /// Workflow id, from `list_workflows`.
    pub workflow_id: String,
    /// The complete chapter list in the order you want, as vault-relative
    /// paths. It must contain exactly the chapters the manuscript already has,
    /// each once — this reorders, it never adds or removes. Use
    /// `create_document` or `trash_document` for that.
    pub order: Vec<String>,
    /// Which manuscript, from `get_workflow`. Omit for the first (and usually
    /// only) one.
    #[serde(default)]
    pub manuscript_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct RestoreParam {
    /// Workflow id, from `list_workflows`.
    pub workflow_id: String,
    /// The deleted item's id, from `list_trash`.
    pub trash_id: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct StarParam {
    /// Workflow id, from `list_workflows`.
    pub workflow_id: String,
    /// The file or folder to star, relative to the vault root.
    pub path: String,
    /// true to star, false to unstar. Omit to flip whatever it is now.
    #[serde(default)]
    pub starred: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
pub struct CompileParam {
    /// Workflow id, from `list_workflows`.
    pub workflow_id: String,
    /// One of: markdown, pdf, epub, docx, fountain. Final Draft (.fdx) is not
    /// exported — compile fountain, which Final Draft imports.
    pub format: String,
    /// Compile one document instead of the manuscript — a vault-relative path,
    /// e.g. "Script.fountain". Omit to compile the manuscript's chapters.
    #[serde(default)]
    pub path: Option<String>,
    /// Which manuscript, from `get_workflow`. Omit for the first (and usually
    /// only) one. Ignored when `path` is given.
    #[serde(default)]
    pub manuscript_id: Option<String>,
    /// Compile a draft's cut instead of the manuscript's order. Ignored when
    /// `path` is given.
    #[serde(default)]
    pub draft_id: Option<String>,
    /// A named set of layout defaults. Prose: standard-submission (the
    /// default), trade-paperback, reader-proof. Markdown: clean (default),
    /// web-ready, plain. Screenplays: industry-standard (default), reader-copy.
    #[serde(default)]
    pub profile: Option<String>,
    /// Where to put the file, relative to the vault root. Defaults to
    /// "Exports"; it is created if it is not there. Absolute paths are refused —
    /// this tool writes inside the vault only.
    #[serde(default)]
    pub output_folder: Option<String>,
    /// File name without an extension. Defaults to the manuscript's title.
    #[serde(default)]
    pub file_name: Option<String>,
    /// Author, for the EPUB / Word / PDF metadata.
    #[serde(default)]
    pub author: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct SnapshotParam {
    /// Workflow id, from `list_workflows`.
    pub workflow_id: String,
    /// The document the snapshot belongs to, relative to the vault root.
    pub path: String,
    /// The snapshot's id, from `list_snapshots`.
    pub snapshot_id: String,
}

// ── the tools ────────────────────────────────────────────────────────────

#[tool_router]
impl AquariusMcp {
    #[tool(
        name = "list_workflows",
        description = "List the vaults (workflows) this copy of Aquarius Writer knows about. \
Start here: every other tool needs a workflow_id from this list. Each entry has the id, the \
display name, the folder path, the kind (novel / screenplay / notes), and how many files it holds."
    )]
    fn list_workflows(&self) -> Result<String, ErrorData> {
        let state = self.state();
        let roots: Vec<PathBuf> = {
            let reg = state.registry.lock().unwrap();
            reg.live_entries().iter().map(|e| PathBuf::from(&e.path)).collect()
        };
        let mut out = Vec::new();
        for root in roots {
            if let Ok((summary, _)) = vault::summarize(&root, false) {
                out.push(summary);
            }
        }
        json(out)
    }

    #[tool(
        name = "get_workflow",
        description = "The full picture of one vault: its manifest (title, kind, drafts, \
manuscripts and their chapter order, goals) and the complete file tree with each markdown \
file's frontmatter and word count. Use this to orient yourself before reading anything."
    )]
    fn get_workflow(
        &self,
        Parameters(WorkflowParam { workflow_id }): Parameters<WorkflowParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        let (wf, _) = vault::workflow::read_or_create(&root).map_err(internal)?;
        let (tree, _) = vault::tree::walk(&root, &wf.title).map_err(internal)?;
        // `starred` rides along here rather than in a tool of its own: it is a
        // handful of paths, it is only meaningful against the tree beside it,
        // and orienting yourself is exactly when you want to know which rows
        // the writer marked.
        json(serde_json::json!({
            "workflow": wf,
            "tree": tree,
            "starred": ops::list_stars(&root),
        }))
    }

    #[tool(
        name = "list_folder",
        description = "One level of a folder inside a vault — names, vault-relative paths, \
kinds and word counts. Cheaper than get_workflow when you already know where you are. \
The app's own .aquarius/ metadata folder is never listed."
    )]
    fn list_folder(
        &self,
        Parameters(FolderParam { workflow_id, path }): Parameters<FolderParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        json(ops::list_folder(&root, path.as_deref().unwrap_or("")).map_err(invalid)?)
    }

    #[tool(
        name = "read_document",
        description = "Read one document. Returns `content` (the exact bytes on disk, \
frontmatter included), `body` (the same text with the frontmatter block removed), the parsed \
`frontmatter` keys, a word count, and `hash` — a fingerprint of the bytes you just read. \
Read before you write: write_document replaces the whole file, and passing this `hash` back \
as its `expected_hash` makes it refuse rather than overwrite an edit that landed in between."
    )]
    fn read_document(
        &self,
        Parameters(DocumentParam { workflow_id, path }): Parameters<DocumentParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        json(ops::read_document(&root, &path).map_err(invalid)?)
    }

    #[tool(
        name = "write_document",
        description = "Replace a document's entire contents. THIS OVERWRITES THE WHOLE FILE — \
send the complete new text, including any frontmatter you want to keep, not a fragment. Call \
read_document first and edit what it gave you. The save is atomic, and a SNAPSHOT OF THE \
PREVIOUS TEXT IS TAKEN AUTOMATICALLY before anything is replaced, so the writer can always get \
back what was there (it appears in the app's version history as \"Before AI write\"). Pass the \
`hash` read_document gave you as `expected_hash` and the write is REFUSED if the file changed \
in between: the answer comes back with status \"conflict\" and the current text in `theirs`, so \
you can re-read, re-apply your change and try again instead of destroying somebody's edit. \
Without expected_hash the write always wins. Writing byte-identical content is a no-op: the \
file is not touched at all, and no snapshot is taken."
    )]
    fn write_document(
        &self,
        Parameters(WriteParam { workflow_id, path, content, expected_hash }): Parameters<WriteParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        let state = self.state();
        let result = ops::agent_write_document(
            &root,
            &path,
            &content,
            expected_hash.as_deref(),
            &state.self_writes,
        )
        .map_err(invalid)?;
        // A refused write left the vault exactly as it was, so there is
        // nothing for the UI to reload — and telling it otherwise would send
        // every open buffer off to re-check itself for no reason.
        if !result.is_conflict() {
            self.notify(&workflow_id);
        }
        json(result)
    }

    #[tool(
        name = "create_document",
        description = "Create a new document that does not exist yet. The path must end in \
.md, .markdown, .fountain or .txt; missing folders are created along the way. Refuses rather \
than overwriting if something is already there — use write_document for that."
    )]
    fn create_document(
        &self,
        Parameters(CreateParam { workflow_id, path, content }): Parameters<CreateParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        let state = self.state();
        let report =
            ops::create_document(&root, &path, content.as_deref().unwrap_or(""), &state.self_writes)
                .map_err(invalid)?;
        self.notify(&workflow_id);
        json(report)
    }

    #[tool(
        name = "create_folder",
        description = "Create a new folder in a vault. `name` is one folder name, not a path — \
say where it goes with `parent`. If a folder of that name is already there the new one is \
given a numbered name (\"Research 2\") rather than merging into it, which is what the app's \
own add menu does."
    )]
    fn create_folder(
        &self,
        Parameters(CreateFolderParam { workflow_id, parent, name }): Parameters<CreateFolderParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        let state = self.state();
        let report =
            ops::create_folder(&root, parent.as_deref().unwrap_or(""), &name, &state.self_writes)
                .map_err(invalid)?;
        self.notify(&workflow_id);
        json(report)
    }

    #[tool(
        name = "rename_document",
        description = "Rename a document or folder in place, keeping it where it is. Pass one \
new name, not a path — move_document is how you relocate something. A document keeps its \
extension unless the new name carries one. If the name is already taken the rename lands on a \
numbered variant (\"Chapter One 2\") instead of overwriting anything. The file's bytes are not \
touched, and its version history and margin comments follow it to the new name."
    )]
    fn rename_document(
        &self,
        Parameters(RenameParam { workflow_id, path, new_name }): Parameters<RenameParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        let state = self.state();
        let report =
            ops::rename_entry(&root, &path, &new_name, &state.self_writes).map_err(invalid)?;
        self.notify(&workflow_id);
        json(report)
    }

    #[tool(
        name = "move_document",
        description = "Move a document or folder into another folder in the same vault, keeping \
its name. The destination folder must already exist (create_folder makes one); pass \"\" to move \
something to the vault root. Moving a folder takes everything inside it. A name collision at the \
destination is resolved with a numbered variant rather than an overwrite. The bytes are not \
rewritten, and version history and comments follow the file."
    )]
    fn move_document(
        &self,
        Parameters(MoveParam { workflow_id, path, destination_folder }): Parameters<MoveParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        let state = self.state();
        let report = ops::move_entry(&root, &path, &destination_folder, &state.self_writes)
            .map_err(invalid)?;
        self.notify(&workflow_id);
        json(report)
    }

    #[tool(
        name = "search",
        description = "Find text anywhere in a vault. Case-insensitive plain substring match \
across markdown, fountain and .txt files. Each hit gives the file's path, the first matching \
line number (0-based), a preview of that line, and how many times the text occurs in that \
file; results are ranked by count."
    )]
    fn search(
        &self,
        Parameters(SearchParam { workflow_id, query, limit }): Parameters<SearchParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        json(vault::search::search(&root, &query, limit.unwrap_or(50)))
    }

    #[tool(
        name = "set_frontmatter_status",
        description = "Set a document's `status` frontmatter key — one of final, drafting, \
rev, outline. This is what paints the status chips in the sidebar, the outline and the \
corkboard. Every other byte of the file is left exactly as it was, and a file with no \
frontmatter block gains one containing just this key."
    )]
    fn set_frontmatter_status(
        &self,
        Parameters(StatusParam { workflow_id, path, status }): Parameters<StatusParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        let state = self.state();
        let report = ops::set_status(&root, &path, &status, &state.self_writes).map_err(invalid)?;
        self.notify(&workflow_id);
        json(report)
    }

    #[tool(
        name = "reorder_chapters",
        description = "Rearrange a manuscript's chapter order in the vault's workflow.json. \
Pass the complete list of chapter paths in the order you want. It must be exactly the \
chapters the manuscript already has, each once — nothing added, nothing dropped. Drafts \
that mirrored the manuscript order follow it."
    )]
    fn reorder_chapters(
        &self,
        Parameters(ReorderParam { workflow_id, order, manuscript_id }): Parameters<ReorderParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        let state = self.state();
        let report =
            ops::reorder_chapters(&root, manuscript_id.as_deref(), &order, &state.self_writes)
                .map_err(invalid)?;
        self.notify(&workflow_id);
        json(report)
    }

    #[tool(
        name = "toggle_star",
        description = "Star or unstar a file or folder — the same star the writer flips in the \
app's sidebar, which puts the row in the Starred quick view at the top of the tree. Pass \
`starred` to set it explicitly, or leave it out to flip whatever it is now; either way the \
answer says which state it landed in. A star is metadata (it lives in the vault's \
.aquarius/favorites.json), so this never rewrites a single byte of the document, and the star \
follows the file through a rename or a move. Use get_workflow to see which rows are already \
starred."
    )]
    fn toggle_star(
        &self,
        Parameters(StarParam { workflow_id, path, starred }): Parameters<StarParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        let report = ops::set_star(&root, &path, starred).map_err(invalid)?;
        self.notify(&workflow_id);
        json(report)
    }

    #[tool(
        name = "trash_document",
        description = "Move a document to the vault's Recently Deleted (.aquarius/trash/). \
This is a soft delete and is reversible with restore_document for 30 days — the file is \
moved, never unlinked. If the row was starred the star is dropped with it. There is no tool \
for permanent deletion, on purpose."
    )]
    fn trash_document(
        &self,
        Parameters(DocumentParam { workflow_id, path }): Parameters<DocumentParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        let state = self.state();
        let record = ops::trash_entry(&root, &path, &state.self_writes).map_err(invalid)?;
        self.notify(&workflow_id);
        json(record)
    }

    #[tool(
        name = "list_trash",
        description = "What is in a vault's Recently Deleted, newest first: each item's id \
(pass it to restore_document), the path it came from, and when it was deleted. Items older \
than 30 days are swept when the vault is opened in the app."
    )]
    fn list_trash(
        &self,
        Parameters(WorkflowParam { workflow_id }): Parameters<WorkflowParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        // The stored bodies are dropped from the listing on purpose: a list of
        // deleted files should not be a way to accidentally pull a megabyte of
        // text into a model's context. Restore it, then read it.
        let entries: Vec<serde_json::Value> = aux_store::trash_entries(&root)
            .into_iter()
            .map(|e| {
                serde_json::json!({ "id": e.id, "path": e.path, "deletedAt": e.deleted_at })
            })
            .collect();
        json(entries)
    }

    #[tool(
        name = "restore_document",
        description = "Put a trashed document back where it came from. Takes the item's id \
from list_trash and returns the path it was restored to."
    )]
    fn restore_document(
        &self,
        Parameters(RestoreParam { workflow_id, trash_id }): Parameters<RestoreParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        let state = self.state();
        let restored = trash::restore(&root, &trash_id).map_err(internal)?;
        let Some(rel) = restored else {
            return Err(invalid(format!("nothing in the trash with id {trash_id}")));
        };
        if let Ok(p) = vault::paths::resolve_in_root(&root, &rel) {
            state.note_self_write(&p);
        }
        self.notify(&workflow_id);
        json(serde_json::json!({ "path": rel }))
    }

    #[tool(
        name = "list_snapshots",
        description = "The version history the app has kept for one document, newest first: \
each snapshot's id, when it was taken, its label, whether it was named by the writer or \
saved automatically, and its word count. Read-only — bodies come from read_snapshot."
    )]
    fn list_snapshots(
        &self,
        Parameters(DocumentParam { workflow_id, path }): Parameters<DocumentParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        // Budget 0: list the rows, read none of the bodies.
        let mut budget = 0usize;
        let rows: Vec<serde_json::Value> = aux_store::list_versions(&root, &path, &mut budget)
            .into_iter()
            .map(|v| {
                serde_json::json!({
                    "id": v.id, "at": v.at, "label": v.label,
                    "named": v.named, "words": v.words,
                })
            })
            .collect();
        json(rows)
    }

    #[tool(
        name = "read_snapshot",
        description = "The text of one past version of a document. Read-only: this does not \
restore anything. To bring an old version back, read it here and pass the text to \
write_document."
    )]
    fn read_snapshot(
        &self,
        Parameters(SnapshotParam { workflow_id, path, snapshot_id }): Parameters<SnapshotParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        let mut budget = usize::MAX;
        let found = aux_store::list_versions(&root, &path, &mut budget)
            .into_iter()
            .find(|v| v.id == snapshot_id)
            .ok_or_else(|| invalid(format!("{path} has no snapshot {snapshot_id}")))?;
        json(serde_json::json!({
            "id": found.id, "at": found.at, "label": found.label,
            "named": found.named, "words": found.words, "content": found.body,
        }))
    }

    #[tool(
        name = "compile_document",
        description = "Compile a manuscript (or one document) into a finished file: markdown, \
pdf, epub, docx or fountain. This is the app's own Compile sheet, so the chapters go in the \
order workflow.json records, each chapter's YAML frontmatter is stripped, and profiles set the \
page layout — standard-submission (12pt Courier, double spaced, 1in margins), trade-paperback, \
reader-proof, clean / web-ready / plain for markdown, industry-standard / reader-copy for \
screenplays. EPUB, Word and PDF need pandoc installed (PDF also needs a TeX engine); markdown \
and fountain need nothing and always work. If pandoc is missing the answer says so and how to \
install it. The file is written inside the vault — `output_folder` is vault-relative and \
defaults to \"Exports\" — and an existing file is never overwritten: the name gets a \" 2\". \
Chapters that are no longer on disk are skipped and listed in `missing` rather than failing \
the compile."
    )]
    fn compile_document(
        &self,
        Parameters(CompileParam {
            workflow_id,
            format,
            path,
            manuscript_id,
            draft_id,
            profile,
            output_folder,
            file_name,
            author,
        }): Parameters<CompileParam>,
    ) -> Result<String, ErrorData> {
        let root = self.root(&workflow_id)?;
        let (wf, _) = vault::workflow::read_or_create(&root).map_err(internal)?;

        // Vault-relative only. The UI's Compile sheet can write to any folder
        // the writer picked in a native dialog — that is their consent, given
        // by hand. A tool call carries no such consent, so this door stays
        // inside the vault where every other MCP path already lives.
        let folder = output_folder.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let out_dir = match folder {
            Some(rel) => vault::paths::resolve_in_root(&root, rel).map_err(|e| invalid(e.0))?,
            None => crate::compile::default_output_dir(&root),
        };

        let source = match path {
            Some(p) => crate::compile::assembler::Source::Document { path: p },
            None => crate::compile::assembler::Source::Manuscript { manuscript_id, draft_id },
        };
        let request = crate::compile::CompileRequest {
            format,
            source,
            profile,
            options: crate::compile::CompileOptions { author, ..Default::default() },
            output_directory: out_dir.to_string_lossy().to_string(),
            file_name,
        };

        let report = crate::compile::run(&root, &wf, &request).map_err(|e| {
            // The install instructions are the useful half of a missing-pandoc
            // failure, so they travel with the message rather than being
            // dropped into a log the client cannot see.
            let text = match &e.hint {
                Some(h) => format!("{} {}", e.message, h),
                None => e.message.clone(),
            };
            match e.code.as_str() {
                "badRequest" | "noChapters" => invalid(text),
                _ => internal(text),
            }
        })?;
        // The file landed in the vault, so the tree has a new row in it.
        self.notify(&workflow_id);
        json(serde_json::json!({
            "path": vault::paths::rel_from_root(&root, std::path::Path::new(&report.path)),
            "absolutePath": report.path,
            "format": report.format,
            "profile": report.profile,
            "bytes": report.bytes,
            "chapters": report.chapters,
            "words": report.words,
            "missing": report.missing,
            "engine": report.engine,
            "renamed": report.renamed,
        }))
    }

    #[tool(
        name = "server_info",
        description = "What this MCP server is attached to: the app version, the port it is \
listening on, and how many vaults are registered. Useful as a connectivity check."
    )]
    fn server_info(&self) -> Result<String, ErrorData> {
        let state = self.state();
        let workflows = state.registry.lock().unwrap().live_entries().len();
        let port = self.app.state::<McpState>().config.lock().unwrap().port;
        json(serde_json::json!({
            "app": "Aquarius Writer",
            "version": env!("CARGO_PKG_VERSION"),
            "port": port,
            "url": crate::mcp::url_for(port),
            "workflows": workflows,
        }))
    }
}

/// What a client is told at `initialize`.
///
/// The instructions are the server's own README for a model: where to start,
/// what a path means here, and the two things it can get wrong that a human
/// would not (replacing a file it never read, and stepping on unsaved text in
/// the writer's open editor).
const INSTRUCTIONS: &str = "\
Aquarius Writer is a local-first writing app. This server exposes the vaults it has open on \
this machine: novels, screenplays and note folders, each one a \"workflow\".

Start with list_workflows to get a workflow_id, then get_workflow for the manifest and file \
tree. Every path you pass is relative to that vault's root and uses forward slashes \
(\"Drafts/Ch_01.md\"); absolute paths and \"..\" are refused.

write_document replaces a file's entire contents, so read_document first and send back the \
whole text with your change applied — and pass read_document's `hash` back as `expected_hash`, \
which makes the write refuse (status \"conflict\", with the current text) rather than overwrite \
an edit that arrived while you were thinking. Whatever you replace is snapshotted first, so \
the writer can undo you. Deleting is soft — trash_document moves the file into the vault's \
Recently Deleted, where restore_document brings it back for 30 days. There is no permanent \
delete.

Reorganising a vault is create_document / create_folder to add, rename_document to change a \
name in place, and move_document to put something in a different folder. Renames and moves \
never rewrite a file's bytes, and they carry its version history and margin comments with it. \
A name that is already taken produces a numbered variant (\"Chapter One 2\") — nothing here \
overwrites an existing file.

toggle_star marks a file or folder as a favourite; get_workflow lists the starred paths \
alongside the tree. Stars are metadata in the vault, never a change to the document.

compile_document turns a manuscript into a finished file — markdown, fountain, epub, docx or \
pdf. Markdown and fountain always work; the other three need pandoc installed on the machine, \
and the failure tells you how to install it. The output lands inside the vault (a \
vault-relative output_folder, \"Exports\" by default), never at an absolute path.

The writer may have this same vault open in the app while you work. Your writes reach the UI \
immediately. If they are actively editing the document you changed, the app now stops and asks \
them which version to keep rather than quietly saving over you — so tell them what you changed \
rather than assuming they watched it happen.";

#[tool_handler]
impl rmcp::ServerHandler for AquariusMcp {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        rmcp::model::ServerInfo::new(
            rmcp::model::ServerCapabilities::builder().enable_tools().build(),
        )
        .with_server_info(rmcp::model::Implementation::new(
            "aquarius-writer",
            env!("CARGO_PKG_VERSION"),
        ))
        .with_instructions(INSTRUCTIONS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The surface Stage 5 promised. A tool disappearing from this list is a
    /// breaking change for anyone who wired the server into Claude Code, so it
    /// should be a deliberate edit here rather than a silent regression.
    const EXPECTED: &[&str] = &[
        "compile_document",
        "create_document",
        "create_folder",
        "get_workflow",
        "list_folder",
        "list_snapshots",
        "list_trash",
        "list_workflows",
        "move_document",
        "read_document",
        "read_snapshot",
        "rename_document",
        "reorder_chapters",
        "restore_document",
        "search",
        "server_info",
        "set_frontmatter_status",
        "toggle_star",
        "trash_document",
        "write_document",
    ];

    #[test]
    fn the_router_exposes_exactly_the_documented_tools() {
        let router = AquariusMcp::tool_router();
        let mut names: Vec<String> =
            router.list_all().into_iter().map(|t| t.name.to_string()).collect();
        names.sort();
        assert_eq!(names, EXPECTED);
    }

    #[test]
    fn every_tool_carries_a_description_written_for_a_model() {
        for tool in AquariusMcp::tool_router().list_all() {
            let description = tool
                .description
                .as_deref()
                .unwrap_or_else(|| panic!("{} has no description", tool.name));
            assert!(
                description.len() > 60,
                "{}'s description is too thin for a client to choose it: {description:?}",
                tool.name
            );
        }
    }

    #[test]
    fn destructive_tools_say_what_they_do_and_permanent_deletion_is_absent() {
        let router = AquariusMcp::tool_router();
        assert!(
            !router.has_route("purge_trash") && !router.has_route("delete_document"),
            "permanent deletion is deliberately not on the MCP surface"
        );

        let write = router.get("write_document").unwrap();
        let d = write.description.as_deref().unwrap();
        assert!(
            d.contains("OVERWRITES THE WHOLE FILE"),
            "write_document must warn that it is a full replace"
        );

        let trash = router.get("trash_document").unwrap();
        assert!(trash.description.as_deref().unwrap().contains("reversible"));
    }

    #[test]
    fn write_document_offers_the_conflict_guard_and_promises_the_snapshot() {
        // The two halves of the safety this tool gained. Both are things a
        // model only knows about because the description says so, which makes
        // the wording load-bearing rather than decorative.
        let router = AquariusMcp::tool_router();
        let write = router.get("write_document").unwrap();

        let schema = serde_json::to_string(&write.input_schema).unwrap();
        assert!(
            schema.contains("expected_hash"),
            "a client cannot ask for the guard if the schema does not offer it: {schema}"
        );
        assert!(
            !serde_json::to_string(&write.input_schema)
                .unwrap()
                .contains("\"required\":[\"content\",\"expected_hash\""),
            "expected_hash is opt-in — every existing caller omits it and must keep working"
        );

        let d = write.description.as_deref().unwrap();
        assert!(d.contains("SNAPSHOT OF THE"), "the auto-snapshot must be promised: {d}");
        assert!(d.contains("expected_hash"), "the guard must be explained: {d}");

        let read = router.get("read_document").unwrap();
        assert!(
            read.description.as_deref().unwrap().contains("hash"),
            "read_document is where the hash comes from, so it has to mention it"
        );
    }

    #[test]
    fn every_tool_that_touches_a_vault_takes_an_explicit_workflow_id() {
        // No hidden "current workflow": the UI's open document and an MCP
        // client's are unrelated, and coupling them would be a bug factory.
        for tool in AquariusMcp::tool_router().list_all() {
            if tool.name == "list_workflows" || tool.name == "server_info" {
                continue;
            }
            let schema = serde_json::to_string(&tool.input_schema).unwrap();
            assert!(
                schema.contains("workflow_id"),
                "{} does not ask which vault it should act on: {schema}",
                tool.name
            );
        }
    }

    #[test]
    fn path_parameters_tell_the_client_they_are_vault_relative() {
        let router = AquariusMcp::tool_router();
        for name in [
            "read_document", "write_document", "create_document", "list_folder",
            "create_folder", "rename_document", "move_document", "toggle_star",
        ] {
            let schema = serde_json::to_string(&router.get(name).unwrap().input_schema).unwrap();
            assert!(
                schema.contains("relative to the vault root"),
                "{name}'s path parameter does not say what a path means here"
            );
        }
    }
}
