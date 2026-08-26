//! Process-wide state: the registry, live watchers, and the self-write ledger.

use crate::fs_ops::watcher::{SelfWrites, WorkflowWatch};
use crate::vault::registry::Registry;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

pub struct AppState {
    /// Where `workflows.json` lives (the app config dir).
    pub config_dir: PathBuf,
    pub registry: Mutex<Registry>,
    /// One watcher per open workflow, keyed by workflow id.
    pub watches: Mutex<HashMap<String, WorkflowWatch>>,
    /// Paths the app has just written — see `fs_ops::watcher`.
    pub self_writes: Arc<SelfWrites>,
    /// Workflows whose folder the asset protocol has accepted.
    asset_scoped: Mutex<HashSet<String>>,
    /// Workflows the asset protocol refused; those fall back to data URLs.
    asset_refused: Mutex<HashSet<String>>,
    /// Set when `AQ_DEV_VAULT` opened a folder at startup.
    pub dev_workflow_id: Mutex<Option<String>>,
}

impl AppState {
    pub fn new(config_dir: PathBuf, registry: Registry) -> Self {
        Self {
            config_dir,
            registry: Mutex::new(registry),
            watches: Mutex::new(HashMap::new()),
            self_writes: Arc::new(SelfWrites::default()),
            asset_scoped: Mutex::new(HashSet::new()),
            asset_refused: Mutex::new(HashSet::new()),
            dev_workflow_id: Mutex::new(None),
        }
    }

    pub fn note_self_write(&self, path: &Path) {
        self.self_writes.record(path);
    }

    /// Where a workflow's folder is on this machine.
    ///
    /// The single place either door — the renderer's commands or the MCP
    /// server's tools — turns a workflow id into a path, so both get the same
    /// answer and the same error when a vault has been moved or unplugged.
    pub fn root_for(&self, workflow_id: &str) -> Result<PathBuf, String> {
        let reg = self.registry.lock().unwrap();
        let entry = reg
            .find(workflow_id)
            .ok_or_else(|| format!("unknown workflow: {workflow_id}"))?;
        let path = PathBuf::from(&entry.path);
        if !path.is_dir() {
            return Err(format!("workflow folder is not available: {}", entry.path));
        }
        Ok(path)
    }

    /// Let the asset protocol serve files from this workflow's folder.
    ///
    /// The scope has to be granted at runtime because the folder is whatever
    /// the writer picked — there is no static path to put in the config.
    /// Returns whether the asset protocol may be used; `false` means the
    /// caller should fall back to a data URL.
    pub fn grant_asset_access(&self, app: &AppHandle, workflow_id: &str, root: &Path) -> bool {
        if self.asset_scoped.lock().unwrap().contains(workflow_id) {
            return true;
        }
        if self.asset_refused.lock().unwrap().contains(workflow_id) {
            return false;
        }
        match app.asset_protocol_scope().allow_directory(root, true) {
            Ok(()) => {
                self.asset_scoped.lock().unwrap().insert(workflow_id.to_string());
                true
            }
            Err(e) => {
                eprintln!(
                    "asset protocol refused {} ({e}); falling back to data URLs for this workflow",
                    root.display()
                );
                self.asset_refused.lock().unwrap().insert(workflow_id.to_string());
                false
            }
        }
    }
}
