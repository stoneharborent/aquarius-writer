//! The terminal pane's back end — one real PTY per session.
//!
//! The Swift app puts SwiftTerm in a pane (SWIFT-AUDIT §2.7). SwiftTerm is a
//! terminal *emulator* and it is macOS-only, so the port splits the job in two:
//!
//! * **Here (Rust):** the pipe. `portable-pty` opens a pseudo-terminal, spawns
//!   the writer's own login shell inside it, and moves bytes both ways —
//!   forkpty on macOS and Linux, ConPTY on Windows, one trait over all three.
//! * **There (webview):** the emulator. xterm.js parses the escape sequences
//!   and draws the screen.
//!
//! Nothing in between interprets the stream. This module never parses output,
//! never rewrites input, and never runs a command of its own devising.
//!
//! ## Security posture
//!
//! This is the writer's own shell, running as the writer, with the writer's
//! environment and the writer's privileges — exactly what `Terminal.app` or
//! GNOME Console would give them, in a pane. There is no sandbox, no
//! privilege elevation, no `sudo`, no setuid, and no remote door: a PTY is
//! only reachable through this process's own Tauri commands, which only this
//! app's webview can call. The pane's *value* is precisely that — it is where
//! `claude` is launched so it can drive the vault over the MCP server
//! (`src/mcp/`), and an agent that could not read the writer's files as the
//! writer would be no use.
//!
//! What that buys has a matching cost, stated plainly so nobody has to
//! discover it: **anything typed into this pane runs.** The startup command
//! stored in a session's config is typed into the shell on spawn, so a
//! session config is executable content — it lives in this machine's
//! `localStorage`, is never synced, and is never accepted from a document, a
//! vault file, or the MCP server. The only writer of a startup command is the
//! gear button in the pane header.
//!
//! ## Lifecycle
//!
//! ```text
//!   pty_spawn ──► openpty ──► shell -l ──┬─► reader thread ─► pty://output
//!                                        └─► waiter thread ─► pty://exit
//!   pty_write / pty_resize   … while it lives
//!   pty_kill  ──► SIGKILL the child; the waiter reaps it and emits the exit
//!   window Destroyed ──► kill_all()
//! ```
//!
//! Two threads per session, both of which end on their own:
//!
//! * The **reader** blocks on the master fd and ends at EOF, which the kernel
//!   delivers when the last slave handle closes — i.e. when the child dies.
//! * The **waiter** blocks in `Child::wait()`. This is the zombie reaper: a
//!   killed child that nobody waits on stays in the process table for the life
//!   of the app, and a writer who opens and closes ten terminals would leave
//!   ten of them. `wait()` runs on its own thread precisely so a kill can
//!   happen while it is blocked — that is what `clone_killer()` is for.
//!
//! Nothing here holds a `tauri::AppHandle`: `spawn` takes two callbacks, so the
//! whole module is testable with `cargo test` and the Tauri layer is the thin
//! part that turns a callback into an event.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// Event carrying a chunk of terminal output. Payload: `{ id, data }`.
pub const OUTPUT_EVENT: &str = "pty://output";
/// Event fired once when a session's process ends. Payload: `{ id, code }`.
pub const EXIT_EVENT: &str = "pty://exit";

/// How long to wait before typing a session's startup command.
///
/// The command is written to the master fd, so the kernel buffers it whether
/// or not the shell is reading yet — the delay is not about losing bytes, it
/// is about not interleaving with the shell's own startup output, which makes
/// the first screen unreadable. Bench-verify this against a slow `.zshrc`
/// (NOTES §26).
const STARTUP_DELAY: Duration = Duration::from_millis(300);

/// Read buffer. Big enough that `cat`ting a file is a handful of events rather
/// than hundreds; small enough that an interactive keystroke echo is immediate.
const READ_CHUNK: usize = 8192;

// ── the pipe ─────────────────────────────────────────────────────────────

/// What to spawn. Every field has a sane fallback, so `SpawnSpec::default()`
/// is "the writer's login shell in their home directory".
#[derive(Debug, Default, Clone)]
pub struct SpawnSpec {
    /// Absolute path to the program. `None` = the writer's shell.
    pub program: Option<String>,
    /// Arguments. Empty with `program: None` means "make it a login shell".
    pub args: Vec<String>,
    /// Working directory — the active workflow's root, in practice.
    pub cwd: Option<PathBuf>,
    /// Typed into the shell once it is up. Empty/whitespace = plain shell.
    pub startup: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

/// A live PTY: the master side, plus the handle that can kill the child.
pub struct Session {
    master: Box<dyn MasterPty + Send>,
    /// Shared because the startup-command thread writes through it too.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl Session {
    /// Open a PTY, spawn into it, and start the reader and waiter threads.
    ///
    /// `on_output` is called on the reader thread with decoded text;
    /// `on_exit` is called once on the waiter thread with the exit code
    /// (`None` if the wait itself failed).
    pub fn spawn<O, E>(spec: SpawnSpec, mut on_output: O, on_exit: E) -> Result<Self, String>
    where
        O: FnMut(String) + Send + 'static,
        E: FnOnce(Option<i32>) + Send + 'static,
    {
        let program = spec.program.clone().unwrap_or_else(default_shell);
        let args = if spec.program.is_some() || !spec.args.is_empty() {
            spec.args.clone()
        } else {
            login_args(&program)
        };

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: spec.rows.max(1),
                cols: spec.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("could not open a pseudo-terminal: {e}"))?;

        let mut cmd = CommandBuilder::new(&program);
        for a in &args {
            cmd.arg(a);
        }
        if let Some(dir) = spec.cwd.as_ref().filter(|d| d.is_dir()) {
            cmd.cwd(dir);
        }
        // Without these the shell believes it is on a dumb terminal and every
        // colour, every cursor move and every `clear` comes through as
        // literal escape text.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("could not start {program}: {e}"))?;

        // The parent's copy of the slave must go, or the reader below never
        // sees EOF: the kernel keeps the pty open while any handle survives,
        // so a shell that exits would leave a reader thread blocked forever.
        drop(pair.slave);

        let killer = child.clone_killer();
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("could not read from the terminal: {e}"))?;
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(
            pair.master
                .take_writer()
                .map_err(|e| format!("could not write to the terminal: {e}"))?,
        ));

        thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; READ_CHUNK];
            let mut chunker = Utf8Chunker::default();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let text = chunker.push(&buf[..n]);
                        if !text.is_empty() {
                            on_output(text);
                        }
                    }
                    // On Linux a closed pty reads as EIO rather than EOF.
                    Err(_) => break,
                }
            }
        });

        thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code() as i32);
            on_exit(code);
        });

        if let Some(line) = spec.startup.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let line = line.to_string();
            let w = writer.clone();
            thread::spawn(move || {
                thread::sleep(STARTUP_DELAY);
                if let Ok(mut w) = w.lock() {
                    let _ = w.write_all(line.as_bytes());
                    let _ = w.write_all(b"\n");
                    let _ = w.flush();
                }
            });
        }

        Ok(Self { master: pair.master, writer, killer })
    }

    /// Keystrokes (or a pasted path) straight through to the shell.
    pub fn write(&self, data: &str) -> Result<(), String> {
        let mut w = self.writer.lock().map_err(|_| "terminal writer poisoned".to_string())?;
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }

    /// Tell the kernel the window changed, which is what makes the child get
    /// `SIGWINCH` and redraw at the new size.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }

    /// Kill the child. The waiter thread reaps it and reports the exit.
    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

impl Drop for Session {
    /// Dropping a session must not leave a shell running with nothing attached
    /// to it — the pane closing is the only reason a session is ever dropped.
    fn drop(&mut self) {
        self.kill();
    }
}

// ── shell discovery ──────────────────────────────────────────────────────

/// The writer's shell, or the best guess this machine allows.
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        return std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
    }
    #[cfg(not(windows))]
    {
        resolve_shell(std::env::var("SHELL").ok().as_deref(), |p| Path::new(p).exists())
    }
}

/// The decision `default_shell` makes, with the environment handed in so a
/// test can ask what happens on a machine that has no `SHELL`.
#[cfg_attr(windows, allow(dead_code))]
fn resolve_shell(env: Option<&str>, exists: impl Fn(&str) -> bool) -> String {
    if let Some(sh) = env.filter(|s| !s.trim().is_empty() && Path::new(s).is_absolute()) {
        return sh.to_string();
    }
    for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if exists(candidate) {
            return candidate.to_string();
        }
    }
    "/bin/sh".to_string()
}

/// `-l` for the shells that understand it.
///
/// A login shell is what sources `.zprofile` / `.bash_profile`, and that is
/// where a writer's `PATH` picks up Homebrew, `~/.local/bin`, nvm — i.e. where
/// `claude` actually lives. Without it the marquee flow fails with
/// "command not found" on a machine where the command plainly exists.
#[cfg_attr(windows, allow(dead_code))]
fn login_args(program: &str) -> Vec<String> {
    let base = Path::new(program).file_name().and_then(|s| s.to_str()).unwrap_or("");
    match base {
        "zsh" | "bash" | "fish" | "sh" | "dash" | "ksh" => vec!["-l".to_string()],
        _ => Vec::new(),
    }
}

// ── UTF-8 across chunk boundaries ────────────────────────────────────────

/// Turns arbitrary byte chunks into complete strings.
///
/// A PTY read can land anywhere, including the middle of a multi-byte
/// character — an em dash, a box-drawing rule, an emoji in a prompt. Decoding
/// each chunk on its own turns that into a replacement character *permanently*,
/// because the two halves are never seen together again. So the tail of an
/// incomplete sequence is held back and prepended to the next chunk.
///
/// Genuinely invalid bytes (not merely incomplete) are replaced and dropped, so
/// a binary file dumped to the terminal cannot wedge the decoder.
#[derive(Default)]
struct Utf8Chunker {
    tail: Vec<u8>,
}

impl Utf8Chunker {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.tail.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.tail) {
                Ok(s) => {
                    out.push_str(s);
                    self.tail.clear();
                    return out;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        out.push_str(std::str::from_utf8(&self.tail[..valid]).unwrap());
                    }
                    match e.error_len() {
                        // Broken bytes: mark them and keep going.
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            self.tail.drain(..valid + bad);
                        }
                        // Truncated but valid so far: hold it for next time.
                        None => {
                            self.tail.drain(..valid);
                            return out;
                        }
                    }
                }
            }
        }
    }
}

// ── the process-wide table ───────────────────────────────────────────────

/// Every live session, keyed by the id the renderer made up for it.
///
/// The renderer owns the ids because it owns the tabs: a session's *config*
/// (name, font size, startup command) is persisted in `localStorage` and long
/// outlives any PTY. This table only holds the ones that are running now.
#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, Session>>,
}

impl PtyState {
    pub fn insert(&self, id: String, session: Session) {
        // Replacing an id kills whatever was there — the old Session's Drop
        // runs, so a relaunch can never leave an orphan behind.
        self.sessions.lock().unwrap().insert(id, session);
    }

    pub fn with<T>(&self, id: &str, f: impl FnOnce(&Session) -> T) -> Result<T, String> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(id).ok_or_else(|| format!("no live terminal session: {id}"))?;
        Ok(f(s))
    }

    /// Remove and kill one session. Silent when it has already gone — the
    /// renderer closes tabs it may have already seen exit.
    pub fn remove(&self, id: &str) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(mut s) = map.remove(id) {
            s.kill();
        }
    }

    /// Remove and kill everything. Called when the window is destroyed.
    pub fn clear(&self) {
        let mut map = self.sessions.lock().unwrap();
        for (_, mut s) in map.drain() {
            s.kill();
        }
    }
}

// ── tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Instant;

    #[test]
    fn chunker_rejoins_a_split_character() {
        let mut c = Utf8Chunker::default();
        // "—" is E2 80 94. Split it three ways.
        assert_eq!(c.push(&[0xE2]), "");
        assert_eq!(c.push(&[0x80]), "");
        assert_eq!(c.push(&[0x94]), "—");
    }

    #[test]
    fn chunker_emits_the_valid_prefix_immediately() {
        let mut c = Utf8Chunker::default();
        let mut bytes = b"ready ".to_vec();
        bytes.push(0xE2); // start of an em dash, cut short
        assert_eq!(c.push(&bytes), "ready ");
        assert_eq!(c.push(&[0x80, 0x94]), "—");
    }

    #[test]
    fn chunker_does_not_wedge_on_garbage() {
        let mut c = Utf8Chunker::default();
        // 0xFF can never begin a sequence; it must not be buffered forever.
        assert_eq!(c.push(&[b'a', 0xFF, b'b']), "a\u{FFFD}b");
        assert_eq!(c.push(b"c"), "c");
    }

    #[test]
    fn shell_falls_back_when_the_environment_is_empty() {
        assert_eq!(resolve_shell(Some("/bin/fish"), |_| true), "/bin/fish");
        // A relative or empty SHELL is not trusted.
        assert_eq!(resolve_shell(Some("zsh"), |p| p == "/bin/bash"), "/bin/bash");
        assert_eq!(resolve_shell(Some(""), |p| p == "/bin/bash"), "/bin/bash");
        assert_eq!(resolve_shell(None, |_| false), "/bin/sh");
    }

    #[test]
    fn login_args_only_for_shells_that_know_the_flag() {
        assert_eq!(login_args("/bin/zsh"), vec!["-l".to_string()]);
        assert_eq!(login_args("/opt/homebrew/bin/fish"), vec!["-l".to_string()]);
        assert!(login_args("/usr/local/bin/claude").is_empty());
    }

    /// The real round trip: spawn a shell in a PTY, have it say something,
    /// read it back through the reader thread, then kill it and see the
    /// waiter thread report the exit.
    #[test]
    #[cfg(unix)]
    fn spawn_echo_kill_round_trip() {
        let (out_tx, out_rx) = mpsc::channel::<String>();
        let (exit_tx, exit_rx) = mpsc::channel::<Option<i32>>();

        let dir = crate::testutil::TempDir::new("pty");
        let mut session = Session::spawn(
            SpawnSpec {
                program: Some("/bin/sh".to_string()),
                args: vec![],
                cwd: Some(dir.path().to_path_buf()),
                startup: Some("echo aquarius-pty-ok".to_string()),
                cols: 80,
                rows: 24,
            },
            move |text| {
                let _ = out_tx.send(text);
            },
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .expect("spawn a pty");

        // The startup command is typed after a delay, so allow for it.
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = String::new();
        while Instant::now() < deadline && !seen.contains("aquarius-pty-ok") {
            if let Ok(chunk) = out_rx.recv_timeout(Duration::from_millis(500)) {
                seen.push_str(&chunk);
            }
        }
        assert!(
            seen.contains("aquarius-pty-ok"),
            "the startup command never reached the shell; saw: {seen:?}"
        );

        // `write` reaches the same shell.
        session.write("echo second-line\n").expect("write to the pty");
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && !seen.contains("second-line") {
            if let Ok(chunk) = out_rx.recv_timeout(Duration::from_millis(500)) {
                seen.push_str(&chunk);
            }
        }
        assert!(seen.contains("second-line"), "a written command never ran; saw: {seen:?}");

        session.resize(100, 30).expect("resize the pty");

        session.kill();
        let code = exit_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the waiter thread never reported an exit — the child would be a zombie");
        // A killed shell reports a signal, not a clean 0. What matters is that
        // `wait()` returned at all: that is the reaping.
        assert!(code.is_some());
    }
}
