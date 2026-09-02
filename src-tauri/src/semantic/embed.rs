//! Turning text into vectors.
//!
//! One trait, two implementations, and nothing above this file knows which one
//! it is holding. That is the whole point of the trait: the index, the search
//! and the MCP tool are written against `Embedder`, so a future GPU backend
//! (Ollama, `llama-server`) or a pure-Rust `candle` backend can be added
//! without touching any of them.
//!
//! The real one is `FastEmbed`, which runs `BAAI/bge-small-en-v1.5` in its
//! 8-bit ONNX form on the CPU, in this process, with no account and no network.
//! It is handed the model files from disk — `fastembed`'s own downloader is
//! compiled out (see `Cargo.toml`), so there is exactly one thing in this app
//! that fetches anything, and it is the checksum-verified path in
//! `semantic::model`.

use std::path::Path;

/// The dimension count of every vector this app stores. bge-small emits 384.
pub const DIMS: usize = 384;

/// bge's card asks for this in front of a *query* and nothing in front of a
/// document. It is stored in the manifest rather than hard-coded at the call
/// site so a different model can want a different prefix, or none.
pub const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";

/// Anything that can turn strings into unit-length vectors.
pub trait Embedder: Send + Sync {
    /// Embed a batch. The result has one vector per input, in order, each of
    /// `DIMS` floats and each normalised to unit length so a cosine score is a
    /// plain dot product.
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String>;

    /// How many floats each vector has.
    fn dims(&self) -> usize {
        DIMS
    }
}

/// Scale a vector to unit length, in place.
///
/// fastembed normalises already; this is here because the *contract* says the
/// stored vectors are unit length, and a contract that depends on a library's
/// current default is a contract waiting to be broken by an upgrade.
pub fn normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

// ---------------------------------------------------------------------------
// The real embedder
// ---------------------------------------------------------------------------

/// The five files a model folder has to contain, in the order `fastembed`
/// wants them. `MODEL_FILE` is the graph; the rest are the tokenizer.
pub const MODEL_FILE: &str = "model_quantized.onnx";
pub const TOKENIZER_FILES: [&str; 4] = [
    "tokenizer.json",
    "config.json",
    "special_tokens_map.json",
    "tokenizer_config.json",
];

pub struct FastEmbed {
    /// `TextEmbedding::embed` takes `&mut self` — the ONNX session is not
    /// re-entrant — so the whole embedder sits behind one lock. Embedding is
    /// already the slow part and it already happens on a background thread;
    /// serialising it costs nothing the app can feel and removes a class of
    /// bug entirely.
    inner: std::sync::Mutex<fastembed::TextEmbedding>,
}

impl FastEmbed {
    /// Load a model folder. Everything is read into memory once — the graph is
    /// 34 MB and the session keeps it anyway, so there is nothing to gain by
    /// being clever about it.
    pub fn load(dir: &Path) -> Result<Self, String> {
        let read = |name: &str| -> Result<Vec<u8>, String> {
            std::fs::read(dir.join(name))
                .map_err(|e| format!("could not read {name} from the model folder: {e}"))
        };
        let tokenizer_files = fastembed::TokenizerFiles {
            tokenizer_file: read(TOKENIZER_FILES[0])?,
            config_file: read(TOKENIZER_FILES[1])?,
            special_tokens_map_file: read(TOKENIZER_FILES[2])?,
            tokenizer_config_file: read(TOKENIZER_FILES[3])?,
        };
        // `Pooling::Mean` and the CLS-free path are what the sentence-transformers
        // export of bge expects; naming it here rather than letting the library
        // guess is the difference between a vector and a plausible-looking
        // vector. `QuantizationMode::Dynamic` matches the int8 export.
        let model = fastembed::UserDefinedEmbeddingModel::new(read(MODEL_FILE)?, tokenizer_files)
            .with_pooling(fastembed::Pooling::Cls)
            .with_quantization(fastembed::QuantizationMode::Dynamic);
        let options = fastembed::InitOptionsUserDefined::new().with_max_length(512);
        let inner = fastembed::TextEmbedding::try_new_from_user_defined(model, options)
            .map_err(|e| format!("the embedding model would not load: {e}"))?;
        Ok(Self { inner: std::sync::Mutex::new(inner) })
    }
}

impl Embedder for FastEmbed {
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let mut guard = self.inner.lock().map_err(|_| "the embedder is poisoned".to_string())?;
        let mut out = guard
            .embed(texts, None)
            .map_err(|e| format!("embedding failed: {e}"))?;
        for v in out.iter_mut() {
            normalize(v);
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// The honest fake
// ---------------------------------------------------------------------------

/// A deterministic stand-in used by the tests — and only by the tests.
///
/// It hashes words into buckets, so two passages that share words land near
/// each other and two that share none do not. That is enough to test chunking,
/// the file format, the ranking and the refusals without a 34 MB download, and
/// it is emphatically **not** enough to search with: it has no idea what a word
/// means. Nothing outside `#[cfg(test)]` and the browser mock ever holds one.
#[derive(Default)]
pub struct WordBagEmbedder;

impl Embedder for WordBagEmbedder {
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        Ok(texts
            .iter()
            .map(|t| {
                let mut v = vec![0f32; DIMS];
                for word in t.to_lowercase().split(|c: char| !c.is_alphanumeric()) {
                    if word.is_empty() {
                        continue;
                    }
                    let mut h: u64 = 1469598103934665603;
                    for b in word.as_bytes() {
                        h ^= *b as u64;
                        h = h.wrapping_mul(1099511628211);
                    }
                    v[(h % DIMS as u64) as usize] += 1.0;
                }
                normalize(&mut v);
                v
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalising_makes_a_unit_vector_and_leaves_zero_alone() {
        let mut v = vec![3.0f32, 4.0];
        normalize(&mut v);
        assert!((v[0] - 0.6).abs() < 1e-6 && (v[1] - 0.8).abs() < 1e-6);
        let mut zero = vec![0.0f32, 0.0];
        normalize(&mut zero);
        assert_eq!(zero, vec![0.0, 0.0], "a zero vector has no direction to keep");
    }

    #[test]
    fn the_fake_embedder_is_deterministic_and_unit_length() {
        let e = WordBagEmbedder;
        let a = e.embed(&["the lantern went out".to_string()]).unwrap();
        let b = e.embed(&["the lantern went out".to_string()]).unwrap();
        assert_eq!(a, b);
        let norm: f32 = a[0].iter().map(|x| x * x).sum();
        assert!((norm - 1.0).abs() < 1e-5);
    }

    /// The spike, kept as a test.
    ///
    /// Skipped unless `AQ_SEMANTIC_MODEL_DIR` points at a folder holding the
    /// five model files — the 34 MB graph is not in the repo and never will be.
    /// What it proves when it does run is the whole of Phase 1: that ONNX
    /// Runtime linked, that the model loads from disk with no network, and that
    /// one string becomes 384 unit-length floats.
    #[test]
    fn a_real_model_embeds_one_string() {
        let Some(dir) = std::env::var_os("AQ_SEMANTIC_MODEL_DIR") else {
            eprintln!("skipped: set AQ_SEMANTIC_MODEL_DIR to a bge-small folder to run this");
            return;
        };
        let e = FastEmbed::load(Path::new(&dir)).expect("load the model");
        let v = e.embed(&["The lantern went out on the stairs.".to_string()]).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].len(), DIMS);
        let norm: f32 = v[0].iter().map(|x| x * x).sum();
        assert!((norm - 1.0).abs() < 1e-3, "vectors come out unit length, got {norm}");

        // And that it is an embedding rather than noise: two sentences about
        // the same thing must score higher against each other than either does
        // against a sentence about something else.
        let texts: Vec<String> = [
            "She decided to leave him and never come back.",
            "He walked out of the marriage for good.",
            "The carburettor needs a new gasket.",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let v = e.embed(&texts).unwrap();
        let dot = |a: &Vec<f32>, b: &Vec<f32>| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
        assert!(
            dot(&v[0], &v[1]) > dot(&v[0], &v[2]),
            "leaving-a-marriage should be nearer to leaving-a-marriage than to a carburettor"
        );
    }
}
