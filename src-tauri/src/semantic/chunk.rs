//! Cutting a document into pieces small enough for the model to read.
//!
//! bge-small stops looking after 512 tokens, which is roughly 390 words of
//! English prose. A 3,000-word chapter handed to it whole would be searched
//! down to about its first page and the rest would be silently invisible —
//! which is worse than no feature, because nothing on screen would say so.
//!
//! So documents are cut into **180-word chunks**, the same grain the Swift app
//! uses. That is a comfortable fit under the ceiling and it is the right size
//! for the answer as well: a hit should land on a paragraph the writer can
//! read, not on a chapter they then have to search by eye.
//!
//! Two rules make the chunks land where a reader expects:
//!
//! * **Paragraphs are packed, never split** — whole paragraphs go into a chunk
//!   until the next one would take it past 180 words.
//! * **Except when one paragraph is itself over 180 words**, in which case it
//!   is cut at sentence ends, because the alternative is cutting mid-clause.
//!
//! Every chunk records the **0-based body line** it starts on — body meaning
//! after the frontmatter block, which is exactly the numbering `insert_text`
//! and `replace_lines` use (NOTES §23b). A hit can therefore be jumped to
//! without anything having to re-derive where it was.

/// Words per chunk. Matches the Swift app.
pub const CHUNK_WORDS: usize = 180;

/// How much of a chunk is kept as a human-readable preview in the index.
const PREVIEW_CHARS: usize = 200;

// ---------------------------------------------------------------------------
// The hostile-input guards (NOTES §34)
// ---------------------------------------------------------------------------
//
// A vault is a folder somebody chose, and §33 already learned what that means:
// Royce's has an Unreal Engine project in it. One of its files is a shader
// cache key: **3,213,390 bytes on one line.** An equivalent file from the
// same engine, measured here, is 3,211,645 bytes with exactly two spaces in
// it and one unbroken run of 3,211,559 characters. The backfill handed the
// whole thing to the tokenizer — 1.3 s of *every core*, in release, to
// produce one vector of a string that is not English and means nothing. The ignore list below
// (`paths::is_ignored_dir_in`) means that particular file is never reached
// again, but the guards here are what make the *class* of file harmless, in a
// vault whose folders nobody has thought of yet.
//
// Three ceilings, all of them tunable constants with a reason attached.

/// The most text any one chunk hands the model.
///
/// bge-small stops after 512 tokens whatever it is given (`with_max_length`),
/// so everything past that point is paid for in tokenizing and then thrown
/// away. English prose runs about four characters to a WordPiece token, which
/// puts 512 tokens at roughly 2,000 characters — and a 180-word chunk of real
/// prose is about 1,100 characters, so **this cap can never bite on a
/// document written by a person.** A chunk over 2,000 characters is, by
/// arithmetic, not 180 words of English.
///
/// The cut is made on a char boundary and **before** the tokenizer sees the
/// string, which is the whole point: truncating afterwards would already have
/// paid the cost.
pub const MAX_CHUNK_CHARS: usize = 2_000;

/// A body bigger than this is not a manuscript.
///
/// One megabyte is about 170,000 words — twice a long novel — in a single
/// file. Everything of that size seen in the wild so far is generated: a
/// shader key, a log, a minified bundle, a data dump.
pub const MAX_BODY_BYTES: usize = 1_048_576;

/// The longest run of characters with no whitespace in it that still reads as
/// writing.
///
/// The longest word in English is 45 letters. A 1,000-character run is a
/// hash, a base64 blob, a minified line, or a shader key — the measured file's
/// run was 3,211,559 characters.
pub const MAX_UNBROKEN_RUN_CHARS: usize = 1_000;

/// The largest average word length that is still prose. English averages
/// about five characters; 40 is a wide margin that only machine output clears.
pub const MAX_AVERAGE_WORD_CHARS: usize = 40;

/// Below this many words the average is not worth trusting. A two-line note
/// whose second line is one long URL has an average word length of 66, and it
/// is still a note; fifty words is enough for the mean to mean something.
const MIN_WORDS_FOR_AVERAGE: usize = 50;

/// The most chunks one document may contribute.
///
/// 2,000 chunks is 360,000 words, four times the longest novel anyone will
/// write in this app. Past it, something is wrong with the file rather than
/// long about it, and the honest answer is to index the beginning and say so.
pub const MAX_CHUNKS_PER_DOC: usize = 2_000;

/// Why this document is not prose, or `None` if it is.
///
/// Runs **before** the chunker and before the tokenizer, in one pass, and
/// stops early on the first run that is too long — so the expensive answer
/// ("this is a 3 MB shader key") is also the fastest one to reach.
///
/// The reason is a sentence, because it ends up in the manifest and in a log
/// line somebody has to read.
pub fn non_prose_reason(body: &str) -> Option<String> {
    if body.len() > MAX_BODY_BYTES {
        return Some(format!(
            "not prose: {} bytes of body, over the {} byte ceiling",
            body.len(),
            MAX_BODY_BYTES
        ));
    }

    let mut run = 0usize;
    let mut longest = 0usize;
    let mut words = 0usize;
    let mut word_chars = 0usize;
    for c in body.chars() {
        if c.is_whitespace() {
            if run > 0 {
                words += 1;
                word_chars += run;
            }
            run = 0;
            continue;
        }
        run += 1;
        if run > longest {
            longest = run;
            if longest > MAX_UNBROKEN_RUN_CHARS {
                // No point counting the rest: this is already not writing.
                return Some(format!(
                    "not prose: a run of over {MAX_UNBROKEN_RUN_CHARS} characters with no space in it"
                ));
            }
        }
    }
    if run > 0 {
        words += 1;
        word_chars += run;
    }

    if words >= MIN_WORDS_FOR_AVERAGE {
        let average = word_chars / words;
        if average > MAX_AVERAGE_WORD_CHARS {
            return Some(format!(
                "not prose: an average word length of {average} characters"
            ));
        }
    }
    None
}

/// Cut a document into chunks, capping how many one document may produce.
///
/// The second value is the reason to record when the cap bit — `None` when
/// the whole document fitted, which is every document anyone has written.
pub fn chunk_document(body: &str) -> (Vec<Chunk>, Option<String>) {
    let mut chunks = chunk_body(body);
    if chunks.len() > MAX_CHUNKS_PER_DOC {
        let found = chunks.len();
        chunks.truncate(MAX_CHUNKS_PER_DOC);
        return (
            chunks,
            Some(format!(
                "only the first {MAX_CHUNKS_PER_DOC} of {found} chunks were indexed"
            )),
        );
    }
    (chunks, None)
}

/// Clip a string to `max` **characters**, never mid-character.
fn clamp_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((byte, _)) => s[..byte].to_string(),
        None => s.to_string(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    /// 0-based line in the document **body** where this chunk starts.
    pub line: usize,
    /// How many words it holds.
    pub words: usize,
    /// The text handed to the model.
    pub text: String,
    /// A short, single-line version for the results list.
    pub preview: String,
}

/// Cut a document body into chunks.
///
/// Takes the **body** — frontmatter already removed by
/// `vault::frontmatter::parse` — because the line numbers have to agree with
/// the editor's, and because a YAML block is not prose worth searching.
pub fn chunk_body(body: &str) -> Vec<Chunk> {
    let mut out: Vec<Chunk> = Vec::new();
    for para in paragraphs(body) {
        if para.words > CHUNK_WORDS {
            for piece in split_long_paragraph(&para) {
                push(&mut out, piece);
            }
        } else {
            push(&mut out, para);
        }
    }
    // The cap is applied here, once, at the end: every path into `out` goes
    // through `push`, and `push` grows a chunk by packing, so a chunk's final
    // length is only known when nothing more can be added to it.
    for chunk in out.iter_mut() {
        if chunk.text.chars().count() > MAX_CHUNK_CHARS {
            chunk.text = clamp_chars(&chunk.text, MAX_CHUNK_CHARS);
        }
    }
    out
}

/// A run of non-blank lines, with the line it started on.
#[derive(Debug, Clone)]
struct Para {
    line: usize,
    words: usize,
    text: String,
}

fn word_count(s: &str) -> usize {
    s.split_whitespace().count()
}

fn paragraphs(body: &str) -> Vec<Para> {
    let mut out = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let mut start = 0usize;
    for (i, line) in body.split('\n').enumerate() {
        if line.trim().is_empty() {
            if !current.is_empty() {
                out.push(make_para(start, &current));
                current.clear();
            }
            continue;
        }
        if current.is_empty() {
            start = i;
        }
        current.push(line);
    }
    if !current.is_empty() {
        out.push(make_para(start, &current));
    }
    out
}

fn make_para(line: usize, lines: &[&str]) -> Para {
    let text = lines.join("\n");
    Para { line, words: word_count(&text), text }
}

/// Cut a paragraph that is on its own too long, at sentence ends.
///
/// Line numbers inside a single paragraph are all the paragraph's first line:
/// a sentence-level line number would be a lie for a paragraph that is one
/// long wrapped line, which is what prose written in this app usually is.
fn split_long_paragraph(para: &Para) -> Vec<Para> {
    let mut out = Vec::new();
    let mut buffer: Vec<&str> = Vec::new();
    let mut words = 0usize;
    for sentence in sentences(&para.text) {
        let w = word_count(sentence);
        if words > 0 && words + w > CHUNK_WORDS {
            out.push(Para { line: para.line, words, text: buffer.join(" ") });
            buffer.clear();
            words = 0;
        }
        buffer.push(sentence);
        words += w;
        // One sentence longer than a whole chunk is a run-on, an epigraph, or
        // a table. It goes out on its own rather than being cut mid-clause;
        // the model will read the first 512 tokens of it, which is the best
        // that can honestly be done without inventing a boundary.
        if words >= CHUNK_WORDS {
            out.push(Para { line: para.line, words, text: buffer.join(" ") });
            buffer.clear();
            words = 0;
        }
    }
    if !buffer.is_empty() {
        out.push(Para { line: para.line, words, text: buffer.join(" ") });
    }
    out
}

/// Split on `.`, `!` or `?` followed by whitespace. Deliberately naive: this
/// decides where a chunk boundary falls, not what a sentence *is*, and the
/// cost of getting it wrong is a slightly odd chunk edge.
fn sentences(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c == '.' || c == '!' || c == '?' {
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                j += 1;
            }
            if j > i + 1 || j == bytes.len() {
                let piece = text[start..j].trim();
                if !piece.is_empty() {
                    out.push(piece);
                }
                start = j;
                i = j;
                continue;
            }
        }
        i += 1;
    }
    let tail = text[start..].trim();
    if !tail.is_empty() {
        out.push(tail);
    }
    out
}

/// Add a paragraph to the chunk list, packing it onto the previous chunk when
/// the two together still fit.
fn push(out: &mut Vec<Chunk>, para: Para) {
    if para.words == 0 {
        return;
    }
    if let Some(last) = out.last_mut() {
        if last.words + para.words <= CHUNK_WORDS {
            last.text.push_str("\n\n");
            last.text.push_str(&para.text);
            last.words += para.words;
            last.preview = preview_of(&last.text);
            return;
        }
    }
    out.push(Chunk {
        line: para.line,
        words: para.words,
        preview: preview_of(&para.text),
        text: para.text,
    });
}

/// One line, clipped, for the results list. Markdown is left alone — a heading
/// still reads as a heading with its hashes on, and stripping them would be a
/// second markdown parser to keep in step with the editor's.
fn preview_of(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= PREVIEW_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(PREVIEW_CHARS).collect();
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(n: usize, word: &str) -> String {
        vec![word; n].join(" ")
    }

    #[test]
    fn short_paragraphs_pack_together_and_keep_the_first_line_number() {
        let body = "One two three.\n\nFour five six.\n\nSeven eight.";
        let chunks = chunk_body(body);
        assert_eq!(chunks.len(), 1, "three tiny paragraphs are one chunk");
        assert_eq!(chunks[0].line, 0);
        assert_eq!(chunks[0].words, 8);
        assert!(chunks[0].text.contains("Seven eight."));
    }

    #[test]
    fn packing_stops_before_the_ceiling_and_the_next_chunk_knows_its_line() {
        // 100 words, blank line, 100 words: the second cannot join the first.
        let body = format!("{}\n\n{}", words(100, "alpha"), words(100, "beta"));
        let chunks = chunk_body(&body);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].words, 100);
        assert_eq!(chunks[1].words, 100);
        assert_eq!(chunks[0].line, 0);
        assert_eq!(chunks[1].line, 2, "0-based body lines: text, blank, text");
        assert!(chunks[1].text.starts_with("beta"));
    }

    #[test]
    fn no_chunk_is_ever_over_the_ceiling_from_packing() {
        let body = (0..20).map(|_| words(30, "word")).collect::<Vec<_>>().join("\n\n");
        for c in chunk_body(&body) {
            assert!(c.words <= CHUNK_WORDS, "packed to {} words", c.words);
        }
    }

    #[test]
    fn one_huge_paragraph_is_cut_at_sentence_ends() {
        // Twelve sentences of 40 words each — 480 words in one paragraph.
        let body = (0..12).map(|_| format!("{}.", words(40, "sentence"))).collect::<Vec<_>>().join(" ");
        let chunks = chunk_body(&body);
        assert!(chunks.len() >= 3, "480 words cannot be one 180-word chunk");
        for c in &chunks {
            assert!(c.words <= CHUNK_WORDS + 40, "a chunk grew past one sentence of slack");
            assert!(c.text.trim_end().ends_with('.'), "cuts land at sentence ends: {:?}", c.text);
        }
        let total: usize = chunks.iter().map(|c| c.words).sum();
        assert_eq!(total, 12 * 40, "no words were dropped on the way through");
    }

    #[test]
    fn a_single_sentence_longer_than_a_chunk_goes_out_whole() {
        let body = format!("{}.", words(400, "endless"));
        let chunks = chunk_body(&body);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].words, 400);
    }

    #[test]
    fn an_empty_or_blank_document_has_no_chunks() {
        assert!(chunk_body("").is_empty());
        assert!(chunk_body("\n\n   \n\n").is_empty());
    }

    // ── the hostile-input guards ─────────────────────────────────────────

    /// The file that started §34, in miniature: one line, no spaces, hex.
    fn shader_key(chars: usize) -> String {
        let hex = b"0123456789ABCDEF";
        let mut s = String::with_capacity(chars);
        let mut n: u64 = 12_345;
        while s.len() < chars {
            n = n.wrapping_mul(6364136223846793005).wrapping_add(1);
            s.push(hex[(n >> 33) as usize % 16] as char);
        }
        s
    }

    #[test]
    fn a_shader_key_is_not_prose_and_saying_so_is_instant() {
        let body = shader_key(3_213_297);
        let t = std::time::Instant::now();
        let reason = non_prose_reason(&body).expect("3 MB on one line is not writing");
        let took = t.elapsed();
        assert!(reason.starts_with("not prose:"), "{reason}");
        // The size ceiling answers first, so nothing scans three megabytes.
        assert!(reason.contains("bytes of body"), "{reason}");
        assert!(took.as_millis() < 50, "the refusal took {took:?}");
    }

    #[test]
    fn a_long_unbroken_run_is_not_prose_even_in_a_small_file() {
        // Under the size ceiling, so this is the run rule doing the work.
        let body = format!("A note about a build.\n\n{}", shader_key(4_000));
        let reason = non_prose_reason(&body).expect("a 4,000-character token is not a word");
        assert!(reason.contains("no space in it"), "{reason}");
    }

    #[test]
    fn absurd_average_word_length_is_not_prose() {
        // Every "word" is 60 characters — under the run ceiling one at a time,
        // and still not something a person wrote.
        let body = (0..60).map(|_| shader_key(60)).collect::<Vec<_>>().join(" ");
        let reason = non_prose_reason(&body).expect("60-character words are machine output");
        assert!(reason.contains("average word length"), "{reason}");
    }

    #[test]
    fn real_writing_passes_every_guard() {
        let prose = "The lantern went out on the stairs, and she did not go back for it.\n\n\
                     He had left the door open, which was the whole of the argument.";
        assert_eq!(non_prose_reason(prose), None);
        // Including a long one, and one carrying a long URL.
        let long = (0..500).map(|_| prose).collect::<Vec<_>>().join("\n\n");
        assert_eq!(non_prose_reason(&long), None);
        let with_url = format!("See {}{} for the rest.", "https://example.com/", "a".repeat(300));
        assert_eq!(non_prose_reason(&with_url), None, "one long URL is not a data dump");
    }

    #[test]
    fn no_chunk_ever_hands_the_model_more_than_the_char_cap() {
        // A run-on sentence of 400 words goes out whole (the test above), so
        // it is the case where the char cap has to be the thing that bounds it.
        let body = format!("{}.", words(4_000, "endless"));
        for c in chunk_body(&body) {
            assert!(
                c.text.chars().count() <= MAX_CHUNK_CHARS,
                "a chunk of {} characters reached the tokenizer",
                c.text.chars().count()
            );
        }
        // And the cut is on a char boundary, whatever the text is made of.
        let emoji = "🜁🜂🜃🜄".repeat(2_000);
        for c in chunk_body(&emoji) {
            assert!(c.text.chars().count() <= MAX_CHUNK_CHARS);
        }
    }

    #[test]
    fn the_char_cap_never_touches_a_real_chunk() {
        let body = (0..40)
            .map(|_| "She counted the stairs on the way down and lost the number twice over.")
            .collect::<Vec<_>>()
            .join("\n\n");
        for c in chunk_body(&body) {
            assert!(c.words <= CHUNK_WORDS);
            assert!(
                c.text.chars().count() < MAX_CHUNK_CHARS,
                "180 words of English is well under {MAX_CHUNK_CHARS} characters"
            );
        }
    }

    #[test]
    fn a_document_with_too_many_chunks_is_cut_and_says_so() {
        // Each paragraph is its own chunk: 180 words, so nothing packs.
        let para = words(CHUNK_WORDS, "word");
        let body = (0..MAX_CHUNKS_PER_DOC + 5).map(|_| para.clone()).collect::<Vec<_>>().join("\n\n");
        let (chunks, reason) = chunk_document(&body);
        assert_eq!(chunks.len(), MAX_CHUNKS_PER_DOC);
        let reason = reason.expect("the cap bit, so it has to be recorded");
        assert!(reason.contains(&MAX_CHUNKS_PER_DOC.to_string()), "{reason}");

        // And an ordinary document reports nothing.
        let (chunks, reason) = chunk_document("One two three.\n\nFour five six.");
        assert_eq!(chunks.len(), 1);
        assert_eq!(reason, None);
    }

    #[test]
    fn the_preview_is_one_clipped_line() {
        let body = format!("A heading\nand a body line.\n\n{}", words(300, "long"));
        let chunks = chunk_body(&body);
        assert!(!chunks[0].preview.contains('\n'));
        for c in &chunks {
            assert!(c.preview.chars().count() <= PREVIEW_CHARS + 1);
        }
    }
}
