//! Updating the app when AquariusOS is the one that installed it.
//!
//! ## The short version
//!
//! On AquariusOS this app is part of the operating system's image, which is
//! read-only — it cannot overwrite itself. So instead it downloads a newer copy
//! into a folder in the user's home directory (the *overlay*), and the OS
//! launcher starts whichever copy is newer. `overlay.rs` owns that folder and
//! explains the agreement with the launcher in detail; `net.rs` owns the
//! downloading. This file is the state machine in between, and the four things
//! Settings can ask for:
//!
//! * **check** — ask GitHub what the newest release is, compare, say so
//! * **install** — download it, prove it is genuine, unpack it, switch to it
//! * **restart** — go back through the OS launcher, which now picks the new copy
//! * **status** — what phase we are in, for the panel to draw
//!
//! ## When this does nothing at all
//!
//! Everywhere else. On macOS, and on a Linux machine where the app was started
//! by hand rather than by AquariusOS, the phase is `unsupported` and the panel
//! is not drawn. The one switch is `AQUARIUS_OS_MANAGED_INSTALL=1`, which only
//! the OS launcher sets.
//!
//! ## Nothing is ever installed without being asked for
//!
//! Checking is quiet and automatic once at launch. Downloading is not — it is
//! one deliberate press, because it is a large download on a connection that
//! may be someone's phone. And nothing restarts on its own: the new copy sits
//! there until the writer decides they are at a good stopping point.

pub mod net;
pub mod overlay;

use overlay::{InstallProgress, LaunchEnv};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Emitted whenever anything about the update changes, so the panel redraws
/// without polling. Payload: the whole `UpdateState`.
pub const STATE_EVENT: &str = "updater://state";

/// The version this running copy was built as. The same number CI checks
/// against the tag, so it cannot drift from what was published.
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Where the update has got to. One value, so the panel can never show two
/// things at once.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Not an AquariusOS install — there is nothing to show.
    Unsupported,
    /// Nothing has been asked for yet.
    Idle,
    Checking,
    /// Checked, and this is the newest there is.
    Current,
    /// Checked, and there is a newer one. `latest_version` names it.
    Available,
    /// Coming down the wire. `percent` is 0–100.
    Downloading,
    /// Downloaded and verified; unpacking and switching over.
    Installing,
    /// Installed. It runs at the next restart.
    Ready,
    /// Something went wrong. `message` says what, in plain language.
    Error,
}

/// Which of the two long operations failed, so a retry button retries the right
/// one. Without it, "try again" after a failed *check* would start a download.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Check,
    Install,
}

/// Everything the Settings panel needs to draw itself.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub phase: Phase,
    /// False everywhere except an AquariusOS install. The panel hides itself.
    pub os_managed: bool,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    /// A sentence for a person to read. Never a raw error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Set only alongside `Phase::Error`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_operation: Option<Operation>,
}

impl UpdateState {
    fn new(os_managed: bool) -> Self {
        Self {
            phase: if os_managed { Phase::Idle } else { Phase::Unsupported },
            os_managed,
            current_version: current_version().to_string(),
            latest_version: None,
            percent: None,
            message: None,
            failed_operation: None,
        }
    }
}

/// The updater's whole state: where the overlay is, and what phase we are in.
pub struct UpdaterState {
    /// `Some` only under AquariusOS. Its presence *is* the feature switch.
    overlay_root: Option<PathBuf>,
    state: Mutex<UpdateState>,
}

impl UpdaterState {
    /// Reads the launcher's environment once, at startup.
    pub fn from_process() -> Self {
        let overlay_root = overlay::resolve_overlay_root(&LaunchEnv::from_process());
        match &overlay_root {
            Some(root) => println!("[updater] OS-managed install; overlay at {}", root.display()),
            None => println!("[updater] not an OS-managed install — updates are handled elsewhere"),
        }
        let os_managed = overlay_root.is_some();
        Self { overlay_root, state: Mutex::new(UpdateState::new(os_managed)) }
    }
}

fn snapshot(app: &AppHandle) -> UpdateState {
    app.state::<UpdaterState>().state.lock().unwrap().clone()
}

fn overlay_root(app: &AppHandle) -> Option<PathBuf> {
    app.state::<UpdaterState>().overlay_root.clone()
}

/// Record a new state and tell the window about it.
fn publish(app: &AppHandle, next: UpdateState) -> UpdateState {
    *app.state::<UpdaterState>().state.lock().unwrap() = next.clone();
    if let Err(e) = app.emit(STATE_EVENT, &next) {
        eprintln!("[updater] could not tell the window about {:?}: {e}", next.phase);
    }
    next
}

/// Change one or two fields of the current state and publish the result.
fn publish_with(app: &AppHandle, edit: impl FnOnce(&mut UpdateState)) -> UpdateState {
    let mut next = snapshot(app);
    edit(&mut next);
    publish(app, next)
}

/// What Settings reads when it opens.
pub fn status(app: &AppHandle) -> UpdateState {
    snapshot(app)
}

/// True while something is already happening, so a second press is ignored
/// rather than starting a competing download.
fn is_busy(phase: Phase) -> bool {
    matches!(phase, Phase::Checking | Phase::Downloading | Phase::Installing)
}

/// Whether asking GitHub again could tell us anything useful.
///
/// It cannot once a version is installed and waiting: the only thing left to do
/// is restart, and answering "0.3.0 is available" would replace the restart
/// button with a download button for something already downloaded.
fn accepts_check(phase: Phase) -> bool {
    !is_busy(phase) && phase != Phase::Ready
}

// ── check ────────────────────────────────────────────────────────────────

/// Ask GitHub what the newest release is.
///
/// `silent` is for the one automatic check at startup: a failure there returns
/// quietly to `idle` instead of putting a red message in front of someone who
/// never asked. A check the writer pressed for always reports what happened.
pub async fn check(app: AppHandle, silent: bool) -> UpdateState {
    if overlay_root(&app).is_none() || !accepts_check(snapshot(&app).phase) {
        return snapshot(&app);
    }
    publish_with(&app, |s| {
        s.phase = Phase::Checking;
        s.percent = None;
        s.message = None;
        s.failed_operation = None;
    });

    let found = run_in_background(net::latest_release_tag).await;

    let outcome = found.and_then(|tag| {
        overlay::is_newer(&tag, current_version())
            .map(|newer| (overlay::normalize_version(&tag).unwrap_or(tag), newer))
    });

    match outcome {
        Ok((latest, true)) => publish_with(&app, |s| {
            s.phase = Phase::Available;
            s.latest_version = Some(latest);
        }),
        Ok((latest, false)) => publish_with(&app, |s| {
            s.phase = Phase::Current;
            s.latest_version = Some(latest);
        }),
        Err(message) => {
            eprintln!("[updater] check failed: {message}");
            publish_with(&app, |s| {
                if silent {
                    s.phase = Phase::Idle;
                    s.message = None;
                } else {
                    s.phase = Phase::Error;
                    s.message = Some(message);
                    s.failed_operation = Some(Operation::Check);
                }
            })
        }
    }
}

// ── download and install ─────────────────────────────────────────────────

/// Reports the install's progress back into the app's state.
struct Publisher(AppHandle);

impl InstallProgress for Publisher {
    fn downloading(&self, percent: u8) {
        publish_with(&self.0, |s| {
            s.phase = Phase::Downloading;
            s.percent = Some(percent.min(100));
        });
    }

    fn installing(&self) {
        publish_with(&self.0, |s| {
            s.phase = Phase::Installing;
            s.percent = Some(100);
        });
    }
}

/// Download the newest release and put it in the overlay, ready for a restart.
///
/// One press does the whole thing — download, checksum, unpack, switch over —
/// because there is nothing useful a person could decide in between. It can
/// only be started when a check has actually found something.
pub async fn install(app: AppHandle) -> UpdateState {
    let Some(root) = overlay_root(&app) else { return snapshot(&app) };
    let state = snapshot(&app);
    // Straight after a check that found something, or after a download that
    // failed. A failed *check* is retried by checking again, not by downloading.
    let can_start = state.phase == Phase::Available
        || (state.phase == Phase::Error && state.failed_operation == Some(Operation::Install));
    let Some(version) = state.latest_version.clone().filter(|_| can_start) else {
        return state;
    };

    publish_with(&app, |s| {
        s.phase = Phase::Downloading;
        s.percent = Some(0);
        s.message = None;
        s.failed_operation = None;
    });

    let handle = app.clone();
    let target = version.clone();
    let installed = run_in_background(move || {
        overlay::install_update(&root, &target, &net::Network, &Publisher(handle))
    })
    .await;

    match installed {
        Ok(dir) => {
            println!("[updater] {version} installed at {}", dir.display());
            publish_with(&app, |s| {
                s.phase = Phase::Ready;
                s.percent = Some(100);
                s.latest_version = Some(version);
            })
        }
        Err(message) => {
            eprintln!("[updater] install failed: {message}");
            publish_with(&app, |s| {
                s.phase = Phase::Error;
                s.percent = None;
                s.message = Some(message);
                s.failed_operation = Some(Operation::Install);
            })
        }
    }
}

// ── restart ──────────────────────────────────────────────────────────────

/// Close this copy and start the app again through the OS launcher.
///
/// **Through the launcher, never through our own executable.** The launcher is
/// the thing that compares the downloaded copy with the one in the OS image and
/// picks the newer one. Restarting by re-running ourselves would just start the
/// old copy again, and the update would look like it had failed.
pub fn restart(app: &AppHandle) -> Result<(), String> {
    if overlay_root(app).is_none() {
        return Err("This copy of Aquarius Writer does not manage its own updates.".into());
    }
    let launcher = std::path::Path::new(overlay::OS_ENTRY_POINT);
    if !launcher.exists() {
        return Err(format!(
            "{} is missing, so the app cannot restart itself. Close it and open it again from the app grid.",
            overlay::OS_ENTRY_POINT
        ));
    }

    let mut command = std::process::Command::new(launcher);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Its own process group, so the new copy does not die with this one.
    std::os::unix::process::CommandExt::process_group(&mut command, 0);

    command.spawn().map_err(|e| {
        format!("Could not start the new version ({e}). Close the app and open it again.")
    })?;

    println!("[updater] restarting through {}", overlay::OS_ENTRY_POINT);
    app.exit(0);
    Ok(())
}

// ── plumbing ─────────────────────────────────────────────────────────────

/// Run slow, blocking work off the UI thread.
///
/// Downloading is `ureq`, which blocks, and unpacking is a child process that
/// takes seconds. Neither may run on the thread drawing the window.
async fn run_in_background<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(result) => result,
        // Only happens if the worker thread panicked, which would be our bug.
        Err(e) => Err(format!("The update task stopped unexpectedly ({e}).")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_machine_the_os_did_not_install_this_on_shows_nothing() {
        let s = UpdateState::new(false);
        assert_eq!(s.phase, Phase::Unsupported);
        assert!(!s.os_managed, "the panel keys off this and stays hidden");
    }

    #[test]
    fn an_os_managed_install_starts_idle_knowing_its_own_version() {
        let s = UpdateState::new(true);
        assert_eq!(s.phase, Phase::Idle);
        assert_eq!(s.current_version, env!("CARGO_PKG_VERSION"));
        assert!(s.latest_version.is_none());
    }

    #[test]
    fn a_second_press_is_ignored_while_something_is_already_happening() {
        for phase in [Phase::Checking, Phase::Downloading, Phase::Installing] {
            assert!(is_busy(phase), "{phase:?}");
        }
        for phase in [Phase::Idle, Phase::Current, Phase::Available, Phase::Ready, Phase::Error] {
            assert!(!is_busy(phase), "{phase:?}");
        }
    }

    #[test]
    fn checking_again_cannot_take_away_a_restart_that_is_waiting() {
        assert!(!accepts_check(Phase::Ready), "the only thing left to do is restart");
        for phase in [Phase::Idle, Phase::Current, Phase::Available, Phase::Error] {
            assert!(accepts_check(phase), "{phase:?}");
        }
        for phase in [Phase::Checking, Phase::Downloading, Phase::Installing] {
            assert!(!accepts_check(phase), "{phase:?}");
        }
    }

    #[test]
    fn the_phases_reach_the_window_with_the_names_the_panel_expects() {
        // The renderer switches on these strings; a rename here without a
        // rename in src/state/updateStore.ts would leave the panel blank.
        let json = serde_json::to_string(&UpdateState {
            phase: Phase::Downloading,
            os_managed: true,
            current_version: "0.2.0".into(),
            latest_version: Some("0.3.0".into()),
            percent: Some(42),
            message: None,
            failed_operation: None,
        })
        .unwrap();
        assert!(json.contains(r#""phase":"downloading""#), "{json}");
        assert!(json.contains(r#""osManaged":true"#), "{json}");
        assert!(json.contains(r#""latestVersion":"0.3.0""#), "{json}");
        assert!(json.contains(r#""percent":42"#), "{json}");
        assert!(!json.contains("message"), "an absent message is left out entirely");
        assert!(!json.contains("failedOperation"));

        let failed = serde_json::to_string(&Operation::Install).unwrap();
        assert_eq!(failed, r#""install""#, "the panel switches on this string too");
    }
}
