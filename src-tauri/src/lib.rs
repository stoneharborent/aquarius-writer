//! Aquarius Writer — the desktop shell.
//!
//! The renderer is the whole app; this side is a filesystem service for it.
//! Nine `VaultService` methods, a file watcher, and the `.aquarius/` metadata
//! store, all written against `std` and portable crates so the same code
//! serves macOS today and AquariusOS/Linux next.
//!
//! On AquariusOS there is one more job: the app is baked into a read-only OS
//! image and cannot overwrite itself, so `updater/` downloads newer copies into
//! a folder in the user's home directory and the OS launcher starts whichever
//! is newer. Everywhere else that module stays asleep.
//!
//! Since Stage 5 there is a **second door onto the same service**: an opt-in
//! MCP server (`mcp/`) that lets an external AI app — Claude Code, Claude
//! Desktop — drive the vault. Both doors call the same `vault::ops`; neither
//! has logic the other lacks.

mod aux_store;
mod commands;
mod compile;
mod fs_ops;
mod mcp;
mod model;
mod pty;
mod semantic;
mod sessions;
mod state;
mod testutil;
mod updater;
mod vault;

use state::AppState;
use std::path::PathBuf;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&config_dir).ok();
            let registry = vault::registry::load(&config_dir);
            app.manage(AppState::new(config_dir, registry));
            app.manage(mcp::McpState::default());
            // The terminal pane's live PTYs. Empty at launch by design: a
            // session's config is persisted in the renderer, the process is
            // not, so nothing survives a quit (pty/mod.rs).
            app.manage(pty::PtyState::default());
            // Reads the AquariusOS launcher's environment once. Off that OS it
            // finds nothing and the whole updater stays asleep.
            app.manage(updater::UpdaterState::from_process());
            open_dev_vault(app.handle());
            // After the dev vault, so a smoke run has something registered by
            // the time a client can connect.
            mcp::restore_on_launch(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the last window ends the process, but the listener is
            // ours to close politely — and on a platform where the app can
            // outlive its window, an orphaned open port would be a surprise.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let app = window.app_handle().clone();
                mcp::stop(&app);
                // Same reason, louder: an orphaned shell is a live process
                // with the writer's privileges and no window attached to it.
                app.state::<pty::PtyState>().clear();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_list_workflows,
            commands::vault_add_workflow_from_folder,
            commands::vault_add_workflow_by_path,
            commands::vault_pick_folder,
            commands::vault_create_workflow,
            commands::vault_create_sample_workflow,
            commands::vault_load_workflow,
            commands::vault_read_file,
            commands::vault_write_file,
            commands::vault_read_binary,
            commands::vault_asset_ref,
            commands::vault_create_file,
            commands::vault_create_folder,
            commands::vault_rename,
            commands::vault_move,
            commands::vault_soft_delete,
            commands::vault_set_star,
            commands::vault_list_stars,
            commands::vault_reorder_chapters,
            commands::vault_set_daily_goal,
            commands::vault_toggle_manuscript_folder,
            commands::vault_toggle_draft_folder,
            commands::vault_set_active_draft,
            commands::vault_set_synopsis,
            commands::session_note,
            commands::session_today,
            commands::session_range,
            commands::vault_watch_start,
            commands::vault_watch_stop,
            commands::app_log,
            commands::dev_context,
            commands::dev_log,
            commands::dev_stat,
            commands::dev_scratch_dir,
            commands::aux_hydrate,
            commands::aux_save_versions,
            commands::aux_save_comments,
            commands::aux_save_searches,
            commands::aux_trash_list,
            commands::trash_restore,
            commands::trash_purge,
            commands::trash_empty,
            commands::trash_retention_days,
            commands::compile_probe,
            commands::compile_run,
            commands::compile_reveal,
            commands::mcp_status,
            commands::mcp_set_enabled,
            commands::mcp_set_port,
            commands::updater_status,
            commands::updater_check,
            commands::updater_install,
            commands::updater_restart,
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::pty_resolve_path,
            commands::semantic_embed_probe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aquarius Writer");
}

/// `AQ_DEV_VAULT=/path/to/folder npm run tauri:dev` opens that folder on
/// launch and makes it the most recent workflow, so the app boots straight
/// into a real vault with no picker in the way. Development only — it is the
/// headless counterpart to the native folder dialog.
fn open_dev_vault(app: &tauri::AppHandle) {
    let Some(raw) = std::env::var_os("AQ_DEV_VAULT") else { return };
    let root = PathBuf::from(raw);
    let state = app.state::<AppState>();
    match commands::register(app, &state, root.clone()) {
        Ok(summary) => {
            *state.dev_workflow_id.lock().unwrap() = Some(summary.id.clone());
            println!(
                "AQ_DEV_VAULT: opened \"{}\" ({}) — id {} — {} items",
                summary.name, root.display(), summary.id, summary.items
            );
        }
        Err(e) => eprintln!("AQ_DEV_VAULT: could not open {}: {e}", root.display()),
    }
}
