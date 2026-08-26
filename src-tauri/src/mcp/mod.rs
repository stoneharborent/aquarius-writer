//! The MCP server — how an external AI app drives Aquarius Writer.
//!
//! Stage 5 replaced the embedded agent with this. The app no longer talks to a
//! model itself; instead it *speaks MCP*, so Claude Code, Claude Desktop, or
//! whatever comes next can open the vault, read a chapter, rewrite it, reorder
//! the manuscript and put a draft in the trash — the same operations a human
//! has in the UI, through the same code (`vault::ops`).
//!
//! ## Shape
//!
//! * **Transport:** streamable HTTP, from the official Rust SDK (`rmcp`), served
//!   by a minimal axum router on a plain `TcpListener`. One route, `POST /mcp`.
//! * **Address:** `127.0.0.1` and nothing else. The listener is bound to the
//!   loopback interface, so the port is not reachable from the network at all —
//!   not from another machine, not from another container. rmcp additionally
//!   validates the `Host` header against loopback names by default, which is
//!   the DNS-rebinding guard the MCP spec asks for.
//! * **Auth:** none, deliberately, in v1. The only thing that can reach the
//!   socket is a process on this machine running as this user, which can
//!   already read the vault directly. **If this is ever bound to anything other
//!   than loopback, it needs a bearer token first** — see docs/NOTES.md.
//! * **Opt-in:** off by default. A toggle in Settings starts and stops it, and
//!   the choice is remembered in the app config dir so it comes back on
//!   relaunch.
//! * **State:** the tools reach the app's *one* `AppState` through the
//!   `AppHandle` — the same registry the UI uses, the same self-write ledger.
//!   There is no second copy of anything.

mod config;
mod tools;

pub use config::{save as save_config, validate_port, McpConfig};

use crate::state::AppState;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpService, StreamableHttpServerConfig,
};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

/// The path MCP clients POST to.
pub const ROUTE: &str = "/mcp";

/// A running server, and the handle that stops it.
pub struct Running {
    pub port: u16,
    stop: Option<oneshot::Sender<()>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(tx) = self.stop.take() {
            println!("[mcp] closing the listener on port {}", self.port);
            // The receiver is the axum graceful-shutdown future. If it has
            // already gone the server is already down, which is the goal.
            let _ = tx.send(());
        }
    }
}

/// Everything the app knows about the MCP server: the persisted preference and
/// the live server, if there is one.
#[derive(Default)]
pub struct McpState {
    pub config: Mutex<McpConfig>,
    pub running: Mutex<Option<Running>>,
}

/// What the Settings panel renders.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    /// `http://127.0.0.1:<port>/mcp`
    pub url: String,
    /// The line to paste into a terminal to register this server with Claude Code.
    pub claude_command: String,
    /// Set when the last start attempt failed (port in use, most likely).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn url_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}{ROUTE}")
}

pub fn claude_command_for(port: u16) -> String {
    format!("claude mcp add --transport http aquarius-writer {}", url_for(port))
}

pub fn status(app: &AppHandle, error: Option<String>) -> McpStatus {
    let mcp = app.state::<McpState>();
    let config = mcp.config.lock().unwrap().clone();
    let running = mcp.running.lock().unwrap();
    McpStatus {
        enabled: config.enabled,
        running: running.is_some(),
        port: config.port,
        url: url_for(config.port),
        claude_command: claude_command_for(config.port),
        error,
    }
}

/// Start the server if it is not already up. Returns the error text on failure
/// rather than panicking — a busy port must not take the app down with it.
pub fn start(app: &AppHandle) -> Result<(), String> {
    let mcp = app.state::<McpState>();
    if mcp.running.lock().unwrap().is_some() {
        return Ok(());
    }
    let port = mcp.config.lock().unwrap().port;

    let handle = app.clone();
    // rmcp's defaults, deliberately: sessions on, replies framed as
    // `text/event-stream`, `Host` restricted to loopback names. The SDK also
    // offers `json_response` (a plain `application/json` reply, which every
    // tool here could use — nothing streams), but it only applies with
    // `legacy_session_mode` off, and trading the SDK's best-tested path for a
    // slightly tidier reply is not a bet worth making on a client we cannot
    // test against here. The spec requires clients to accept both framings.
    let service = StreamableHttpService::new(
        // One handler per request. It is a thin thing — an `AppHandle` clone
        // and nothing else — so there is no per-request cost worth avoiding,
        // and no shared mutable state to get wrong.
        move || Ok(tools::AquariusMcp::new(handle.clone())),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );

    // Loopback only. Binding here rather than inside the task means a port
    // clash is reported to the caller (and to Settings) instead of vanishing
    // into a background thread.
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = std::net::TcpListener::bind(addr)
        .map_err(|e| format!("could not open {addr}: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("could not prepare the listener: {e}"))?;

    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let router = axum::Router::new().route_service(ROUTE, service);

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[mcp] listener could not join the runtime: {e}");
                return;
            }
        };
        println!("[mcp] serving {}", url_for(port));
        let served = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = stop_rx.await;
            })
            .await;
        if let Err(e) = served {
            eprintln!("[mcp] server stopped: {e}");
        } else {
            println!("[mcp] stopped");
        }
    });

    *mcp.running.lock().unwrap() = Some(Running { port, stop: Some(stop_tx) });
    Ok(())
}

/// Stop the server if it is up. Idempotent.
pub fn stop(app: &AppHandle) {
    let mcp = app.state::<McpState>();
    // Dropping `Running` fires the shutdown signal.
    let _ = mcp.running.lock().unwrap().take();
}

/// Called from `setup`: bring the server back if it was on when the app closed.
pub fn restore_on_launch(app: &AppHandle) {
    let state = app.state::<AppState>();
    let config = config::load(&state.config_dir);
    let enabled = config.enabled;
    *app.state::<McpState>().config.lock().unwrap() = config;
    if enabled {
        if let Err(e) = start(app) {
            eprintln!("[mcp] enabled in settings but could not start: {e}");
        }
    }
}
