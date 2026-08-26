//! The workflow registry — "which folders has this writer opened?"
//!
//! Lives in the app config dir (`app_config_dir()/workflows.json`), *not* in
//! any vault. A vault folder stays portable: copy it to a thumb drive, open it
//! on another machine, and it works. The registry is only this machine's
//! memory of where things are.

use crate::fs_ops::atomic::write_atomic;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    /// Same id as the folder's `.aquarius/workflow.json`.
    pub id: String,
    /// Absolute path on this machine.
    pub path: String,
    #[serde(default)]
    pub added_at: i64,
    #[serde(default)]
    pub last_opened_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub workflows: Vec<RegistryEntry>,
}

fn one() -> u32 {
    1
}

pub fn registry_path(config_dir: &Path) -> PathBuf {
    config_dir.join("workflows.json")
}

pub fn load(config_dir: &Path) -> Registry {
    let path = registry_path(config_dir);
    match fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Registry>(&t).ok()) {
        Some(r) => r,
        None => Registry { version: 1, workflows: Vec::new() },
    }
}

pub fn save(config_dir: &Path, reg: &Registry) -> std::io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let json = serde_json::to_string_pretty(reg).map_err(std::io::Error::other)?;
    write_atomic(&registry_path(config_dir), format!("{json}\n").as_bytes())?;
    Ok(())
}

impl Registry {
    pub fn find(&self, id: &str) -> Option<&RegistryEntry> {
        self.workflows.iter().find(|w| w.id == id)
    }

    /// Add a folder, or refresh the entry if this path (or id) is already
    /// registered. Registering the same folder twice must not create a second
    /// row in the picker.
    pub fn upsert(&mut self, id: &str, path: &Path) {
        let path_s = path.to_string_lossy().to_string();
        let now = now_ms();
        if let Some(existing) =
            self.workflows.iter_mut().find(|w| w.path == path_s || w.id == id)
        {
            existing.id = id.to_string();
            existing.path = path_s;
            existing.last_opened_at = now;
            return;
        }
        self.workflows.push(RegistryEntry {
            id: id.to_string(),
            path: path_s,
            added_at: now,
            last_opened_at: now,
        });
    }

    /// Re-key an entry from the id in its folder's `workflow.json`, without
    /// counting as an open. A vault copied from another machine arrives with
    /// its own id; the folder is authoritative, the registry follows.
    pub fn upsert_path_only(&mut self, id: &str, path: &Path) {
        let path_s = path.to_string_lossy().to_string();
        if let Some(existing) = self.workflows.iter_mut().find(|w| w.path == path_s) {
            existing.id = id.to_string();
        } else {
            let now = now_ms();
            self.workflows.push(RegistryEntry {
                id: id.to_string(),
                path: path_s,
                added_at: now,
                last_opened_at: 0.max(now - 1),
            });
        }
    }

    pub fn touch(&mut self, id: &str) {
        if let Some(e) = self.workflows.iter_mut().find(|w| w.id == id) {
            e.last_opened_at = now_ms();
        }
    }

    /// Entries whose folder is still on disk, most recently opened first.
    ///
    /// Missing folders are *kept* in the file (an unplugged drive is not a
    /// deletion) but omitted from what the picker shows.
    pub fn live_entries(&self) -> Vec<&RegistryEntry> {
        let mut live: Vec<&RegistryEntry> =
            self.workflows.iter().filter(|w| Path::new(&w.path).is_dir()).collect();
        live.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
        live
    }

    /// The id the app should reopen on launch.
    pub fn most_recent_id(&self) -> Option<String> {
        self.live_entries().first().map(|e| e.id.clone())
    }
}

pub fn now_ms() -> i64 {
    chrono::Local::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn round_trips_through_disk() {
        let cfg = TempDir::new("registry");
        let vault = TempDir::new("registry-vault");
        let mut reg = load(cfg.path());
        assert!(reg.workflows.is_empty());

        reg.upsert("wf-1", vault.path());
        save(cfg.path(), &reg).unwrap();

        let again = load(cfg.path());
        assert_eq!(again.workflows.len(), 1);
        assert_eq!(again.find("wf-1").unwrap().path, vault.path().to_string_lossy());
    }

    #[test]
    fn registering_the_same_folder_twice_updates_in_place() {
        let vault = TempDir::new("registry-dup");
        let mut reg = Registry::default();
        reg.upsert("wf-1", vault.path());
        reg.upsert("wf-1", vault.path());
        assert_eq!(reg.workflows.len(), 1);
    }

    #[test]
    fn missing_folders_are_hidden_but_not_forgotten() {
        let mut reg = Registry::default();
        reg.upsert("gone", Path::new("/definitely/not/here"));
        let live = TempDir::new("registry-live");
        reg.upsert("here", live.path());

        assert_eq!(reg.workflows.len(), 2, "the unplugged drive stays in the file");
        let ids: Vec<&str> = reg.live_entries().iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["here"], "but only reachable folders are listed");
    }

    #[test]
    fn most_recent_wins_the_launch_slot() {
        let a = TempDir::new("registry-a");
        let b = TempDir::new("registry-b");
        let mut reg = Registry::default();
        reg.upsert("a", a.path());
        std::thread::sleep(std::time::Duration::from_millis(5));
        reg.upsert("b", b.path());
        assert_eq!(reg.most_recent_id().as_deref(), Some("b"));
        std::thread::sleep(std::time::Duration::from_millis(5));
        reg.touch("a");
        assert_eq!(reg.most_recent_id().as_deref(), Some("a"));
    }
}
