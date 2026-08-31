//! Finding pandoc, and running it.
//!
//! Pandoc is the one thing in this app that is not ours and not bundled. That
//! is a deliberate trade: it is a 150 MB Haskell binary with a per-platform
//! build, and on AquariusOS it is a one-line package dependency. So the app
//! **looks for it**, says clearly what is missing when it is not there, and
//! never pretends otherwise. (The Compile sheet used to claim "Pandoc bundled".
//! It was never true.)
//!
//! Two rules that are not negotiable:
//!
//! * **No shell.** Every argument goes into `Command::arg`, never into a
//!   string that something else parses. A manuscript called
//!   `Ch 01; rm -rf ~.md` is a file name, not an instruction.
//! * **PATH first, then the usual places.** A `tauri dev` process inherits the
//!   shell's PATH, but an app launched from Finder or a `.desktop` entry often
//!   gets a minimal one — which is exactly how "it works in my terminal" bugs
//!   are born. So a PATH miss falls through to the handful of directories a
//!   package manager actually installs into.

use super::CompileError;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Where package managers put things when PATH is not telling us.
///
/// Homebrew (both prefixes), MacPorts, distro `/usr`, Nix, a user-local
/// install, and the Flatpak export dir — the six that cover nearly everything
/// a writer would have done.
const EXTRA_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/opt/local/bin",
    "/usr/local/texlive/bin",
    "/Library/TeX/texbin",
    "/nix/var/nix/profiles/default/bin",
    "/var/lib/flatpak/exports/bin",
];

/// PDF engines pandoc knows, best first.
///
/// xelatex is the one the Swift app uses and the one the profiles below are
/// written for: it is the only common engine that takes a `mainfont` name.
/// The rest are fallbacks so a machine with *some* renderer still gets a PDF —
/// the report says which one ran, because a typst PDF will not honour the
/// LaTeX layout variables and the writer deserves to know that.
pub const PDF_ENGINES: &[&str] =
    &["xelatex", "lualatex", "pdflatex", "tectonic", "typst", "weasyprint", "wkhtmltopdf"];

/// Engines that take the LaTeX layout variables the profiles set.
pub const LATEX_ENGINES: &[&str] = &["xelatex", "lualatex", "pdflatex", "tectonic"];

pub fn is_latex_engine(name: &str) -> bool {
    LATEX_ENGINES.contains(&name)
}

/// Find an executable by name: PATH, then the usual install directories.
pub fn find_program(name: &str) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    EXTRA_DIRS
        .iter()
        .map(|d| Path::new(d).join(name))
        .find(|c| is_executable(c))
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return meta.permissions().mode() & 0o111 != 0;
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn locate() -> Option<PathBuf> {
    find_program("pandoc")
}

/// `pandoc 3.1.11` — the first line of `pandoc --version`, trimmed.
pub fn version(bin: &Path) -> Option<String> {
    let out = Command::new(bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

/// The best available PDF engine, as (name, path).
pub fn find_pdf_engine() -> Option<(String, PathBuf)> {
    PDF_ENGINES
        .iter()
        .find_map(|name| find_program(name).map(|p| ((*name).to_string(), p)))
}

/// What to tell someone who does not have pandoc, on the platform they are on.
pub fn install_hint() -> String {
    if cfg!(target_os = "macos") {
        "Install it with Homebrew: `brew install pandoc` (and `brew install --cask basictex` \
if you also want PDF)."
            .into()
    } else if cfg!(target_os = "linux") {
        "Install pandoc with your package manager — `sudo apt install pandoc`, \
`sudo dnf install pandoc`, or `rpm-ostree install pandoc` on an atomic system. On AquariusOS \
it ships with the image."
            .into()
    } else {
        "Install pandoc from pandoc.org, then open Compile again.".into()
    }
}

/// What to tell someone whose pandoc has no PDF engine to hand it to.
pub fn engine_hint() -> String {
    if cfg!(target_os = "macos") {
        "PDF needs a TeX engine as well as pandoc. `brew install --cask basictex` installs \
xelatex; EPUB, Word and Markdown need nothing extra."
            .into()
    } else {
        "PDF needs a TeX engine as well as pandoc — `sudo apt install texlive-xetex` (or \
`texlive-xetex` on your distro). EPUB, Word and Markdown need nothing extra."
            .into()
    }
}

/// Run pandoc with an argument array. Never a shell string.
///
/// Failure comes back with pandoc's own stderr attached, because pandoc's
/// complaints ("Could not find data file", "pdflatex not found") are genuinely
/// the most useful thing anyone could be told at that moment.
pub fn run(bin: &Path, args: &[std::ffi::OsString]) -> Result<(), CompileError> {
    let output = Command::new(bin).args(args).output().map_err(|e| {
        CompileError::new("pandocFailed", format!("could not start pandoc: {e}"))
            .with_hint(install_hint())
    })?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.trim();
    let message = if detail.is_empty() {
        format!("pandoc exited with status {}", output.status)
    } else {
        // Pandoc's messages can run long; the first few lines carry the cause.
        let head: Vec<&str> = detail.lines().take(8).collect();
        head.join("\n")
    };
    let err = CompileError::new("pandocFailed", message);
    // The single most common pandoc failure on a fresh machine.
    if detail.contains("pdflatex not found")
        || detail.contains("xelatex not found")
        || detail.to_lowercase().contains("pdf-engine")
    {
        return Err(err.with_hint(engine_hint()));
    }
    Err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_program_that_cannot_exist_is_not_found() {
        assert!(find_program("aquarius-definitely-not-a-real-program").is_none());
    }

    #[test]
    fn find_program_finds_something_every_unix_has() {
        // `sh` is in /bin on every platform this app targets, and it proves
        // both halves of the lookup: PATH on a dev machine, /bin in the
        // fallback list when a launcher hands us an empty PATH.
        assert!(find_program("sh").is_some(), "the executable lookup found nothing at all");
    }

    #[test]
    fn a_directory_is_never_mistaken_for_an_executable() {
        assert!(!is_executable(Path::new("/usr")));
        assert!(!is_executable(Path::new("/definitely/not/here")));
    }

    #[test]
    fn the_engine_list_is_ordered_with_xelatex_first_and_latex_engines_flagged() {
        assert_eq!(PDF_ENGINES[0], "xelatex", "the profiles are written for xelatex");
        assert!(is_latex_engine("xelatex"));
        assert!(!is_latex_engine("typst"), "typst ignores the LaTeX layout variables");
    }

    #[test]
    fn the_install_hints_name_a_command_someone_can_actually_run() {
        let hint = install_hint();
        assert!(hint.contains("pandoc"));
        assert!(
            hint.contains("brew install") || hint.contains("apt install") || hint.contains("pandoc.org")
        );
        assert!(engine_hint().to_lowercase().contains("pdf"));
    }

    #[test]
    fn running_a_failing_program_reports_its_own_words() {
        // `sh -c 'echo boom >&2; exit 3'` stands in for a pandoc that refused.
        let sh = find_program("sh").expect("sh");
        let args: Vec<std::ffi::OsString> =
            vec!["-c".into(), "echo 'pandoc: boom' >&2; exit 3".into()];
        let err = run(&sh, &args).unwrap_err();
        assert_eq!(err.code, "pandocFailed");
        assert!(err.message.contains("boom"), "pandoc's stderr is what the writer needs: {err:?}");
    }

    #[test]
    fn arguments_are_never_handed_to_a_shell() {
        // If this ran through a shell, the `;` would start a second command
        // and the exit status would be 0.
        let sh = find_program("sh").expect("sh");
        let args: Vec<std::ffi::OsString> = vec!["-c".into(), "exit 7".into(), "; exit 0".into()];
        assert!(run(&sh, &args).is_err());
    }
}
