//! A read-only mirror of `src/lib/frontmatter.ts`.
//!
//! The tree walk needs frontmatter (status dots, corkboard synopses, outline
//! titles) without shipping every file's full text to the renderer. This parses
//! the same subset the TypeScript reader does: flat `key: value` pairs plus
//! `key: |` indented blocks.
//!
//! **This module never writes.** Writing frontmatter stays in the renderer,
//! which is what keeps the byte-for-byte rule honest: a file with no
//! frontmatter is parsed here as "no frontmatter" and nothing is ever
//! serialised back from this side.

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
    fn quotes_are_stripped_and_words_counted() {
        let p = parse("---\ntitle: \"Helmreach in Rain\"\n---\n\none two  three\nfour");
        assert_eq!(p.frontmatter.get("title").unwrap(), "Helmreach in Rain");
        assert_eq!(count_words(&p.body), 4);
    }
}
