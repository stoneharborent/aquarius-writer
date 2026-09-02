//! Relative-path handling for the vault.
//!
//! The renderer only ever speaks in `/`-separated paths relative to a workflow
//! root ("Drafts/Ch_01.md"). Everything that turns one of those into a real
//! `PathBuf` goes through here, so there is exactly one place that can let a
//! path escape the vault — and it doesn't.

use std::path::{Component, Path, PathBuf};

/// The metadata folder. Never walked, never watched, never returned in a tree.
pub const AQ_DIR: &str = ".aquarius";

#[derive(Debug)]
pub struct PathError(pub String);

impl std::fmt::Display for PathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Join a renderer-supplied relative path onto a workflow root.
///
/// Rejects absolute paths, Windows prefixes, and any `..` — a vault path can
/// never address a file outside its own folder, however it was constructed.
pub fn resolve_in_root(root: &Path, rel: &str) -> Result<PathBuf, PathError> {
    // No leniency about a leading slash: the renderer speaks vault-relative
    // paths, so an absolute one is a bug worth surfacing rather than quietly
    // reinterpreting.
    if rel.is_empty() {
        return Err(PathError("empty relative path".into()));
    }
    let candidate = Path::new(rel);
    for comp in candidate.components() {
        match comp {
            Component::Normal(_) => {}
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(PathError(format!("path escapes the workflow: {rel}")))
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(PathError(format!("absolute paths are not vault paths: {rel}")))
            }
        }
    }
    let mut out = root.to_path_buf();
    for comp in candidate.components() {
        if let Component::Normal(part) = comp {
            out.push(part);
        }
    }
    Ok(out)
}

/// Turn an absolute path back into a `/`-separated vault path.
pub fn rel_from_root(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    let mut parts: Vec<String> = Vec::new();
    for comp in rel.components() {
        if let Component::Normal(p) = comp {
            parts.push(p.to_string_lossy().to_string());
        }
    }
    Some(parts.join("/"))
}

/// `.aquarius/` inside a workflow.
pub fn aq_dir(root: &Path) -> PathBuf {
    root.join(AQ_DIR)
}

/// True for anything inside `.aquarius/`, so watchers and the tree walk agree
/// on what is app bookkeeping rather than the writer's work.
pub fn is_metadata(root: &Path, abs: &Path) -> bool {
    abs.starts_with(aq_dir(root))
}

/// Files we never show and never react to: dotfiles, editor swap files, and
/// our own atomic-write temporaries.
///
/// This is about *names*, and it is also a **guard**: `vault::ops` refuses to
/// create, rename or move anything that matches, with "that name is reserved
/// for app temporaries". So it must stay a short list of names nobody would
/// deliberately give a document. Build folders are a different question and
/// live in `is_ignored_dir` below — a writer may legitimately want a folder
/// called "Out", and refusing the rename would be worse than walking it.
pub fn is_ignored_name(name: &str) -> bool {
    name.starts_with('.')
        || name.ends_with('~')
        || name.ends_with(".swp")
        || name.ends_with(".tmp")
        || name.starts_with(crate::fs_ops::atomic::TMP_PREFIX)
}

/// Directory names that hold a machine's output rather than a writer's work.
///
/// A vault is a folder someone chose, and people put folders inside folders.
/// Royce's vault has code repositories in it, and before this list existed the
/// walk found **19,304 directories where 2,481 are his, and 3,539 markdown
/// files where 667 are his** — the other 2,870 were `README.md` files inside
/// `node_modules`. Everything that walks the tree paid that 5–8× over: the
/// sidebar, Backlinks, the graph, the semantic backfill, the watcher.
///
/// The list is deliberately built in and deliberately short. It is the set of
/// names that, as a *directory*, mean "generated, reproducible, not prose" in
/// the ecosystems a writer is most likely to have sitting next to their notes.
/// If a writer ever genuinely needs one of these walked, the answer is a
/// per-vault ignore file, not a longer built-in list — see docs/NOTES.md §33.
pub const IGNORED_DIR_NAMES: &[&str] = &[
    "node_modules",   // npm / yarn / pnpm
    "target",         // cargo
    "dist",           // almost every bundler
    "build",          // cmake, gradle, sphinx, xcode
    "out",            // go, next.js, javac
    "__pycache__",    // python bytecode
    "venv",           // python virtualenv (`.venv` is already a dotfile)
    "Pods",           // cocoapods
    "DerivedData",    // xcode
    "vendor",         // go modules, composer, bundler
];

/// True for a **directory** name we never walk into.
///
/// Two rules. The first is `IGNORED_DIR_NAMES`, compared case-insensitively
/// because macOS filesystems are.
///
/// The second is the `.nosync` suffix, and it is the more interesting one:
/// this project's own `scripts/nosync-link.sh` renames a folder to
/// `<name>.nosync` precisely to tell iCloud not to sync it, then symlinks the
/// original name at it. The suffix is a Mac convention meaning "bulk, derived,
/// not worth syncing" — which is the same thing this walk wants to know. So
/// `target.nosync` and `node_modules.nosync` are skipped by the suffix even
/// when the base name is not on the list.
pub fn is_ignored_dir(name: &str) -> bool {
    if name.ends_with(".nosync") {
        return true;
    }
    IGNORED_DIR_NAMES.iter().any(|d| d.eq_ignore_ascii_case(name))
}

/// The one question a tree walk asks about a directory entry it just read.
///
/// `is_dir` must come from `DirEntry::file_type()`, which does **not** follow
/// symlinks — a symlinked directory reports as neither file nor dir and is
/// dropped by the caller, which is what keeps a `node_modules -> node_modules.nosync`
/// link from being walked twice and a link to an ancestor from hanging.
pub fn skip_entry(name: &str, is_dir: bool) -> bool {
    name == AQ_DIR || is_ignored_name(name) || (is_dir && is_ignored_dir(name))
}

/// `~`-shortened display path for the workflow picker.
pub fn display_path(abs: &Path) -> String {
    let s = abs.to_string_lossy().to_string();
    if let Some(home) = home_dir() {
        let home = home.to_string_lossy().to_string();
        if !home.is_empty() && s.starts_with(&home) {
            return format!("~{}", &s[home.len()..]);
        }
    }
    s
}

fn home_dir() -> Option<PathBuf> {
    // Cross-platform without pulling in a crate: HOME on unix, USERPROFILE on
    // Windows. Only used for display, so a miss is cosmetic.
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_normal_paths() {
        let root = Path::new("/vault");
        let p = resolve_in_root(root, "Drafts/Ch_01.md").unwrap();
        assert_eq!(p, PathBuf::from("/vault/Drafts/Ch_01.md"));
    }

    #[test]
    fn refuses_traversal_and_absolutes() {
        let root = Path::new("/vault");
        assert!(resolve_in_root(root, "../secrets.md").is_err());
        assert!(resolve_in_root(root, "Drafts/../../etc/passwd").is_err());
        assert!(resolve_in_root(root, "/etc/passwd").is_err());
        assert!(resolve_in_root(root, "").is_err());
    }

    #[test]
    fn round_trips_relative_paths() {
        let root = Path::new("/vault");
        let abs = resolve_in_root(root, "Characters/Old Sennet.md").unwrap();
        assert_eq!(rel_from_root(root, &abs).unwrap(), "Characters/Old Sennet.md");
    }

    #[test]
    fn ignores_dotfiles_and_temporaries() {
        assert!(is_ignored_name(".DS_Store"));
        assert!(is_ignored_name("Ch_01.md~"));
        assert!(is_ignored_name(".aq-tmp-abc"));
        assert!(!is_ignored_name("Ch_01.md"));
    }

    #[test]
    fn build_folders_are_not_the_writers_work() {
        for name in IGNORED_DIR_NAMES {
            assert!(is_ignored_dir(name), "{name} should be skipped");
        }
        // macOS filesystems are case-insensitive, so the rule is too.
        assert!(is_ignored_dir("Node_Modules"));
        assert!(is_ignored_dir("DERIVEDDATA"));
        // A writer's own folders are not on the list.
        assert!(!is_ignored_dir("Characters"));
        assert!(!is_ignored_dir("Outline"), "a prefix is not a match");
        assert!(!is_ignored_dir("Distant Shores"));
    }

    #[test]
    fn the_nosync_suffix_is_ignored_whatever_it_is_called() {
        assert!(is_ignored_dir("target.nosync"));
        assert!(is_ignored_dir("node_modules.nosync"));
        // The suffix carries the rule on its own — the base name need not be
        // on the list at all.
        assert!(is_ignored_dir("Footage.nosync"));
        assert!(!is_ignored_dir("nosync"));
        assert!(!is_ignored_dir("Chapter.nosync.md"), "that is a file name, not a folder");
    }

    #[test]
    fn a_build_folder_is_only_ignored_as_a_folder() {
        // The name rule is a guard in `vault::ops` — a *document* called
        // "build" must still be creatable and renamable.
        assert!(!is_ignored_name("build"));
        assert!(!skip_entry("build", false));
        assert!(skip_entry("build", true));
        assert!(skip_entry(".aquarius", true));
        assert!(skip_entry(".DS_Store", false));
        assert!(!skip_entry("Ch_01.md", false));
    }
}
