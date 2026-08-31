//! Compile / Export — PARITY row 7.
//!
//! Until now the Compile sheet was a picture of a feature: six cards, a path
//! field, and a Compile button with no click handler. This module is the
//! feature.
//!
//! It splits three ways on purpose:
//!
//! * [`assembler`] is **pure**. Selection → ordered chapter list → one
//!   markdown document. No processes, no output files, and therefore a large
//!   pile of unit tests that run on a machine with no toolchain at all.
//! * [`pandoc`] is the **outside world**: finding a binary, running it with an
//!   argument array, and turning its stderr into something a person can act on.
//! * This file is the **policy**: which formats exist, which profile means
//!   what, where the file lands, and what the writer is told.
//!
//! Two of the five formats need nothing installed. Markdown (combined) and the
//! Fountain round-trip are written directly, because they are text and pandoc
//! would only be in the way. EPUB, Word and PDF go through pandoc; PDF also
//! needs a PDF engine, and the report says which one ran.
//!
//! **Nothing is ever overwritten.** The output name de-duplicates with a
//! " 2" / " 3" suffix, using the same `vault::ops::dedupe` the sidebar's
//! "New document" uses, so Compile behaves like the rest of the app.

pub mod assembler;
pub mod pandoc;

use crate::model::Workflow;
use crate::vault::ops;
use assembler::{AssembleOptions, Source};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

// ── errors ───────────────────────────────────────────────────────────────

/// A failure the UI can render as something other than a red string.
///
/// `code` is for the renderer (it decides whether to offer "install pandoc"),
/// `message` is the plain-language sentence, and `hint` is the actionable
/// second line when there is one. Codes: `pandocMissing`, `pdfEngineMissing`,
/// `pandocFailed`, `noChapters`, `badRequest`, `io`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompileError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl CompileError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), hint: None }
    }
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new("badRequest", message)
    }
    pub fn io(message: impl Into<String>) -> Self {
        Self::new("io", message)
    }
}

impl std::fmt::Display for CompileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.hint {
            Some(h) => write!(f, "{} — {}", self.message, h),
            None => write!(f, "{}", self.message),
        }
    }
}

// ── formats ──────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Markdown,
    Fountain,
    Epub,
    Docx,
    Pdf,
}

impl Format {
    pub fn parse(id: &str) -> Result<Self, CompileError> {
        match id.trim().to_lowercase().as_str() {
            "markdown" | "md" => Ok(Format::Markdown),
            "fountain" => Ok(Format::Fountain),
            "epub" => Ok(Format::Epub),
            "docx" | "word" => Ok(Format::Docx),
            "pdf" => Ok(Format::Pdf),
            "fdx" | "finaldraft" => Err(CompileError::bad_request(
                "Final Draft (.fdx) is not exported. Compile Fountain instead — Final Draft \
imports it directly.",
            )),
            other => Err(CompileError::bad_request(format!(
                "unknown format \"{other}\" — one of markdown, pdf, epub, docx, fountain"
            ))),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Format::Markdown => "markdown",
            Format::Fountain => "fountain",
            Format::Epub => "epub",
            Format::Docx => "docx",
            Format::Pdf => "pdf",
        }
    }

    pub fn ext(self) -> &'static str {
        match self {
            Format::Markdown => "md",
            Format::Fountain => "fountain",
            Format::Epub => "epub",
            Format::Docx => "docx",
            Format::Pdf => "pdf",
        }
    }

    /// True when producing this format means running pandoc.
    pub fn needs_pandoc(self) -> bool {
        matches!(self, Format::Epub | Format::Docx | Format::Pdf)
    }

    /// Pandoc's writer name. `None` for PDF: pandoc picks that from the output
    /// extension plus `--pdf-engine`, and naming it explicitly is the sort of
    /// flag that changed between pandoc 2 and 3.
    fn writer(self) -> Option<&'static str> {
        match self {
            Format::Epub => Some("epub"),
            Format::Docx => Some("docx"),
            _ => None,
        }
    }
}

// ── profiles ─────────────────────────────────────────────────────────────

/// A named set of defaults. The Swift app has exactly these, split by kind:
/// three for prose, three for markdown, two for screenplays.
#[derive(Clone, Copy, Debug)]
pub struct Profile {
    pub id: &'static str,
    pub label: &'static str,
    /// What it says under the name in the sheet.
    pub note: &'static str,
    /// Which formats it is offered for.
    pub formats: &'static [&'static str],
    /// LaTeX layout, applied only for PDF and only on a LaTeX engine.
    pub layout: &'static [(&'static str, &'static str)],
    pub page_breaks: bool,
    pub rules_between: bool,
    pub chapter_headings: bool,
    pub title_block: bool,
    pub strip_notes: bool,
    pub scene_numbers: bool,
    /// Ask pandoc for a table of contents (EPUB / DOCX).
    pub toc: bool,
}

const PROSE: &[&str] = &["pdf", "epub", "docx"];
const MD: &[&str] = &["markdown"];
const SCREEN: &[&str] = &["fountain", "pdf"];

/// Standard manuscript submission format: 12pt Courier, double spaced, 1"
/// margins on US Letter. This is the shape an agent's submission guidelines
/// ask for, and it is the default for prose.
const STANDARD_SUBMISSION: Profile = Profile {
    id: "standard-submission",
    label: "Standard submission",
    note: "12pt Courier, double spaced, 1\" margins, US Letter",
    formats: PROSE,
    layout: &[
        ("papersize", "letter"),
        ("geometry", "margin=1in"),
        ("fontsize", "12pt"),
        ("mainfont", "Courier New"),
        ("linestretch", "2"),
    ],
    page_breaks: true,
    rules_between: false,
    chapter_headings: true,
    title_block: true,
    strip_notes: false,
    scene_numbers: true,
    toc: false,
};

const TRADE_PAPERBACK: Profile = Profile {
    id: "trade-paperback",
    label: "Trade paperback",
    note: "5.5 × 8.5in, 11pt serif, 0.75\" margins",
    formats: PROSE,
    layout: &[
        ("papersize", "custom"),
        ("geometry", "paperwidth=5.5in,paperheight=8.5in,margin=0.75in"),
        ("fontsize", "11pt"),
        ("linestretch", "1.15"),
    ],
    page_breaks: true,
    rules_between: false,
    chapter_headings: true,
    title_block: true,
    strip_notes: false,
    scene_numbers: true,
    toc: true,
};

const READER_PROOF: Profile = Profile {
    id: "reader-proof",
    label: "Reader proof",
    note: "US Letter, 12pt serif, 1.5 spacing — for beta readers",
    formats: PROSE,
    layout: &[
        ("papersize", "letter"),
        ("geometry", "margin=1in"),
        ("fontsize", "12pt"),
        ("linestretch", "1.5"),
    ],
    page_breaks: true,
    rules_between: false,
    chapter_headings: true,
    title_block: true,
    strip_notes: false,
    scene_numbers: true,
    toc: true,
};

const CLEAN: Profile = Profile {
    id: "clean",
    label: "Clean",
    note: "Frontmatter stripped, chapter headings, rules between chapters",
    formats: MD,
    layout: &[],
    page_breaks: false,
    rules_between: true,
    chapter_headings: true,
    title_block: false,
    strip_notes: false,
    scene_numbers: true,
    toc: false,
};

const WEB_READY: Profile = Profile {
    id: "web-ready",
    label: "Web ready",
    note: "A YAML title block on top, headings, no rules — paste into a CMS",
    formats: MD,
    layout: &[],
    page_breaks: false,
    rules_between: false,
    chapter_headings: true,
    title_block: true,
    strip_notes: false,
    scene_numbers: true,
    toc: false,
};

const PLAIN: Profile = Profile {
    id: "plain",
    label: "Plain",
    note: "Just the prose — no headings, no metadata, no rules",
    formats: MD,
    layout: &[],
    page_breaks: false,
    rules_between: false,
    chapter_headings: false,
    title_block: false,
    strip_notes: false,
    scene_numbers: true,
    toc: false,
};

/// WGA margins: 1.5" left, 1" everywhere else, 12pt Courier.
const INDUSTRY_STANDARD: Profile = Profile {
    id: "industry-standard",
    label: "Industry standard",
    note: "WGA margins (1.5\" left), 12pt Courier, scene numbers and notes kept",
    formats: SCREEN,
    layout: &[
        ("papersize", "letter"),
        ("geometry", "left=1.5in,right=1in,top=1in,bottom=1in"),
        ("fontsize", "12pt"),
        ("mainfont", "Courier New"),
    ],
    page_breaks: false,
    rules_between: false,
    chapter_headings: false,
    title_block: false,
    strip_notes: false,
    scene_numbers: true,
    toc: false,
};

const READER_COPY: Profile = Profile {
    id: "reader-copy",
    label: "Reader copy",
    note: "Notes, boneyards and scene numbers removed; 1\" margins",
    formats: SCREEN,
    layout: &[
        ("papersize", "letter"),
        ("geometry", "margin=1in"),
        ("fontsize", "12pt"),
        ("mainfont", "Courier New"),
    ],
    page_breaks: false,
    rules_between: false,
    chapter_headings: false,
    title_block: false,
    strip_notes: true,
    scene_numbers: false,
    toc: false,
};

pub const PROFILES: &[Profile] = &[
    STANDARD_SUBMISSION,
    TRADE_PAPERBACK,
    READER_PROOF,
    CLEAN,
    WEB_READY,
    PLAIN,
    INDUSTRY_STANDARD,
    READER_COPY,
];

/// The profile a format falls back to when the caller names none.
fn default_profile(format: Format, screenplay: bool) -> Profile {
    match format {
        Format::Markdown => CLEAN,
        Format::Fountain => INDUSTRY_STANDARD,
        Format::Pdf if screenplay => INDUSTRY_STANDARD,
        _ => STANDARD_SUBMISSION,
    }
}

fn resolve_profile(
    format: Format,
    screenplay: bool,
    requested: Option<&str>,
) -> Result<Profile, CompileError> {
    let Some(id) = requested.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(default_profile(format, screenplay));
    };
    let found = PROFILES
        .iter()
        .find(|p| p.id.eq_ignore_ascii_case(id))
        .ok_or_else(|| {
            CompileError::bad_request(format!(
                "unknown profile \"{id}\" — one of {}",
                PROFILES.iter().map(|p| p.id).collect::<Vec<_>>().join(", ")
            ))
        })?;
    if !found.formats.contains(&format.id()) {
        return Err(CompileError::bad_request(format!(
            "the \"{}\" profile is not offered for {} — try {}",
            found.id,
            format.id(),
            PROFILES
                .iter()
                .filter(|p| p.formats.contains(&format.id()))
                .map(|p| p.id)
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    Ok(*found)
}

// ── the request and the answer ───────────────────────────────────────────

/// The include options a caller can override. Everything is optional: what is
/// not set comes from the profile.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CompileOptions {
    pub strip_frontmatter: Option<bool>,
    pub chapter_headings: Option<bool>,
    pub page_breaks: Option<bool>,
    pub title_block: Option<bool>,
    /// Fountain only.
    pub title_page: Option<bool>,
    /// Fountain only.
    pub strip_notes: Option<bool>,
    /// Fountain only.
    pub scene_numbers: Option<bool>,
    /// Goes into the EPUB / DOCX / PDF metadata.
    pub author: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompileRequest {
    /// markdown | pdf | epub | docx | fountain.
    pub format: String,
    pub source: Source,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub options: CompileOptions,
    /// Absolute path of the folder to write into. Created if it does not exist.
    pub output_directory: String,
    /// File name without an extension. Defaults to a slug of the title.
    #[serde(default)]
    pub file_name: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompileReport {
    /// Absolute path of the file that was written.
    pub path: String,
    pub file_name: String,
    pub directory: String,
    pub format: String,
    pub profile: String,
    pub bytes: u64,
    pub chapters: usize,
    pub words: usize,
    /// Chapters in the order that were not on disk. Never fatal.
    pub missing: Vec<String>,
    /// The PDF engine that rendered it, when one did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// True when the name was taken and a " 2" was used.
    pub renamed: bool,
}

// ── the probe ────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub note: &'static str,
    pub formats: Vec<&'static str>,
}

/// What Compile can actually do on this machine, right now.
///
/// The sheet asks for this when it opens, so a card that would fail on click
/// can say "needs pandoc" before it is clicked instead of after.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompileProbe {
    pub pandoc: bool,
    pub pandoc_path: Option<String>,
    pub pandoc_version: Option<String>,
    pub pdf_engine: Option<String>,
    pub pdf_engine_path: Option<String>,
    /// True when the found engine honours the profiles' layout settings.
    pub pdf_layout_supported: bool,
    /// Formats that work with what is installed.
    pub available_formats: Vec<&'static str>,
    pub install_hint: String,
    pub engine_hint: String,
    pub profiles: Vec<ProfileInfo>,
    /// Where to put the file unless the writer says otherwise: `Exports/`
    /// inside the vault. Absolute; not created until something is compiled.
    pub default_directory: Option<String>,
}

/// The folder Compile offers by default for a vault.
pub fn default_output_dir(root: &Path) -> PathBuf {
    root.join("Exports")
}

pub fn probe(root: Option<&Path>) -> CompileProbe {
    let bin = pandoc::locate();
    let version = bin.as_deref().and_then(pandoc::version);
    let engine = pandoc::find_pdf_engine();
    let has_pandoc = bin.is_some();

    let mut formats: Vec<&'static str> = vec!["markdown", "fountain"];
    if has_pandoc {
        formats.push("epub");
        formats.push("docx");
        if engine.is_some() {
            formats.push("pdf");
        }
    }

    CompileProbe {
        pandoc: has_pandoc,
        pandoc_path: bin.as_ref().map(|p| p.to_string_lossy().to_string()),
        pandoc_version: version,
        pdf_engine: engine.as_ref().map(|(n, _)| n.clone()),
        pdf_engine_path: engine.as_ref().map(|(_, p)| p.to_string_lossy().to_string()),
        pdf_layout_supported: engine
            .as_ref()
            .map(|(n, _)| pandoc::is_latex_engine(n))
            .unwrap_or(false),
        available_formats: formats,
        install_hint: pandoc::install_hint(),
        engine_hint: pandoc::engine_hint(),
        profiles: PROFILES
            .iter()
            .map(|p| ProfileInfo {
                id: p.id,
                label: p.label,
                note: p.note,
                formats: p.formats.to_vec(),
            })
            .collect(),
        default_directory: root.map(|r| default_output_dir(r).to_string_lossy().to_string()),
    }
}

// ── the run ──────────────────────────────────────────────────────────────

/// Compile a selection into a file. The one entry point; the Tauri command and
/// the MCP tool are both three lines around it.
pub fn run(root: &Path, wf: &Workflow, req: &CompileRequest) -> Result<CompileReport, CompileError> {
    let format = Format::parse(&req.format)?;
    let order = assembler::resolve(wf, &req.source)?;
    if order.is_empty() {
        return Err(CompileError::new(
            "noChapters",
            "there is nothing to compile — this manuscript has no chapters yet",
        ));
    }
    let screenplay = order.iter().any(|p| assembler::is_fountain(p));

    if format == Format::Fountain && !screenplay {
        return Err(CompileError::bad_request(
            "Fountain export needs a screenplay — the chosen source has no .fountain files",
        ));
    }

    let profile = resolve_profile(format, screenplay, req.profile.as_deref())?;
    let opts = assemble_options(format, screenplay, &profile, &req.options);

    let (chapters, missing) = assembler::read_chapters(root, &order, &opts);
    if chapters.is_empty() {
        return Err(CompileError::new(
            "noChapters",
            format!(
                "none of the {} document(s) in this selection could be read — they may have been \
moved or deleted outside the app",
                order.len()
            ),
        ));
    }

    let title = assembler::title_for(wf, &req.source, &order);
    let author = req.options.author.as_deref().filter(|a| !a.trim().is_empty());
    let text = assembler::assemble(&title, author, &chapters, &opts);
    let words = chapters.iter().map(|c| c.words).sum();

    // The output folder. Created if it is not there — "~/Aquarius/Exports"
    // should not need to be made by hand first.
    let dir = PathBuf::from(req.output_directory.trim());
    if req.output_directory.trim().is_empty() {
        return Err(CompileError::bad_request("choose a folder to write the file into"));
    }
    std::fs::create_dir_all(&dir)
        .map_err(|e| CompileError::io(format!("could not use {}: {e}", dir.display())))?;

    let requested_stem = req
        .file_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(assembler::slugify)
        .unwrap_or_else(|| assembler::slugify(&title));
    let file_name = ops::dedupe(&dir, &requested_stem, Some(format.ext()));
    let renamed = file_name != format!("{requested_stem}.{}", format.ext());
    let out_path = dir.join(&file_name);

    let mut engine_used: Option<String> = None;
    match format {
        // Text formats are written straight out. Pandoc would only be a
        // round trip through a parser that could lose something.
        Format::Markdown => write_text(&out_path, &text)?,
        Format::Fountain => {
            // The round trip: the fountain the writer typed, with the include
            // options applied, and nothing else touched. No headings, no
            // escaping — assemble_options guarantees both are off.
            write_text(&out_path, &text)?
        }
        Format::Epub | Format::Docx | Format::Pdf => {
            let bin = pandoc::locate().ok_or_else(|| {
                CompileError::new(
                    "pandocMissing",
                    format!(
                        "{} export needs pandoc, and it is not installed on this machine.",
                        format.id().to_uppercase()
                    ),
                )
                .with_hint(pandoc::install_hint())
            })?;
            let engine = if format == Format::Pdf {
                let found = pandoc::find_pdf_engine().ok_or_else(|| {
                    CompileError::new(
                        "pdfEngineMissing",
                        "pandoc is installed, but there is no PDF engine for it to hand the \
document to.",
                    )
                    .with_hint(pandoc::engine_hint())
                })?;
                engine_used = Some(found.0.clone());
                Some(found)
            } else {
                None
            };
            let source = TempSource::write(&text)?;
            let args = pandoc_args(
                source.path(),
                &out_path,
                root,
                format,
                &profile,
                &title,
                author,
                screenplay,
                engine.as_ref(),
            );
            pandoc::run(&bin, &args)?;
            if !out_path.is_file() {
                return Err(CompileError::new(
                    "pandocFailed",
                    "pandoc reported success but wrote no file",
                ));
            }
        }
    }

    let bytes = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    Ok(CompileReport {
        path: out_path.to_string_lossy().to_string(),
        file_name,
        directory: dir.to_string_lossy().to_string(),
        format: format.id().to_string(),
        profile: profile.id.to_string(),
        bytes,
        chapters: chapters.len(),
        words,
        missing,
        engine: engine_used,
        renamed,
    })
}

/// Turn a profile plus the caller's overrides into the assembler's options.
fn assemble_options(
    format: Format,
    screenplay: bool,
    profile: &Profile,
    over: &CompileOptions,
) -> AssembleOptions {
    // A .fountain round trip must not gain markdown headings or backslashes —
    // it has to be a file a screenwriting app can open again.
    let round_trip = format == Format::Fountain;
    AssembleOptions {
        strip_frontmatter: over.strip_frontmatter.unwrap_or(true),
        chapter_headings: if round_trip {
            false
        } else {
            over.chapter_headings.unwrap_or(profile.chapter_headings)
        },
        page_breaks: if round_trip {
            false
        } else {
            over.page_breaks.unwrap_or(profile.page_breaks)
        },
        rules_between: !round_trip && profile.rules_between,
        title_block: if round_trip {
            false
        } else {
            over.title_block.unwrap_or(profile.title_block && format == Format::Markdown)
        },
        title_page: over.title_page.unwrap_or(true),
        strip_notes: over.strip_notes.unwrap_or(profile.strip_notes),
        scene_numbers: over.scene_numbers.unwrap_or(profile.scene_numbers),
        // Fountain going through pandoc is escaped so its `*`, `#` and `>`
        // survive as the characters the writer typed.
        escape_markdown: screenplay && format.needs_pandoc(),
    }
}

#[allow(clippy::too_many_arguments)]
fn pandoc_args(
    input: &Path,
    output: &Path,
    resource_root: &Path,
    format: Format,
    profile: &Profile,
    title: &str,
    author: Option<&str>,
    screenplay: bool,
    engine: Option<&(String, PathBuf)>,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    args.push(input.into());
    // hard_line_breaks keeps a screenplay's line structure; smart is pandoc's
    // typographic quotes, which prose wants and a screenplay does not.
    args.push(if screenplay {
        "--from=markdown+hard_line_breaks-smart".into()
    } else {
        "--from=markdown".into()
    });
    if let Some(writer) = format.writer() {
        args.push(format!("--to={writer}").into());
    }
    args.push("--standalone".into());
    args.push("--output".into());
    args.push(output.into());
    // So a `![](Images/map.png)` in a chapter resolves against the vault.
    let mut resource = OsString::from("--resource-path=");
    resource.push(resource_root.as_os_str());
    args.push(resource);

    args.push(format!("--metadata=title:{title}").into());
    if let Some(a) = author {
        args.push(format!("--metadata=author:{a}").into());
    }
    if profile.toc && matches!(format, Format::Epub | Format::Docx | Format::Pdf) {
        args.push("--toc".into());
        args.push("--toc-depth=1".into());
    }

    if format == Format::Pdf {
        if let Some((name, path)) = engine {
            let mut flag = OsString::from("--pdf-engine=");
            flag.push(path.as_os_str());
            args.push(flag);
            // The layout variables are LaTeX's. typst / weasyprint / wkhtmltopdf
            // would either ignore them or refuse, so they are not sent.
            if pandoc::is_latex_engine(name) {
                for (key, value) in profile.layout {
                    args.push(format!("--variable={key}:{value}").into());
                }
                if screenplay {
                    args.push("--variable=monofont:Courier New".into());
                }
            }
        }
    }
    args
}

fn write_text(path: &Path, text: &str) -> Result<(), CompileError> {
    std::fs::write(path, text.as_bytes())
        .map_err(|e| CompileError::io(format!("could not write {}: {e}", path.display())))
}

/// The assembled markdown, on disk, for pandoc to read — and deleted after.
///
/// Piping it to pandoc's stdin would avoid the file, but pandoc resolves
/// relative resources against the input's directory, and a temp file with an
/// explicit `--resource-path` is both simpler to debug and easier to reason
/// about than a pipe that can deadlock on a large manuscript.
struct TempSource(PathBuf);

impl TempSource {
    fn write(text: &str) -> Result<Self, CompileError> {
        let dir = std::env::temp_dir().join("aquarius-compile");
        std::fs::create_dir_all(&dir)
            .map_err(|e| CompileError::io(format!("could not make a scratch folder: {e}")))?;
        let path = dir.join(format!("{}.md", uuid::Uuid::new_v4().simple()));
        std::fs::write(&path, text.as_bytes())
            .map_err(|e| CompileError::io(format!("could not stage the manuscript: {e}")))?;
        Ok(Self(path))
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempSource {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Goals, Manuscript, Workflow, WorkflowSettings};
    use crate::testutil::TempDir;

    fn wf() -> Workflow {
        Workflow {
            id: "w".into(),
            title: "Lantern, Lantern".into(),
            kind: "novel".into(),
            drafts: vec![],
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

    fn vault() -> TempDir {
        let t = TempDir::new("compile-run");
        t.write("Drafts/Ch_01.md", "---\ntitle: Helmreach in Rain\nstatus: drafting\n---\n\nThe rain came sideways.\n");
        t.write("Drafts/Ch_02.md", "---\ntitle: The Lantern\n---\n\nShe lit it anyway.\n");
        t
    }

    fn request(format: &str, dir: &Path) -> CompileRequest {
        CompileRequest {
            format: format.into(),
            source: Source::Manuscript { manuscript_id: None, draft_id: None },
            profile: None,
            options: CompileOptions::default(),
            output_directory: dir.to_string_lossy().to_string(),
            file_name: None,
        }
    }

    #[test]
    fn format_ids_parse_the_way_the_ui_and_a_model_would_write_them() {
        assert_eq!(Format::parse("md").unwrap(), Format::Markdown);
        assert_eq!(Format::parse("Markdown").unwrap(), Format::Markdown);
        assert_eq!(Format::parse("word").unwrap(), Format::Docx);
        assert_eq!(Format::parse(" PDF ").unwrap(), Format::Pdf);
        assert!(Format::parse("psd").unwrap_err().message.contains("unknown format"));
    }

    #[test]
    fn fdx_is_refused_by_name_and_points_at_fountain() {
        let e = Format::parse("fdx").unwrap_err();
        assert_eq!(e.code, "badRequest");
        assert!(e.message.contains("Fountain"), "the refusal has to say what to do instead");
    }

    #[test]
    fn only_epub_docx_and_pdf_need_pandoc() {
        assert!(!Format::Markdown.needs_pandoc());
        assert!(!Format::Fountain.needs_pandoc());
        for f in [Format::Epub, Format::Docx, Format::Pdf] {
            assert!(f.needs_pandoc());
        }
    }

    #[test]
    fn profiles_are_gated_by_format_and_the_refusal_lists_the_alternatives() {
        assert_eq!(resolve_profile(Format::Pdf, false, None).unwrap().id, "standard-submission");
        assert_eq!(resolve_profile(Format::Markdown, false, None).unwrap().id, "clean");
        assert_eq!(resolve_profile(Format::Pdf, true, None).unwrap().id, "industry-standard");

        let e = resolve_profile(Format::Markdown, false, Some("trade-paperback")).unwrap_err();
        assert!(e.message.contains("not offered for markdown"));
        assert!(e.message.contains("clean"), "it names what would work: {}", e.message);

        let e = resolve_profile(Format::Pdf, false, Some("nope")).unwrap_err();
        assert!(e.message.contains("unknown profile"));
    }

    #[test]
    fn every_profile_is_offered_for_at_least_one_format_and_ids_are_unique() {
        let mut ids: Vec<&str> = PROFILES.iter().map(|p| p.id).collect();
        ids.sort();
        let before = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), before, "two profiles share an id");
        for p in PROFILES {
            assert!(!p.formats.is_empty(), "{} is offered for nothing", p.id);
            assert!(!p.note.is_empty(), "{} has no explanation", p.id);
        }
    }

    #[test]
    fn a_fountain_round_trip_never_gains_headings_page_breaks_or_escapes() {
        let opts = assemble_options(
            Format::Fountain,
            true,
            &INDUSTRY_STANDARD,
            &CompileOptions::default(),
        );
        assert!(!opts.chapter_headings);
        assert!(!opts.page_breaks);
        assert!(!opts.rules_between);
        assert!(!opts.title_block);
        assert!(!opts.escape_markdown, "a .fountain file must stay fountain");
    }

    #[test]
    fn a_screenplay_bound_for_pandoc_is_escaped_but_prose_is_not() {
        assert!(
            assemble_options(Format::Pdf, true, &INDUSTRY_STANDARD, &CompileOptions::default())
                .escape_markdown
        );
        assert!(
            !assemble_options(Format::Pdf, false, &STANDARD_SUBMISSION, &CompileOptions::default())
                .escape_markdown
        );
    }

    #[test]
    fn markdown_compiles_with_no_pandoc_anywhere_in_sight() {
        let t = vault();
        let out = TempDir::new("compile-out-md");
        let report = run(t.path(), &wf(), &request("markdown", out.path())).unwrap();

        assert_eq!(report.file_name, "Helmreach.md");
        assert_eq!(report.chapters, 2);
        assert_eq!(report.words, 8);
        assert!(report.missing.is_empty());
        assert!(!report.renamed);
        assert_eq!(report.profile, "clean");

        let text = std::fs::read_to_string(&report.path).unwrap();
        assert_eq!(
            text,
            "# Helmreach in Rain\n\nThe rain came sideways.\n\n---\n\n# The Lantern\n\nShe lit it anyway.\n"
        );
        assert!(!text.contains("status:"), "frontmatter does not reach the reader");
    }

    #[test]
    fn compiling_twice_never_overwrites_the_first_file() {
        let t = vault();
        let out = TempDir::new("compile-out-dedupe");
        let first = run(t.path(), &wf(), &request("markdown", out.path())).unwrap();
        let second = run(t.path(), &wf(), &request("markdown", out.path())).unwrap();
        assert_eq!(first.file_name, "Helmreach.md");
        assert_eq!(second.file_name, "Helmreach 2.md");
        assert!(second.renamed);
        assert!(Path::new(&first.path).is_file(), "the first file is still there");
    }

    #[test]
    fn the_output_folder_is_created_and_a_missing_one_is_not_an_error() {
        let t = vault();
        let out = TempDir::new("compile-out-mkdir");
        let nested = out.path().join("Exports").join("2026");
        let report = run(t.path(), &wf(), &request("markdown", &nested)).unwrap();
        assert!(Path::new(&report.path).is_file());
    }

    #[test]
    fn a_chosen_file_name_is_slugified_rather_than_trusted() {
        let t = vault();
        let out = TempDir::new("compile-out-name");
        let mut req = request("markdown", out.path());
        req.file_name = Some("../../etc/passwd".into());
        let report = run(t.path(), &wf(), &req).unwrap();
        assert_eq!(report.file_name, "etc-passwd.md");
        assert_eq!(Path::new(&report.path).parent().unwrap(), out.path());
    }

    #[test]
    fn a_missing_chapter_is_reported_and_the_rest_still_compile() {
        let t = vault();
        std::fs::remove_file(t.path().join("Drafts/Ch_02.md")).unwrap();
        let out = TempDir::new("compile-out-missing");
        let report = run(t.path(), &wf(), &request("markdown", out.path())).unwrap();
        assert_eq!(report.chapters, 1);
        assert_eq!(report.missing, vec!["Drafts/Ch_02.md"]);
    }

    #[test]
    fn a_selection_that_reads_nothing_is_an_error_not_an_empty_file() {
        let t = vault();
        std::fs::remove_dir_all(t.path().join("Drafts")).unwrap();
        let out = TempDir::new("compile-out-empty");
        let err = run(t.path(), &wf(), &request("markdown", out.path())).unwrap_err();
        assert_eq!(err.code, "noChapters");
        assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 0);

        let mut empty = wf();
        empty.manuscripts[0].chapter_order.clear();
        let err = run(t.path(), &empty, &request("markdown", out.path())).unwrap_err();
        assert_eq!(err.code, "noChapters");
    }

    #[test]
    fn fountain_export_refuses_a_prose_manuscript_and_round_trips_a_screenplay() {
        let t = TempDir::new("compile-fountain");
        t.write("Drafts/Ch_01.md", "Prose.\n");
        t.write(
            "Script.fountain",
            "Title: Helmreach\n\nINT. KITCHEN - DAY #4#\n\nShe waits. [[check]]\n",
        );
        let out = TempDir::new("compile-out-fountain");

        let mut req = request("fountain", out.path());
        let err = run(t.path(), &wf(), &req).unwrap_err();
        assert_eq!(err.code, "badRequest");
        assert!(err.message.contains("screenplay"));

        req.source = Source::Document { path: "Script.fountain".into() };
        let report = run(t.path(), &wf(), &req).unwrap();
        assert_eq!(report.file_name, "Script.fountain");
        assert_eq!(report.profile, "industry-standard");
        let text = std::fs::read_to_string(&report.path).unwrap();
        assert!(text.starts_with("Title: Helmreach"), "the title page survives: {text:?}");
        assert!(text.contains("#4#"), "industry standard keeps scene numbers");
        assert!(!text.contains('\\'), "nothing is escaped in a round trip");

        req.profile = Some("reader-copy".into());
        let reader = run(t.path(), &wf(), &req).unwrap();
        let text = std::fs::read_to_string(&reader.path).unwrap();
        assert!(!text.contains("#4#"), "a reader copy drops scene numbers");
        assert!(!text.contains("[[check]]"), "and the notes");
    }

    #[test]
    fn an_empty_output_folder_is_refused_before_anything_is_assembled() {
        let t = vault();
        let mut req = request("markdown", Path::new("/tmp"));
        req.output_directory = "   ".into();
        let err = run(t.path(), &wf(), &req).unwrap_err();
        assert_eq!(err.code, "badRequest");
    }

    #[test]
    fn pandoc_args_are_an_array_with_no_shell_metacharacters_interpreted() {
        let args = pandoc_args(
            Path::new("/tmp/in.md"),
            Path::new("/out/Ch 01; rm -rf ~.epub"),
            Path::new("/vault"),
            Format::Epub,
            &TRADE_PAPERBACK,
            "Lantern; Lantern",
            Some("R. Adkins"),
            false,
            None,
        );
        let strings: Vec<String> = args.iter().map(|a| a.to_string_lossy().to_string()).collect();
        assert!(strings.contains(&"--to=epub".to_string()));
        assert!(strings.contains(&"--metadata=title:Lantern; Lantern".to_string()));
        assert!(strings.contains(&"--metadata=author:R. Adkins".to_string()));
        assert!(strings.contains(&"--resource-path=/vault".to_string()));
        assert!(strings.contains(&"--toc".to_string()));
        assert!(
            strings.contains(&"/out/Ch 01; rm -rf ~.epub".to_string()),
            "the path is one argument, complete with its spaces and semicolon"
        );
        assert!(
            !strings.iter().any(|s| s.starts_with("--variable=")),
            "LaTeX layout variables are for PDF only"
        );
    }

    #[test]
    fn pdf_args_carry_the_profile_layout_only_for_a_latex_engine() {
        let latex = ("xelatex".to_string(), PathBuf::from("/usr/bin/xelatex"));
        let args = pandoc_args(
            Path::new("/tmp/in.md"),
            Path::new("/out/a.pdf"),
            Path::new("/vault"),
            Format::Pdf,
            &STANDARD_SUBMISSION,
            "T",
            None,
            false,
            Some(&latex),
        );
        let s: Vec<String> = args.iter().map(|a| a.to_string_lossy().to_string()).collect();
        assert!(s.contains(&"--pdf-engine=/usr/bin/xelatex".to_string()));
        assert!(s.contains(&"--variable=fontsize:12pt".to_string()));
        assert!(s.contains(&"--variable=linestretch:2".to_string()));
        assert!(s.contains(&"--variable=mainfont:Courier New".to_string()));
        assert!(!s.iter().any(|a| a.starts_with("--to=")), "pandoc infers pdf from the extension");

        let typst = ("typst".to_string(), PathBuf::from("/usr/bin/typst"));
        let s: Vec<String> = pandoc_args(
            Path::new("/tmp/in.md"),
            Path::new("/out/a.pdf"),
            Path::new("/vault"),
            Format::Pdf,
            &STANDARD_SUBMISSION,
            "T",
            None,
            false,
            Some(&typst),
        )
        .iter()
        .map(|a| a.to_string_lossy().to_string())
        .collect();
        assert!(s.contains(&"--pdf-engine=/usr/bin/typst".to_string()));
        assert!(
            !s.iter().any(|a| a.starts_with("--variable=")),
            "a non-LaTeX engine would choke on LaTeX variables"
        );
    }

    #[test]
    fn a_screenplay_going_through_pandoc_keeps_its_line_breaks_and_straight_quotes() {
        let s: Vec<String> = pandoc_args(
            Path::new("/tmp/in.md"),
            Path::new("/out/a.pdf"),
            Path::new("/vault"),
            Format::Pdf,
            &INDUSTRY_STANDARD,
            "T",
            None,
            true,
            Some(&("xelatex".to_string(), PathBuf::from("/usr/bin/xelatex"))),
        )
        .iter()
        .map(|a| a.to_string_lossy().to_string())
        .collect();
        assert!(s.contains(&"--from=markdown+hard_line_breaks-smart".to_string()));
        assert!(s.contains(&"--variable=geometry:left=1.5in,right=1in,top=1in,bottom=1in".to_string()));
    }

    #[test]
    fn the_probe_reports_what_is_installed_and_never_lies_about_pdf() {
        let t = vault();
        let p = probe(Some(t.path()));
        assert!(p.available_formats.contains(&"markdown"));
        assert!(p.available_formats.contains(&"fountain"));
        assert_eq!(p.pandoc, p.pandoc_path.is_some());
        assert_eq!(p.available_formats.contains(&"epub"), p.pandoc);
        assert_eq!(
            p.available_formats.contains(&"pdf"),
            p.pandoc && p.pdf_engine.is_some(),
            "pdf is only offered when both halves are there"
        );
        assert!(p.install_hint.contains("pandoc"));
        assert_eq!(p.profiles.len(), PROFILES.len());
        assert!(p.default_directory.unwrap().ends_with("Exports"));
        assert!(probe(None).default_directory.is_none());
    }

    #[test]
    fn asking_for_epub_without_pandoc_says_how_to_get_pandoc() {
        if pandoc::locate().is_some() {
            return; // covered by the integration test below instead
        }
        let t = vault();
        let out = TempDir::new("compile-out-nopandoc");
        let err = run(t.path(), &wf(), &request("epub", out.path())).unwrap_err();
        assert_eq!(err.code, "pandocMissing");
        assert!(err.hint.unwrap().contains("install"));
    }

    /// The one test that runs a real subprocess. Skips itself cleanly on a
    /// machine with no pandoc, which is most machines and was this one when
    /// the module was written.
    #[test]
    fn docx_really_compiles_when_pandoc_is_installed() {
        if pandoc::locate().is_none() {
            eprintln!("skipping: pandoc is not installed on this machine");
            return;
        }
        let t = vault();
        let out = TempDir::new("compile-out-docx");
        let report = run(t.path(), &wf(), &request("docx", out.path())).unwrap();
        assert_eq!(report.file_name, "Helmreach.docx");
        assert!(report.bytes > 1000, "a two-chapter docx should not be tiny");
        let head = std::fs::read(&report.path).unwrap();
        assert_eq!(&head[..2], b"PK", "a .docx is a zip archive");
    }
}
