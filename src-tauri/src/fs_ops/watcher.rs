//! Live vault watching.
//!
//! One recursive watcher per open workflow (`notify` — FSEvents on macOS,
//! inotify on Linux, one API for both). Raw filesystem events are noisy, so
//! everything funnels through two filters before the renderer hears about it:
//!
//! * **Noise filter** — `.aquarius/`, dotfiles and our own atomic-write
//!   temporaries never count as a change.
//! * **Echo suppression** — every path the app itself writes is stamped in a
//!   ledger. An event for a path we just wrote, within the echo window, is our
//!   own save coming back and is dropped. Without this, saving a file would
//!   reload the tree, which would re-render the editor, forever.
//!
//! Survivors are debounced (300 ms of quiet) into a single "something changed"
//! callback — a burst of thirty events from a `git checkout` is one reload.

use crate::vault::paths::{is_ignored_dir, is_ignored_name, is_metadata};
use notify::{RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const DEBOUNCE: Duration = Duration::from_millis(300);
/// How long one of our own writes stays "ours" in the ledger. Generous enough
/// to cover FSEvents' coalescing delay, short enough that a real external edit
/// a second later still lands.
pub const ECHO_WINDOW: Duration = Duration::from_millis(1500);

/// Paths the app has written recently, so their events can be ignored.
#[derive(Default)]
pub struct SelfWrites {
    inner: Mutex<HashMap<PathBuf, Instant>>,
}

impl SelfWrites {
    pub fn record(&self, path: &Path) {
        let mut map = self.inner.lock().unwrap();
        map.insert(canonical(path), Instant::now());
        // Opportunistic prune so a long session doesn't grow the ledger.
        map.retain(|_, at| at.elapsed() < ECHO_WINDOW * 4);
    }

    /// True when this event is the echo of a write we just made.
    pub fn is_own(&self, path: &Path) -> bool {
        let map = self.inner.lock().unwrap();
        map.get(&canonical(path)).map(|at| at.elapsed() < ECHO_WINDOW).unwrap_or(false)
    }
}

/// Resolve symlinks so the ledger and the watcher agree on one spelling of a
/// path. macOS reports events under `/private/var/...` for a vault opened as
/// `/var/...`; without this, echo suppression would silently never match.
///
/// The path itself may not exist at the moment we canonicalise it — the ledger
/// is stamped *before* a write, so a brand-new file has no inode yet (nor does
/// the folder the write is about to create), and a delete is checked *after*
/// the file is gone. So walk up to the nearest ancestor that does exist,
/// canonicalise that, and re-attach the tail. Without this, the two halves of a
/// file creation (stamped `/var/…`, reported `/private/var/…`) never match and
/// the app's own new file reads as an external edit.
fn canonical(path: &Path) -> PathBuf {
    if let Ok(resolved) = std::fs::canonicalize(path) {
        return resolved;
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = path;
    while let (Some(parent), Some(name)) = (cursor.parent(), cursor.file_name()) {
        tail.push(name.to_os_string());
        if let Ok(mut resolved) = std::fs::canonicalize(parent) {
            for part in tail.iter().rev() {
                resolved.push(part);
            }
            return resolved;
        }
        cursor = parent;
    }
    path.to_path_buf()
}

/// Should this path produce a "vault changed" notification?
pub fn is_interesting(root: &Path, path: &Path, self_writes: &SelfWrites) -> bool {
    // An event on the vault folder *itself* is never a content change we can
    // act on, and FSEvents emits several: the folder's own creation and
    // extended-attribute touches arrive on the stream even when they happened
    // just before the watch started. Anything that really changed inside the
    // vault also produces an event for the file or subfolder it changed, which
    // is a path *below* root and still reaches us.
    if path == root {
        return false;
    }
    if is_metadata(root, path) {
        return false;
    }
    // Two rules, and the split matters. Every component is checked against
    // `is_ignored_name` — a dotfile anywhere in the path is noise. Only the
    // components *above* the last one are checked against `is_ignored_dir`,
    // because those are certainly directories, and a file called "build" is
    // still a file the tree shows.
    //
    // This is the same rule the tree walk uses, and it has to be: an event the
    // watcher lets through reloads the workflow, which re-walks the tree and
    // re-runs the semantic pass. A `npm install` inside a vault would
    // otherwise be thousands of reloads of a tree that did not change.
    let rel = path.strip_prefix(root).unwrap_or(path);
    let names: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(n) => Some(n.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    for (i, name) in names.iter().enumerate() {
        if is_ignored_name(name) {
            return false;
        }
        if i + 1 < names.len() && is_ignored_dir(name) {
            return false;
        }
    }
    !self_writes.is_own(path)
}

/// A running watcher. Dropping it stops the watch and joins the thread.
pub struct WorkflowWatch {
    watcher: Option<notify::RecommendedWatcher>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl WorkflowWatch {
    /// Start watching `root`, calling `on_change` at most once per quiet period.
    pub fn start(
        root: &Path,
        self_writes: Arc<SelfWrites>,
        on_change: impl Fn() + Send + 'static,
    ) -> notify::Result<Self> {
        let (tx, rx) = channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })?;
        watcher.watch(root, RecursiveMode::Recursive)?;

        // Same reason as `canonical` above: compare like with like.
        let root = canonical(root);
        let thread = std::thread::Builder::new()
            .name("aquarius-vault-watch".into())
            .spawn(move || {
                let mut pending = false;
                loop {
                    // No pending change: block until something happens (or the
                    // channel closes, which is how we shut down).
                    let timeout = if pending { DEBOUNCE } else { Duration::from_secs(3600) };
                    match rx.recv_timeout(timeout) {
                        Ok(Ok(event)) => {
                            if event
                                .paths
                                .iter()
                                .any(|p| is_interesting(&root, p, &self_writes))
                            {
                                if std::env::var_os("AQ_WATCH_DEBUG").is_some() {
                                    eprintln!("[dbg] interesting: {:?} {:?}", event.kind, event.paths);
                                }
                                pending = true;
                            }
                        }
                        Ok(Err(_)) => { /* a watch error on one path — keep going */ }
                        Err(RecvTimeoutError::Timeout) => {
                            if pending {
                                pending = false;
                                on_change();
                            }
                        }
                        Err(RecvTimeoutError::Disconnected) => {
                            if pending {
                                on_change();
                            }
                            return;
                        }
                    }
                }
            })
            .expect("spawn watch thread");

        Ok(Self { watcher: Some(watcher), thread: Some(thread) })
    }
}

impl Drop for WorkflowWatch {
    fn drop(&mut self) {
        // Dropping the watcher closes the event channel, which ends the thread.
        self.watcher.take();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Let a freshly started watcher deliver whatever the OS had queued for
    /// the folder before we started watching it, then zero the counter.
    ///
    /// This is not padding. On macOS the FSEvents stream hands us the vault
    /// folder's own creation and metadata events *after* the stream opens, so
    /// a test that starts counting immediately is counting the fixture's setup
    /// as well as its subject. On a loaded two-core CI runner that lands late
    /// enough to be indistinguishable from the write under test.
    const SETTLE: Duration = Duration::from_millis(750);

    fn settle(hits: &Arc<AtomicUsize>) {
        std::thread::sleep(SETTLE);
        hits.store(0, Ordering::SeqCst);
    }

    #[test]
    fn metadata_and_temporaries_are_not_interesting() {
        let root = Path::new("/vault");
        let sw = SelfWrites::default();
        assert!(is_interesting(root, Path::new("/vault/Drafts/Ch_01.md"), &sw));
        assert!(!is_interesting(root, Path::new("/vault/.aquarius/workflow.json"), &sw));
        assert!(!is_interesting(root, Path::new("/vault/Drafts/.aq-tmp-9f2a"), &sw));
        assert!(!is_interesting(root, Path::new("/vault/.DS_Store"), &sw));
    }

    #[test]
    fn a_dependency_folder_never_reloads_the_workflow() {
        // The expensive half of Royce's "search gets stuck": an event under a
        // build folder reloads the tree and re-runs the semantic pass, and a
        // `npm install` inside a vault emits thousands of them.
        let root = Path::new("/vault");
        let sw = SelfWrites::default();
        assert!(!is_interesting(root, Path::new("/vault/node_modules/react/README.md"), &sw));
        assert!(!is_interesting(root, Path::new("/vault/app/target/debug/build.rs"), &sw));
        assert!(!is_interesting(
            root,
            Path::new("/vault/app/node_modules.nosync/x/index.js"),
            &sw
        ));
        // A *file* whose name happens to be on the folder list is still a file
        // the tree shows, so its events still count.
        assert!(is_interesting(root, Path::new("/vault/Notes/build"), &sw));
        assert!(is_interesting(root, Path::new("/vault/Drafts/Ch_01.md"), &sw));
    }

    #[test]
    fn an_event_on_the_vault_folder_itself_is_not_a_change() {
        // FSEvents reports the watched folder's own creation and xattr touches.
        // Nothing inside the vault changed, so nothing should reload.
        let root = Path::new("/vault");
        let sw = SelfWrites::default();
        assert!(!is_interesting(root, root, &sw));
        assert!(
            is_interesting(root, Path::new("/vault/Notes"), &sw),
            "a folder created *inside* the vault is still a change"
        );
    }

    #[test]
    fn our_own_writes_are_suppressed_then_expire() {
        let root = Path::new("/vault");
        let target = Path::new("/vault/Drafts/Ch_01.md");
        let sw = SelfWrites::default();
        sw.record(target);
        assert!(!is_interesting(root, target, &sw), "our own save must not fire the watcher");
        assert!(
            is_interesting(root, Path::new("/vault/Drafts/Ch_02.md"), &sw),
            "a different file is still an external change"
        );
    }

    #[test]
    fn a_path_stamped_before_it_exists_still_matches_its_event() {
        // The ledger is stamped *before* the write, so at `record` time neither
        // the new file nor the folder it lands in exists yet. Both spellings
        // have to canonicalise the same way or a file the app creates itself
        // comes back as an external edit.
        let t = TempDir::new("watch-create");
        let target = t.path().join("Drafts/Ch_09.md");
        let sw = SelfWrites::default();
        sw.record(&target);

        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "new").unwrap();

        assert!(sw.is_own(&target), "the create's own event must be suppressed");
        assert!(!is_interesting(t.path(), &target, &sw));

        // And a file it did not write is still an external change.
        let other = t.path().join("Drafts/Ch_10.md");
        std::fs::write(&other, "external").unwrap();
        assert!(is_interesting(t.path(), &other, &sw));
    }

    #[test]
    fn an_external_edit_fires_exactly_one_debounced_callback() {
        let t = TempDir::new("watch-external");
        t.write("Drafts/Ch_01.md", "before");
        let hits = Arc::new(AtomicUsize::new(0));
        let seen = hits.clone();
        let watch = WorkflowWatch::start(t.path(), Arc::new(SelfWrites::default()), move || {
            seen.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        settle(&hits);

        // A burst of edits, the way an external tool writes.
        for i in 0..5 {
            std::fs::write(t.path().join("Drafts/Ch_01.md"), format!("after {i}")).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }

        let deadline = Instant::now() + Duration::from_secs(10);
        while hits.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(hits.load(Ordering::SeqCst) >= 1, "the watcher never fired");
        let after_first = hits.load(Ordering::SeqCst);
        assert!(after_first <= 2, "five edits in a burst should coalesce, got {after_first}");
        drop(watch);
    }

    #[test]
    fn a_live_watch_ignores_a_dependency_folder_and_still_hears_a_real_note() {
        // The paired assertion, against the real `notify` backend rather than
        // the filter alone: writing inside `node_modules` must be silent, and
        // the very next write to an ordinary note must still arrive. A filter
        // that has gone too far would pass the first half of this on its own.
        let t = TempDir::new("watch-deps");
        t.write("Drafts/Ch_01.md", "before");
        t.write("node_modules/react/README.md", "before");
        let hits = Arc::new(AtomicUsize::new(0));
        let seen = hits.clone();
        let watch = WorkflowWatch::start(t.path(), Arc::new(SelfWrites::default()), move || {
            seen.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        settle(&hits);

        for i in 0..10 {
            std::fs::write(
                t.path().join("node_modules/react/README.md"),
                format!("install {i}"),
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(DEBOUNCE * 3);
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "a dependency folder must never reload the workflow"
        );

        std::fs::write(t.path().join("Drafts/Ch_01.md"), "after").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while hits.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(hits.load(Ordering::SeqCst) >= 1, "a real note's edit must still arrive");
        drop(watch);
    }

    #[test]
    fn writes_recorded_in_the_ledger_do_not_fire() {
        let t = TempDir::new("watch-echo");
        t.write("note.md", "before");
        let hits = Arc::new(AtomicUsize::new(0));
        let seen = hits.clone();
        let ledger = Arc::new(SelfWrites::default());
        let watch = WorkflowWatch::start(t.path(), ledger.clone(), move || {
            seen.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        // Setup noise has to be out of the way before the write under test,
        // or a late fixture event gets blamed on the ledger.
        settle(&hits);

        let target = t.path().join("note.md");
        ledger.record(&target);
        std::fs::write(&target, "after").unwrap();

        std::thread::sleep(Duration::from_millis(900));
        assert_eq!(hits.load(Ordering::SeqCst), 0, "the app's own write echoed back as a change");
        drop(watch);
    }
}
