//! The command surface — every `invoke()` the renderer can make.
//!
//! These are dedicated `#[tauri::command]`s rather than calls through the
//! generic `fs` plugin. Two reasons: the capability file then grants the app
//! *no* blanket filesystem access (only the dialog needs a permission at all),
//! and the interesting logic — path safety, atomic saves, trash, tree shape —
//! stays in plain Rust functions that `cargo test` can reach.
//!
//! Every path argument is vault-relative and goes through
//! `vault::paths::resolve_in_root`, so no command can be talked into touching
//! a file outside the workflow it names.

use crate::aux_store::{self, AuxSnapshot, CommentEntry, VersionEntry};
use crate::fs_ops::{self, trash, watcher::WorkflowWatch};
use crate::model::{AssetRef, LoadedWorkflow, WorkflowSummary};
use crate::state::AppState;
use crate::vault::{self, paths, registry, scaffold, tree, workflow};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Emitted when a workflow's folder changed on disk. Payload: `{ workflowId }`.
pub const CHANGE_EVENT: &str = "vault://changed";

type R<T> = Result<T, String>;

fn io(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn root_of(state: &AppState, workflow_id: &str) -> R<PathBuf> {
    state.root_for(workflow_id)
}

fn file_in(state: &AppState, workflow_id: &str, rel: &str) -> R<PathBuf> {
    let root = root_of(state, workflow_id)?;
    paths::resolve_in_root(&root, rel).map_err(|e| e.0)
}

// ── workflows ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn vault_list_workflows(state: State<'_, AppState>) -> R<Vec<WorkflowSummary>> {
    let (paths, active): (Vec<PathBuf>, Option<String>) = {
        let reg = state.registry.lock().unwrap();
        (
            reg.live_entries().iter().map(|e| PathBuf::from(&e.path)).collect(),
            reg.most_recent_id(),
        )
    };

    let mut out = Vec::new();
    let mut reg = state.registry.lock().unwrap();
    for root in paths {
        match vault::summarize(&root, false) {
            Ok((mut summary, _)) => {
                // The id lives in the folder, so a vault copied from another
                // machine keeps its identity — refresh the registry from it.
                reg.upsert_path_only(&summary.id, &root);
                summary.active = if Some(&summary.id) == active.as_ref() { Some(true) } else { None };
                out.push(summary);
            }
            Err(e) => eprintln!("skipping unreadable workflow {}: {e}", root.display()),
        }
    }
    let _ = registry::save(&state.config_dir, &reg);
    Ok(out)
}

/// Put the native folder picker on screen and wait for an answer.
///
/// Both doors onto the picker go through here so they log identically. The
/// logging is not decoration: on Linux this dialog is `rfd`'s GTK3 file
/// chooser, running inside an extracted AppImage against whatever GTK the host
/// provides, and the first Linux boot of v0.1.0 had no way to tell "the writer
/// pressed Cancel" apart from "the dialog never appeared" (docs/NOTES.md §10.8).
/// Now the log says which.
async fn pick_folder(app: &AppHandle, title: &str) -> R<Option<PathBuf>> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    eprintln!("[dialog] opening the folder picker — {title}");
    app.dialog().file().set_title(title).pick_folder(move |picked| {
        // `try_send`, not `blocking_send`: the picker's callback may land on
        // the UI thread, and exactly one message is ever sent into a channel
        // with room for one.
        let _ = tx.try_send(picked);
    });
    let picked = rx.recv().await.flatten();
    let Some(file_path) = picked else {
        eprintln!("[dialog] folder picker closed without a choice");
        return Ok(None);
    };
    let root = file_path.into_path().map_err(io)?;
    eprintln!("[dialog] folder picker chose {}", root.display());
    Ok(Some(root))
}

#[tauri::command]
pub async fn vault_add_workflow_from_folder(
    app: AppHandle,
    state: State<'_, AppState>,
) -> R<Option<WorkflowSummary>> {
    let Some(root) = pick_folder(&app, "Choose a folder of writing").await? else {
        return Ok(None);
    };
    register(&app, &state, root).map(Some)
}

/// Ask the writer for a folder and answer with its absolute path.
///
/// "Create new" needs the *parent* folder, not a workflow, so it cannot use
/// `vault_add_workflow_from_folder` — that registers whatever it is given.
#[tauri::command]
pub async fn vault_pick_folder(app: AppHandle, title: String) -> R<Option<String>> {
    Ok(pick_folder(&app, &title).await?.map(|p| p.to_string_lossy().to_string()))
}

/// Open a vault by absolute path, without the picker.
///
/// Two callers: `AQ_DEV_VAULT` / devtools, which is what it was written for,
/// and — since v0.1.1 — the welcome screen's "type a folder path instead"
/// escape hatch.
///
/// That escape hatch is why the debug-only guard is gone. It was there because
/// "in release the picker is the only way a folder should get registered", and
/// the first Linux boot showed the flaw in that reasoning: if the native picker
/// does not work on some desktop, an app whose only door is the picker is a
/// brick. A path the writer typed into this app's own welcome screen is the
/// same consent a path they clicked in a dialog is, so it gets the same
/// treatment — and every registration is logged either way.
#[tauri::command]
pub fn vault_add_workflow_by_path(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> R<WorkflowSummary> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("type the full path to a folder".into());
    }
    // A leading `~` is what anyone types; nothing expands it for us here.
    let expanded = match raw.strip_prefix("~/") {
        Some(rest) => match std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            Some(home) => PathBuf::from(home).join(rest),
            None => PathBuf::from(raw),
        },
        None => PathBuf::from(raw),
    };
    register(&app, &state, expanded)
}

// ── creating a workflow ──────────────────────────────────────────────────

/// Make a new workflow folder inside a folder the writer picks, then open it.
///
/// `parent` is where to put it; `None` puts the folder picker on screen first.
#[tauri::command]
pub async fn vault_create_workflow(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    kind: String,
    parent: Option<String>,
) -> R<Option<WorkflowSummary>> {
    // Validate before the dialog: a bad name should be a message under the
    // text field, not something the writer discovers after choosing a folder.
    let name = scaffold::validate_name(&name)?;
    let parent = match parent {
        Some(p) => PathBuf::from(p),
        None => match pick_folder(&app, "Choose where to keep the new workflow").await? {
            Some(p) => p,
            None => return Ok(None),
        },
    };
    let root = scaffold::create_workflow(&parent, &name, &kind)?;
    eprintln!("[vault] created workflow \"{name}\" ({kind}) at {}", root.display());
    register(&app, &state, root).map(Some)
}

/// Write the sample workflow somewhere sensible and open it.
///
/// Idempotent: pressing "Try the sample" twice reopens the one that is already
/// there rather than failing or making a second copy.
#[tauri::command]
pub fn vault_create_sample_workflow(
    app: AppHandle,
    state: State<'_, AppState>,
) -> R<WorkflowSummary> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("could not work out where to put the sample: {e}"))?;
    let parent = base.join("Aquarius");
    let root = scaffold::create_sample(&parent)?;
    eprintln!("[vault] sample workflow ready at {}", root.display());
    register(&app, &state, root)
}

pub fn register(app: &AppHandle, state: &AppState, root: PathBuf) -> R<WorkflowSummary> {
    if !root.is_dir() {
        return Err(format!("not a folder: {}", root.display()));
    }
    eprintln!("[vault] registering {}", root.display());
    let (summary, _) = vault::summarize(&root, true).map_err(io)?;
    {
        let mut reg = state.registry.lock().unwrap();
        reg.upsert(&summary.id, &root);
        registry::save(&state.config_dir, &reg).map_err(io)?;
    }
    state.grant_asset_access(app, &summary.id, &root);
    Ok(summary)
}

#[tauri::command]
pub fn vault_load_workflow(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> R<LoadedWorkflow> {
    let root = root_of(&state, &id)?;

    // Opening a workflow does not delete anything. There used to be a 30-day
    // sweep here; it went on 2026-08-31 because the Swift app has never had one
    // (SWIFT-AUDIT §4) and because "I opened my folder and my deleted chapter
    // was gone for good" is not a thing a writing app should ever cause. The
    // window is display-only now — `trash::is_expired` marks old rows in
    // Recently Deleted, and `trash_empty` below is the only bulk destruction,
    // behind a confirm.

    let (mut wf, _) = workflow::read_or_create(&root).map_err(io)?;
    if workflow::reconcile_chapter_order(&root, &mut wf) {
        state.note_self_write(&workflow::workflow_json_path(&root));
        workflow::save(&root, &wf).map_err(io)?;
    }
    let (tree, _) = tree::walk(&root, &wf.title).map_err(io)?;

    {
        let mut reg = state.registry.lock().unwrap();
        reg.touch(&wf.id);
        let _ = registry::save(&state.config_dir, &reg);
    }
    state.grant_asset_access(&app, &wf.id, &root);

    // One pass over the tree comparing content hashes with the semantic
    // manifest, on a background thread. Nothing is embedded unless something
    // actually changed, so opening an already-indexed vault costs a few KB of
    // reads; opening one for the first time is the backfill, with progress on
    // `semantic://state`. Does nothing at all when there is no model.
    crate::semantic::service::spawn_sync(&app, wf.id.clone(), root.clone());

    Ok(LoadedWorkflow { workflow: wf, tree })
}

// ── documents ────────────────────────────────────────────────────────────

/// Read a document, with the stamp of the bytes it came from.
///
/// The stamp is the whole point: the renderer keeps it as that buffer's
/// baseline and hands it back on the next save, which is what lets
/// `vault_write_file` tell an ordinary save apart from one that would
/// overwrite somebody else's edit.
#[tauri::command]
pub fn vault_read_file(
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
) -> R<crate::model::FileRead> {
    let root = root_of(&state, &workflow_id)?;
    vault::ops::read_file(&root, &rel_path)
}

/// Save a document, optionally guarded by the baseline the caller is holding.
///
/// Omit `expected` (or send null) and this is the force-write it always was.
/// Send the stamp the buffer was opened at and the write is *refused* — as a
/// `conflict` result carrying the on-disk text, not as an error — when the file
/// no longer matches it. See `vault::ops::write_document_checked`.
#[tauri::command]
pub fn vault_write_file(
    app: AppHandle,
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
    content: String,
    expected: Option<crate::model::FileStamp>,
) -> R<crate::model::WriteResult> {
    let root = root_of(&state, &workflow_id)?;
    // The ledger is stamped inside `write_document_checked`, before the write,
    // so the watcher can't win the race and report our own save as an
    // external edit (docs/NOTES.md §3c).
    let result = vault::ops::write_document_checked(
        &root,
        &rel_path,
        &content,
        expected.as_ref(),
        &state.self_writes,
    )?;
    // Search by meaning keeps up with the save, not with the keystroke. This
    // call checks a boolean and hands a closure to a thread pool; the chunking
    // and the model run on that pool, never here. The save has already been
    // debounced by the editor, so this fires at the same cadence the disk does.
    crate::semantic::service::spawn_document_sync(&app, root, rel_path);
    Ok(result)
}

/// Raw bytes for pdf.js and friends. Returns an ArrayBuffer to the renderer
/// rather than a JSON array of numbers — a 20 MB PDF would otherwise become a
/// 60 MB JSON message.
#[tauri::command]
pub fn vault_read_binary(
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
) -> R<tauri::ipc::Response> {
    let path = file_in(&state, &workflow_id, &rel_path)?;
    let bytes = fs_ops::read_bytes(&path).map_err(|e| format!("{rel_path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// How to display an image / PDF / video.
///
/// Preferred answer is `file`: the renderer runs the path through
/// `convertFileSrc` and the asset protocol streams it, so a 300 MB video does
/// not have to fit in a string. If the asset-protocol scope refused this
/// workflow's folder, we fall back to an inline data URL.
#[tauri::command]
pub fn vault_asset_ref(
    app: AppHandle,
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
) -> R<AssetRef> {
    let root = root_of(&state, &workflow_id)?;
    let path = paths::resolve_in_root(&root, &rel_path).map_err(|e| e.0)?;
    if !path.is_file() {
        return Err(format!("asset not found: {rel_path}"));
    }
    if state.grant_asset_access(&app, &workflow_id, &root) {
        return Ok(AssetRef::File { path: path.to_string_lossy().to_string() });
    }
    let bytes = fs_ops::read_bytes(&path).map_err(io)?;
    Ok(AssetRef::Data {
        url: format!("data:{};base64,{}", fs_ops::mime_for(&path), fs_ops::base64(&bytes)),
    })
}

// ── making, renaming and moving things ───────────────────────────────────
//
// The four commands behind the sidebar's add menu and its row context menu.
// None of them do filesystem work here: every one is a one-line call into
// `vault::ops`, which is the same function the matching MCP tool calls. The
// answer is an `EntryReport` — path, display name, kind, and where it came
// from — so the renderer can patch its tree instead of reloading the vault.

/// Create a document. `parent` is a folder path, `""` for the vault root;
/// `kind` is "markdown" or "fountain".
#[tauri::command]
pub fn vault_create_file(
    state: State<'_, AppState>,
    workflow_id: String,
    parent: String,
    name: String,
    kind: String,
) -> R<vault::ops::EntryReport> {
    let root = root_of(&state, &workflow_id)?;
    vault::ops::create_file(&root, &parent, &name, &kind, &state.self_writes)
}

#[tauri::command]
pub fn vault_create_folder(
    state: State<'_, AppState>,
    workflow_id: String,
    parent: String,
    name: String,
) -> R<vault::ops::EntryReport> {
    let root = root_of(&state, &workflow_id)?;
    vault::ops::create_folder(&root, &parent, &name, &state.self_writes)
}

/// Rename a file or folder in place. `new_name` is one path segment.
#[tauri::command]
pub fn vault_rename(
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
    new_name: String,
) -> R<vault::ops::EntryReport> {
    let root = root_of(&state, &workflow_id)?;
    let report = vault::ops::rename_entry(&root, &rel_path, &new_name, &state.self_writes)?;
    // The vectors follow the file. Re-keying a small file is instant;
    // re-embedding a chapter is not, and nothing about it changed.
    crate::semantic::service::note_rename(&root, &rel_path, &report.path);
    Ok(report)
}

/// Move a file or folder into `dest_folder` (`""` for the vault root).
#[tauri::command]
pub fn vault_move(
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
    dest_folder: String,
) -> R<vault::ops::EntryReport> {
    let root = root_of(&state, &workflow_id)?;
    let report = vault::ops::move_entry(&root, &rel_path, &dest_folder, &state.self_writes)?;
    crate::semantic::service::note_rename(&root, &rel_path, &report.path);
    Ok(report)
}

#[tauri::command]
pub fn vault_soft_delete(
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
) -> R<()> {
    let root = root_of(&state, &workflow_id)?;
    vault::ops::trash_entry(&root, &rel_path, &state.self_writes)?;
    // A trashed document leaves no vectors behind — the index must never
    // return a hit in a file that is not there.
    crate::semantic::service::note_removed(&root, &rel_path);
    Ok(())
}

// ── stars ────────────────────────────────────────────────────────────────

/// Star or unstar a tree row. `starred` is null for a toggle; the answer is
/// the state it landed in, which is what the sidebar paints.
#[tauri::command]
pub fn vault_set_star(
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
    starred: Option<bool>,
) -> R<vault::ops::StarReport> {
    let root = root_of(&state, &workflow_id)?;
    vault::ops::set_star(&root, &rel_path, starred)
}

/// The starred rows in a vault. Cheap enough to re-read whenever the tree
/// reloads, so an MCP client's `toggle_star` shows up in the sidebar.
#[tauri::command]
pub fn vault_list_stars(state: State<'_, AppState>, workflow_id: String) -> R<Vec<String>> {
    let root = root_of(&state, &workflow_id)?;
    Ok(vault::ops::list_stars(&root))
}

// ── chapter order ────────────────────────────────────────────────────────

/// Persist a manuscript's chapter order — the drag in the chapter rail and the
/// outline, landing in the same `vault::ops::reorder_chapters` the MCP
/// `reorder_chapters` tool calls. `order` must be a permutation of the order
/// the manuscript already has; anything else is refused rather than half-done.
#[tauri::command]
pub fn vault_reorder_chapters(
    state: State<'_, AppState>,
    workflow_id: String,
    order: Vec<String>,
    manuscript_id: Option<String>,
) -> R<vault::ops::ReorderReport> {
    let root = root_of(&state, &workflow_id)?;
    vault::ops::reorder_chapters(&root, manuscript_id.as_deref(), &order, &state.self_writes)
}

// ── manuscript management (PARITY row 8) ─────────────────────────────────
//
// Four thin wrappers, and deliberately nothing more: each one is the same
// `vault::ops` function the matching MCP tool calls, so the sidebar's "Mark as
// Manuscript", the rail's Working Draft pill and the corkboard's synopsis box
// cannot drift from what an AI client does through the same door.

/// Mark a folder as a manuscript, or unmark it — the sidebar row's ⋯ menu.
#[tauri::command]
pub fn vault_toggle_manuscript_folder(
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
) -> R<vault::ops::FolderRoleReport> {
    let root = root_of(&state, &workflow_id)?;
    vault::ops::toggle_manuscript_folder(&root, &rel_path, &state.self_writes)
}

/// Mark a folder inside a manuscript as a draft, or unmark it.
#[tauri::command]
pub fn vault_toggle_draft_folder(
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
) -> R<vault::ops::FolderRoleReport> {
    let root = root_of(&state, &workflow_id)?;
    vault::ops::toggle_draft_folder(&root, &rel_path, &state.self_writes)
}

/// Make one draft the working draft — the chapter rail's Working Draft pill.
#[tauri::command]
pub fn vault_set_active_draft(
    state: State<'_, AppState>,
    workflow_id: String,
    draft_id: String,
) -> R<vault::ops::ActiveDraftReport> {
    let root = root_of(&state, &workflow_id)?;
    vault::ops::set_active_draft(&root, &draft_id, &state.self_writes)
}

/// Write a document's `synopsis` frontmatter key — the corkboard card's text.
///
/// Frontmatter surgery, not a rewrite: the body survives byte for byte, which
/// is why this is a command of its own rather than the editor's save path.
#[tauri::command]
pub fn vault_set_synopsis(
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
    synopsis: String,
) -> R<vault::ops::WriteReport> {
    let root = root_of(&state, &workflow_id)?;
    vault::ops::set_synopsis(&root, &rel_path, &synopsis, &state.self_writes)
}

// ── writing sessions (the Today panel) ───────────────────────────────────
//
// `.aquarius/sessions/YYYY-MM-DD.json`, one file per calendar day. The
// renderer notes a document's word count after each successful save — which is
// already debounced, so this is never per keystroke — and reads the day back
// for the Today panel. See `crate::sessions`.

/// The workflow's daily word goal, or the default when it has none.
fn goal_of(root: &Path) -> u32 {
    workflow::read_or_create(root)
        .map(|(wf, _)| wf.goals.daily_words)
        .unwrap_or(crate::sessions::DEFAULT_GOAL)
}

/// Record where a document's word count stands now. Answers with today, so a
/// save updates the panel without a second round trip.
#[tauri::command]
pub fn session_note(
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
    words: usize,
) -> R<crate::sessions::DaySummary> {
    let root = root_of(&state, &workflow_id)?;
    // Refuse a path that could not be a vault document before writing its name
    // into a session file — the same guard every other door has.
    paths::resolve_in_root(&root, &rel_path).map_err(|e| e.0)?;
    crate::sessions::note(&root, &rel_path, words, goal_of(&root), registry::now_ms()).map_err(io)
}

#[tauri::command]
pub fn session_today(
    state: State<'_, AppState>,
    workflow_id: String,
) -> R<crate::sessions::DaySummary> {
    let root = root_of(&state, &workflow_id)?;
    Ok(crate::sessions::today(&root, goal_of(&root), registry::now_ms()))
}

/// Today, the last `days` days (oldest first, gaps included) and the streak.
#[tauri::command]
pub fn session_range(
    state: State<'_, AppState>,
    workflow_id: String,
    days: Option<usize>,
) -> R<crate::sessions::SessionsView> {
    let root = root_of(&state, &workflow_id)?;
    let days = days.unwrap_or(crate::sessions::SPARK_DAYS);
    Ok(crate::sessions::view(&root, days, goal_of(&root), registry::now_ms()))
}

/// Set the daily word goal in `workflow.json` and stamp today's session file
/// with it. The Today panel's ring is editable, which is what makes
/// `goals.dailyWords` a real setting rather than a field nothing ever wrote.
#[tauri::command]
pub fn vault_set_daily_goal(
    state: State<'_, AppState>,
    workflow_id: String,
    daily_words: u32,
) -> R<crate::model::Goals> {
    if daily_words == 0 || daily_words > 1_000_000 {
        return Err("a daily goal has to be between 1 and 1,000,000 words".into());
    }
    let root = root_of(&state, &workflow_id)?;
    let (mut wf, _) = workflow::read_or_create(&root).map_err(io)?;
    wf.goals.daily_words = daily_words;
    vault::ops::save_workflow(&root, &wf, &state.self_writes)?;
    // Best effort: the goal is saved either way, and a session file that could
    // not be written is not worth failing the setting over.
    let _ = crate::sessions::set_goal(&root, daily_words, registry::now_ms());
    Ok(wf.goals)
}

// ── watching ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn vault_watch_start(app: AppHandle, state: State<'_, AppState>, workflow_id: String) -> R<()> {
    let root = root_of(&state, &workflow_id)?;
    let mut watches = state.watches.lock().unwrap();
    if watches.contains_key(&workflow_id) {
        return Ok(());
    }
    let handle = app.clone();
    let id = workflow_id.clone();
    let watch = WorkflowWatch::start(&root, state.self_writes.clone(), move || {
        if cfg!(debug_assertions) {
            println!("[watch] {id}: external change — notifying the renderer");
        }
        let _ = handle.emit(CHANGE_EVENT, serde_json::json!({ "workflowId": &id }));
    })
    .map_err(io)?;
    watches.insert(workflow_id, watch);
    Ok(())
}

#[tauri::command]
pub fn vault_watch_stop(state: State<'_, AppState>, workflow_id: String) -> R<()> {
    state.watches.lock().unwrap().remove(&workflow_id);
    Ok(())
}

// ── versions / comments / trash / searches ───────────────────────────────

#[tauri::command]
pub fn aux_hydrate(state: State<'_, AppState>, workflow_id: String) -> R<AuxSnapshot> {
    let root = root_of(&state, &workflow_id)?;
    Ok(aux_store::hydrate(&root))
}

#[tauri::command]
pub fn aux_save_versions(
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
    entries: Vec<VersionEntry>,
) -> R<()> {
    let root = root_of(&state, &workflow_id)?;
    aux_store::save_versions(&root, &rel_path, &entries).map_err(io)
}

#[tauri::command]
pub fn aux_save_comments(
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
    entries: Vec<CommentEntry>,
) -> R<()> {
    let root = root_of(&state, &workflow_id)?;
    aux_store::save_comments(&root, &rel_path, entries).map_err(io)
}

#[tauri::command]
pub fn aux_save_searches(
    state: State<'_, AppState>,
    workflow_id: String,
    queries: Vec<String>,
) -> R<()> {
    let root = root_of(&state, &workflow_id)?;
    aux_store::save_searches(&root, &queries).map_err(io)
}

/// Just the Recently Deleted list — cheap enough to re-read after every
/// delete/restore/purge, unlike a full aux hydration.
#[tauri::command]
pub fn aux_trash_list(
    state: State<'_, AppState>,
    workflow_id: String,
) -> R<Vec<aux_store::TrashEntry>> {
    let root = root_of(&state, &workflow_id)?;
    Ok(aux_store::trash_entries(&root))
}

#[tauri::command]
pub fn trash_restore(
    state: State<'_, AppState>,
    workflow_id: String,
    id: String,
) -> R<Option<String>> {
    let root = root_of(&state, &workflow_id)?;
    let restored = trash::restore(&root, &id).map_err(io)?;
    if let Some(rel) = &restored {
        if let Ok(p) = paths::resolve_in_root(&root, rel) {
            state.note_self_write(&p);
        }
    }
    Ok(restored)
}

#[tauri::command]
pub fn trash_purge(state: State<'_, AppState>, workflow_id: String, id: String) -> R<()> {
    let root = root_of(&state, &workflow_id)?;
    trash::purge(&root, &id).map_err(io)
}

/// Empty the trash. Returns how many deletions were destroyed.
///
/// The confirm lives in the renderer, where the writer can read what they are
/// about to lose. This command does not ask; it is the click's other half.
#[tauri::command]
pub fn trash_empty(state: State<'_, AppState>, workflow_id: String) -> R<usize> {
    let root = root_of(&state, &workflow_id)?;
    trash::purge_all(&root).map_err(io)
}

/// How old a deletion has to be before Recently Deleted calls it old.
///
/// Display only — nothing expires on its own (see `fs_ops::trash`). The sheet
/// asks rather than hardcoding 30, so the number has exactly one home.
#[tauri::command]
pub fn trash_retention_days() -> i64 {
    trash::RETENTION_DAYS
}

// ── compile / export ─────────────────────────────────────────────────────
//
// Three commands behind the Compile sheet (⌘E). `compile_probe` is asked when
// the sheet opens, so a format that cannot work on this machine says so on the
// card rather than failing on click. `compile_run` does the work — its error
// type is a *structured* `CompileError`, not a string, because the renderer
// has to tell "pandoc is missing, here is how to install it" apart from
// "chapter 4 has gone".
//
// The output folder comes from `vault_pick_folder`, the same native dialog the
// welcome screen uses, so nothing new is granted in capabilities/default.json.

/// What Compile can do on this machine: pandoc, a PDF engine, the profile
/// table, and the folder to offer by default. `workflow_id` is optional — the
/// browser preview and a cold sheet can ask without one.
#[tauri::command]
pub fn compile_probe(
    state: State<'_, AppState>,
    workflow_id: Option<String>,
) -> crate::compile::CompileProbe {
    let root = workflow_id.and_then(|id| root_of(&state, &id).ok());
    crate::compile::probe(root.as_deref())
}

#[tauri::command]
pub fn compile_run(
    state: State<'_, AppState>,
    workflow_id: String,
    request: crate::compile::CompileRequest,
) -> Result<crate::compile::CompileReport, crate::compile::CompileError> {
    let root = root_of(&state, &workflow_id)
        .map_err(|e| crate::compile::CompileError::bad_request(e))?;
    let (wf, _) = workflow::read_or_create(&root)
        .map_err(|e| crate::compile::CompileError::io(e.to_string()))?;
    let report = crate::compile::run(&root, &wf, &request)?;
    eprintln!(
        "[compile] wrote {} ({} chapter(s), {} words)",
        report.path, report.chapters, report.words
    );
    Ok(report)
}

/// Show a compiled file in the desktop's file manager.
///
/// Deliberately a Rust command rather than the shell plugin's JS API: that
/// would need `shell:allow-open` in `capabilities/default.json`, which is a
/// blanket "open anything" permission for the whole renderer. This opens one
/// folder that this process itself just wrote to, and grants the renderer
/// nothing — the capability file is unchanged by the whole Compile feature.
///
/// The platform opener is spawned with an argument array, never a shell
/// string, for the same reason `compile::pandoc` is.
#[tauri::command]
pub fn compile_reveal(path: String) -> R<()> {
    let p = PathBuf::from(&path);
    // A file's *folder*, not the file — opening the file itself would launch
    // whatever application claims .epub, which is not what "show me" means.
    let target = if p.is_dir() { p.clone() } else { p.parent().map(Path::to_path_buf).unwrap_or(p) };
    if !target.is_dir() {
        return Err(format!("no such folder: {}", target.display()));
    }
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(target.as_os_str())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open {}: {e}", target.display()))
}

// ── the MCP server ───────────────────────────────────────────────────────
//
// Three commands, all for the Settings panel: read the state, flip the switch,
// change the port. The server itself lives in `crate::mcp`.

#[tauri::command]
pub fn mcp_status(app: AppHandle) -> R<crate::mcp::McpStatus> {
    Ok(crate::mcp::status(&app, None))
}

#[tauri::command]
pub fn mcp_set_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> R<crate::mcp::McpStatus> {
    let mcp = app.state::<crate::mcp::McpState>();
    // Persist the intent even if starting fails, so the toggle reflects what
    // the writer asked for and Settings can show why it isn't running.
    {
        let mut config = mcp.config.lock().unwrap();
        config.enabled = enabled;
        let _ = crate::mcp::save_config(&state.config_dir, &config);
    }
    let error = if enabled {
        crate::mcp::start(&app).err()
    } else {
        crate::mcp::stop(&app);
        None
    };
    Ok(crate::mcp::status(&app, error))
}

#[tauri::command]
pub fn mcp_set_port(
    app: AppHandle,
    state: State<'_, AppState>,
    port: u16,
) -> R<crate::mcp::McpStatus> {
    crate::mcp::validate_port(port)?;
    let was_running = {
        let mcp = app.state::<crate::mcp::McpState>();
        let running = mcp.running.lock().unwrap().is_some();
        let mut config = mcp.config.lock().unwrap();
        config.port = port;
        let _ = crate::mcp::save_config(&state.config_dir, &config);
        running
    };
    // A live server has to be rebound; a stopped one just remembers the number.
    let error = if was_running {
        crate::mcp::stop(&app);
        crate::mcp::start(&app).err()
    } else {
        None
    };
    Ok(crate::mcp::status(&app, error))
}

// ── updates (AquariusOS only) ────────────────────────────────────────────
//
// These four are the whole update surface. They do almost nothing themselves —
// `crate::updater` holds the state and does the work — but they are the only
// way the Settings panel can reach it. Off an AquariusOS install every one of
// them is a no-op that answers "unsupported", so the panel hides itself and
// nothing here ever runs.

#[tauri::command]
pub fn updater_status(app: AppHandle) -> crate::updater::UpdateState {
    crate::updater::status(&app)
}

/// `silent` is set by the one automatic check at startup, so a machine that is
/// offline says nothing rather than opening with a complaint.
#[tauri::command]
pub async fn updater_check(app: AppHandle, silent: bool) -> R<crate::updater::UpdateState> {
    Ok(crate::updater::check(app, silent).await)
}

#[tauri::command]
pub async fn updater_install(app: AppHandle) -> R<crate::updater::UpdateState> {
    Ok(crate::updater::install(app).await)
}

/// Quits and starts again through the OS launcher, which then picks the copy
/// that was just downloaded. This one does not return on success.
#[tauri::command]
pub fn updater_restart(app: AppHandle) -> R<()> {
    crate::updater::restart(&app)
}

// ── the terminal pane ────────────────────────────────────────────────────
//
// Five commands over `crate::pty`. The session ids are the renderer's — see
// the note on `PtyState`. Read the module header before changing any of this;
// the security posture is written down there, not here.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    /// The directory the shell actually started in — shown in the pane header
    /// so "which workflow is this terminal in" is never a guess.
    pub cwd: String,
    /// The program that was spawned.
    pub shell: String,
}

/// Open a PTY and spawn the writer's shell in it.
///
/// `workflow_id` picks the working directory: the workflow's root, which is
/// the whole point of the pane (SWIFT-AUDIT §2.7 — "auto-cwd to the active
/// workflow"). An unknown or unavailable workflow is not an error; the shell
/// starts in the home directory and the returned `cwd` says so.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    pty: State<'_, crate::pty::PtyState>,
    id: String,
    workflow_id: Option<String>,
    startup: Option<String>,
    cols: u16,
    rows: u16,
) -> R<PtyInfo> {
    let cwd = workflow_id
        .as_deref()
        .and_then(|w| root_of(&state, w).ok())
        .or_else(|| dirs_home())
        .unwrap_or_else(|| PathBuf::from("/"));

    let shell = crate::pty::default_shell();
    let spec = crate::pty::SpawnSpec {
        program: None,
        args: Vec::new(),
        cwd: Some(cwd.clone()),
        startup,
        cols,
        rows,
    };

    // Both callbacks cross a thread boundary into the webview. `emit` is
    // fire-and-forget on purpose: a dropped output event during shutdown must
    // not panic a reader thread.
    let out_app = app.clone();
    let out_id = id.clone();
    let exit_app = app.clone();
    let exit_id = id.clone();

    let session = crate::pty::Session::spawn(
        spec,
        move |data| {
            let _ = out_app.emit(
                crate::pty::OUTPUT_EVENT,
                serde_json::json!({ "id": out_id, "data": data }),
            );
        },
        move |code| {
            let _ = exit_app.emit(
                crate::pty::EXIT_EVENT,
                serde_json::json!({ "id": exit_id, "code": code }),
            );
        },
    )?;

    pty.insert(id, session);
    Ok(PtyInfo { cwd: cwd.to_string_lossy().to_string(), shell })
}

/// Keystrokes from xterm.js, straight through.
#[tauri::command]
pub fn pty_write(pty: State<'_, crate::pty::PtyState>, id: String, data: String) -> R<()> {
    pty.with(&id, |s| s.write(&data))?
}

#[tauri::command]
pub fn pty_resize(
    pty: State<'_, crate::pty::PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> R<()> {
    pty.with(&id, |s| s.resize(cols, rows))?
}

/// Close a session. Idempotent — a tab closed after its shell already exited
/// is the normal case, not an error.
#[tauri::command]
pub fn pty_kill(pty: State<'_, crate::pty::PtyState>, id: String) {
    pty.remove(&id);
}

/// The absolute path of a vault-relative one.
///
/// This is what makes "drag a file from the sidebar onto the terminal" work:
/// the tree's drag payload is a workflow-relative path (`Drafts/Ch_03.md`) and
/// a shell needs the real thing. It goes through `resolve_in_root` like every
/// other path command, so a crafted drag cannot name a file outside the vault.
#[tauri::command]
pub fn pty_resolve_path(
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
) -> R<String> {
    let path = file_in(&state, &workflow_id, &rel_path)?;
    Ok(path.to_string_lossy().to_string())
}

/// The writer's home directory, without a crate for it.
fn dirs_home() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

// ── the log bridge ───────────────────────────────────────────────────────

/// Print a line the renderer sent us to stderr.
///
/// The WebView's console goes nowhere a shell can see it, so before v0.1.1 a
/// button that failed inside the renderer produced a completely clean log — the
/// exact symptom of the first Linux boot, where three welcome-screen buttons
/// did nothing and the launcher's stderr showed only harmless GTK chatter.
/// `src/lib/logging.ts` now forwards uncaught errors and rejected promises
/// here, and mirrors `console.error` too when `AQ_WRITER_DEBUG=1` is set.
///
/// Release builds included — a log that only exists in development is a log
/// that is never there when it is needed.
#[tauri::command]
pub fn app_log(level: String, message: String) {
    let level = match level.as_str() {
        "error" | "warn" | "info" => level,
        _ => "info".to_string(),
    };
    eprintln!("[webview:{level}] {message}");
}

// ── development entry points ─────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevContext {
    /// Set when `AQ_DEV_VAULT` opened a folder at startup.
    pub workflow_id: Option<String>,
    /// `AQ_DEV_SMOKE=1` — run the renderer's backend smoke pass on boot.
    pub smoke: bool,
    /// `AQ_DEV_SMOKE=welcome` — run the welcome-screen flows instead. Needs no
    /// `AQ_DEV_VAULT`: creating a workflow is the thing being checked.
    pub smoke_welcome: bool,
    /// `AQ_WRITER_DEBUG=1` — mirror the WebView console to stderr as well as
    /// the errors that are forwarded unconditionally.
    pub debug: bool,
    /// `AQ_PERF=1` — show the frame / jank meter (docs/NOTES.md §27k). Read in
    /// RELEASE builds too, on purpose: the whole point is to measure the
    /// shipped AppImage on the machine that feels slow, which is never a
    /// `npm run dev` on the Mac.
    pub perf: bool,
}

#[tauri::command]
pub fn dev_context(state: State<'_, AppState>) -> R<DevContext> {
    let smoke = std::env::var("AQ_DEV_SMOKE").unwrap_or_default();
    Ok(DevContext {
        workflow_id: state.dev_workflow_id.lock().unwrap().clone(),
        smoke: smoke == "1",
        smoke_welcome: smoke == "welcome",
        debug: std::env::var("AQ_WRITER_DEBUG").map(|v| v == "1").unwrap_or(false),
        perf: std::env::var("AQ_PERF").map(|v| v == "1").unwrap_or(false),
    })
}

/// An empty folder under the OS temp directory, for the welcome-screen smoke
/// pass to create workflows in. Debug builds only — nothing in a shipped app
/// has any business making scratch folders.
#[tauri::command]
pub fn dev_scratch_dir() -> R<String> {
    if !cfg!(debug_assertions) {
        return Err("dev_scratch_dir is a development-only entry point".into());
    }
    let dir = std::env::temp_dir().join(format!("aquarius-smoke-{}", registry::now_ms()));
    std::fs::create_dir_all(&dir).map_err(io)?;
    Ok(dir.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevStat {
    pub len: u64,
    /// mtime in epoch milliseconds.
    pub modified_ms: i64,
}

/// Size and mtime of a vault file. Exists so a headless check can prove the
/// byte-for-byte rule — that an unchanged save leaves the file's mtime alone —
/// from inside the running app rather than by taking the backend's word for it.
#[tauri::command]
pub fn dev_stat(state: State<'_, AppState>, workflow_id: String, rel_path: String) -> R<DevStat> {
    let path = file_in(&state, &workflow_id, &rel_path)?;
    let meta = std::fs::metadata(&path).map_err(io)?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(DevStat { len: meta.len(), modified_ms })
}

/// Print a line from the renderer to the terminal running `tauri dev`.
///
/// Only useful for headless verification: the WebView's own console isn't
/// visible from a shell, so a scripted check has no way to report what it
/// found. Debug builds only.
#[tauri::command]
pub fn dev_log(line: String) {
    if cfg!(debug_assertions) {
        println!("[smoke] {line}");
    }
}

// ── search by meaning ────────────────────────────────────────────────────
//
// Four commands, and the shape is deliberately the Compile sheet's: the sheet
// asks `semantic_probe` when it opens so it already knows which of four states
// it is in — model present, downloading, absent, or broken — and draws a card
// rather than failing on click (NOTES §19d).
//
// `semantic_download` is the only one that touches the network, and it exists
// because the download is a **human click**. There is deliberately no MCP tool
// for it: putting 35 MB on the writer's disk is consent, not an operation.

/// What search by meaning can do on this machine. Cheap: a few `stat` calls.
#[tauri::command]
pub fn semantic_probe(app: AppHandle) -> crate::semantic::service::SemanticStatus {
    crate::semantic::service::probe(&app)
}

/// Download the model. Progress arrives on `semantic://state`.
#[tauri::command]
pub async fn semantic_download(app: AppHandle) -> R<crate::semantic::service::SemanticStatus> {
    crate::semantic::service::download(app).await
}

/// Delete the model from this machine. The index it built is left alone — it
/// is keyed on this model, so a later re-download finds its vectors intact.
#[tauri::command]
pub fn semantic_remove(app: AppHandle) -> R<crate::semantic::service::SemanticStatus> {
    crate::semantic::service::remove(&app)
}

/// Search a vault by meaning.
///
/// The error type is the structured `Refusal`, not a string: the renderer and
/// an agent both have to tell "there is no model here" apart from "the search
/// failed", and neither should be parsing English to do it.
#[tauri::command]
pub async fn semantic_search(
    app: AppHandle,
    workflow_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<crate::semantic::index::SemanticHit>, crate::semantic::service::Refusal> {
    let root = app
        .state::<AppState>()
        .root_for(&workflow_id)
        .map_err(crate::semantic::service::Refusal::model_broken)?;
    let limit = limit.unwrap_or(50);
    // Embedding the query plus a scan over every vector: milliseconds, but
    // milliseconds on a thread that is not drawing the window.
    tauri::async_runtime::spawn_blocking(move || {
        crate::semantic::service::search_blocking(&app, &root, &query, limit)
    })
    .await
    .map_err(|e| crate::semantic::service::Refusal::model_broken(format!("the search stopped ({e})")))?
}

/// Re-index a vault from scratch — the Settings button, for when someone wants
/// to be sure. Returns immediately; progress arrives on `semantic://state`.
#[tauri::command]
pub fn semantic_reindex(app: AppHandle, workflow_id: String) -> R<()> {
    let root = app.state::<AppState>().root_for(&workflow_id)?;
    crate::semantic::service::spawn_sync(&app, workflow_id, root);
    Ok(())
}
