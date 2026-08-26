//! Aquarius Writer — the desktop shell.
//!
//! The renderer is the whole app; this side is a filesystem service for it.
//! Nine `VaultService` methods, a file watcher, and the `.aquarius/` metadata
//! store, all written against `std` and portable crates so the same code
//! serves macOS today and AquariusOS/Linux next.

mod aux_store;
mod commands;
mod fs_ops;
mod model;
mod state;
mod testutil;
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
            open_dev_vault(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_list_workflows,
            commands::vault_add_workflow_from_folder,
            commands::vault_add_workflow_by_path,
            commands::vault_load_workflow,
            commands::vault_read_file,
            commands::vault_write_file,
            commands::vault_read_binary,
            commands::vault_asset_ref,
            commands::vault_soft_delete,
            commands::vault_watch_start,
            commands::vault_watch_stop,
            commands::vault_dev_workflow_id,
            commands::aux_hydrate,
            commands::aux_save_versions,
            commands::aux_save_comments,
            commands::aux_save_searches,
            commands::trash_restore,
            commands::trash_purge,
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
