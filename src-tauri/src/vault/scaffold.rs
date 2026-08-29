//! Making a workflow folder that does not exist yet.
//!
//! Until v0.1.1 the welcome screen's "Create new" and "Try the sample" cards
//! had nothing behind them at all — the renderer's `VaultService` could open a
//! folder and nothing else (docs/NOTES.md §8). This module is the missing
//! half: it lays out a folder on disk, then writes `.aquarius/workflow.json`
//! for it so the chosen kind sticks instead of being re-guessed.
//!
//! Everything here takes plain paths and returns plain errors, so `cargo test`
//! can drive it against a `TempDir` with no app running — same rule as
//! `vault::ops`.

use crate::model::Workflow;
use crate::vault::workflow;
use std::fs;
use std::path::{Path, PathBuf};

pub type ScaffoldResult<T> = Result<T, String>;

/// What the sample workflow's folder is called, wherever it is put.
pub const SAMPLE_FOLDER_NAME: &str = "Lantern, Lantern";

/// The kinds "Create new" offers. `workflow::infer` can only ever answer
/// novel / screenplay / notes from the shape of a folder, so "worldbuilding"
/// exists here and is written into `workflow.json` explicitly.
pub const WORKFLOW_KINDS: &[&str] = &["novel", "screenplay", "worldbuilding", "notes"];

/// Check a name the writer typed before it becomes a folder.
///
/// Deliberately strict: this string is joined onto a folder the writer picked,
/// so a separator or a `..` in it would put the new workflow somewhere they did
/// not choose. Trailing dots and spaces are trimmed because Windows silently
/// drops them and the folder would then not be the one we reported.
pub fn validate_name(raw: &str) -> ScaffoldResult<String> {
    let name = raw.trim().trim_end_matches([' ', '.']).to_string();
    if name.is_empty() {
        return Err("give the workflow a name".into());
    }
    if name.len() > 120 {
        return Err("that name is too long — keep it under 120 characters".into());
    }
    if name.starts_with('.') {
        return Err("a name starting with \".\" would make a hidden folder".into());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("a name cannot contain \"/\" or \"\\\" — it is one folder, not a path".into());
    }
    if name.contains("..") {
        return Err("a name cannot contain \"..\"".into());
    }
    if let Some(bad) = name.chars().find(|c| ":*?\"<>|".contains(*c) || c.is_control()) {
        return Err(format!("a name cannot contain \"{bad}\""));
    }
    Ok(name)
}

fn check_kind(kind: &str) -> ScaffoldResult<&str> {
    WORKFLOW_KINDS
        .iter()
        .find(|k| **k == kind)
        .copied()
        .ok_or_else(|| format!("unknown workflow kind \"{kind}\" — expected one of {}", WORKFLOW_KINDS.join(", ")))
}

/// Create a new workflow folder inside `parent` and return its root.
///
/// Refuses to write into a folder that already exists: a new workflow is a new
/// folder, and quietly merging into somebody's existing one is the kind of
/// surprise a writer only forgives once.
pub fn create_workflow(parent: &Path, raw_name: &str, kind: &str) -> ScaffoldResult<PathBuf> {
    let kind = check_kind(kind)?;
    let name = validate_name(raw_name)?;
    if !parent.is_dir() {
        return Err(format!("not a folder: {}", parent.display()));
    }
    let root = parent.join(&name);
    if root.exists() {
        return Err(format!("\"{name}\" already exists in that folder — pick another name"));
    }
    fs::create_dir(&root).map_err(|e| format!("could not create {}: {e}", root.display()))?;
    lay_out(&root, &name, kind)?;
    write_metadata(&root, &name, kind)?;
    Ok(root)
}

/// Materialise the sample workflow inside `parent`, or return the one already
/// there. Opening the sample twice must not fail and must not duplicate it.
pub fn create_sample(parent: &Path) -> ScaffoldResult<PathBuf> {
    fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    let root = parent.join(SAMPLE_FOLDER_NAME);
    let existed = root.exists();
    fs::create_dir_all(&root).map_err(|e| format!("could not create {}: {e}", root.display()))?;
    // Files are only ever added, never replaced: someone who wrote in the
    // sample keeps what they wrote.
    for (rel, body) in SAMPLE_FILES {
        write_if_absent(&root, rel, body)?;
    }
    if !existed {
        write_metadata(&root, SAMPLE_FOLDER_NAME, "novel")?;
    }
    Ok(root)
}

/// Folders and starter files for each kind.
fn lay_out(root: &Path, name: &str, kind: &str) -> ScaffoldResult<()> {
    match kind {
        "novel" => {
            for f in ["Drafts", "Characters", "Worldbuilding", "Research"] {
                make_dir(root, f)?;
            }
            write_if_absent(
                root,
                "Drafts/Chapter One.md",
                &format!("---\ntitle: Chapter One\nstatus: outline\n---\n\n# Chapter One\n\n{name} starts here.\n"),
            )?;
        }
        "screenplay" => {
            for f in ["Episodes", "Characters", "Research"] {
                make_dir(root, f)?;
            }
            write_if_absent(
                root,
                &format!("Episodes/{name}.fountain"),
                &format!(
                    "Title: {name}\nCredit: Written by\nAuthor: \nDraft date: \n\nFADE IN:\n\nINT. SOMEWHERE — DAY\n\nWrite here.\n\nFADE OUT.\n"
                ),
            )?;
        }
        "worldbuilding" => {
            for f in ["Characters", "Places", "History", "Research"] {
                make_dir(root, f)?;
            }
            write_if_absent(
                root,
                "Index.md",
                &format!("---\ntitle: {name}\n---\n\n# {name}\n\nStart with a place or a person, and link outward with [[wikilinks]].\n"),
            )?;
        }
        // "notes"
        _ => {
            write_if_absent(
                root,
                "Notes.md",
                &format!("---\ntitle: {name}\n---\n\n# {name}\n\n"),
            )?;
        }
    }
    Ok(())
}

/// Write `.aquarius/workflow.json` with the kind the writer actually chose.
///
/// `workflow::infer` reads the folder to guess a kind, which is right for a
/// folder we have never seen and wrong here — a brand-new worldbuilding
/// workflow looks exactly like a pile of notes on disk. So we infer (to pick up
/// the manuscript folder and chapter order) and then overwrite the two fields
/// we actually know.
fn write_metadata(root: &Path, name: &str, kind: &str) -> ScaffoldResult<()> {
    let mut wf: Workflow = workflow::infer(root);
    wf.title = name.to_string();
    wf.kind = kind.to_string();
    workflow::save(root, &wf).map_err(|e| format!("could not write workflow.json: {e}"))
}

fn make_dir(root: &Path, rel: &str) -> ScaffoldResult<()> {
    let path = root.join(rel);
    fs::create_dir_all(&path).map_err(|e| format!("could not create {}: {e}", path.display()))
}

fn write_if_absent(root: &Path, rel: &str, body: &str) -> ScaffoldResult<()> {
    let path = root.join(rel);
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    fs::write(&path, body).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// The sample vault — the same "Lantern, Lantern" fixture the browser preview
/// has always shown (`src/lib/vault/browser-service.ts`), written to disk as
/// real Markdown and Fountain so it behaves like any other workflow.
const SAMPLE_FILES: &[(&str, &str)] = &[
    (
        "Drafts/Ch_01.md",
        "---\ntitle: A Door of Letters\nstatus: final\n---\n\n\
         [[Imogen]] arrived at the lighthouse on a wet October morning. [[Old Sennet]] met her at the dock — not what she expected.\n",
    ),
    (
        "Drafts/Ch_02.md",
        "---\ntitle: The Bell Ringer's Vow\nstatus: final\n---\n\n\
         Routines of [[Helmreach]]: bread, log, salt. [[Old Sennet]] teaches her the names of the rocks.\n",
    ),
    (
        "Drafts/Ch_03.md",
        "---\ntitle: Helmreach in Rain\nstatus: drafting\n---\n\n\
         The city of [[Helmreach]] wore the rain like a coat too large for it. [[Imogen]] arrives at the cathedral square wet through, with a letter folded in three. The letter is from [[The Bell Ringer]].\n",
    ),
    (
        "Drafts/Ch_04.md",
        "---\ntitle: The Long Echo\nstatus: outline\n---\n\n\
         - arrival at the cathedral in [[Helmreach]]\n- the third bell rings out of order\n- [[The Bell Ringer]] refuses to say [[Old Sennet]]'s name\n",
    ),
    (
        "Characters/Imogen.md",
        "---\ntitle: Imogen\n---\n\n# Imogen\n\n\
         Niece of [[Old Sennet]]. Arrived at the lighthouse in [[Helmreach]] in October. Carries fifty-three letters from her grandfather.\n\n\
         ## Voice\n\nQuiet, observant. Will not be hurried. Tells the truth slant.\n\n\
         ## Arc\n\nLearns the names of the rocks; learns the cost of [[The Order of Lamps]].\n",
    ),
    (
        "Characters/Old Sennet.md",
        "---\ntitle: Old Sennet\n---\n\n# Old Sennet\n\n\
         Lighthouse keeper at [[Helmreach]]. Older than the daughter remembers. Stops correcting [[Imogen]]'s pronunciation in winter — first sign something is wrong.\n",
    ),
    (
        "Characters/The Bell Ringer.md",
        "---\ntitle: The Bell Ringer\n---\n\n# The Bell Ringer\n\n\
         Knows [[Old Sennet]] by his first name — which no one else does. Refuses to call out a trawler in trouble. Counts the wakes.\n",
    ),
    (
        "Worldbuilding/Helmreach.md",
        "---\ntitle: Helmreach\n---\n\n# Helmreach\n\n\
         A port city. Twelve bells across the bay. Home to [[The Order of Lamps]]. The lighthouse where [[Old Sennet]] and [[Imogen]] live sits on the cape, three miles north.\n",
    ),
    (
        "Worldbuilding/Order of Lamps.md",
        "---\ntitle: The Order of Lamps\n---\n\n# The Order of Lamps\n\n\
         The society that keeps the [[Helmreach]] lights lit. [[Old Sennet]] is the senior keeper but rarely attends. They keep score.\n",
    ),
    (
        "Episodes/Pilot — Cold Open.fountain",
        "Title: The Long Echo\nCredit: Written by\nAuthor: Imogen Vale\nSource: Based on \"Lantern, Lantern\"\n\n\
         INT. LIGHTHOUSE GALLERY — NIGHT\n\n\
         Wind. The lamp turns. SENNET stands at the rail, watching the bay. Boots wet. He is sixty-eight years old and looks every year of it tonight.\n\n\
         MARIN (O.S.)\nSennet?\n\n\
         He doesn't turn.\n\n\
         SENNET\nTwelve bells. You hear them?\n\n\
         MARIN steps into the gallery, oilskin dripping. Half his age and a head shorter. She listens.\n\n\
         MARIN\nI count seven.\n\n\
         SENNET\nSeven across the bay. Five from the cathedral. That's twelve.\n\n\
         He finally looks at her. The lamp passes between them — face, dark, face, dark.\n\n\
         SENNET (CONT'D)\nA trawler is in trouble out there.\n\n\
         MARIN\nThen call it in.\n\n\
         A long beat. The lamp turns.\n\n\
         SENNET\nNo.\n\n\
         CUT TO:\n\n\
         EXT. HEADLAND — CONTINUOUS\n\n\
         The lighthouse from below — small against the storm. The third bell, somewhere in the dark, rings out of order.\n\n\
         FADE OUT.\n",
    ),
    (
        "README.md",
        "---\ntitle: About this sample\n---\n\n# Lantern, Lantern\n\n\
         This is a sample workflow Aquarius Writer made for you. Everything in it is an\n\
         ordinary file in an ordinary folder — open them in any other app, back them up,\n\
         or delete the whole folder when you are done. Nothing else on your machine\n\
         changes when you do.\n\n\
         The one folder that is ours is `.aquarius/`, which holds this workflow's\n\
         settings and its version history.\n",
    ),
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn refuses_names_that_would_escape_the_chosen_folder() {
        assert!(validate_name("").is_err());
        assert!(validate_name("   ").is_err());
        assert!(validate_name("../elsewhere").is_err());
        assert!(validate_name("Drafts/Ch_01").is_err());
        assert!(validate_name("back\\slash").is_err());
        assert!(validate_name(".hidden").is_err());
        assert!(validate_name("what?").is_err());
        assert_eq!(validate_name("  Lantern, Lantern  ").unwrap(), "Lantern, Lantern");
        assert_eq!(validate_name("Trailing dots...").unwrap(), "Trailing dots");
    }

    #[test]
    fn creates_a_novel_with_the_kind_the_writer_chose() {
        let t = TempDir::new("scaffold-novel");
        let root = create_workflow(t.path(), "Lantern", "novel").unwrap();
        assert!(root.join("Drafts/Chapter One.md").is_file());
        assert!(root.join("Characters").is_dir());
        let (wf, created) = workflow::read_or_create(&root).unwrap();
        assert!(!created, "the scaffold wrote workflow.json itself");
        assert_eq!(wf.kind, "novel");
        assert_eq!(wf.title, "Lantern");
        assert_eq!(wf.manuscripts[0].folder, "Drafts");
        assert_eq!(wf.manuscripts[0].chapter_order, vec!["Drafts/Chapter One.md"]);
    }

    #[test]
    fn worldbuilding_survives_the_kind_inference_that_would_call_it_notes() {
        let t = TempDir::new("scaffold-world");
        let root = create_workflow(t.path(), "Helmreach", "worldbuilding").unwrap();
        assert!(root.join("Index.md").is_file());
        let (wf, _) = workflow::read_or_create(&root).unwrap();
        assert_eq!(wf.kind, "worldbuilding", "infer() would have said \"notes\"");
    }

    #[test]
    fn a_screenplay_gets_a_fountain_file_named_after_it() {
        let t = TempDir::new("scaffold-screenplay");
        let root = create_workflow(t.path(), "The Long Echo", "screenplay").unwrap();
        assert!(root.join("Episodes/The Long Echo.fountain").is_file());
        let (wf, _) = workflow::read_or_create(&root).unwrap();
        assert_eq!(wf.kind, "screenplay");
    }

    #[test]
    fn refuses_an_existing_folder_and_an_unknown_kind() {
        let t = TempDir::new("scaffold-guards");
        create_workflow(t.path(), "Twice", "notes").unwrap();
        let again = create_workflow(t.path(), "Twice", "notes").unwrap_err();
        assert!(again.contains("already exists"), "got {again}");
        assert!(create_workflow(t.path(), "Fine", "poem").is_err());
    }

    #[test]
    fn the_sample_is_a_real_vault_and_opening_it_twice_is_harmless() {
        let t = TempDir::new("scaffold-sample");
        let root = create_sample(t.path()).unwrap();
        assert_eq!(root.file_name().unwrap(), SAMPLE_FOLDER_NAME);
        assert!(root.join("Drafts/Ch_01.md").is_file());
        assert!(root.join("Episodes/Pilot — Cold Open.fountain").is_file());

        let (wf, created) = workflow::read_or_create(&root).unwrap();
        assert!(!created);
        assert_eq!(wf.kind, "novel");
        assert_eq!(wf.manuscripts[0].chapter_order.len(), 4);

        // A second run must not fail, must not duplicate, and must not stamp on
        // work the writer did inside the sample.
        std::fs::write(root.join("Drafts/Ch_01.md"), "mine now").unwrap();
        let again = create_sample(t.path()).unwrap();
        assert_eq!(again, root);
        assert_eq!(std::fs::read_to_string(root.join("Drafts/Ch_01.md")).unwrap(), "mine now");
    }
}
