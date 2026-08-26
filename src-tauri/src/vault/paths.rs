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
pub fn is_ignored_name(name: &str) -> bool {
    name.starts_with('.')
        || name.ends_with('~')
        || name.ends_with(".swp")
        || name.ends_with(".tmp")
        || name.starts_with(crate::fs_ops::atomic::TMP_PREFIX)
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
}
