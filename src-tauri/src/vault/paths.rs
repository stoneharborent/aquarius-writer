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
    // Added after NOTES §34, when the same vault turned out to hold an Unreal
    // Engine project as well as the git repositories §33 found. None of these
    // is a name a person gives a folder of writing.
    "site-packages",   // python, and the five 178 KB single-line scipy files
    "DerivedDataCache", // unreal's shader/asset cache
    "ShaderDebugInfo",  // unreal — where the 3 MB single-line key lived
    "Intermediate",     // unreal build intermediates
    "Binaries",         // unreal compiled output
];

/// Directory names that are only machine output **next to a project marker**.
///
/// `Saved` is the case that forced this. A writer can perfectly well have a
/// folder called "Saved" — of clippings, of drafts, of anything — and putting
/// it in the list above would silently make their work invisible to the
/// sidebar, to Find, and to search by meaning. Beside a `.uproject` file it is
/// certainly Unreal's, and Unreal's `Saved/` is where the shader dumps live.
///
/// So the rule is scoped: the name is ignored only when its **parent
/// directory** carries the marker. The four Unreal names are all listed even
/// though the last three are on the built-in list above, because the two rules
/// are allowed to be trimmed independently — if `Intermediate` ever comes off
/// the global list because a writer complained, it must still be ignored
/// inside an Unreal project.
///
/// The mechanism generalises: a `Cargo.toml` beside a `target` would be the
/// same shape, and it is deliberately *not* written down, because `target` is
/// already on the global list and a second rule saying the same thing is a
/// second rule to keep in step.
const MARKER_SCOPED: [(&str, &[&str]); 1] = [(
    // A file with this extension in the directory marks it as an Unreal project.
    "uproject",
    &["Saved", "Intermediate", "Binaries", "DerivedDataCache"],
)];

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

/// True when `parent` holds a file with extension `ext`.
///
/// One extra `read_dir`, and it is only ever reached for a directory whose
/// name is already one of the four scoped ones — so on a vault of prose it
/// runs zero times, and on Royce's it runs a handful.
fn has_marker(parent: &Path, ext: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(parent) else { return false };
    let suffix = format!(".{ext}");
    for entry in entries.filter_map(Result::ok) {
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false)
            && entry.file_name().to_string_lossy().to_lowercase().ends_with(&suffix)
        {
            return true;
        }
    }
    false
}

/// `is_ignored_dir`, plus the rules that depend on what else is in the folder.
///
/// `parent` is the directory the entry was read from — the one that would
/// carry the `.uproject`, not the entry itself.
pub fn is_ignored_dir_in(parent: &Path, name: &str) -> bool {
    if is_ignored_dir(name) {
        return true;
    }
    for (ext, names) in MARKER_SCOPED.iter() {
        if names.iter().any(|n| n.eq_ignore_ascii_case(name)) && has_marker(parent, ext) {
            return true;
        }
    }
    false
}

/// The one question a tree walk asks about a directory entry it just read.
///
/// `parent` is the directory the entry came out of — the scoped rules are
/// questions about the folder, not the name. There is deliberately no version
/// of this without a `parent`: a caller that cannot say where it found the
/// name cannot answer them, and would silently get the looser answer.
///
/// `is_dir` must come from `DirEntry::file_type()`, which does **not** follow
/// symlinks — a symlinked directory reports as neither file nor dir and is
/// dropped by the caller, which is what keeps a `node_modules -> node_modules.nosync`
/// link from being walked twice and a link to an ancestor from hanging.
pub fn skip_entry_in(parent: &Path, name: &str, is_dir: bool) -> bool {
    name == AQ_DIR || is_ignored_name(name) || (is_dir && is_ignored_dir_in(parent, name))
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
        // A folder with nothing special in it — no marker, so only the global
        // rules apply.
        let plain = crate::testutil::TempDir::new("paths-plain");
        let d = plain.path();
        assert!(!skip_entry_in(d, "build", false));
        assert!(skip_entry_in(d, "build", true));
        assert!(skip_entry_in(d, ".aquarius", true));
        assert!(skip_entry_in(d, ".DS_Store", false));
        assert!(!skip_entry_in(d, "Ch_01.md", false));
    }

    #[test]
    fn the_folders_an_unreal_project_generates_are_not_the_writers_work() {
        // The names that need no marker: nobody calls a folder of prose
        // "ShaderDebugInfo".
        for name in ["site-packages", "DerivedDataCache", "ShaderDebugInfo", "Intermediate", "Binaries"] {
            assert!(is_ignored_dir(name), "{name} should be skipped anywhere");
        }
        assert!(is_ignored_dir("SITE-PACKAGES"), "the rule is case-insensitive");
        // And a *file* of that name is still a file.
        let plain = crate::testutil::TempDir::new("paths-unreal-file");
        assert!(!skip_entry_in(plain.path(), "Binaries", false));
    }

    #[test]
    fn saved_is_only_ignored_beside_a_uproject() {
        // A writer's folder of saved things, in an ordinary folder.
        let writer = crate::testutil::TempDir::new("paths-writer");
        writer.write("Notes.md", "words");
        assert!(
            !skip_entry_in(writer.path(), "Saved", true),
            "a writer may have a folder called Saved and it must still be walked"
        );

        // The same name beside a .uproject is Unreal's, and holds the 3 MB
        // shader keys that started NOTES §34.
        let game = crate::testutil::TempDir::new("paths-uproject");
        game.write("MyGame.uproject", "{}");
        assert!(skip_entry_in(game.path(), "Saved", true));
        assert!(skip_entry_in(game.path(), "saved", true), "case-insensitive here too");
        // The marker only speaks for its own folder, not for the tree below it.
        assert!(!skip_entry_in(writer.path(), "Saved", true));
        // And it still says nothing about a file.
        assert!(!skip_entry_in(game.path(), "Saved", false));
        // Nor about a folder that is nobody's build output.
        assert!(!skip_entry_in(game.path(), "Characters", true));
    }
}
