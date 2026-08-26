//! The MCP server's remembered preference — `mcp.json` in the app config dir.
//!
//! Beside `workflows.json`, and for the same reason: it is this machine's
//! setting, not the vault's. Copy a vault to another computer and it does not
//! bring an open port with it.

use crate::fs_ops::atomic::write_atomic;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The port the server listens on unless the writer changes it.
///
/// Chosen to stay out of the way of everything else on Royce's machine and on
/// AquariusOS: not 1420 (this app's own Vite dev server), not 5173 or 4173
/// (Vite's other defaults), not 4747 (Miracle OS's HUD), not 3000/8000/8080.
/// 1729 is in the registered range but has no service anyone runs, and it is
/// short enough to type.
pub const DEFAULT_PORT: u16 = 1729;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    /// Off until the writer turns it on. An app that opens a port on first
    /// launch without being asked is not a local-first app.
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

impl Default for McpConfig {
    fn default() -> Self {
        Self { enabled: false, port: DEFAULT_PORT }
    }
}

pub fn config_path(config_dir: &Path) -> PathBuf {
    config_dir.join("mcp.json")
}

/// Read the preference. Anything unreadable falls back to the default — a
/// corrupt settings file must never stop the app from launching, and the worst
/// case here is a server that stays off until it is switched on again.
pub fn load(config_dir: &Path) -> McpConfig {
    std::fs::read_to_string(config_path(config_dir))
        .ok()
        .and_then(|t| serde_json::from_str::<McpConfig>(&t).ok())
        .unwrap_or_default()
}

pub fn save(config_dir: &Path, config: &McpConfig) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let json = serde_json::to_string_pretty(config).map_err(std::io::Error::other)?;
    write_atomic(&config_path(config_dir), format!("{json}\n").as_bytes())?;
    Ok(())
}

/// Ports the app refuses to take. Below 1024 needs root on Unix; 1420 is this
/// app's own dev server, and binding it would break `npm run tauri:dev`.
pub fn validate_port(port: u16) -> Result<(), String> {
    if port < 1024 {
        return Err(format!("{port} is a privileged port — pick one above 1023"));
    }
    if port == 1420 {
        return Err("1420 is the app's own dev server — pick another port".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn the_default_is_off_on_a_port_nothing_else_wants() {
        let c = McpConfig::default();
        assert!(!c.enabled, "the server must never open a port unasked");
        assert_eq!(c.port, 1729);
        assert_ne!(c.port, 1420, "the app's own Vite dev server");
        assert_ne!(c.port, 4747, "Miracle OS's HUD");
    }

    #[test]
    fn round_trips_through_disk() {
        let t = TempDir::new("mcp-config");
        assert_eq!(load(t.path()), McpConfig::default(), "a missing file reads as the default");

        let want = McpConfig { enabled: true, port: 1730 };
        save(t.path(), &want).unwrap();
        assert_eq!(load(t.path()), want);
    }

    #[test]
    fn a_corrupt_file_reads_as_the_default_rather_than_failing() {
        let t = TempDir::new("mcp-config-corrupt");
        std::fs::write(config_path(t.path()), "{ not json").unwrap();
        assert_eq!(load(t.path()), McpConfig::default());
    }

    #[test]
    fn a_partial_file_keeps_the_default_for_what_it_omits() {
        let t = TempDir::new("mcp-config-partial");
        std::fs::write(config_path(t.path()), r#"{"enabled":true}"#).unwrap();
        let c = load(t.path());
        assert!(c.enabled);
        assert_eq!(c.port, DEFAULT_PORT);
    }

    #[test]
    fn refuses_privileged_ports_and_the_dev_server() {
        assert!(validate_port(80).is_err());
        assert!(validate_port(1023).is_err());
        assert!(validate_port(1420).is_err());
        assert!(validate_port(1024).is_ok());
        assert!(validate_port(DEFAULT_PORT).is_ok());
    }
}
