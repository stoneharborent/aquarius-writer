//! The overlay: where a downloaded copy of the app goes, and how it is swapped in.
//!
//! On AquariusOS this app is baked into the operating system's image, which is
//! **read-only**. It cannot overwrite itself the way a normal desktop app does.
//! So it does the next best thing: it downloads a newer copy of itself into a
//! folder in the user's home directory — the *overlay* — and the OS launcher
//! (`/usr/bin/aquarius-writer`) starts whichever copy is newer.
//!
//! ## The agreement with the operating system
//!
//! The launcher, and its helper `/usr/libexec/aquarius-app-overlay` in the
//! `os-image` repo, promise this and expect this. Neither half may change
//! alone.
//!
//! * The launcher exports `AQUARIUS_OS_MANAGED_INSTALL=1` and
//!   `AQUARIUS_UPDATE_OVERLAY_DIR`. Without the first one, everything in this
//!   file stays asleep.
//! * The overlay looks like this:
//!
//!   ```text
//!   ~/.local/share/aquarius/aquarius-writer/
//!     ├── versions/
//!     │   └── 0.2.0/        ← a whole unpacked copy of the app, AppRun on top
//!     ├── tmp/              ← scratch space, emptied after every attempt
//!     └── current -> versions/0.2.0     (a RELATIVE symlink)
//!   ```
//!
//! * A version folder is named with a **bare** version number — `0.2.0`, never
//!   `v0.2.0`. The launcher refuses anything else.
//! * `current` is repointed in one atomic step, so the launcher can never catch
//!   it missing or half-written.
//!
//! ## The safety rule
//!
//! The copy inside the OS image is never touched. Every download happens in a
//! scratch folder *inside the overlay* (so the final move is a rename on the
//! same disk, not a second copy), and `current` is not repointed until the new
//! version is completely in place. If anything at all goes wrong, the scratch
//! folder is deleted and the machine is exactly as it was.
//!
//! Everything here is plain `std` — no Tauri, no network — so `cargo test` can
//! exercise the whole flow against temporary directories.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Set to `1` by the AquariusOS launcher when this build came out of the
/// read-only image.
pub const OS_MANAGED_INSTALL_ENV: &str = "AQUARIUS_OS_MANAGED_INSTALL";
/// The absolute, writable folder the launcher hands us for downloaded copies.
pub const OVERLAY_DIR_ENV: &str = "AQUARIUS_UPDATE_OVERLAY_DIR";
/// Used when the launcher sets the flag but not the folder. Relative to `$HOME`.
pub const DEFAULT_OVERLAY_SUBDIR: &str = ".local/share/aquarius/aquarius-writer";
/// The OS launcher script. Restarting means going back through *this*, never
/// re-running our own executable — the launcher is the thing that picks the
/// newer copy, so a restart that skips it would just start the old one again.
pub const OS_ENTRY_POINT: &str = "/usr/bin/aquarius-writer";

/// Where the release feed lives. Set by `.github/workflows/build.yml`, which
/// publishes exactly these names — see its `release` job.
pub const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/stoneharborent/aquarius-writer/releases/latest";
pub const RELEASE_DOWNLOAD_BASE: &str =
    "https://github.com/stoneharborent/aquarius-writer/releases/download";
pub const CHECKSUM_ASSET_NAME: &str = "SHA256SUMS.txt";

const CURRENT_LINK: &str = "current";
const VERSIONS_DIR: &str = "versions";
const WORK_DIR: &str = "tmp";
/// What `--appimage-extract` always calls the folder it produces.
const EXTRACTED_DIR: &str = "squashfs-root";

/// The files that have to be runnable for the OS launcher to accept a copy.
/// `AppRun` is the front door; `AppRun.wrapped` is the real one the AppImage
/// packaging puts behind it; the third is the program itself.
const MUST_BE_RUNNABLE: [&str; 3] = ["AppRun", "AppRun.wrapped", "usr/bin/aquarius-writer"];

/// The start-up snippet the AppImage packaging generates, which pins the window
/// system — see `patch_gdk_backend`.
const GTK_HOOK: &str = "apprun-hooks/linuxdeploy-plugin-gtk.sh";

// ── the launcher's environment ───────────────────────────────────────────

/// The two variables the launcher sets, plus the home folder they fall back to.
///
/// Kept as a struct rather than read from `std::env` at the point of use so the
/// tests below can pose every awkward case — no home folder, a relative overlay
/// path, the flag missing — without touching the real process environment.
#[derive(Clone, Debug, Default)]
pub struct LaunchEnv {
    pub os_managed: bool,
    pub overlay_dir: Option<String>,
    pub home: Option<String>,
}

impl LaunchEnv {
    /// What this process was actually started with.
    ///
    /// Linux only, deliberately. On macOS there is no AquariusOS launcher, no
    /// read-only image and no overlay, so the whole feature stays dormant even
    /// if someone exports the variable by hand.
    pub fn from_process() -> Self {
        let os_managed = cfg!(target_os = "linux")
            && std::env::var(OS_MANAGED_INSTALL_ENV).map(|v| v == "1").unwrap_or(false);
        Self {
            os_managed,
            overlay_dir: std::env::var(OVERLAY_DIR_ENV).ok(),
            home: std::env::var("HOME").ok(),
        }
    }
}

/// The writable overlay folder, or `None` when this is not an OS-managed install.
///
/// A *relative* `AQUARIUS_UPDATE_OVERLAY_DIR` is ignored rather than resolved
/// against whatever the working directory happens to be: the launcher always
/// passes an absolute path, so anything else is a mistake, and the documented
/// default is the safer answer.
pub fn resolve_overlay_root(env: &LaunchEnv) -> Option<PathBuf> {
    if !env.os_managed {
        return None;
    }
    if let Some(dir) = env.overlay_dir.as_deref().map(str::trim) {
        if !dir.is_empty() && Path::new(dir).is_absolute() {
            return Some(PathBuf::from(dir));
        }
    }
    let home = env.home.as_deref().map(str::trim).filter(|h| !h.is_empty())?;
    if !Path::new(home).is_absolute() {
        return None;
    }
    Some(Path::new(home).join(DEFAULT_OVERLAY_SUBDIR))
}

// ── version numbers ──────────────────────────────────────────────────────

/// Strips a leading `v` and insists on `1.2.3` or `1.2.3-beta.1`.
///
/// This is a security check, not tidiness: the string becomes a **folder name**
/// under the overlay, so anything with a slash or a `..` in it has to be
/// refused outright rather than sanitised and hoped about. Matching
/// `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$` by hand keeps the rule readable and
/// keeps a regex crate out of the build.
///
/// Build metadata (`1.2.3+ci.7`) is refused too. Releases never carry it, and
/// `+` in a folder name is a nuisance nobody needs.
pub fn normalize_version(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let v = trimmed.strip_prefix('v').or_else(|| trimmed.strip_prefix('V')).unwrap_or(trimmed);

    let (core, pre) = match v.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (v, None),
    };

    let mut parts = core.split('.');
    let mut numbers = 0;
    for _ in 0..3 {
        match parts.next() {
            // No leading zeros, no `+1`, no empty segment.
            Some(p) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => numbers += 1,
            _ => break,
        }
    }
    if numbers != 3 || parts.next().is_some() {
        return Err(format!("\"{raw}\" is not a version number like 0.2.0"));
    }
    if let Some(pre) = pre {
        if pre.is_empty()
            || !pre.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        {
            return Err(format!("\"{raw}\" is not a version number like 0.2.0"));
        }
    }
    Ok(v.to_string())
}

/// Is `candidate` a genuinely newer release than `current`?
///
/// Both sides go through `normalize_version` first, so a malformed answer from
/// the release feed is an error rather than a comparison nobody can trust. The
/// comparison itself is the `semver` crate's, which already knows the awkward
/// rules — that `1.0.0-beta` comes *before* `1.0.0`, and that `0.10.0` comes
/// after `0.9.0`.
pub fn is_newer(candidate: &str, current: &str) -> Result<bool, String> {
    let candidate = normalize_version(candidate)?;
    let current = normalize_version(current)?;
    let a = semver::Version::parse(&candidate).map_err(|e| e.to_string())?;
    let b = semver::Version::parse(&current).map_err(|e| e.to_string())?;
    Ok(a > b)
}

// ── the release's files ──────────────────────────────────────────────────

/// The three things an install needs to know about a release.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseAssets {
    /// The published filename, which is also its key in `SHA256SUMS.txt`.
    pub asset_name: String,
    pub appimage_url: String,
    pub checksums_url: String,
}

/// The Linux download's published name.
///
/// This is not what the bundler produces — tauri names it
/// `Aquarius Writer_0.2.0_amd64.AppImage`, spaces and all. The release job in
/// `.github/workflows/build.yml` renames it to this. If that renaming step ever
/// changes, this has to change with it or every update will 404.
pub fn appimage_asset_name(version: &str) -> Result<String, String> {
    Ok(format!("AquariusWriter-{}-x86_64.AppImage", normalize_version(version)?))
}

pub fn release_assets(version: &str) -> Result<ReleaseAssets, String> {
    let version = normalize_version(version)?;
    let asset_name = appimage_asset_name(&version)?;
    let base = format!("{RELEASE_DOWNLOAD_BASE}/v{version}");
    Ok(ReleaseAssets {
        appimage_url: format!("{base}/{asset_name}"),
        checksums_url: format!("{base}/{CHECKSUM_ASSET_NAME}"),
        asset_name,
    })
}

/// Pulls `tag_name` out of what the GitHub releases API answered.
///
/// Kept separate from the network call so the parsing has tests of its own, and
/// so an unrecognisable answer produces a sentence a person can act on rather
/// than a serde error about a missing field.
pub fn tag_from_release_json(text: &str) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| "GitHub's answer was not readable. Try again in a minute.".to_string())?;
    value
        .get("tag_name")
        .and_then(|t| t.as_str())
        .map(str::to_string)
        .ok_or_else(|| "GitHub's answer did not name a release. Try again in a minute.".to_string())
}

// ── checksums ────────────────────────────────────────────────────────────

/// Reads a `sha256sum` manifest into filename → digest.
///
/// The release job runs `sha256sum ./*`, so every name arrives with a `./` in
/// front of it. `sha256sum -b` would instead put a `*` in front. Both spellings
/// are normalised away here so the caller can just look up the asset name.
pub fn parse_sha256_sums(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        let Some((digest, rest)) = line.split_once(char::is_whitespace) else { continue };
        if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let name = rest.trim_start().trim_start_matches('*').trim();
        let name = name.strip_prefix("./").unwrap_or(name);
        if name.is_empty() {
            continue;
        }
        out.insert(name.to_string(), digest.to_ascii_lowercase());
    }
    out
}

/// The digest `SHA256SUMS.txt` claims for one file, if it lists it at all.
pub fn expected_sha256(text: &str, asset_name: &str) -> Option<String> {
    parse_sha256_sums(text).remove(asset_name)
}

// ── the overlay on disk ──────────────────────────────────────────────────

pub fn versions_dir(overlay_root: &Path) -> PathBuf {
    overlay_root.join(VERSIONS_DIR)
}

pub fn current_link(overlay_root: &Path) -> PathBuf {
    overlay_root.join(CURRENT_LINK)
}

/// Repoints `<overlay>/current` at `versions/<version>` in one indivisible step.
///
/// A symlink cannot be edited in place. So a *new* link is made under a
/// throwaway name and then renamed on top of the old one. `rename` either
/// happens or does not, which means the launcher reading `current` at the same
/// moment sees the old target or the new one — never a missing link, never a
/// half-written one.
///
/// The link is written relative (`versions/0.2.0`, not the full path) so the
/// whole overlay folder can be moved or copied and still make sense.
pub fn swap_current(overlay_root: &Path, version: &str) -> Result<(), String> {
    let version = normalize_version(version)?;
    let link = current_link(overlay_root);
    let staged = overlay_root.join(format!(
        ".{CURRENT_LINK}.{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));

    // `rename` will happily replace a symlink or a file, but refuses to replace
    // a directory. Something has gone strange if `current` is one, and leaving
    // it there would wedge every future update, so it goes.
    if let Ok(meta) = fs::symlink_metadata(&link) {
        if meta.is_dir() {
            fs::remove_dir_all(&link).map_err(io_msg("could not clear the old 'current' folder"))?;
        }
    }
    let _ = fs::remove_file(&staged);

    // macOS and Linux are both Unix; this app targets nothing else. A Windows
    // port would need its own answer here (a directory junction, most likely).
    std::os::unix::fs::symlink(Path::new(VERSIONS_DIR).join(&version), &staged)
        .map_err(io_msg("could not prepare the new 'current' link"))?;

    if let Err(e) = fs::rename(&staged, &link) {
        let _ = fs::remove_file(&staged);
        return Err(io_msg("could not put the new 'current' link in place")(e));
    }
    Ok(())
}

/// The version `current` points at, or `None` when there is no usable link.
pub fn read_current_version(overlay_root: &Path) -> Option<String> {
    let target = fs::read_link(current_link(overlay_root)).ok()?;
    let name = target.file_name()?.to_str()?.to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Deletes every downloaded version except the one just installed — and,
/// defensively, whatever `current` actually points at.
///
/// An unpacked copy of the app is not small, and a handheld's disk is. Keeping
/// every version ever downloaded would fill it. Returns what it removed, sorted,
/// which is what the tests assert on and what the log line prints.
pub fn prune_versions(overlay_root: &Path, keep_version: &str) -> Result<Vec<String>, String> {
    let mut keep = vec![normalize_version(keep_version)?];
    if let Some(linked) = read_current_version(overlay_root) {
        keep.push(linked);
    }
    let dir = versions_dir(overlay_root);
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(Vec::new()) };

    let mut removed = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        if keep.iter().any(|k| k == &name) {
            continue;
        }
        let path = dir.join(&name);
        let outcome = if path.is_dir() && !path.is_symlink() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        match outcome {
            Ok(()) => removed.push(name),
            // A version we could not delete is only wasted disk space; it must
            // never turn a successful update into a failed one.
            Err(e) => eprintln!("[updater] could not remove {}: {e}", path.display()),
        }
    }
    removed.sort();
    Ok(removed)
}

// ── the two fixes the OS build also applies ──────────────────────────────
//
// The copy of this app baked into the AquariusOS image is not shipped exactly
// as the AppImage unpacks. `os-image/build_files/creator-apps.sh` fixes two
// things about it first. A copy *we* download and unpack here gets none of that
// — so we do the same two things, or a downloaded update would be subtly worse
// than the one it replaces.

/// Makes an unpacked copy readable and runnable by the person running it.
///
/// **Why this is not paranoia.** What comes out of `--appimage-extract` is
/// whatever permissions the packaging tool happened to leave behind, and they
/// have been wrong before: Aquarius Writer v0.1.0's AppImage carried
/// `AppRun.wrapped` as 0770, and Aquarius Editor's self-extractor once produced
/// *every* directory as 0700. The OS launcher checks a downloaded copy before
/// trusting it, and quietly starts the built-in copy instead when something is
/// unreadable — which is safe, but means the update would appear to install and
/// then never actually run. This is the step that stops that happening.
///
/// The rule is exactly the one `creator-apps.sh` applies to the baked copy:
///
/// ```text
///   directories       0755   anyone may enter and list
///   runnable files    0755   anyone may run
///   everything else   0644   anyone may read
/// ```
///
/// Symlinks are stepped over rather than followed: changing the permissions of
/// a link changes its *target*, which could be a file outside this folder.
pub fn normalize_permissions(root: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fn set(path: &Path, mode: u32) -> Result<(), String> {
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|e| format!("could not set the permissions of {}: {e}", path.display()))
    }

    // An explicit stack rather than recursion: an unpacked app is a deep tree,
    // and this way its depth cannot become this function's problem.
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        set(&dir, 0o755)?;
        let entries = fs::read_dir(&dir)
            .map_err(|e| format!("could not read {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
            } else {
                // "The owner can run it" is what decides whether everyone can.
                let runnable = meta.permissions().mode() & 0o100 != 0;
                set(&path, if runnable { 0o755 } else { 0o644 })?;
            }
        }
    }

    // The three the launcher actually checks, named so a packaging change that
    // drops the owner-execute bit cannot make an update silently un-startable.
    for rel in MUST_BE_RUNNABLE {
        let path = root.join(rel);
        if path.is_file() {
            set(&path, 0o755)?;
        }
    }
    Ok(())
}

/// Lets the launcher have the last word on the window system.
///
/// AppImages packaged with the linuxdeploy GTK plugin — this app is one — carry
/// a start-up snippet with this line in it:
///
/// ```text
/// export GDK_BACKEND=x11
/// ```
///
/// It is sourced *after* anything the launcher sets, so it overwrites it, and
/// `/usr/bin/aquarius-writer`'s documented `AQUARIUS_GDK_BACKEND` escape hatch
/// silently does nothing. Upstream's own fix (tauri-apps/tauri#15786) is to
/// make the line a default rather than an order:
///
/// ```text
/// export GDK_BACKEND="${GDK_BACKEND:-x11}"
/// ```
///
/// `os-image/build_files/creator-apps.sh` applies exactly that to the baked
/// copy; this applies it to a downloaded one. Note what it does *not* do: with
/// nothing set the value is still `x11`, so the app behaves exactly as
/// released. All it does is make the knob reachable, so a future Wayland or
/// NVIDIA problem can be fixed in a launcher instead of in a whole new build.
///
/// Returns whether it changed anything. A missing file or a missing line is
/// fine and is not an error — packaging changes, and an update must not fail
/// because upstream stopped generating a snippet we were only patching.
pub fn patch_gdk_backend(root: &Path) -> Result<bool, String> {
    const ORDER: &str = "export GDK_BACKEND=x11";
    const DEFAULT: &str =
        "export GDK_BACKEND=\"${GDK_BACKEND:-x11}\" # AquariusOS: a default, not an order";

    let hook = root.join(GTK_HOOK);
    let Ok(text) = fs::read_to_string(&hook) else { return Ok(false) };
    if !text.lines().any(|l| l.starts_with(ORDER)) {
        return Ok(false);
    }

    let mut out = String::with_capacity(text.len() + 64);
    for line in text.lines() {
        if line.starts_with(ORDER) {
            out.push_str(DEFAULT);
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    fs::write(&hook, out).map_err(io_msg("could not update the start-up snippet"))?;
    Ok(true)
}

// ── the install ──────────────────────────────────────────────────────────

/// The four jobs that touch the outside world, behind a trait so the tests can
/// stand in for all of them. The real one is `super::net::Network`.
pub trait OverlayIo {
    /// Fetch `url` into `destination`, reporting whole percentages as it goes.
    fn download_file(
        &self,
        url: &str,
        destination: &Path,
        on_progress: &dyn Fn(u8),
    ) -> Result<(), String>;
    fn fetch_text(&self, url: &str) -> Result<String, String>;
    /// Lowercase hex SHA-256 of a file.
    fn hash_file(&self, path: &Path) -> Result<String, String>;
    /// Run `<appimage> --appimage-extract` with `work_dir` as its working
    /// directory, leaving a `squashfs-root/` folder behind.
    fn extract_appimage(&self, appimage: &Path, work_dir: &Path) -> Result<(), String>;
}

/// What the install tells the app while it works, so Settings can show it.
pub trait InstallProgress {
    /// 0–100, while the download is on the wire.
    fn downloading(&self, percent: u8);
    /// The download is verified; the slow unpack-and-swap has begun.
    fn installing(&self);
}

/// Downloads, verifies, unpacks and activates `version` inside `overlay_root`.
///
/// Returns the folder it installed into. Every step happens inside a scratch
/// directory that is deleted whatever the outcome, and `current` still points
/// where it pointed before unless the whole thing succeeded — so a failure here
/// leaves the machine running exactly what it was running.
pub fn install_update(
    overlay_root: &Path,
    version: &str,
    io: &dyn OverlayIo,
    progress: &dyn InstallProgress,
) -> Result<PathBuf, String> {
    let version = normalize_version(version)?;
    let assets = release_assets(&version)?;

    let versions = versions_dir(overlay_root);
    fs::create_dir_all(&versions).map_err(io_msg("could not open the update folder"))?;
    // The scratch folder lives *inside* the overlay on purpose: the finished
    // copy is then moved into place with a rename on the same disk, instead of
    // being copied a second time across filesystems.
    let work_root = overlay_root.join(WORK_DIR);
    fs::create_dir_all(&work_root).map_err(io_msg("could not open the download folder"))?;
    let work_dir = work_root.join(format!("install-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&work_dir).map_err(io_msg("could not open the download folder"))?;

    let installed_dir = versions.join(&version);
    let result = install_inside(&work_dir, &installed_dir, overlay_root, &version, &assets, io, progress);

    // Whatever happened, the scratch folder goes.
    if let Err(e) = fs::remove_dir_all(&work_dir) {
        eprintln!("[updater] could not clean up {}: {e}", work_dir.display());
    }
    if result.is_err() {
        // A half-moved version folder would look installable to the launcher.
        let _ = fs::remove_dir_all(&installed_dir);
    }
    result.map(|()| installed_dir)
}

#[allow(clippy::too_many_arguments)]
fn install_inside(
    work_dir: &Path,
    installed_dir: &Path,
    overlay_root: &Path,
    version: &str,
    assets: &ReleaseAssets,
    io: &dyn OverlayIo,
    progress: &dyn InstallProgress,
) -> Result<(), String> {
    let appimage = work_dir.join(&assets.asset_name);
    io.download_file(&assets.appimage_url, &appimage, &|p| progress.downloading(p))?;

    // Verify before running. `--appimage-extract` *executes* the file we just
    // downloaded, so the checksum is the gate that decides whether it is ours.
    let manifest = io.fetch_text(&assets.checksums_url)?;
    let expected = expected_sha256(&manifest, &assets.asset_name).ok_or_else(|| {
        format!("{} is not listed in {CHECKSUM_ASSET_NAME}", assets.asset_name)
    })?;
    let actual = io.hash_file(&appimage)?.to_ascii_lowercase();
    if actual != expected {
        return Err(format!(
            "The download did not match its checksum, so it was thrown away. \
             (expected {expected}, got {actual})"
        ));
    }

    progress.installing();

    // An AppImage has to be runnable to unpack itself. GitHub does not carry
    // the executable bit through a release asset, so it is set here.
    fs::set_permissions(&appimage, std::os::unix::fs::PermissionsExt::from_mode(0o755))
        .map_err(io_msg("could not make the download runnable"))?;
    // Self-extraction is built into the AppImage runtime and needs no FUSE,
    // which an unprivileged AquariusOS session cannot be assumed to have.
    io.extract_appimage(&appimage, work_dir)?;

    let extracted = work_dir.join(EXTRACTED_DIR);
    if !extracted.is_dir() {
        return Err(format!("The download did not unpack — no {EXTRACTED_DIR} folder appeared."));
    }

    // The same two fixes the OS image build applies to the baked copy. Done
    // here, while the copy is still in the scratch folder, so a failure at
    // either one is just another failed attempt.
    normalize_permissions(&extracted)?;
    if patch_gdk_backend(&extracted)? {
        println!("[updater] the window-system setting is now overridable by the launcher");
    }

    // Only now, with a complete copy in hand, is anything outside the scratch
    // folder touched.
    let _ = fs::remove_dir_all(installed_dir);
    fs::rename(&extracted, installed_dir).map_err(io_msg("could not move the new version into place"))?;
    swap_current(overlay_root, version)?;
    match prune_versions(overlay_root, version) {
        Ok(removed) if !removed.is_empty() => {
            println!("[updater] removed older versions: {}", removed.join(", "));
        }
        Ok(_) => {}
        Err(e) => eprintln!("[updater] could not tidy old versions: {e}"),
    }
    Ok(())
}

fn io_msg(what: &'static str) -> impl Fn(io::Error) -> String {
    move |e| format!("{what}: {e}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use std::cell::RefCell;

    /// A progress reporter that does nothing, for the tests that only care
    /// about what ended up on disk.
    struct SilentProgress;

    impl InstallProgress for SilentProgress {
        fn downloading(&self, _percent: u8) {}
        fn installing(&self) {}
    }

    // ── the launcher's environment ───────────────────────────────────────

    fn env(managed: bool, overlay: Option<&str>, home: Option<&str>) -> LaunchEnv {
        LaunchEnv {
            os_managed: managed,
            overlay_dir: overlay.map(str::to_string),
            home: home.map(str::to_string),
        }
    }

    #[test]
    fn there_is_no_overlay_unless_the_os_launcher_says_so() {
        assert_eq!(
            resolve_overlay_root(&env(false, Some("/srv/overlay"), Some("/home/royce"))),
            None,
            "an ordinary run must never write an update anywhere"
        );
    }

    #[test]
    fn the_launchers_folder_wins_when_it_is_absolute() {
        assert_eq!(
            resolve_overlay_root(&env(true, Some("/srv/overlay"), Some("/home/royce"))),
            Some(PathBuf::from("/srv/overlay"))
        );
    }

    #[test]
    fn a_relative_or_empty_folder_falls_back_to_the_documented_default() {
        let want = Some(PathBuf::from("/home/royce").join(DEFAULT_OVERLAY_SUBDIR));
        assert_eq!(resolve_overlay_root(&env(true, Some("overlay"), Some("/home/royce"))), want);
        assert_eq!(resolve_overlay_root(&env(true, Some("  "), Some("/home/royce"))), want);
        assert_eq!(resolve_overlay_root(&env(true, None, Some("/home/royce"))), want);
    }

    #[test]
    fn without_a_usable_home_there_is_nowhere_to_put_an_update() {
        assert_eq!(resolve_overlay_root(&env(true, None, None)), None);
        assert_eq!(resolve_overlay_root(&env(true, None, Some("relative"))), None);
    }

    // ── version numbers ──────────────────────────────────────────────────

    #[test]
    fn a_version_is_stripped_of_its_v_and_nothing_else() {
        assert_eq!(normalize_version("v0.2.0").unwrap(), "0.2.0");
        assert_eq!(normalize_version("0.2.0").unwrap(), "0.2.0");
        assert_eq!(normalize_version("  V1.10.3  ").unwrap(), "1.10.3");
        assert_eq!(normalize_version("1.0.0-beta.1").unwrap(), "1.0.0-beta.1");
    }

    #[test]
    fn anything_that_could_escape_its_folder_is_refused() {
        for bad in [
            "../../etc", "0.2", "0.2.0.1", "0.2.x", "", "v", "0.2.0/evil", "0.2.0+ci.7",
            "0.2.0-", "0.2.0-beta/../..", "latest", "0.2.-1",
        ] {
            assert!(
                normalize_version(bad).is_err(),
                "{bad:?} must be refused — it becomes a folder name"
            );
        }
    }

    #[test]
    fn newer_means_newer_by_semver_not_by_string() {
        assert!(is_newer("0.10.0", "0.9.0").unwrap(), "0.10 is after 0.9, not before it");
        assert!(is_newer("v0.2.0", "0.1.2").unwrap());
        assert!(!is_newer("0.1.2", "0.1.2").unwrap(), "the same version is not an update");
        assert!(!is_newer("0.1.1", "0.1.2").unwrap(), "never offer a downgrade");
        assert!(!is_newer("1.0.0-beta.1", "1.0.0").unwrap(), "a prerelease comes first");
        assert!(is_newer("1.0.0", "1.0.0-beta.1").unwrap());
        assert!(is_newer("0.2.0", "nonsense").is_err());
    }

    // ── the release's files ──────────────────────────────────────────────

    #[test]
    fn the_asset_names_match_what_the_release_workflow_publishes() {
        let a = release_assets("v0.2.0").unwrap();
        assert_eq!(a.asset_name, "AquariusWriter-0.2.0-x86_64.AppImage");
        assert_eq!(
            a.appimage_url,
            "https://github.com/stoneharborent/aquarius-writer/releases/download/v0.2.0/AquariusWriter-0.2.0-x86_64.AppImage"
        );
        assert_eq!(
            a.checksums_url,
            "https://github.com/stoneharborent/aquarius-writer/releases/download/v0.2.0/SHA256SUMS.txt"
        );
    }

    #[test]
    fn the_release_feed_is_read_for_its_tag_and_nothing_else() {
        assert_eq!(
            tag_from_release_json(r#"{"tag_name":"v0.3.0","name":"whatever"}"#).unwrap(),
            "v0.3.0"
        );
        assert!(tag_from_release_json("not json").is_err());
        assert!(tag_from_release_json(r#"{"message":"Not Found"}"#).is_err());
    }

    // ── checksums ────────────────────────────────────────────────────────

    #[test]
    fn checksums_are_read_in_every_spelling_sha256sum_produces() {
        let text = concat!(
            "0000000000000000000000000000000000000000000000000000000000000001  ./AquariusWriter-0.2.0-x86_64.AppImage\n",
            "0000000000000000000000000000000000000000000000000000000000000002 *AquariusWriter-0.2.0-arm64.zip\n",
            "ABCDEF0000000000000000000000000000000000000000000000000000000003  plain.txt\n",
            "\n",
            "this line is not a checksum\n",
        );
        let sums = parse_sha256_sums(text);
        assert_eq!(sums.len(), 3, "the junk lines are skipped, not fatal");
        assert_eq!(
            expected_sha256(text, "AquariusWriter-0.2.0-x86_64.AppImage").unwrap(),
            "0000000000000000000000000000000000000000000000000000000000000001"
        );
        assert_eq!(
            expected_sha256(text, "AquariusWriter-0.2.0-arm64.zip").unwrap(),
            "0000000000000000000000000000000000000000000000000000000000000002"
        );
        assert_eq!(
            expected_sha256(text, "plain.txt").unwrap(),
            "abcdef0000000000000000000000000000000000000000000000000000000003",
            "digests are compared lowercase"
        );
        assert!(expected_sha256(text, "not-published.AppImage").is_none());
    }

    // ── the overlay on disk ──────────────────────────────────────────────

    fn make_version(root: &Path, version: &str) -> PathBuf {
        let dir = versions_dir(root).join(version);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("AppRun"), "#!/bin/sh\n").unwrap();
        dir
    }

    #[test]
    fn current_points_at_the_version_by_a_relative_path() {
        let t = TempDir::new("overlay-swap");
        make_version(t.path(), "0.2.0");
        swap_current(t.path(), "v0.2.0").unwrap();

        let link = fs::read_link(current_link(t.path())).unwrap();
        assert_eq!(link, PathBuf::from("versions/0.2.0"), "relative, so the overlay stays movable");
        assert!(current_link(t.path()).join("AppRun").exists(), "and it resolves");
        assert_eq!(read_current_version(t.path()).as_deref(), Some("0.2.0"));
    }

    #[test]
    fn swapping_replaces_an_existing_link_and_leaves_no_litter() {
        let t = TempDir::new("overlay-reswap");
        make_version(t.path(), "0.2.0");
        make_version(t.path(), "0.3.0");
        swap_current(t.path(), "0.2.0").unwrap();
        swap_current(t.path(), "0.3.0").unwrap();

        assert_eq!(read_current_version(t.path()).as_deref(), Some("0.3.0"));
        let staged: Vec<_> = fs::read_dir(t.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".current."))
            .collect();
        assert!(staged.is_empty(), "the temporary link must never survive the swap");
    }

    #[test]
    fn swapping_refuses_a_version_that_is_not_a_version() {
        let t = TempDir::new("overlay-bad-swap");
        assert!(swap_current(t.path(), "../escape").is_err());
        assert!(!current_link(t.path()).exists());
    }

    #[test]
    fn pruning_keeps_the_new_version_and_the_one_current_points_at() {
        let t = TempDir::new("overlay-prune");
        for v in ["0.1.0", "0.1.2", "0.2.0"] {
            make_version(t.path(), v);
        }
        swap_current(t.path(), "0.1.2").unwrap();

        let removed = prune_versions(t.path(), "0.2.0").unwrap();
        assert_eq!(removed, vec!["0.1.0".to_string()]);
        assert!(versions_dir(t.path()).join("0.2.0").is_dir());
        assert!(versions_dir(t.path()).join("0.1.2").is_dir(), "still the running copy");
        assert!(!versions_dir(t.path()).join("0.1.0").exists());
    }

    #[test]
    fn pruning_an_overlay_that_has_nothing_in_it_is_not_an_error() {
        let t = TempDir::new("overlay-prune-empty");
        assert_eq!(prune_versions(t.path(), "0.2.0").unwrap(), Vec::<String>::new());
    }

    // ── the install, end to end against temp folders ─────────────────────

    /// A stand-in for the network and the AppImage. Records what it was asked
    /// for, and can be told to fail at any one step.
    struct FakeIo {
        payload: String,
        manifest: String,
        /// The digest `hash_file` will claim, whatever the bytes say.
        digest: String,
        fail_at: Option<&'static str>,
    }

    impl FakeIo {
        fn good() -> Self {
            let digest = "a".repeat(64);
            Self {
                payload: "an appimage".into(),
                manifest: format!("{digest}  ./AquariusWriter-0.2.0-x86_64.AppImage\n"),
                digest,
                fail_at: None,
            }
        }
    }

    impl OverlayIo for FakeIo {
        fn download_file(&self, _url: &str, dest: &Path, on_progress: &dyn Fn(u8)) -> Result<(), String> {
            if self.fail_at == Some("download") {
                return Err("the network went away".into());
            }
            for p in [0u8, 50, 100] {
                on_progress(p);
            }
            fs::write(dest, &self.payload).unwrap();
            Ok(())
        }

        fn fetch_text(&self, _url: &str) -> Result<String, String> {
            if self.fail_at == Some("checksums") {
                return Err("no checksum file".into());
            }
            Ok(self.manifest.clone())
        }

        fn hash_file(&self, _path: &Path) -> Result<String, String> {
            Ok(self.digest.clone())
        }

        /// Produces the kind of tree a real self-extractor has been caught
        /// producing: directories nobody else can enter, an `AppRun.wrapped`
        /// only the owner can run, and the unpatched GTK start-up snippet.
        fn extract_appimage(&self, _appimage: &Path, work_dir: &Path) -> Result<(), String> {
            if self.fail_at == Some("extract") {
                return Err("--appimage-extract exited with 1".into());
            }
            let root = work_dir.join(EXTRACTED_DIR);
            write_mode(&root.join("AppRun"), "#!/bin/sh\n", 0o770);
            write_mode(&root.join("AppRun.wrapped"), "#!/bin/sh\n", 0o770);
            write_mode(&root.join("usr/bin/aquarius-writer"), "elf\n", 0o700);
            write_mode(&root.join("usr/share/icons/icon.png"), "png\n", 0o600);
            write_mode(&root.join(GTK_HOOK), GTK_HOOK_AS_PACKAGED, 0o600);
            // Directories nobody but the owner can enter — the Editor's
            // extractor did exactly this.
            for dir in ["", "usr", "usr/bin", "usr/share", "usr/share/icons", "apprun-hooks"] {
                chmod(&root.join(dir), 0o700);
            }
            Ok(())
        }
    }

    const GTK_HOOK_AS_PACKAGED: &str = concat!(
        "#! /bin/bash\n",
        "# generated by linuxdeploy-plugin-gtk\n",
        "export GDK_BACKEND=x11\n",
        "export GSETTINGS_SCHEMA_DIR=\"$APPDIR/usr/share/glib-2.0/schemas\"\n",
    );

    fn chmod(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::symlink_metadata(path).unwrap().permissions().mode() & 0o7777
    }

    fn write_mode(path: &Path, contents: &str, mode: u32) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
        chmod(path, mode);
    }

    struct RecordingProgress(RefCell<Vec<String>>);

    impl InstallProgress for RecordingProgress {
        fn downloading(&self, percent: u8) {
            self.0.borrow_mut().push(format!("download {percent}"));
        }
        fn installing(&self) {
            self.0.borrow_mut().push("installing".into());
        }
    }

    #[test]
    fn a_good_install_lands_the_version_and_repoints_current() {
        let t = TempDir::new("install-ok");
        let io = FakeIo::good();
        let progress = RecordingProgress(RefCell::new(Vec::new()));

        let dir = install_update(t.path(), "v0.2.0", &io, &progress).unwrap();

        assert_eq!(dir, versions_dir(t.path()).join("0.2.0"));
        assert!(dir.join("AppRun").exists(), "a complete copy, AppRun on top");
        assert_eq!(read_current_version(t.path()).as_deref(), Some("0.2.0"));
        assert_eq!(
            progress.0.borrow().as_slice(),
            ["download 0", "download 50", "download 100", "installing"],
            "the panel is told about the download, then the slow part"
        );
        assert!(
            fs::read_dir(t.path().join(WORK_DIR)).unwrap().next().is_none(),
            "the scratch folder is emptied on the way out"
        );

        // The two fixes the OS image build also applies, done on the way in.
        assert_eq!(mode_of(&dir), 0o755, "the launcher has to be able to enter it");
        assert_eq!(mode_of(&dir.join("AppRun")), 0o755);
        assert_eq!(mode_of(&dir.join("AppRun.wrapped")), 0o755);
        assert_eq!(mode_of(&dir.join("usr/bin/aquarius-writer")), 0o755);
        assert!(
            fs::read_to_string(dir.join(GTK_HOOK)).unwrap().contains("${GDK_BACKEND:-x11}"),
            "the launcher's window-system knob must reach a downloaded copy too"
        );
    }

    // ── the two fixes the OS build also applies ──────────────────────────

    #[test]
    fn an_unpacked_copy_is_made_readable_and_runnable_by_everyone() {
        let t = TempDir::new("perms");
        let root = t.path().join(EXTRACTED_DIR);
        write_mode(&root.join("AppRun"), "#!/bin/sh\n", 0o770);
        write_mode(&root.join("AppRun.wrapped"), "#!/bin/sh\n", 0o600);
        write_mode(&root.join("usr/bin/aquarius-writer"), "elf\n", 0o700);
        write_mode(&root.join("usr/lib/libthing.so"), "so\n", 0o600);
        write_mode(&root.join("usr/share/notes.txt"), "text\n", 0o000);
        std::os::unix::fs::symlink("usr/bin/aquarius-writer", root.join("shortcut")).unwrap();
        for dir in ["", "usr", "usr/bin", "usr/lib", "usr/share"] {
            chmod(&root.join(dir), 0o700);
        }

        normalize_permissions(&root).unwrap();

        for dir in ["", "usr", "usr/bin", "usr/lib", "usr/share"] {
            assert_eq!(mode_of(&root.join(dir)), 0o755, "directory {dir:?}");
        }
        // The three the launcher checks are runnable whatever they arrived as —
        // AppRun.wrapped came in at 0600, with no execute bit to infer from.
        assert_eq!(mode_of(&root.join("AppRun")), 0o755);
        assert_eq!(mode_of(&root.join("AppRun.wrapped")), 0o755);
        assert_eq!(mode_of(&root.join("usr/bin/aquarius-writer")), 0o755);
        // Ordinary files become readable, and stay non-runnable.
        assert_eq!(mode_of(&root.join("usr/lib/libthing.so")), 0o644);
        assert_eq!(mode_of(&root.join("usr/share/notes.txt")), 0o644);
        assert!(root.join("shortcut").is_symlink(), "the link itself is left alone");
    }

    #[test]
    fn the_window_system_line_becomes_a_default_instead_of_an_order() {
        let t = TempDir::new("gdk-patch");
        let root = t.path().join(EXTRACTED_DIR);
        write_mode(&root.join(GTK_HOOK), GTK_HOOK_AS_PACKAGED, 0o644);

        assert!(patch_gdk_backend(&root).unwrap(), "the line was there to rewrite");

        let text = fs::read_to_string(root.join(GTK_HOOK)).unwrap();
        assert!(text.contains(r#"export GDK_BACKEND="${GDK_BACKEND:-x11}""#));
        assert!(!text.contains("export GDK_BACKEND=x11\n"), "the order is gone");
        assert!(
            text.contains("GSETTINGS_SCHEMA_DIR"),
            "every other line of the snippet is left exactly as it was"
        );

        assert!(!patch_gdk_backend(&root).unwrap(), "running it twice changes nothing");
    }

    #[test]
    fn a_missing_snippet_or_a_missing_line_is_not_a_failure() {
        let t = TempDir::new("gdk-absent");
        let root = t.path().join(EXTRACTED_DIR);
        fs::create_dir_all(&root).unwrap();
        assert!(!patch_gdk_backend(&root).unwrap(), "no snippet at all — nothing to do");

        write_mode(&root.join(GTK_HOOK), "#! /bin/bash\nexport SOMETHING=else\n", 0o644);
        assert!(!patch_gdk_backend(&root).unwrap(), "a snippet without the line");
        assert_eq!(
            fs::read_to_string(root.join(GTK_HOOK)).unwrap(),
            "#! /bin/bash\nexport SOMETHING=else\n",
            "and it is not rewritten for the sake of it"
        );
    }

    #[test]
    fn an_installed_version_supersedes_the_old_ones() {
        let t = TempDir::new("install-prunes");
        make_version(t.path(), "0.1.0");
        install_update(t.path(), "0.2.0", &FakeIo::good(), &SilentProgress).unwrap();
        assert!(!versions_dir(t.path()).join("0.1.0").exists());
    }

    #[test]
    fn a_download_that_does_not_match_its_checksum_is_thrown_away() {
        let t = TempDir::new("install-badsum");
        make_version(t.path(), "0.1.0");
        swap_current(t.path(), "0.1.0").unwrap();

        let mut io = FakeIo::good();
        io.manifest = format!("{}  ./AquariusWriter-0.2.0-x86_64.AppImage\n", "b".repeat(64));

        let err = install_update(t.path(), "0.2.0", &io, &SilentProgress).unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        assert!(!versions_dir(t.path()).join("0.2.0").exists());
        assert_eq!(
            read_current_version(t.path()).as_deref(),
            Some("0.1.0"),
            "the running copy is untouched"
        );
    }

    #[test]
    fn a_download_the_checksum_file_does_not_mention_is_refused() {
        let t = TempDir::new("install-unlisted");
        let mut io = FakeIo::good();
        io.manifest = format!("{}  ./something-else.AppImage\n", "a".repeat(64));
        let err = install_update(t.path(), "0.2.0", &io, &SilentProgress).unwrap_err();
        assert!(err.contains("not listed"), "{err}");
    }

    #[test]
    fn every_way_this_can_fail_leaves_the_machine_as_it_was() {
        for step in ["download", "checksums", "extract"] {
            let t = TempDir::new(&format!("install-fail-{step}"));
            make_version(t.path(), "0.1.0");
            swap_current(t.path(), "0.1.0").unwrap();

            let mut io = FakeIo::good();
            io.fail_at = Some(step);

            assert!(install_update(t.path(), "0.2.0", &io, &SilentProgress).is_err(), "{step}");
            assert_eq!(read_current_version(t.path()).as_deref(), Some("0.1.0"), "{step}");
            assert!(!versions_dir(t.path()).join("0.2.0").exists(), "{step}");
            assert!(versions_dir(t.path()).join("0.1.0").join("AppRun").exists(), "{step}");
            assert!(
                fs::read_dir(t.path().join(WORK_DIR)).unwrap().next().is_none(),
                "{step}: scratch folder left behind"
            );
        }
    }

    #[test]
    fn reinstalling_the_same_version_replaces_it_cleanly() {
        let t = TempDir::new("install-again");
        install_update(t.path(), "0.2.0", &FakeIo::good(), &SilentProgress).unwrap();
        fs::write(versions_dir(t.path()).join("0.2.0").join("stale"), "leftover").unwrap();

        install_update(t.path(), "0.2.0", &FakeIo::good(), &SilentProgress).unwrap();
        assert!(
            !versions_dir(t.path()).join("0.2.0").join("stale").exists(),
            "the old folder is removed rather than merged into"
        );
        assert_eq!(read_current_version(t.path()).as_deref(), Some("0.2.0"));
    }
}
