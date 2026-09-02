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
