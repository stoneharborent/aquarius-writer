//! A three-line temp directory, so the tests don't need a dev-dependency.

#![cfg(test)]

use std::path::{Path, PathBuf};

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "aquarius-writer-test-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// Write a file (creating parents) inside the temp dir.
    pub fn write(&self, rel: &str, contents: &str) -> PathBuf {
        let p = self.0.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).expect("create parents");
        }
        std::fs::write(&p, contents).expect("write fixture");
        p
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
