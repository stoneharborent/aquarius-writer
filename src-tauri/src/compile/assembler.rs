//! The pure half of Compile: turning a selection of documents into one string.
//!
//! Nothing here touches pandoc, spawns a process, or writes an output file. It
//! resolves a selection against `workflow.json`, reads the chapters in the
//! order the writer put them in, applies the include options, and hands back a
//! single document plus a note of anything it could not find. That is the
//! Swift app's `ManuscriptAssembler`, and it is pure for the same reason: it is
//! the part with all the ordering rules in it, so it is the part worth testing
//! without a toolchain installed.
//!
//! Two conventions:
//!
//! * A **missing chapter is not fatal.** A file that was deleted outside the
//!   app drops out of the compile and is reported in `missing`, because a
//!   writer pressing Compile at 2am wants the other nineteen chapters. Only an
//!   empty result is an error, and that error is raised by the caller.
//! * The assembled text is **markdown**, because pandoc's markdown reader is
//!   what every downstream format goes through. Fountain sources are escaped
//!   into markdown for that path and left completely alone for the `.fountain`
//!   round-trip.

use super::CompileError;
use crate::model::Workflow;
use crate::vault::{frontmatter, paths};
use std::path::Path;

/// Where the text comes from.
#[derive(serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    /// A manuscript's chapters, in the order `workflow.json` records. An
    /// explicit `draftId` uses that draft's cut instead of the manuscript's.
    Manuscript {
        #[serde(default)]
        manuscript_id: Option<String>,
        #[serde(default)]
        draft_id: Option<String>,
    },
    /// One document — a note, or a screenplay file.
    Document { path: String },
}

/// The include options, per kind. Every one mirrors a checkbox in the Swift
/// app's Contents column; the defaults come from the chosen profile.
#[derive(Clone, Debug, PartialEq)]
pub struct AssembleOptions {
    /// Drop the YAML block at the top of each chapter. On by default: a reader
    /// should not see `status: drafting`.
    pub strip_frontmatter: bool,
    /// Put a `# Chapter title` above each chapter — the frontmatter `title`
    /// when there is one, otherwise the file name.
    pub chapter_headings: bool,
    /// Separate chapters with `\newpage`, which is what makes a PDF start each
    /// chapter on a fresh page. (EPUB and DOCX ignore it; their chapter breaks
    /// come from the headings.)
    pub page_breaks: bool,
    /// Separate chapters with a horizontal rule instead. Markdown profiles use
    /// this; it is ignored when `page_breaks` is on.
    pub rules_between: bool,
    /// Emit a YAML title block at the very top (title + author).
    pub title_block: bool,
    /// Fountain only: keep the `Title: / Credit: / Author:` block at the top of
    /// the file. Off strips it.
    pub title_page: bool,
    /// Fountain only: drop `[[notes]]` and `/* boneyards */`.
    pub strip_notes: bool,
    /// Fountain only: keep `#1#` scene numbers on scene headings.
    pub scene_numbers: bool,
    /// Escape markdown-significant characters, so fountain text survives
    /// pandoc's markdown reader as the literal lines the writer typed.
    pub escape_markdown: bool,
}

impl Default for AssembleOptions {
    fn default() -> Self {
        Self {
            strip_frontmatter: true,
            chapter_headings: true,
            page_breaks: true,
            rules_between: false,
            title_block: false,
            title_page: true,
            strip_notes: false,
            scene_numbers: true,
            escape_markdown: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Chapter {
    /// Vault-relative path it came from.
    pub path: String,
    /// What a `# heading` for it would say.
    pub title: String,
    /// The text after the include options were applied.
    pub body: String,
    pub words: usize,
}

/// The vault-relative chapter paths a source resolves to, in order.
///
/// This is where "persisted order" actually means something: the list comes
/// from `workflow.json`, not from a directory listing, so a manuscript the
/// writer re-cut compiles in the shape they left it in.
pub fn resolve(wf: &Workflow, source: &Source) -> Result<Vec<String>, CompileError> {
    match source {
        Source::Document { path } => {
            if path.trim().is_empty() {
                return Err(CompileError::bad_request("no document was chosen to compile"));
            }
            Ok(vec![path.clone()])
        }
        Source::Manuscript { manuscript_id, draft_id } => {
            if let Some(id) = draft_id {
                let draft = wf
                    .drafts
                    .iter()
                    .find(|d| &d.id == id)
                    .ok_or_else(|| CompileError::bad_request(format!("no draft with id {id}")))?;
                return Ok(draft.chapter_order.clone());
            }
            let manuscript = match manuscript_id {
                Some(id) => wf
                    .manuscripts
                    .iter()
                    .find(|m| &m.id == id)
                    .ok_or_else(|| {
                        CompileError::bad_request(format!("no manuscript with id {id}"))
                    })?,
                None => wf.manuscripts.first().ok_or_else(|| {
                    CompileError::bad_request(
                        "this workflow has no manuscript — choose a document to compile instead",
                    )
                })?,
            };
            Ok(manuscript.chapter_order.clone())
        }
    }
}

/// The title a compiled document should carry.
pub fn title_for(wf: &Workflow, source: &Source, paths_in: &[String]) -> String {
    match source {
        Source::Manuscript { manuscript_id, .. } => {
            let m = match manuscript_id {
                Some(id) => wf.manuscripts.iter().find(|m| &m.id == id),
                None => wf.manuscripts.first(),
            };
            m.map(|m| m.title.clone()).unwrap_or_else(|| wf.title.clone())
        }
        Source::Document { path } => {
            let _ = paths_in;
            stem_of(path)
        }
    }
}

/// Read the chapters that exist, in order, applying the include options.
pub fn read_chapters(
    root: &Path,
    order: &[String],
    opts: &AssembleOptions,
) -> (Vec<Chapter>, Vec<String>) {
    let mut chapters = Vec::new();
    let mut missing = Vec::new();
    for rel in order {
        let Ok(abs) = paths::resolve_in_root(root, rel) else {
            missing.push(rel.clone());
            continue;
        };
        let Ok(raw) = std::fs::read_to_string(&abs) else {
            missing.push(rel.clone());
            continue;
        };
        chapters.push(prepare(rel, &raw, opts));
    }
    (chapters, missing)
}

/// One chapter's text, with the include options applied. Pure — this is the
/// function the tests hammer.
pub fn prepare(rel: &str, raw: &str, opts: &AssembleOptions) -> Chapter {
    let parsed = frontmatter::parse(raw);
    let title = parsed
        .frontmatter
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| stem_of(rel));

    let mut body = if opts.strip_frontmatter { parsed.body } else { raw.to_string() };

    if is_fountain(rel) {
        if opts.strip_notes {
            body = strip_boneyards(&body);
            body = strip_inline_notes(&body);
        }
        if !opts.scene_numbers {
            body = strip_scene_numbers(&body);
        }
        if !opts.title_page {
            body = strip_title_page(&body);
        }
    }
    if opts.escape_markdown {
        body = escape_markdown(&body);
    }

    let words = frontmatter::count_words(&body);
    Chapter { path: rel.to_string(), title, body: body.trim_matches('\n').to_string(), words }
}

/// Glue the chapters into one document.
pub fn assemble(
    title: &str,
    author: Option<&str>,
    chapters: &[Chapter],
    opts: &AssembleOptions,
) -> String {
    let mut out = String::new();

    if opts.title_block {
        out.push_str("---\n");
        out.push_str(&format!("title: {}\n", yaml_scalar(title)));
        if let Some(a) = author.filter(|a| !a.trim().is_empty()) {
            out.push_str(&format!("author: {}\n", yaml_scalar(a)));
        }
        out.push_str("---\n\n");
    }

    for (i, chapter) in chapters.iter().enumerate() {
        if i > 0 {
            if opts.page_breaks {
                out.push_str("\n\n\\newpage\n\n");
            } else if opts.rules_between {
                out.push_str("\n\n---\n\n");
            } else {
                out.push_str("\n\n");
            }
        }
        if opts.chapter_headings {
            out.push_str("# ");
            out.push_str(chapter.title.trim());
            out.push_str("\n\n");
        }
        out.push_str(&chapter.body);
    }

    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

// ── the small pure helpers ───────────────────────────────────────────────

pub fn is_fountain(rel: &str) -> bool {
    rel.to_lowercase().ends_with(".fountain")
}

/// File name without its extension, `/`-separated path in.
pub fn stem_of(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name.to_string(),
    }
}

/// A file name a filesystem will not argue with: letters, digits, spaces,
/// hyphens. Everything else collapses to a single hyphen.
pub fn slugify(input: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in input.chars() {
        if ch.is_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch);
        } else {
            pending_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "untitled".into()
    } else {
        trimmed
    }
}

/// Fountain `/* … */` boneyards, including multi-line ones.
fn strip_boneyards(input: &str) -> String {
    let bytes: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '/' && bytes.get(i + 1) == Some(&'*') {
            let mut j = i + 2;
            while j < bytes.len() && !(bytes[j] == '*' && bytes.get(j + 1) == Some(&'/')) {
                j += 1;
            }
            i = if j < bytes.len() { j + 2 } else { bytes.len() };
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    collapse_blank_runs(&out)
}

/// Fountain `[[inline notes]]`.
fn strip_inline_notes(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' && chars.get(i + 1) == Some(&'[') {
            let mut j = i + 2;
            while j < chars.len() && !(chars[j] == ']' && chars.get(j + 1) == Some(&']')) {
                j += 1;
            }
            i = if j < chars.len() { j + 2 } else { chars.len() };
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    collapse_blank_runs(&out)
}

/// `INT. KITCHEN - DAY #12#` → `INT. KITCHEN - DAY`.
fn strip_scene_numbers(input: &str) -> String {
    input
        .split('\n')
        .map(|line| {
            let trimmed = line.trim_end();
            if !trimmed.ends_with('#') || trimmed.len() < 3 {
                return line.to_string();
            }
            let body = &trimmed[..trimmed.len() - 1];
            match body.rfind('#') {
                Some(open) if open > 0 && body[open + 1..].chars().all(|c| c != ' ') => {
                    body[..open].trim_end().to_string()
                }
                _ => line.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The keys a fountain title page is allowed to open with.
///
/// A closed list, not a "looks like `Key:`" guess — because `FADE IN:` also
/// looks like `Key:`, and eating the first page of a screenplay is a much
/// worse failure than leaving a title page in.
const TITLE_PAGE_KEYS: &[&str] = &[
    "title", "credit", "author", "authors", "source", "notes", "draft date", "date", "contact",
    "copyright", "revision",
];

/// A fountain title page is the `Key: value` block at the very top, ended by
/// the first blank line. Anything else at the top is not a title page and is
/// left alone.
fn strip_title_page(input: &str) -> String {
    let lines: Vec<&str> = input.split('\n').collect();
    let first = lines.iter().position(|l| !l.trim().is_empty());
    let Some(first) = first else { return input.to_string() };
    let opens_a_title_page = lines[first]
        .split_once(':')
        .map(|(key, _)| {
            let key = key.trim().to_lowercase();
            TITLE_PAGE_KEYS.contains(&key.as_str())
        })
        .unwrap_or(false);
    if !opens_a_title_page {
        return input.to_string();
    }
    let mut end = first;
    while end < lines.len() && !lines[end].trim().is_empty() {
        end += 1;
    }
    while end < lines.len() && lines[end].trim().is_empty() {
        end += 1;
    }
    lines[end..].join("\n")
}

fn collapse_blank_runs(input: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut blanks = 0;
    for line in input.split('\n') {
        if line.trim().is_empty() {
            blanks += 1;
            if blanks > 2 {
                continue;
            }
        } else {
            blanks = 0;
        }
        out.push(line);
    }
    out.join("\n")
}

/// Escape the characters pandoc's markdown reader would otherwise eat.
///
/// Fountain is not markdown, and a screenplay is full of `*`, `_`, `#`, `>`
/// and `[` that mean something entirely different there. Escaping them is what
/// lets the PDF path go through pandoc at all without a fountain reader.
pub fn escape_markdown(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + input.len() / 8);
    for line in input.split('\n') {
        if !out.is_empty() {
            out.push('\n');
        }
        let mut chars = line.chars().peekable();
        let mut at_start = true;
        while let Some(ch) = chars.next() {
            let escape = match ch {
                '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' => true,
                '#' | '+' | '=' | '~' | '|' => at_start,
                '-' => at_start && chars.peek().map(|c| *c == ' ').unwrap_or(true),
                '.' => at_start,
                _ => false,
            };
            if escape {
                out.push('\\');
            }
            out.push(ch);
            if ch != ' ' && ch != '\t' {
                at_start = false;
            }
        }
    }
    out
}

fn yaml_scalar(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Draft, Goals, Manuscript, Workflow, WorkflowSettings};
    use crate::testutil::TempDir;

    fn wf() -> Workflow {
        Workflow {
            id: "w".into(),
            title: "Lantern, Lantern".into(),
            kind: "novel".into(),
            drafts: vec![Draft {
                id: "d1".into(),
                name: "Reading cut".into(),
                active: Some(true),
                chapter_order: vec!["Drafts/Ch_02.md".into(), "Drafts/Ch_01.md".into()],
            }],
            manuscripts: vec![Manuscript {
                id: "m1".into(),
                title: "Helmreach".into(),
                folder: "Drafts".into(),
                chapter_order: vec!["Drafts/Ch_01.md".into(), "Drafts/Ch_02.md".into()],
            }],
            settings: WorkflowSettings::default(),
            goals: Goals::default(),
            extra: Default::default(),
        }
    }

    #[test]
    fn a_manuscript_compiles_in_the_order_workflow_json_records() {
        let order =
            resolve(&wf(), &Source::Manuscript { manuscript_id: None, draft_id: None }).unwrap();
        assert_eq!(order, vec!["Drafts/Ch_01.md", "Drafts/Ch_02.md"]);
    }

    #[test]
    fn a_draft_compiles_in_its_own_cut_not_the_manuscripts() {
        let order = resolve(
            &wf(),
            &Source::Manuscript { manuscript_id: None, draft_id: Some("d1".into()) },
        )
        .unwrap();
        assert_eq!(
            order,
            vec!["Drafts/Ch_02.md", "Drafts/Ch_01.md"],
            "the draft's re-cut wins over the manuscript order"
        );
    }

    #[test]
    fn unknown_ids_and_manuscript_less_workflows_say_so() {
        let e = resolve(
            &wf(),
            &Source::Manuscript { manuscript_id: Some("nope".into()), draft_id: None },
        )
        .unwrap_err();
        assert_eq!(e.code, "badRequest");
        assert!(e.message.contains("nope"));

        let mut bare = wf();
        bare.manuscripts.clear();
        let e =
            resolve(&bare, &Source::Manuscript { manuscript_id: None, draft_id: None }).unwrap_err();
        assert!(e.message.contains("no manuscript"));

        let e = resolve(&bare, &Source::Document { path: "  ".into() }).unwrap_err();
        assert!(e.message.contains("no document"));
    }

    #[test]
    fn frontmatter_is_stripped_and_supplies_the_chapter_title() {
        let raw = "---\ntitle: Helmreach in Rain\nstatus: drafting\n---\n\nThe rain came sideways.\n";
        let opts = AssembleOptions::default();
        let ch = prepare("Drafts/Ch_01.md", raw, &opts);
        assert_eq!(ch.title, "Helmreach in Rain");
        assert_eq!(ch.body, "The rain came sideways.");
        assert!(!ch.body.contains("status"), "no metadata reaches the reader");
        assert_eq!(ch.words, 4);

        let kept = prepare(
            "Drafts/Ch_01.md",
            raw,
            &AssembleOptions { strip_frontmatter: false, ..opts },
        );
        assert!(kept.body.starts_with("---"), "keeping it is a real option");
    }

    #[test]
    fn a_chapter_with_no_title_key_falls_back_to_its_file_name() {
        let ch = prepare("Drafts/Ch_07.md", "Words.\n", &AssembleOptions::default());
        assert_eq!(ch.title, "Ch_07");
        let blank = prepare(
            "Drafts/Ch_08.md",
            "---\ntitle:   \n---\nWords.\n",
            &AssembleOptions::default(),
        );
        assert_eq!(blank.title, "Ch_08", "an empty title is not a title");
    }

    #[test]
    fn missing_files_drop_out_and_are_reported_rather_than_failing() {
        let t = TempDir::new("compile-missing");
        t.write("Drafts/Ch_01.md", "One.\n");
        t.write("Drafts/Ch_03.md", "Three.\n");
        let order = vec![
            "Drafts/Ch_01.md".to_string(),
            "Drafts/Ch_02.md".to_string(),
            "Drafts/Ch_03.md".to_string(),
        ];
        let (chapters, missing) = read_chapters(t.path(), &order, &AssembleOptions::default());
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].path, "Drafts/Ch_01.md");
        assert_eq!(chapters[1].path, "Drafts/Ch_03.md");
        assert_eq!(missing, vec!["Drafts/Ch_02.md"]);
    }

    #[test]
    fn a_path_that_escapes_the_vault_is_treated_as_missing_not_read() {
        let t = TempDir::new("compile-escape");
        let (chapters, missing) = read_chapters(
            t.path(),
            &["../secrets.md".to_string(), "/etc/passwd".to_string()],
            &AssembleOptions::default(),
        );
        assert!(chapters.is_empty());
        assert_eq!(missing.len(), 2);
    }

    #[test]
    fn chapters_are_joined_with_page_breaks_and_headings() {
        let chapters = vec![
            Chapter { path: "a.md".into(), title: "One".into(), body: "First.".into(), words: 1 },
            Chapter { path: "b.md".into(), title: "Two".into(), body: "Second.".into(), words: 1 },
        ];
        let text = assemble("Helmreach", None, &chapters, &AssembleOptions::default());
        assert_eq!(text, "# One\n\nFirst.\n\n\\newpage\n\n# Two\n\nSecond.\n");
    }

    #[test]
    fn markdown_profiles_can_ask_for_rules_and_no_page_breaks() {
        let chapters = vec![
            Chapter { path: "a.md".into(), title: "One".into(), body: "First.".into(), words: 1 },
            Chapter { path: "b.md".into(), title: "Two".into(), body: "Second.".into(), words: 1 },
        ];
        let opts = AssembleOptions {
            page_breaks: false,
            rules_between: true,
            ..AssembleOptions::default()
        };
        assert_eq!(
            assemble("x", None, &chapters, &opts),
            "# One\n\nFirst.\n\n---\n\n# Two\n\nSecond.\n"
        );

        let plain = AssembleOptions {
            page_breaks: false,
            rules_between: false,
            chapter_headings: false,
            ..AssembleOptions::default()
        };
        assert_eq!(assemble("x", None, &chapters, &plain), "First.\n\nSecond.\n");
    }

    #[test]
    fn a_title_block_carries_the_title_and_author_for_pandoc() {
        let chapters =
            vec![Chapter { path: "a.md".into(), title: "One".into(), body: "Hi.".into(), words: 1 }];
        let opts = AssembleOptions { title_block: true, ..AssembleOptions::default() };
        let text = assemble("Lantern, \"Lantern\"", Some("R. Adkins"), &chapters, &opts);
        assert!(text.starts_with("---\ntitle: \"Lantern, \\\"Lantern\\\"\"\nauthor: \"R. Adkins\"\n---\n\n"));

        let no_author = assemble("T", Some("   "), &chapters, &opts);
        assert!(!no_author.contains("author:"), "a blank author is not an author");
    }

    #[test]
    fn assembling_nothing_is_an_empty_document_not_a_panic() {
        assert_eq!(assemble("x", None, &[], &AssembleOptions::default()), "\n");
    }

    #[test]
    fn fountain_notes_boneyards_and_scene_numbers_come_out_on_request() {
        let raw = "INT. KITCHEN - DAY #12#\n\nShe waits. [[check the year]]\n\n/* cut this\nand this */\n\nOUT.\n";
        let opts = AssembleOptions {
            strip_notes: true,
            scene_numbers: false,
            ..AssembleOptions::default()
        };
        let ch = prepare("Script.fountain", raw, &opts);
        assert!(ch.body.starts_with("INT. KITCHEN - DAY\n"), "got {:?}", ch.body);
        assert!(!ch.body.contains("check the year"));
        assert!(!ch.body.contains("cut this"));
        assert!(ch.body.contains("OUT."));

        let kept = prepare("Script.fountain", raw, &AssembleOptions::default());
        assert!(kept.body.contains("#12#"), "scene numbers stay unless asked");
        assert!(kept.body.contains("[[check the year]]"));
    }

    #[test]
    fn fountain_options_do_not_touch_a_markdown_chapter() {
        let raw = "A line with [[brackets]] and /* slashes */ intact.\n";
        let opts = AssembleOptions {
            strip_notes: true,
            scene_numbers: false,
            ..AssembleOptions::default()
        };
        let ch = prepare("Notes/Idea.md", raw, &opts);
        assert!(ch.body.contains("[[brackets]]"));
        assert!(ch.body.contains("/* slashes */"));
    }

    #[test]
    fn a_fountain_title_page_can_be_dropped() {
        let raw = "Title: Helmreach\nCredit: written by\nAuthor: R. Adkins\n\nINT. KITCHEN - DAY\n";
        let ch = prepare(
            "Script.fountain",
            raw,
            &AssembleOptions { title_page: false, ..AssembleOptions::default() },
        );
        assert_eq!(ch.body, "INT. KITCHEN - DAY");

        let no_title_page = prepare(
            "Script.fountain",
            "FADE IN:\n\nINT. KITCHEN - DAY\n",
            &AssembleOptions { title_page: false, ..AssembleOptions::default() },
        );
        assert!(no_title_page.body.starts_with("FADE IN:"), "a script with no title page is left alone");
    }

    #[test]
    fn escaping_keeps_a_screenplay_looking_like_a_screenplay_through_pandoc() {
        let escaped = escape_markdown("# ACT ONE\n>THE END<\n- a dash\n*emphasis* and _under_\n");
        assert_eq!(
            escaped,
            "\\# ACT ONE\n\\>THE END\\<\n\\- a dash\n\\*emphasis\\* and \\_under\\_\n"
        );
        // A hyphen inside a word is not a list marker and must survive plainly.
        assert_eq!(escape_markdown("well-lit room"), "well-lit room");
    }

    #[test]
    fn slugify_produces_a_file_name_a_filesystem_will_accept() {
        assert_eq!(slugify("Lantern, Lantern"), "Lantern-Lantern");
        assert_eq!(slugify("  ///  "), "untitled");
        assert_eq!(slugify("Ch 01: Helmreach/Rain"), "Ch-01-Helmreach-Rain");
    }

    #[test]
    fn stem_of_handles_folders_dots_and_dotfiles() {
        assert_eq!(stem_of("Drafts/Ch_01.md"), "Ch_01");
        assert_eq!(stem_of("Notes/A.thing.md"), "A.thing");
        assert_eq!(stem_of("README"), "README");
    }

    #[test]
    fn the_title_comes_from_the_manuscript_then_the_workflow_then_the_file() {
        let w = wf();
        assert_eq!(
            title_for(&w, &Source::Manuscript { manuscript_id: None, draft_id: None }, &[]),
            "Helmreach"
        );
        let mut bare = w.clone();
        bare.manuscripts.clear();
        assert_eq!(
            title_for(&bare, &Source::Manuscript { manuscript_id: None, draft_id: None }, &[]),
            "Lantern, Lantern"
        );
        assert_eq!(
            title_for(&w, &Source::Document { path: "Notes/Idea.md".into() }, &[]),
            "Idea"
        );
    }
}
