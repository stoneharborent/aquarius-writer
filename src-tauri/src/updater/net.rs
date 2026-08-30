//! The parts of an update that touch the outside world.
//!
//! Downloading, checksumming and unpacking, kept in one small file behind the
//! `OverlayIo` trait so everything *else* about updating can be tested against
//! temporary directories with no network in sight.
//!
//! HTTP is `ureq`: a blocking client with a rustls TLS stack built in, so
//! nothing here needs OpenSSL on the build machine and nothing here needs an
//! async runtime. Every call it makes happens on a background thread — see
//! `super::run_in_background`.

use super::overlay::{OverlayIo, LATEST_RELEASE_API};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;
use std::time::Duration;

/// GitHub's API refuses requests that do not identify themselves. This is what
/// shows up in their logs, and it is how a rate-limit complaint gets traced
/// back to this app.
const USER_AGENT: &str = concat!("AquariusWriter/", env!("CARGO_PKG_VERSION"), " (+https://github.com/stoneharborent/aquarius-writer)");

/// Long enough for a slow connection to finish a ~100 MB download, short enough
/// that a wedged connection eventually gives up instead of hanging the panel.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(45 * 60);
/// A checksum file and a JSON reply are tiny; neither has an excuse to be slow.
const SMALL_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The real implementation of everything `overlay::install_update` needs.
pub struct Network;

impl Network {
    fn agent(timeout: Duration) -> ureq::Agent {
        ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .user_agent(USER_AGENT)
            .build()
            .into()
    }
}

/// Ask GitHub what the newest release is, and answer with its tag.
///
/// Every failure becomes a sentence a person can act on. A failed update check
/// is a nuisance, never a crash: there is nothing wrong with the app when
/// GitHub is unreachable, and the message should say so.
pub fn latest_release_tag() -> Result<String, String> {
    let body = get_text(LATEST_RELEASE_API, SMALL_REQUEST_TIMEOUT)
        .map_err(|e| describe_check_failure(&e))?;
    super::overlay::tag_from_release_json(&body)
}

fn get_text(url: &str, timeout: Duration) -> Result<String, ureq::Error> {
    Network::agent(timeout).get(url).call()?.into_body().read_to_string()
}

/// Turns a transport failure into something worth putting on screen.
fn describe_check_failure(error: &ureq::Error) -> String {
    if let ureq::Error::StatusCode(code) = error {
        return match code {
            // GitHub answers an over-eager unauthenticated client with 403 or
            // 429 and a rate-limit header. Both mean "later", not "broken".
            403 | 429 => "GitHub is asking us to check less often. Try again in a few minutes."
                .to_string(),
            404 => "There are no published releases to check against yet.".to_string(),
            other => format!("GitHub answered {other}. Try again in a few minutes."),
        };
    }
    "Could not reach GitHub. Check your internet connection and try again.".to_string()
}

impl OverlayIo for Network {
    fn download_file(
        &self,
        url: &str,
        destination: &Path,
        on_progress: &dyn Fn(u8),
    ) -> Result<(), String> {
        let response = Network::agent(DOWNLOAD_TIMEOUT)
            .get(url)
            .call()
            .map_err(|e| format!("The download did not start. {}", describe_check_failure(&e)))?;

        // Read the size before the body is consumed. Without it there is no
        // percentage to report, which is a worse progress bar but not a failure.
        let total: u64 = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        let mut reader = response.into_body().into_reader();
        let mut file = std::fs::File::create(destination)
            .map_err(|e| format!("could not open the download file: {e}"))?;

        let mut buffer = vec![0u8; 128 * 1024];
        let mut received: u64 = 0;
        // Only whole-percent changes are forwarded: every one of them redraws
        // the Settings panel, and 100 redraws is plenty for a progress bar.
        let mut last_reported: i16 = -1;
        loop {
            let n = reader.read(&mut buffer).map_err(|e| format!("the download stopped: {e}"))?;
            if n == 0 {
                break;
            }
            std::io::Write::write_all(&mut file, &buffer[..n])
                .map_err(|e| format!("could not write the download to disk: {e}"))?;
            received += n as u64;
            if total > 0 {
                let percent = ((received.min(total) * 100) / total) as i16;
                if percent != last_reported {
                    last_reported = percent;
                    on_progress(percent as u8);
                }
            }
        }
        std::io::Write::flush(&mut file).map_err(|e| format!("could not finish the download: {e}"))?;
        Ok(())
    }

    fn fetch_text(&self, url: &str) -> Result<String, String> {
        get_text(url, SMALL_REQUEST_TIMEOUT).map_err(|e| {
            format!("Could not fetch the checksum file. {}", describe_check_failure(&e))
        })
    }

    fn hash_file(&self, path: &Path) -> Result<String, String> {
        let mut file = std::fs::File::open(path)
            .map_err(|e| format!("could not re-open the download to check it: {e}"))?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 128 * 1024];
        loop {
            let n = file.read(&mut buffer).map_err(|e| format!("could not read the download: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    }

    fn extract_appimage(&self, appimage: &Path, work_dir: &Path) -> Result<(), String> {
        // Every AppImage can unpack itself with this flag, and doing it that way
        // needs no FUSE — which an unprivileged AquariusOS session cannot be
        // assumed to have. It leaves a `squashfs-root/` folder in `work_dir`.
        let status = std::process::Command::new(appimage)
            .arg("--appimage-extract")
            .current_dir(work_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| format!("could not unpack the download: {e}"))?;
        if !status.success() {
            return Err(format!(
                "The download would not unpack (the unpacker exited with {}).",
                status.code().map(|c| c.to_string()).unwrap_or_else(|| "no code".into())
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn the_user_agent_names_this_app_and_its_version() {
        // GitHub rejects an anonymous client outright, so this is not cosmetic.
        assert!(USER_AGENT.starts_with("AquariusWriter/"));
        assert!(USER_AGENT.contains(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn hashing_agrees_with_sha256sum() {
        let t = TempDir::new("hash");
        let path = t.write("payload.bin", "abc");
        // The published SHA-256 of the three bytes "abc".
        assert_eq!(
            Network.hash_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
