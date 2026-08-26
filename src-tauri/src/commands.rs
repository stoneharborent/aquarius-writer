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
use crate::vault::{self, paths, registry, tree, workflow};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

/// Emitted when a workflow's folder changed on disk. Payload: `{ workflowId }`.
pub const CHANGE_EVENT: &str = "vault://changed";

type R<T> = Result<T, String>;

fn io(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn root_of(state: &AppState, workflow_id: &str) -> R<PathBuf> {
    let reg = state.registry.lock().unwrap();
    let entry = reg
        .find(workflow_id)
        .ok_or_else(|| format!("unknown workflow: {workflow_id}"))?;
    let path = PathBuf::from(&entry.path);
    if !path.is_dir() {
        return Err(format!("workflow folder is not available: {}", entry.path));
    }
    Ok(path)
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

#[tauri::command]
pub async fn vault_add_workflow_from_folder(
    app: AppHandle,
    state: State<'_, AppState>,
) -> R<Option<WorkflowSummary>> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog().file().set_title("Choose a folder of writing").pick_folder(move |picked| {
        // `try_send`, not `blocking_send`: the picker's callback may land on
        // the UI thread, and exactly one message is ever sent into a channel
        // with room for one.
        let _ = tx.try_send(picked);
    });
    let picked = rx.recv().await.flatten();
    let Some(file_path) = picked else { return Ok(None) };
    let root = file_path.into_path().map_err(io)?;
    register(&app, &state, root).map(Some)
}

/// Open a vault by absolute path, without the picker.
///
/// This is the headless door: it powers `AQ_DEV_VAULT` and is callable from
/// devtools (`__TAURI_INTERNALS__.invoke('vault_add_workflow_by_path', …)`)
/// so the whole backend can be exercised without a human clicking through a
/// native dialog. Debug builds only — a release build refuses, because in
/// release the picker is the only way a folder should get registered.
#[tauri::command]
pub fn vault_add_workflow_by_path(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> R<WorkflowSummary> {
    if !cfg!(debug_assertions) && std::env::var_os("AQ_DEV_VAULT").is_none() {
        return Err("vault_add_workflow_by_path is a development-only entry point".into());
    }
    register(&app, &state, PathBuf::from(path))
}

pub fn register(app: &AppHandle, state: &AppState, root: PathBuf) -> R<WorkflowSummary> {
    if !root.is_dir() {
        return Err(format!("not a folder: {}", root.display()));
    }
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

    // 30-day retention, applied on open: a vault that sat closed for a year
    // still tidies itself the next time the writer comes back to it.
    match trash::sweep_expired(&root, registry::now_ms()) {
        Ok(n) if n > 0 => eprintln!("trash sweep: purged {n} expired deletion(s) in {}", root.display()),
        Err(e) => eprintln!("trash sweep failed in {}: {e}", root.display()),
        _ => {}
    }

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

    Ok(LoadedWorkflow { workflow: wf, tree })
}

// ── documents ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn vault_read_file(state: State<'_, AppState>, workflow_id: String, rel_path: String) -> R<String> {
    let path = file_in(&state, &workflow_id, &rel_path)?;
    fs_ops::read_text(&path).map_err(|e| format!("{rel_path}: {e}"))
}

#[tauri::command]
pub fn vault_write_file(
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
    content: String,
) -> R<()> {
    let path = file_in(&state, &workflow_id, &rel_path)?;
    // Stamp the ledger *before* the write, so the watcher can't win the race
    // and report our own save as an external edit.
    state.note_self_write(&path);
    fs_ops::atomic::write_atomic(&path, content.as_bytes())
        .map(|_| ())
        .map_err(|e| format!("{rel_path}: {e}"))
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

#[tauri::command]
pub fn vault_soft_delete(
    state: State<'_, AppState>,
    workflow_id: String,
    rel_path: String,
) -> R<()> {
    let root = root_of(&state, &workflow_id)?;
    let path = paths::resolve_in_root(&root, &rel_path).map_err(|e| e.0)?;
    state.note_self_write(&path);
    trash::soft_delete(&root, &rel_path, registry::now_ms())
        .map(|_| ())
        .map_err(|e| format!("{rel_path}: {e}"))
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

// ── development entry points ─────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevContext {
    /// Set when `AQ_DEV_VAULT` opened a folder at startup.
    pub workflow_id: Option<String>,
    /// `AQ_DEV_SMOKE=1` — run the renderer's backend smoke pass on boot.
    pub smoke: bool,
}

#[tauri::command]
pub fn dev_context(state: State<'_, AppState>) -> R<DevContext> {
    Ok(DevContext {
        workflow_id: state.dev_workflow_id.lock().unwrap().clone(),
        smoke: std::env::var("AQ_DEV_SMOKE").map(|v| v == "1").unwrap_or(false),
    })
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
