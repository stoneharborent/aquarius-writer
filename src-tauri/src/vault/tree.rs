//! Walking a vault folder into the `VaultNode` tree the sidebar renders.
//!
//! What the walk deliberately does *not* include: `.aquarius/` (app
//! bookkeeping), dotfiles, and editor temporaries. What it adds: frontmatter
//! and word counts for markdown, so the outline, corkboard and chapter rail
//! have their data without the renderer reading every file.

use super::frontmatter;
use super::paths::{is_ignored_name, AQ_DIR};
use crate::model::VaultNode;
use std::fs;
use std::path::Path;
use std::time::SystemTime;

/// Files bigger than this are listed but not scanned for frontmatter/words.
/// A 4 MB markdown file is a pathology, not a chapter.
const MAX_SCAN_BYTES: u64 = 4 * 1024 * 1024;
/// Depth guard — a vault nested deeper than this is almost certainly a symlink
/// loop or a checked-in dependency tree.
const MAX_DEPTH: usize = 16;

#[derive(Debug, Default, Clone)]
pub struct WalkStats {
    /// Number of files (not folders) in the tree — the picker's "items" count.
    pub items: usize,
    /// Most recent mtime seen, for the picker's "updated" string.
    pub newest: Option<SystemTime>,
}

pub fn kind_for(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "md" | "markdown" => "markdown",
        "fountain" => "fountain",
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg" | "bmp" | "avif" | "heic" => "image",
        "pdf" => "pdf",
        _ => "other",
    }
}

/// Walk `root` into a tree. `title` names the root node (the workflow title).
pub fn walk(root: &Path, title: &str) -> std::io::Result<(VaultNode, WalkStats)> {
    let mut stats = WalkStats::default();
    let children = walk_dir(root, root, 0, &mut stats)?;
    let node = VaultNode {
        name: title.to_string(),
        path: String::new(),
        kind: "folder".into(),
        children: Some(children),
        frontmatter: None,
        words: None,
    };
    Ok((node, stats))
}

fn walk_dir(
    root: &Path,
    dir: &Path,
    depth: usize,
    stats: &mut WalkStats,
) -> std::io::Result<Vec<VaultNode>> {
    if depth >= MAX_DEPTH {
        return Ok(Vec::new());
    }
    let mut out: Vec<VaultNode> = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        // An unreadable subfolder shouldn't blow up the whole vault.
        Err(_) => return Ok(Vec::new()),
    };

    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == AQ_DIR || is_ignored_name(&name) {
            continue;
        }
        let path = entry.path();
        // `file_type` does not follow symlinks — a symlinked directory is
        // reported as a symlink, so we never recurse into one and can't loop.
        let Ok(ft) = entry.file_type() else { continue };
        let rel = match super::paths::rel_from_root(root, &path) {
            Some(r) => r,
            None => continue,
        };

        if ft.is_dir() {
            let children = walk_dir(root, &path, depth + 1, stats)?;
            out.push(VaultNode {
                name,
                path: rel,
                kind: "folder".into(),
                children: Some(children),
                frontmatter: None,
                words: None,
            });
        } else if ft.is_file() {
            stats.items += 1;
            let meta = entry.metadata().ok();
            if let Some(m) = &meta {
                if let Ok(modified) = m.modified() {
                    stats.newest = Some(match stats.newest {
                        Some(prev) if prev > modified => prev,
                        _ => modified,
                    });
                }
            }
            let kind = kind_for(&name);
            let mut node = VaultNode {
                // Markdown shows as a title ("Old Sennet"); everything else keeps
                // its extension, the way the design mock lists
                // "Pilot — Cold Open.fountain" and "Cathedral diagram.jpg".
                name: if kind == "markdown" { stem(&name) } else { name.clone() },
                path: rel,
                kind: kind.into(),
                children: None,
                frontmatter: None,
                words: None,
            };
            if kind == "markdown" && meta.map(|m| m.len() <= MAX_SCAN_BYTES).unwrap_or(false) {
                if let Ok(text) = fs::read_to_string(&path) {
                    let parsed = frontmatter::parse(&text);
                    if !parsed.frontmatter.is_empty() {
                        node.frontmatter = Some(parsed.frontmatter);
                    }
                    node.words = Some(frontmatter::count_words(&parsed.body));
                }
            }
            out.push(node);
        }
    }

    // Folders first, then files, each alphabetical and case-insensitive —
    // stable output so the sidebar doesn't reshuffle between reads.
    out.sort_by(|a, b| {
        let a_dir = a.kind == "folder";
        let b_dir = b.kind == "folder";
        b_dir.cmp(&a_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

fn stem(name: &str) -> String {
    Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string())
}

/// Every markdown path under `folder` (one level), sorted — used to seed a
/// manuscript's chapter order.
pub fn markdown_paths_in(root: &Path, folder: &str) -> Vec<String> {
    let dir = root.join(folder);
    let mut out: Vec<String> = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else { return out };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_name(&name) || kind_for(&name) != "markdown" {
            continue;
        }
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            out.push(if folder.is_empty() { name } else { format!("{folder}/{name}") });
        }
    }
    out.sort_by_key(|p| p.to_lowercase());
    out
}

/// The three front-matter documents a manuscript folder can hold, by name.
///
/// The Swift app's ChapterRail shows a FRONT MATTER section above the chapters
/// (SWIFT-AUDIT §2.2) and the audit does not say how those files are found. This
/// side settles it by **convention**: a markdown file sitting directly in the
/// manuscript's own folder whose name (without the extension) is one of these,
/// compared case-insensitively. Nothing is created, nothing is renamed — a
/// folder that has none of them simply has an empty front-matter section, with
/// a row that offers to make each one.
///
/// They are deliberately **not** chapters: `chapter_paths_in` leaves them out of
/// a manuscript's chapter order, so a title page is never compiled as chapter
/// one and never counted in "N chapters".
pub const FRONT_MATTER_NAMES: &[&str] = &["Title Page", "Dedication", "Epigraph"];

/// Is `rel` one of `folder`'s front-matter documents?
///
/// Strictly one level down: `Book/Title Page.md` is front matter for `Book`,
/// `Book/Part One/Title Page.md` is an ordinary document.
pub fn is_front_matter(folder: &str, rel: &str) -> bool {
    let Some(name) = rel.strip_prefix(&if folder.is_empty() {
        String::new()
    } else {
        format!("{folder}/")
    }) else {
        return false;
    };
    if name.contains('/') {
        return false;
    }
    if kind_for(name) != "markdown" {
        return false;
    }
    let s = stem(name).to_lowercase();
    FRONT_MATTER_NAMES.iter().any(|n| n.to_lowercase() == s)
}

/// The markdown paths that count as a manuscript's **chapters** — everything
/// `markdown_paths_in` finds, minus the front matter.
pub fn chapter_paths_in(root: &Path, folder: &str) -> Vec<String> {
    markdown_paths_in(root, folder).into_iter().filter(|p| !is_front_matter(folder, p)).collect()
}

/// Which front-matter documents `folder` actually has, in `FRONT_MATTER_NAMES`
/// order, as `(label, relative path)`.
pub fn front_matter_in(root: &Path, folder: &str) -> Vec<(String, String)> {
    let present = markdown_paths_in(root, folder);
    FRONT_MATTER_NAMES
        .iter()
        .filter_map(|label| {
            let want = label.to_lowercase();
            present
                .iter()
                .find(|p| {
                    is_front_matter(folder, p)
                        && stem(p.rsplit('/').next().unwrap_or(p)).to_lowercase() == want
                })
                .map(|p| ((*label).to_string(), p.clone()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn fixture() -> TempDir {
        let t = TempDir::new("tree");
        t.write("Drafts/Ch_01.md", "---\ntitle: A Door of Letters\nstatus: final\n---\n\none two three");
        t.write("Drafts/Ch_02.md", "no frontmatter here, four words");
        t.write("Characters/Old Sennet.md", "---\ntitle: Old Sennet\n---\n\nKeeper.");
        t.write("Research/Cathedral diagram.jpg", "\u{FFFD}jpegish");
        t.write("Research/Bell-pull mechanics.pdf", "%PDF-1.4");
        t.write("Episodes/Pilot — Cold Open.fountain", "INT. LIGHTHOUSE — NIGHT");
        // Things the walk must not show:
        t.write(".aquarius/workflow.json", "{}");
        t.write(".aquarius/trash/index.json", "[]");
        t.write(".DS_Store", "junk");
        t.write("Drafts/.aq-tmp-abc123", "half-written");
        t
    }

    fn child<'a>(node: &'a VaultNode, path: &str) -> &'a VaultNode {
        node.children
            .as_ref()
            .unwrap()
            .iter()
            .find(|c| c.path == path)
            .unwrap_or_else(|| panic!("no node at {path}; tree = {node:#?}"))
    }

    #[test]
    fn walks_folders_and_files_with_the_right_kinds() {
        let t = fixture();
        let (tree, stats) = walk(t.path(), "Lantern, Lantern").unwrap();

        assert_eq!(tree.path, "");
        assert_eq!(tree.name, "Lantern, Lantern");
        assert_eq!(tree.kind, "folder");

        let drafts = child(&tree, "Drafts");
        assert_eq!(drafts.kind, "folder");
        assert_eq!(child(drafts, "Drafts/Ch_01.md").kind, "markdown");
        assert_eq!(child(&tree, "Episodes").children.as_ref().unwrap()[0].kind, "fountain");
        let research = child(&tree, "Research");
        assert_eq!(child(research, "Research/Cathedral diagram.jpg").kind, "image");
        assert_eq!(child(research, "Research/Bell-pull mechanics.pdf").kind, "pdf");

        // Six real files; the metadata + dotfiles are not counted.
        assert_eq!(stats.items, 6);
        assert!(stats.newest.is_some());
    }

    #[test]
    fn hides_metadata_dotfiles_and_temporaries() {
        let t = fixture();
        let (tree, _) = walk(t.path(), "V").unwrap();
        let top: Vec<&str> = tree.children.as_ref().unwrap().iter().map(|c| c.path.as_str()).collect();
        assert!(!top.contains(&".aquarius"), "metadata folder leaked into the tree: {top:?}");
        assert!(!top.contains(&".DS_Store"));
        let drafts = child(&tree, "Drafts");
        let names: Vec<&str> = drafts.children.as_ref().unwrap().iter().map(|c| c.path.as_str()).collect();
        assert_eq!(names, vec!["Drafts/Ch_01.md", "Drafts/Ch_02.md"]);
    }

    #[test]
    fn markdown_carries_frontmatter_and_word_counts() {
        let t = fixture();
        let (tree, _) = walk(t.path(), "V").unwrap();
        let ch1 = child(child(&tree, "Drafts"), "Drafts/Ch_01.md");
        assert_eq!(ch1.name, "Ch_01", "markdown nodes drop the extension");
        assert_eq!(ch1.frontmatter.as_ref().unwrap().get("status").unwrap(), "final");
        assert_eq!(ch1.words, Some(3));

        let ch2 = child(child(&tree, "Drafts"), "Drafts/Ch_02.md");
        assert!(ch2.frontmatter.is_none(), "a file without frontmatter reports none");
        assert_eq!(ch2.words, Some(5));
    }

    #[test]
    fn non_markdown_keeps_its_extension_in_the_name() {
        let t = fixture();
        let (tree, _) = walk(t.path(), "V").unwrap();
        let pdf = child(child(&tree, "Research"), "Research/Bell-pull mechanics.pdf");
        assert_eq!(pdf.name, "Bell-pull mechanics.pdf");
    }

    #[test]
    fn folders_sort_before_files() {
        let t = TempDir::new("tree-sort");
        t.write("aaa.md", "x");
        t.write("Zebra/inner.md", "x");
        let (tree, _) = walk(t.path(), "V").unwrap();
        let kinds: Vec<&str> = tree.children.as_ref().unwrap().iter().map(|c| c.kind.as_str()).collect();
        assert_eq!(kinds, vec!["folder", "markdown"]);
    }

    #[test]
    fn lists_markdown_for_a_manuscript_folder() {
        let t = fixture();
        assert_eq!(
            markdown_paths_in(t.path(), "Drafts"),
            vec!["Drafts/Ch_01.md", "Drafts/Ch_02.md"]
        );
    }

    #[test]
    fn front_matter_is_by_name_one_level_down_and_is_not_a_chapter() {
        let t = TempDir::new("tree-frontmatter");
        t.write("Book/Ch_01.md", "one");
        t.write("Book/title page.md", "cover");
        t.write("Book/Epigraph.md", "a quote");
        // A chapter that merely *mentions* a front-matter name is a chapter.
        t.write("Book/Dedication of the Bell.md", "no");
        // And one nested a level deeper is a document, not this folder's cover.
        t.write("Book/Part One/Title Page.md", "no");

        assert!(is_front_matter("Book", "Book/title page.md"), "case does not matter");
        assert!(!is_front_matter("Book", "Book/Part One/Title Page.md"));
        assert!(!is_front_matter("Book", "Book/Dedication of the Bell.md"));

        assert_eq!(
            chapter_paths_in(t.path(), "Book"),
            vec!["Book/Ch_01.md", "Book/Dedication of the Bell.md"]
        );
        assert_eq!(
            front_matter_in(t.path(), "Book"),
            vec![
                ("Title Page".to_string(), "Book/title page.md".to_string()),
                ("Epigraph".to_string(), "Book/Epigraph.md".to_string()),
            ],
            "reported in FRONT_MATTER_NAMES order, and only the ones that exist"
        );
    }
}
