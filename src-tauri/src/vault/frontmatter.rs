//! A mirror of `src/lib/frontmatter.ts`.
//!
//! The tree walk needs frontmatter (status dots, corkboard synopses, outline
//! titles) without shipping every file's full text to the renderer. This parses
//! the same subset the TypeScript reader does: flat `key: value` pairs plus
//! `key: |` indented blocks.
//!
//! **Reading is the common case, and until Stage 5 it was the only case.**
//! Writing arrived with the MCP tool `set_frontmatter_status`, which has to
//! change one key in a file nobody has open in the editor. `stringify` and
//! `upsert` below mirror the TypeScript writer exactly, and the byte-for-byte
//! rule is unharmed:
//!
//! * `upsert` only ever runs when a caller asked to change a key; nothing here
//!   is invoked on a plain read or save, so a file with no frontmatter still
//!   never gains one just because the app looked at it;
//! * the result still goes through `fs_ops::atomic::write_atomic`, which does
//!   not touch the file at all when the bytes come out identical.
//!
//! Parity rule: if the TypeScript reader or writer changes, change this in the
//! same commit.

use serde_json::Value;
use std::collections::BTreeMap;

const FENCE: &str = "---";

pub struct Parsed {
    pub frontmatter: BTreeMap<String, Value>,
    pub body: String,
}

pub fn parse(input: &str) -> Parsed {
    let lines: Vec<&str> = input.split('\n').collect();
    if lines.first().map(|l| l.trim()) != Some(FENCE) {
        return Parsed { frontmatter: BTreeMap::new(), body: input.to_string() };
    }
    let mut end: Option<usize> = None;
    for (i, line) in lines.iter().enumerate().skip(1) {
        if line.trim() == FENCE {
            end = Some(i);
            break;
        }
    }
    let Some(end) = end else {
        return Parsed { frontmatter: BTreeMap::new(), body: input.to_string() };
    };

    let yaml = &lines[1..end];
    let mut body_lines = lines[end + 1..].to_vec();
    if body_lines.first() == Some(&"") {
        body_lines.remove(0);
    }

    Parsed { frontmatter: parse_yaml(yaml), body: body_lines.join("\n") }
}

/// Word count matching the renderer's `(s.match(/\S+/g) ?? []).length`.
pub fn count_words(s: &str) -> usize {
    s.split_whitespace().count()
}

fn parse_yaml(lines: &[&str]) -> BTreeMap<String, Value> {
    let mut fm = BTreeMap::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some((key, raw_val)) = split_key(line) {
            if raw_val.trim() == "|" {
                let mut block: Vec<String> = Vec::new();
                while i + 1 < lines.len() && starts_with_space(lines[i + 1]) {
                    i += 1;
                    block.push(strip_indent(lines[i]));
                }
                fm.insert(key, Value::String(block.join("\n")));
            } else {
                fm.insert(key, Value::String(strip_quotes(raw_val.trim()).to_string()));
            }
        }
        i += 1;
    }
    fm
}

/// `^([A-Za-z0-9_-]+)\s*:\s*(.*)$`
fn split_key(line: &str) -> Option<(String, &str)> {
    let colon = line.find(':')?;
    let key = &line[..colon];
    if key.is_empty()
        || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some((key.to_string(), line[colon + 1..].trim_start()))
}

fn starts_with_space(line: &str) -> bool {
    line.starts_with(' ') || line.starts_with('\t')
}

/// Drop up to two leading spaces — the same `replace(/^\s\s?/, "")` the TS does.
fn strip_indent(line: &str) -> String {
    let mut rest = line;
    for _ in 0..2 {
        if let Some(r) = rest.strip_prefix(' ') {
            rest = r;
        } else {
            break;
        }
    }
    rest.to_string()
}

/// Set one frontmatter key, leaving every other byte of the file alone.
///
/// This is **line surgery, not parse-and-reserialise**, and that is deliberate.
/// Round-tripping through the parser would reorder keys (this side reads into a
/// `BTreeMap`, which is alphabetical, while the file's order is the writer's)
/// and would quietly drop any YAML shape this deliberately-small parser does
/// not understand — lists, nested maps, anchors. Editing the one line that owns
/// the key cannot do either.
///
/// A file with no frontmatter block gains one, containing only this key. That
/// only happens because a caller explicitly asked to set a key; nothing on the
/// read or save path calls this.
pub fn upsert(input: &str, key: &str, value: &str) -> String {
    let rendered = format!("{key}: {}", format_scalar(value));
    let lines: Vec<&str> = input.split('\n').collect();

    let opens = lines.first().map(|l| l.trim()) == Some(FENCE);
    let close = if opens {
        lines.iter().enumerate().skip(1).find(|(_, l)| l.trim() == FENCE).map(|(i, _)| i)
    } else {
        None
    };

    let Some(close) = close else {
        // No frontmatter block (or an unterminated fence, which the reader also
        // treats as none). Put one in front of the file as it stands.
        return format!("{FENCE}\n{rendered}\n{FENCE}\n\n{input}");
    };

    let mut out: Vec<String> = vec![lines[0].to_string()];
    let mut replaced = false;
    let mut i = 1;
    while i < close {
        let line = lines[i];
        match split_key(line) {
            Some((k, raw)) if k == key => {
                let cr = if line.ends_with('\r') { "\r" } else { "" };
                out.push(format!("{rendered}{cr}"));
                replaced = true;
                // A `key: |` block owns the indented lines under it; they go
                // with the value being replaced.
                if raw.trim_end_matches('\r').trim() == "|" {
                    while i + 1 < close && starts_with_space(lines[i + 1]) {
                        i += 1;
                    }
                }
            }
            _ => out.push(line.to_string()),
        }
        i += 1;
    }
    if !replaced {
        out.push(rendered);
    }
    for line in &lines[close..] {
        out.push((*line).to_string());
    }
    out.join("\n")
}

/// Mirrors `formatScalar` in the TypeScript writer: quote only when the value
/// would otherwise be ambiguous YAML.
fn format_scalar(v: &str) -> String {
    let needs_quotes = v.contains(':')
        || v.contains('#')
        || v.contains('-')
        || v.contains('?')
        || v.starts_with(char::is_whitespace)
        || v.ends_with(char::is_whitespace);
    let plain_enough = !v.is_empty()
        && v.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '_' | '/' | '.' | ',' | '\'' | '-' | ' ' | '\t')
        });
    if needs_quotes && !plain_enough {
        format!("\"{}\"", v.replace('"', "\\\""))
    } else {
        v.to_string()
    }
}

fn strip_quotes(v: &str) -> &str {
    if v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')))
    {
        &v[1..v.len() - 1]
    } else {
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_frontmatter_is_reported_as_none() {
        let p = parse("Just a paragraph.\n\nAnd another.");
        assert!(p.frontmatter.is_empty());
        assert_eq!(p.body, "Just a paragraph.\n\nAnd another.");
    }

    #[test]
    fn unterminated_fence_is_not_frontmatter() {
        let src = "---\ntitle: Nope\n\nbody text";
        let p = parse(src);
        assert!(p.frontmatter.is_empty());
        assert_eq!(p.body, src, "the whole file stays body when the fence never closes");
    }

    #[test]
    fn flat_keys_and_block_scalars() {
        let src = "---\ntitle: A Door of Letters\nstatus: drafting\nsynopsis: |\n  Fifty-three letters\n  from her grandfather.\n---\n\nShe does not open them.";
        let p = parse(src);
        assert_eq!(p.frontmatter.get("title").unwrap(), "A Door of Letters");
        assert_eq!(p.frontmatter.get("status").unwrap(), "drafting");
        assert_eq!(
            p.frontmatter.get("synopsis").unwrap(),
            "Fifty-three letters\nfrom her grandfather."
        );
        assert_eq!(p.body, "She does not open them.");
    }

    #[test]
    fn upsert_replaces_one_key_and_leaves_the_rest_byte_for_byte() {
        let src = "---\ntitle: A Door of Letters\nstatus: drafting\nsynopsis: |\n  Fifty-three letters\n  from her grandfather.\n---\n\nShe does not open them.\n";
        let out = upsert(src, "status", "final");
        assert_eq!(
            out,
            "---\ntitle: A Door of Letters\nstatus: final\nsynopsis: |\n  Fifty-three letters\n  from her grandfather.\n---\n\nShe does not open them.\n"
        );
        // Key order and the block scalar both survive.
        let p = parse(&out);
        assert_eq!(p.frontmatter.get("status").unwrap(), "final");
        assert_eq!(p.frontmatter.get("title").unwrap(), "A Door of Letters");
        assert!(p.frontmatter.get("synopsis").unwrap().as_str().unwrap().contains("grandfather"));
    }

    #[test]
    fn upsert_appends_a_missing_key_at_the_end_of_the_block() {
        let src = "---\ntitle: Helmreach\n---\n\nbody";
        assert_eq!(upsert(src, "status", "outline"), "---\ntitle: Helmreach\nstatus: outline\n---\n\nbody");
    }

    #[test]
    fn upsert_gives_a_bare_file_a_frontmatter_block() {
        let src = "Just prose.\n";
        assert_eq!(upsert(src, "status", "drafting"), "---\nstatus: drafting\n---\n\nJust prose.\n");
    }

    #[test]
    fn upsert_replacing_a_block_scalar_drops_its_indented_lines() {
        let src = "---\nsynopsis: |\n  one\n  two\ntitle: T\n---\n\nbody";
        assert_eq!(upsert(src, "synopsis", "short"), "---\nsynopsis: short\ntitle: T\n---\n\nbody");
    }

    #[test]
    fn upsert_quotes_only_what_would_be_ambiguous() {
        // Plain words, slashes and commas stay bare — matching the TS writer.
        assert!(upsert("---\na: 1\n---\n\nb", "title", "Old Sennet").contains("title: Old Sennet"));
        assert!(upsert("---\na: 1\n---\n\nb", "title", "Ch 1: The Bell").contains("title: \"Ch 1: The Bell\""));
    }

    #[test]
    fn quotes_are_stripped_and_words_counted() {
        let p = parse("---\ntitle: \"Helmreach in Rain\"\n---\n\none two  three\nfour");
        assert_eq!(p.frontmatter.get("title").unwrap(), "Helmreach in Rain");
        assert_eq!(count_words(&p.body), 4);
    }
}
