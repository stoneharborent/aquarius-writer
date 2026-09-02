//! `.aquarius/workflow.json` — reading it, and creating a sensible one for a
//! folder that has never been opened by Aquarius before (HANDOFF §3).
//!
//! Opening a folder must never feel like an import step. Point the app at any
//! folder of writing and it becomes a workflow: we infer a kind, find the
//! obvious manuscript folder, and write the metadata file. Nothing the writer
//! already had on disk is moved or rewritten.

use super::tree;
use crate::fs_ops::atomic::write_atomic;
use crate::model::{Draft, Manuscript, Workflow};
use std::fs;
use std::path::{Path, PathBuf};

/// Folder names that mean "this is the manuscript" in the wild.
const MANUSCRIPT_FOLDERS: &[&str] = &["Drafts", "Manuscript", "Chapters", "Draft", "Scenes"];

pub fn workflow_json_path(root: &Path) -> PathBuf {
    super::paths::aq_dir(root).join("workflow.json")
}

/// Read the workflow metadata, creating it with inferred defaults if absent.
///
/// Returns the workflow and whether it was newly created.
pub fn read_or_create(root: &Path) -> std::io::Result<(Workflow, bool)> {
    let path = workflow_json_path(root);
    if let Ok(text) = fs::read_to_string(&path) {
        match serde_json::from_str::<Workflow>(&text) {
            Ok(wf) => return Ok((wf, false)),
            Err(e) => {
                // A corrupt metadata file must not lock the writer out of their
                // own folder. Keep the broken one for forensics, start fresh.
                let backup = path.with_extension(format!("json.broken-{}", stamp()));
                let _ = fs::rename(&path, &backup);
                eprintln!("workflow.json unreadable ({e}); kept a copy at {}", backup.display());
            }
        }
    }
    let wf = infer(root);
    save(root, &wf)?;
    Ok((wf, true))
}

pub fn save(root: &Path, wf: &Workflow) -> std::io::Result<()> {
    let path = workflow_json_path(root);
    fs::create_dir_all(path.parent().unwrap())?;
    let json = serde_json::to_string_pretty(wf).map_err(std::io::Error::other)?;
    write_atomic(&path, format!("{json}\n").as_bytes())?;
    Ok(())
}

/// Build metadata for a folder we've never seen.
pub fn infer(root: &Path) -> Workflow {
    let title = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".into());

    let manuscript_folder = MANUSCRIPT_FOLDERS
        .iter()
        .find(|f| root.join(f).is_dir())
        .map(|f| f.to_string());

    let has_fountain = has_extension(root, "fountain", 2);
    let kind = if let Some(folder) = &manuscript_folder {
        let _ = folder;
        "novel"
    } else if has_fountain {
        "screenplay"
    } else {
        "notes"
    };

    let mut manuscripts = Vec::new();
    let mut drafts = Vec::new();
    if let Some(folder) = manuscript_folder {
        let order = tree::chapter_paths_in(root, &folder);
        manuscripts.push(Manuscript {
            id: new_id(),
            title: title.clone(),
            folder,
            chapter_order: order.clone(),
        });
        drafts.push(Draft {
            id: new_id(),
            name: "Working Draft".into(),
            active: Some(true),
            chapter_order: order,
            // Not folder-backed: this is the manuscript's own cut, and it
            // should keep following the manuscript rather than being pinned to
            // a folder of its own.
            folder: None,
        });
    }

    Workflow {
        id: new_id(),
        title,
        kind: kind.into(),
        drafts,
        manuscripts,
        settings: Default::default(),
        goals: Default::default(),
        extra: Default::default(),
    }
}

/// Bring chapter order back in line with what is actually on disk.
///
/// The writer's ordering is authoritative for files that still exist; files
/// deleted outside the app drop out, and new ones land at the end rather than
/// being silently invisible. Returns true when anything moved.
///
/// **A folder-backed draft is reconciled against its own folder.** Those
/// arrived with `toggle_draft_folder` (an alternate cut living in, say,
/// `Drafts/Second Pass/`), and their chapters are not in the manuscript
/// folder's listing at all — running them through the manuscript's pass would
/// see every one of their chapters as "gone from disk" and quietly replace the
/// alternate cut with the main one.
pub fn reconcile_chapter_order(root: &Path, wf: &mut Workflow) -> bool {
    let mut changed = false;
    for i in 0..wf.manuscripts.len() {
        let folder = wf.manuscripts[i].folder.clone();
        let on_disk = tree::chapter_paths_in(root, &folder);
        let next = merge_order(&wf.manuscripts[i].chapter_order, &on_disk);
        if next != wf.manuscripts[i].chapter_order {
            let old = wf.manuscripts[i].chapter_order.clone();
            wf.manuscripts[i].chapter_order = next.clone();
            changed = true;
            // Drafts that mirrored the manuscript order follow it; a draft the
            // writer has re-cut on its own keeps its own shape.
            for d in wf.drafts.iter_mut().filter(|d| d.folder.is_none()) {
                if d.chapter_order == old {
                    d.chapter_order = next.clone();
                } else {
                    let merged = merge_order(&d.chapter_order, &on_disk);
                    if merged != d.chapter_order {
                        d.chapter_order = merged;
                    }
                }
            }
        }
    }
    for d in wf.drafts.iter_mut() {
        let Some(folder) = d.folder.clone() else { continue };
        let merged = merge_order(&d.chapter_order, &tree::chapter_paths_in(root, &folder));
        if merged != d.chapter_order {
            d.chapter_order = merged;
            changed = true;
        }
    }
    changed
}

/// Keep `current`'s order for anything still present, then append newcomers.
fn merge_order(current: &[String], on_disk: &[String]) -> Vec<String> {
    let mut out: Vec<String> = current.iter().filter(|p| on_disk.contains(p)).cloned().collect();
    for p in on_disk {
        if !out.contains(p) {
            out.push(p.clone());
        }
    }
    out
}

fn has_extension(root: &Path, ext: &str, depth: usize) -> bool {
    let Ok(entries) = fs::read_dir(root) else { return false };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(ft) = entry.file_type() else { continue };
        if super::paths::skip_entry_in(root, &name, ft.is_dir()) {
            continue;
        }
        if ft.is_file() && name.to_lowercase().ends_with(&format!(".{ext}")) {
            return true;
        }
        if ft.is_dir() && depth > 0 && has_extension(&entry.path(), ext, depth - 1) {
            return true;
        }
    }
    false
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn stamp() -> String {
    chrono::Local::now().format("%Y%m%dT%H%M%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn creates_workflow_json_for_a_plain_folder_of_notes() {
        let t = TempDir::new("wf-notes");
        t.write("Ideas.md", "one");
        let (wf, created) = read_or_create(t.path()).unwrap();
        assert!(created);
        assert_eq!(wf.kind, "notes");
        assert!(wf.manuscripts.is_empty());
        assert_eq!(wf.settings.theme, "parchment");
        assert_eq!(wf.settings.font_size, 17);
        assert_eq!(wf.goals.daily_words, 1000);
        assert!(workflow_json_path(t.path()).exists());
    }

    #[test]
    fn infers_a_novel_from_a_drafts_folder_and_seeds_the_chapter_order() {
        let t = TempDir::new("wf-novel");
        t.write("Drafts/Ch_01.md", "a");
        t.write("Drafts/Ch_02.md", "b");
        t.write("Characters/Imogen.md", "c");
        let (wf, _) = read_or_create(t.path()).unwrap();
        assert_eq!(wf.kind, "novel");
        assert_eq!(wf.manuscripts.len(), 1);
        assert_eq!(wf.manuscripts[0].folder, "Drafts");
        assert_eq!(wf.manuscripts[0].chapter_order, vec!["Drafts/Ch_01.md", "Drafts/Ch_02.md"]);
        assert_eq!(wf.drafts[0].active, Some(true));
    }

    #[test]
    fn infers_a_screenplay_from_fountain_files() {
        let t = TempDir::new("wf-screenplay");
        t.write("Episodes/Pilot.fountain", "INT.");
        let (wf, _) = read_or_create(t.path()).unwrap();
        assert_eq!(wf.kind, "screenplay");
    }

    #[test]
    fn reads_back_what_it_wrote_including_unknown_keys() {
        let t = TempDir::new("wf-roundtrip");
        t.write("Drafts/Ch_01.md", "a");
        let (mut wf, _) = read_or_create(t.path()).unwrap();
        wf.extra.insert("futureThing".into(), serde_json::json!({ "x": 1 }));
        wf.title = "Lantern, Lantern".into();
        save(t.path(), &wf).unwrap();

        let (again, created) = read_or_create(t.path()).unwrap();
        assert!(!created, "an existing workflow.json is read, not replaced");
        assert_eq!(again.id, wf.id, "the id is stable across opens");
        assert_eq!(again.title, "Lantern, Lantern");
        assert_eq!(again.extra.get("futureThing").unwrap(), &serde_json::json!({ "x": 1 }));
    }

    #[test]
    fn a_corrupt_workflow_json_is_replaced_not_fatal() {
        let t = TempDir::new("wf-corrupt");
        t.write(".aquarius/workflow.json", "{ this is not json");
        let (wf, created) = read_or_create(t.path()).unwrap();
        assert!(created);
        assert!(!wf.id.is_empty());
        let broken: Vec<_> = fs::read_dir(t.path().join(".aquarius"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains("broken"))
            .collect();
        assert_eq!(broken.len(), 1, "the unreadable file is kept for forensics");
    }

    #[test]
    fn reconciles_chapter_order_with_the_disk() {
        let t = TempDir::new("wf-reconcile");
        t.write("Drafts/Ch_01.md", "a");
        t.write("Drafts/Ch_02.md", "b");
        let (mut wf, _) = read_or_create(t.path()).unwrap();

        // The writer re-orders, then adds one file and deletes another outside
        // the app.
        wf.manuscripts[0].chapter_order = vec!["Drafts/Ch_02.md".into(), "Drafts/Ch_01.md".into()];
        wf.drafts[0].chapter_order = wf.manuscripts[0].chapter_order.clone();
        fs::remove_file(t.path().join("Drafts/Ch_01.md")).unwrap();
        t.write("Drafts/Ch_03.md", "c");

        assert!(reconcile_chapter_order(t.path(), &mut wf));
        assert_eq!(
            wf.manuscripts[0].chapter_order,
            vec!["Drafts/Ch_02.md", "Drafts/Ch_03.md"],
            "existing order is kept, the deleted file drops, the new one appends"
        );
        assert_eq!(wf.drafts[0].chapter_order, wf.manuscripts[0].chapter_order);
        assert!(!reconcile_chapter_order(t.path(), &mut wf), "second pass is a no-op");
    }
}
