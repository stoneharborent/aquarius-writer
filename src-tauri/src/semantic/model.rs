//! Getting the 34 MB model onto this machine, once, on purpose.
//!
//! The app ships without it. That is a deliberate trade: baking it in would
//! grow the AppImage from 84 MB to about 119 MB and the Mac zip from 10 MB to
//! 45 MB, for a feature not every writer will turn on.
//!
//! Three rules govern the download, and none of them is negotiable:
//!
//! * **It is a human click.** Opening Find never starts it. Putting 35 MB on
//!   someone's disk is a decision they make, the same way compile's output
//!   folder is a native dialog rather than an assumption.
//! * **Every byte is checked.** The files come from this repo's own
//!   `models-v1` release, and each one has to match a digest **compiled into
//!   this binary**. `SHA256SUMS.txt` is fetched and cross-checked too, but the
//!   pinned constant is the authority: a release someone else could edit is
//!   not something to trust a 34 MB executable graph to.
//! * **One downloader.** `fastembed`'s own Hugging Face fetcher is compiled
//!   out (see `Cargo.toml`), so this file and the updater are the only two
//!   things in the app that pull anything off the internet, and they share a
//!   transport.
//!
//! The files land in Tauri's `app_data_dir` — `~/.local/share/<bundle-id>/`
//! on Linux, `~/Library/Application Support/<bundle-id>/` on macOS — which the
//! AppImage overlay updater never touches, so updating the app never
//! re-downloads the model.

use std::path::{Path, PathBuf};

/// The release these files live on. Not a version tag of the app: the model
/// changes on its own schedule, and an app update must never re-download it.
pub const RELEASE_TAG: &str = "models-v1";
/// Where the files are. Built from the tag above so the two can never drift.
pub fn release_base() -> String {
    format!("https://github.com/stoneharborent/aquarius-writer/releases/download/{RELEASE_TAG}")
}

pub const MODEL_ID: &str = "BAAI/bge-small-en-v1.5";
pub const PUBLISHER: &str = "baai";
pub const MODEL_NAME: &str = "bge-small-en-v1.5";
/// What Settings and the download card say. MIT, and the writer should be able
/// to see that without leaving the app.
pub const MODEL_LICENCE: &str = "MIT";

/// One file of the model, and the digest this build insists on.
pub struct ModelFile {
    /// What it is called on the release.
    pub asset: &'static str,
    /// What it is called in the model folder — the name `fastembed` expects.
    pub local: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}

/// The five files, plus the licence notice, which is downloaded too: a model
/// on someone's disk should carry its own licence.
pub const FILES: [ModelFile; 6] = [
    ModelFile {
        asset: "bge-small-en-v1.5--model_quantized.onnx",
        local: "model_quantized.onnx",
        sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4",
        bytes: 34_014_426,
    },
    ModelFile {
        asset: "bge-small-en-v1.5--tokenizer.json",
        local: "tokenizer.json",
        sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
        bytes: 711_396,
    },
    ModelFile {
        asset: "bge-small-en-v1.5--config.json",
        local: "config.json",
        sha256: "fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350",
        bytes: 683,
    },
    ModelFile {
        asset: "bge-small-en-v1.5--special_tokens_map.json",
        local: "special_tokens_map.json",
        sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
        bytes: 125,
    },
    ModelFile {
        asset: "bge-small-en-v1.5--tokenizer_config.json",
        local: "tokenizer_config.json",
        sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
        bytes: 366,
    },
    ModelFile {
        asset: "bge-small-en-v1.5--LICENSE.txt",
        local: "LICENSE.txt",
        sha256: "085f6bea07cc31372aa9c2edd8f61300d1f9561f01d661addd1110eb148b07f5",
        bytes: 1_852,
    },
];

/// The digest of the graph itself — the thing the index is keyed on.
pub fn model_sha256() -> &'static str {
    FILES[0].sha256
}

/// `baai--bge-small-en-v1.5--6c9c6101a956`. A constant, because the digest is.
pub fn model_key() -> String {
    super::index::model_key(PUBLISHER, MODEL_NAME, model_sha256())
}

/// What the manifest records about the model that built an index.
pub fn descriptor() -> super::index::ModelDescriptor {
    super::index::ModelDescriptor {
        id: MODEL_ID.to_string(),
        file: FILES[0].local.to_string(),
        sha256: model_sha256().to_string(),
        dims: super::embed::DIMS,
        normalized: true,
        query_prefix: super::embed::QUERY_PREFIX.to_string(),
        extra: serde_json::Map::new(),
    }
}

/// Total download, in bytes — what the card turns into "35 MB".
pub fn download_bytes() -> u64 {
    FILES.iter().map(|f| f.bytes).sum()
}

/// Where the model lives on this machine.
pub fn model_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("models").join(model_key())
}

/// Is every file there, at the right length?
///
/// Length rather than digest, deliberately: this runs whenever the Find sheet
/// opens, and re-hashing 34 MB to answer "is it there" would be a visible
/// pause. The digest was checked when the file was written and it is checked
/// again by `verify_installed` when something looks wrong.
pub fn is_installed(app_data_dir: &Path) -> bool {
    let dir = model_dir(app_data_dir);
    FILES.iter().all(|f| {
        std::fs::metadata(dir.join(f.local)).map(|m| m.len() == f.bytes).unwrap_or(false)
    })
}

/// How much of the model is on disk, for the "Remove" row in Settings.
pub fn bytes_on_disk(app_data_dir: &Path) -> u64 {
    let dir = model_dir(app_data_dir);
    FILES
        .iter()
        .filter_map(|f| std::fs::metadata(dir.join(f.local)).ok())
        .map(|m| m.len())
        .sum()
}

/// Delete the model. The index that was built with it is left alone: it is
/// keyed on this model, so a later re-download finds its own vectors intact.
pub fn remove(app_data_dir: &Path) -> Result<(), String> {
    let dir = model_dir(app_data_dir);
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|e| format!("Could not remove the model folder ({e})."))
}

// ---------------------------------------------------------------------------
// The download
// ---------------------------------------------------------------------------

/// The three things the download needs from the outside world.
///
/// A trait so the whole verify-and-place path can be tested against a folder
/// of fixtures with no network in sight — the same reason `OverlayIo` exists,
/// and `updater::net::Network` satisfies both.
pub trait Fetcher {
    fn download_file(&self, url: &str, destination: &Path, on_progress: &dyn Fn(u8))
        -> Result<(), String>;
    fn fetch_text(&self, url: &str) -> Result<String, String>;
    fn hash_file(&self, path: &Path) -> Result<String, String>;
}

impl Fetcher for crate::updater::net::Network {
    fn download_file(
        &self,
        url: &str,
        destination: &Path,
        on_progress: &dyn Fn(u8),
    ) -> Result<(), String> {
        crate::updater::overlay::OverlayIo::download_file(self, url, destination, on_progress)
    }
    fn fetch_text(&self, url: &str) -> Result<String, String> {
        crate::updater::overlay::OverlayIo::fetch_text(self, url)
    }
    fn hash_file(&self, path: &Path) -> Result<String, String> {
        crate::updater::overlay::OverlayIo::hash_file(self, path)
    }
}

/// Download every file, check every one, and put them in place.
///
/// `on_progress` is called with 0–100 across the *whole* set, weighted by
/// size, so the bar moves smoothly rather than jumping five times.
///
/// Nothing is written into the model folder until a file has passed its check.
/// A failure halfway through therefore leaves a folder that `is_installed`
/// still says no to, which is the state the card knows how to draw.
pub fn download(
    io: &dyn Fetcher,
    app_data_dir: &Path,
    on_progress: &dyn Fn(u8),
) -> Result<(), String> {
    let dir = model_dir(app_data_dir);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not make a folder for the model ({e})."))?;

    // The release's own checksum file, used as a cross-check. If it disagrees
    // with what is compiled in, something is wrong on the release and the
    // download stops before a byte is trusted.
    let sums = io.fetch_text(&format!("{}/SHA256SUMS.txt", release_base()))?;
    let published = crate::updater::overlay::parse_sha256_sums(&sums);
    for file in FILES.iter() {
        if let Some(theirs) = published.get(file.asset) {
            if theirs != file.sha256 {
                return Err(format!(
                    "The published checksum for {} does not match the one this app was built with. \
                     Nothing was downloaded.",
                    file.asset
                ));
            }
        }
    }

    let total: u64 = download_bytes();
    let mut done: u64 = 0;
    for file in FILES.iter() {
        let temp = dir.join(format!(".aq-tmp-{}", file.local));
        let result = (|| -> Result<(), String> {
            let share = file.bytes;
            io.download_file(
                &format!("{}/{}", release_base(), file.asset),
                &temp,
                &|percent| {
                    let so_far = done + (share * percent as u64) / 100;
                    on_progress(((so_far.min(total) * 100) / total.max(1)) as u8);
                },
            )?;
            let actual = io.hash_file(&temp)?;
            if actual != file.sha256 {
                return Err(format!(
                    "{} did not download correctly — its fingerprint does not match. \
                     Nothing was installed.",
                    file.local
                ));
            }
            std::fs::rename(&temp, dir.join(file.local))
                .map_err(|e| format!("Could not put {} in place ({e}).", file.local))
        })();
        if let Err(e) = result {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
        done += file.bytes;
        on_progress(((done.min(total) * 100) / total.max(1)) as u8);
    }
    Ok(())
}

/// Re-hash what is on disk. Used when the model will not load — the honest
/// answer to "it was fine yesterday" is usually a half-written file.
pub fn verify_installed(io: &dyn Fetcher, app_data_dir: &Path) -> Result<(), String> {
    let dir = model_dir(app_data_dir);
    for file in FILES.iter() {
        let path = dir.join(file.local);
        if io.hash_file(&path)? != file.sha256 {
            return Err(format!("{} on this machine does not match the model it should be.", file.local));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// A `Fetcher` that serves bytes from a map instead of the internet.
    struct FakeNet {
        bodies: HashMap<String, Vec<u8>>,
        sums: String,
        calls: RefCell<Vec<String>>,
    }

    impl FakeNet {
        /// Every file correct, and a checksum manifest that agrees.
        fn honest() -> Self {
            let mut bodies = HashMap::new();
            let mut sums = String::new();
            for f in FILES.iter() {
                // Content whose digest is *claimed* to be f.sha256 — the fake
                // hashes by lookup, so the bytes themselves need only be the
                // right length.
                bodies.insert(f.asset.to_string(), vec![b'x'; f.bytes as usize]);
                sums.push_str(&format!("{}  ./{}\n", f.sha256, f.asset));
            }
            Self { bodies, sums, calls: RefCell::new(Vec::new()) }
        }
    }

    impl Fetcher for FakeNet {
        fn download_file(
            &self,
            url: &str,
            destination: &Path,
            on_progress: &dyn Fn(u8),
        ) -> Result<(), String> {
            self.calls.borrow_mut().push(url.to_string());
            let name = url.rsplit('/').next().unwrap_or_default();
            let body = self.bodies.get(name).ok_or_else(|| format!("404 {name}"))?;
            std::fs::write(destination, body).map_err(|e| e.to_string())?;
            on_progress(100);
            Ok(())
        }
        fn fetch_text(&self, _url: &str) -> Result<String, String> {
            Ok(self.sums.clone())
        }
        fn hash_file(&self, path: &Path) -> Result<String, String> {
            let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
            // Whichever file has this length is the one it claims to be.
            Ok(FILES
                .iter()
                .find(|f| f.bytes == len)
                .map(|f| f.sha256.to_string())
                // Anything of an unexpected length hashes to something that
                // matches nothing, which is what a corrupt download looks like.
                .unwrap_or_else(|| "de".repeat(32)))
        }
    }

    #[test]
    fn the_key_is_the_model_files_own_digest() {
        assert!(model_key().starts_with("baai--bge-small-en-v1.5--"));
        assert!(model_key().ends_with(&model_sha256()[..12]));
        assert_eq!(descriptor().sha256, model_sha256());
        assert_eq!(descriptor().dims, 384);
    }

    #[test]
    fn the_download_is_about_thirty_five_megabytes() {
        let mb = download_bytes() as f64 / 1_000_000.0;
        assert!((34.0..36.0).contains(&mb), "the card says 35 MB; it is {mb:.1}");
    }

    #[test]
    fn a_clean_download_installs_every_file_and_reports_progress_once_per_file() {
        let t = TempDir::new("model-ok");
        let net = FakeNet::honest();
        let seen = RefCell::new(Vec::new());
        download(&net, t.path(), &|p| seen.borrow_mut().push(p)).unwrap();

        assert!(is_installed(t.path()));
        assert_eq!(bytes_on_disk(t.path()), download_bytes());
        let dir = model_dir(t.path());
        for f in FILES.iter() {
            assert!(dir.join(f.local).exists(), "{} is missing", f.local);
        }
        let seen = seen.into_inner();
        assert_eq!(*seen.last().unwrap(), 100, "the bar reaches the end");
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "the bar never goes backwards");
    }

    #[test]
    fn a_file_that_does_not_match_its_fingerprint_installs_nothing() {
        let t = TempDir::new("model-bad");
        let mut net = FakeNet::honest();
        // The tokenizer arrives at the wrong length, so the fake hasher gives
        // it a digest belonging to some other file — a mismatch.
        net.bodies.insert(FILES[1].asset.to_string(), vec![b'x'; 99]);
        let err = download(&net, t.path(), &|_| {}).unwrap_err();
        assert!(err.contains("did not download correctly"), "got: {err}");
        assert!(!is_installed(t.path()));
        assert!(
            !model_dir(t.path()).join(FILES[1].local).exists(),
            "a failed file is never left behind under its real name"
        );
    }

    #[test]
    fn a_release_whose_checksums_disagree_with_this_build_is_refused() {
        let t = TempDir::new("model-tampered");
        let mut net = FakeNet::honest();
        net.sums = net
            .sums
            .replace(FILES[0].sha256, "0000000000000000000000000000000000000000000000000000000000000000");
        let err = download(&net, t.path(), &|_| {}).unwrap_err();
        assert!(err.contains("does not match the one this app was built with"), "got: {err}");
        assert!(net.calls.borrow().is_empty(), "not one byte was fetched");
    }

    #[test]
    fn removing_takes_the_folder_and_is_happy_to_be_asked_twice() {
        let t = TempDir::new("model-remove");
        download(&FakeNet::honest(), t.path(), &|_| {}).unwrap();
        assert!(is_installed(t.path()));
        remove(t.path()).unwrap();
        assert!(!is_installed(t.path()));
        assert_eq!(bytes_on_disk(t.path()), 0);
        remove(t.path()).unwrap();
    }

    /// The real download, against the real release, over the real network.
    ///
    /// Off unless `AQ_SEMANTIC_LIVE_DOWNLOAD=1`, because a test suite that
    /// pulls 35 MB every time it runs is a test suite people stop running.
    /// It is the one thing the fake above cannot prove: that the asset names
    /// on `models-v1` are the names this build asks for, and that the bytes
    /// GitHub serves are the bytes this build pinned.
    #[test]
    fn the_published_release_serves_exactly_what_this_build_expects() {
        if std::env::var_os("AQ_SEMANTIC_LIVE_DOWNLOAD").is_none() {
            eprintln!("skipped: set AQ_SEMANTIC_LIVE_DOWNLOAD=1 to fetch the real model");
            return;
        }
        let t = TempDir::new("model-live");
        download(&crate::updater::net::Network, t.path(), &|_| {}).unwrap();
        assert!(is_installed(t.path()));
        verify_installed(&crate::updater::net::Network, t.path()).unwrap();
    }

    #[test]
    fn a_truncated_file_on_disk_reads_as_not_installed() {
        let t = TempDir::new("model-truncated");
        download(&FakeNet::honest(), t.path(), &|_| {}).unwrap();
        std::fs::write(model_dir(t.path()).join(FILES[0].local), b"half").unwrap();
        assert!(!is_installed(t.path()), "a wrong-sized graph is not a model");
    }
}
