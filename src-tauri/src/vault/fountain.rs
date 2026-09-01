//! A minimal Fountain scene scanner — enough to index a screenplay and move
//! its scenes around, and deliberately nothing more.
//!
//! The renderer already parses Fountain properly (`src/lib/fountain.ts` leans
//! on `fountain-js` for the full grammar: dual dialogue, boneyards, title
//! pages). None of that is reachable from the Rust side, and the MCP tools
//! `list_scenes` / `reorder_scenes` need exactly one thing out of a script:
//! **where the scene headings are**. So this is a line scanner, not a parser.
//!
//! The heading rule mirrors `SCENE_HEAD_RE` in `src/lib/fountain.ts`, which in
//! turn mirrors the Swift app's `Fountain.swift`: a line whose trimmed text
//! starts with `INT.`, `EXT.`, `EST.`, `INT./EXT.` or `I/E.`, **or** a forced
//! heading — a line beginning with a single `.` followed by something that is
//! neither another dot nor whitespace. This side matches the prefixes
//! case-insensitively; the TypeScript regex is upper-case only, which means
//! Rust accepts a lowercase `int. kitchen` the renderer would paint as action.
//! That asymmetry is on purpose: a tool refusing to see a scene the writer can
//! see is worse than one that sees a scene the syntax highlighter missed.
//!
//! **Line numbers here are 1-based and count body lines** — the same numbers
//! `ops::insert_text` and `ops::replace_lines` take, so a scene's range can be
//! handed straight to `replace_lines`. See `ops::split_body`.

use serde::Serialize;

/// One scene heading and the block of text it owns.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    /// 0-based position in the script. This is what `reorder_scenes` permutes.
    pub index: usize,
    /// The heading line exactly as written, trimmed.
    pub heading: String,
    /// The heading without its `#12#` scene number and without the `.` of a
    /// forced heading — what a human calls the slug.
    pub slug: String,
    /// The `#…#` scene number, when the script carries one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    /// 1-based body line of the heading itself.
    pub start_line: usize,
    /// 1-based body line of the last line this scene owns — the line before
    /// the next heading, or the end of the script.
    pub end_line: usize,
    /// How many words are in the scene, heading included.
    pub words: usize,
}

/// Is this line a scene heading?
pub fn is_scene_heading(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    // A forced heading: ".SHIP'S HOLD". A leading ".." is Fountain's escape for
    // a literal dot, and ". " is just a line starting with punctuation.
    if let Some(rest) = t.strip_prefix('.') {
        return !rest.is_empty()
            && !rest.starts_with('.')
            && !rest.starts_with(char::is_whitespace);
    }
    const PREFIXES: &[&str] = &["INT./EXT.", "INT/EXT.", "I/E.", "INT.", "EXT.", "EST."];
    let upper = t.to_uppercase();
    PREFIXES.iter().any(|p| upper.starts_with(p))
}

/// Split a heading into its slug and its `#…#` scene number.
fn slug_and_number(heading: &str) -> (String, Option<String>) {
    let t = heading.trim();
    let mut slug = t;
    let mut number = None;
    if t.ends_with('#') && t.len() >= 2 {
        if let Some(open) = t[..t.len() - 1].rfind('#') {
            let inner = &t[open + 1..t.len() - 1];
            if !inner.is_empty() && !inner.contains('#') {
                number = Some(inner.to_string());
                slug = t[..open].trim_end();
            }
        }
    }
    let slug = slug.strip_prefix('.').unwrap_or(slug).trim().to_string();
    (slug, number)
}

/// Every scene heading in `body`, in order.
///
/// `body` is body text — pass `ops::split_body(content).1`, not the raw file,
/// or the line numbers will be off by the height of the frontmatter block.
pub fn collect_scenes(body: &str) -> Vec<Scene> {
    let lines: Vec<&str> = body.split('\n').collect();
    let heads: Vec<usize> =
        (0..lines.len()).filter(|&i| is_scene_heading(lines[i])).collect();

    heads
        .iter()
        .enumerate()
        .map(|(index, &start)| {
            let end = heads.get(index + 1).map(|&n| n - 1).unwrap_or(lines.len() - 1);
            let heading = lines[start].trim().to_string();
            let (slug, number) = slug_and_number(&heading);
            Scene {
                index,
                heading,
                slug,
                number,
                start_line: start + 1,
                end_line: end + 1,
                words: lines[start..=end].iter().map(|l| l.split_whitespace().count()).sum(),
            }
        })
        .collect()
}

/// Rewrite `body` with its scenes in the order `order` names.
///
/// `order` is a permutation of `0..scene_count` — every index exactly once,
/// none invented. Anything else is refused rather than half-applied: a
/// "reorder" that silently dropped a scene would take a chunk of the script
/// with it.
///
/// **Whatever sits above the first heading does not move.** In a screenplay
/// that is the title page and any opening action, and a reorder that shuffled
/// the title page into the middle of act two would be a very confusing bug.
pub fn reorder_scenes(body: &str, order: &[usize]) -> Result<String, String> {
    let scenes = collect_scenes(body);
    if scenes.is_empty() {
        return Err("no scene headings in this document — nothing to reorder".into());
    }

    let mut seen = vec![false; scenes.len()];
    for &i in order {
        match seen.get_mut(i) {
            Some(slot) if !*slot => *slot = true,
            Some(_) => return Err(format!("scene {i} appears twice in the new order")),
            None => {
                return Err(format!(
                    "there is no scene {i} — this script has {} (0–{})",
                    scenes.len(),
                    scenes.len() - 1
                ))
            }
        }
    }
    if let Some(missing) = seen.iter().position(|s| !s) {
        return Err(format!(
            "the new order must list all {} scenes, each once — scene {missing} is missing",
            scenes.len()
        ));
    }

    // A trailing newline belongs to the file, not to the last scene: split it
    // off so it cannot be carried into the middle of the script by a move.
    let (core, tail) = match body.strip_suffix('\n') {
        Some(c) => (c, "\n"),
        None => (body, ""),
    };
    let lines: Vec<&str> = core.split('\n').collect();
    let first = scenes[0].start_line - 1;

    let mut out: Vec<&str> = lines[..first].to_vec();
    for &i in order {
        let s = &scenes[i];
        // Fountain wants a blank line above a scene heading. Scene blocks
        // usually end with one, but the *last* scene in a script does not — so
        // moving it anywhere but the end would glue its heading onto the line
        // above and the heading would stop being a heading. One blank line is
        // inserted only where that would happen, which leaves an identity
        // permutation byte-identical.
        if !out.last().map(|l| l.trim().is_empty()).unwrap_or(true) {
            out.push("");
        }
        let end = s.end_line.min(lines.len());
        out.extend_from_slice(&lines[s.start_line - 1..end]);
    }
    Ok(format!("{}{tail}", out.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCRIPT: &str = "Title: Helmreach\nCredit: Written by\n\nFADE IN:\n\nINT. LIGHTHOUSE - NIGHT\n\nShe climbs.\n\nEXT. CLIFF PATH - LATER #12#\n\nRain.\nMore rain.\n\n.THE BELL ROOM\n\nSilence.\n";

    #[test]
    fn recognises_every_heading_shape_and_nothing_else() {
        for good in [
            "INT. KITCHEN - DAY",
            "EXT. FIELD",
            "EST. THE TOWN - DAWN",
            "INT./EXT. CAR - MOVING",
            "I/E. CAR",
            "  INT. INDENTED - DAY",
            "int. lowercase - day",
            ".FORCED HEADING",
        ] {
            assert!(is_scene_heading(good), "should be a heading: {good:?}");
        }
        for bad in [
            "",
            "   ",
            "She climbs.",
            "INTERIOR MONOLOGUE",
            "Title: Helmreach",
            "..a literal dot",
            ". spaced",
            "CUT TO:",
        ] {
            assert!(!is_scene_heading(bad), "should not be a heading: {bad:?}");
        }
    }

    #[test]
    fn indexes_scenes_with_slugs_numbers_and_line_ranges() {
        let scenes = collect_scenes(SCRIPT);
        assert_eq!(scenes.len(), 3);

        assert_eq!(scenes[0].index, 0);
        assert_eq!(scenes[0].heading, "INT. LIGHTHOUSE - NIGHT");
        assert_eq!(scenes[0].slug, "INT. LIGHTHOUSE - NIGHT");
        assert_eq!(scenes[0].number, None);
        assert_eq!((scenes[0].start_line, scenes[0].end_line), (6, 9));

        assert_eq!(scenes[1].heading, "EXT. CLIFF PATH - LATER #12#");
        assert_eq!(scenes[1].slug, "EXT. CLIFF PATH - LATER", "the scene number is not the slug");
        assert_eq!(scenes[1].number.as_deref(), Some("12"));
        assert_eq!((scenes[1].start_line, scenes[1].end_line), (10, 14));

        assert_eq!(scenes[2].slug, "THE BELL ROOM", "a forced heading loses its dot");
        assert_eq!(scenes[2].start_line, 15);
        assert_eq!(
            scenes[2].end_line, 18,
            "the last scene runs to the end of the script, trailing blank included"
        );
    }

    #[test]
    fn a_script_with_no_headings_indexes_as_empty() {
        assert!(collect_scenes("Just prose.\n\nMore prose.\n").is_empty());
        assert!(collect_scenes("").is_empty());
    }

    #[test]
    fn reordering_moves_whole_scenes_and_leaves_the_title_page_alone() {
        let out = reorder_scenes(SCRIPT, &[2, 0, 1]).unwrap();
        assert!(
            out.starts_with("Title: Helmreach\nCredit: Written by\n\nFADE IN:\n\n"),
            "everything above the first heading stays put: {out:?}"
        );
        let scenes = collect_scenes(&out);
        assert_eq!(
            scenes.iter().map(|s| s.slug.as_str()).collect::<Vec<_>>(),
            ["THE BELL ROOM", "INT. LIGHTHOUSE - NIGHT", "EXT. CLIFF PATH - LATER"]
        );
        assert!(out.contains("Rain.\nMore rain."), "a scene's body travels with its heading");
        assert!(out.ends_with('\n'), "the file keeps its trailing newline");

        // The identity permutation is a true no-op, byte for byte.
        assert_eq!(reorder_scenes(SCRIPT, &[0, 1, 2]).unwrap(), SCRIPT);
    }

    #[test]
    fn reordering_refuses_anything_that_is_not_a_permutation() {
        for bad in [vec![0, 1], vec![0, 1, 1], vec![0, 1, 3], vec![]] {
            let err = reorder_scenes(SCRIPT, &bad).unwrap_err();
            assert!(!err.is_empty(), "{bad:?} must be refused with a reason");
        }
        assert!(reorder_scenes(SCRIPT, &[0, 1, 2, 2]).is_err());
        assert!(
            reorder_scenes("no headings here\n", &[0]).is_err(),
            "nothing to reorder is an error, not an empty rewrite"
        );
    }

    #[test]
    fn moving_the_last_scene_up_keeps_the_blank_line_a_heading_needs() {
        // The last scene has no trailing blank line of its own. Without the
        // separator this inserts, the next heading would land directly under
        // "two" and stop parsing as a heading at all.
        let src = "INT. A\n\none\n\nINT. B\n\ntwo";
        let out = reorder_scenes(src, &[1, 0]).unwrap();
        assert_eq!(out, "INT. B\n\ntwo\n\nINT. A\n\none\n");
        assert_eq!(
            collect_scenes(&out).iter().map(|s| s.slug.as_str()).collect::<Vec<_>>(),
            ["INT. B", "INT. A"],
            "the rewritten script still parses as two scenes"
        );
    }
}
