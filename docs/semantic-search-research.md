# Semantic search on Linux — the embedding story (PARITY row 19)

*Research, 2026-09-02, against `main` at `2da51ff` (v0.5.4). No code was
written for this document. Every fact about a library, a model or a licence
carries a link to a primary source; anything that could not be verified
against one is marked **unverified**. Sizes below use the real release
assets: the Linux AppImage is 84.1 MB and the Mac zip is 10.3 MB
(`gh release view v0.5.4`).*

## The recommendation, in one paragraph

Build "search by meaning" **in-process, on the CPU, with no account and no
cloud**: the [`fastembed`](https://crates.io/crates/fastembed) crate (which
wires the ONNX Runtime and the Hugging Face tokenizer together and does the
pooling for us — the "wire through a library, pin it, never write our own"
rule from NOTES §1) running **`BAAI/bge-small-en-v1.5`** in its 8-bit ONNX
form (MIT, 384 dimensions, about 34 MB). The model is **not** baked into the
AppImage; it downloads on first use from our own GitHub release, checked
against a `SHA256SUMS.txt` exactly the way the self-updater already checks
an update. Vectors live in **flat files under
`.aquarius/semantic.nosync/`**, one small file per document, searched by a
brute-force cosine scan in Rust — no SQLite, no vector database, because at
this vault's scale (hundreds of documents, tens of thousands of chunks) a
scan is a few milliseconds and a database in an iCloud folder is something
both SQLite and Apple tell you not to do. The index is **per machine and per
model** — Apple's on-device embeddings cannot be reproduced on Linux, so the
Swift app and this app will never read each other's vectors, and the contract
below is about not stepping on each other rather than about sharing. The
Find sheet gets a **"By meaning"** toggle that, when no model is present,
shows a "needs a 35 MB model — Download" card in the pandoc style (NOTES
§19d) instead of pretending. One MCP tool ships with it, `search_semantic`,
which answers honestly when the model is missing. Size: **M** — with a
half-day spike first to prove the ONNX Runtime builds and links on both CI
runners, and `candle` named as the fallback if it fights back.

---

## 1. What the Swift app does, and why it cannot be copied

SWIFT-AUDIT §2.5: the Swift app has a "search by meaning" toggle inside its
Find sheet, backed by Apple's on-device embeddings, with a SHA-256
incremental index in `.aquarius/` and 180-word chunks, falling back to
keyword search. (The Swift source is not on the Linux bench — only its
`CLAUDE.md` is — so this section is from the audit, not a fresh read.)

The part that does not port is the model. Apple's
[`NLEmbedding.sentenceEmbedding(for:)`](https://developer.apple.com/documentation/naturallanguage/nlembedding)
is a framework call that returns a 512-dimension vector
([WWDC20 session 10657](https://developer.apple.com/videos/play/wwdc2020/10657/)),
versioned by `currentSentenceEmbeddingRevision`. The weights are never
exposed: `write()` exports only word dictionaries, and there is no ONNX or
Core ML export of the sentence model. So there is no way to produce the same
vector on Linux — **an index built with Apple's embeddings is unreadable
anywhere but a Mac with the same OS revision** (Apple's own guidance for its
newer `NLContextualEmbedding` is to
["use the same model revision … to maintain consistent results"](https://developer.apple.com/documentation/naturallanguage/nlcontextualembedding/revision)).
That single fact shapes everything below: we need our own model, and the
index becomes a per-machine cache rather than shared state.

## 2. Runtime options in Rust

Constraints: CPU-only must work; NVIDIA/AMD is a bonus; the same code builds
the Mac app; CI is `ubuntu-24.04` + `macos-14`; no cloud API, not even as a
default; Royce should never need to install a C++ toolchain to work on it.

| | **fastembed** | **ort** (direct) | **candle** | **llama.cpp** via `llama-cpp-2` | **model2vec-rs** (static) | **External tool** (Ollama / `llama-server`) |
|---|---|---|---|---|---|---|
| What it is | Embedding library on top of `ort` + HF `tokenizers`; bge-small is its default model ([README](https://github.com/Anush008/fastembed-rs)) | ONNX Runtime bindings; we would write tokenising + pooling ourselves | Hugging Face's pure-Rust tensor library; has a BERT example that embeds sentences ([bert example](https://github.com/huggingface/candle/blob/main/candle-examples/examples/bert/main.rs)) | Raw bindings to llama.cpp, compiled from source ([README](https://github.com/utilityai/llama-cpp-rs)) | Static token-vector lookup, no neural net at run time ([README](https://github.com/MinishLab/model2vec-rs)) | The pandoc pattern: a program the writer installs; we talk to it over localhost |
| Version / cadence | 6.0.2, 2026-08-27; ~weekly ([crates.io](https://crates.io/crates/fastembed)) | 2.0.0-**rc.13**, 2026-07-28; **no stable 2.x yet**, rc since 2024 ([crates.io](https://crates.io/crates/ort)) | 0.11.0, 2026-06-26 ([crates.io](https://crates.io/crates/candle-core)) | 0.1.155, 2026-08-31; "does not follow semver meaningfully" ([crates.io](https://crates.io/crates/llama-cpp-2)) | 0.2.1, 2026-05-23 ([crates.io](https://crates.io/crates/model2vec-rs)) | Ollama 0.33.2 ([releases](https://github.com/ollama/ollama/releases/latest)); llama.cpp daily builds |
| Maturity | 1.0k stars, single maintainer; pins `ort = "=2.0.0-rc.13"` ([Cargo.toml](https://docs.rs/crate/fastembed/latest/source/Cargo.toml)) | 2.5k stars; used by HF Text Embeddings Inference and Google Magika ([GitHub](https://github.com/pykeio/ort)) | 21k stars, HF-maintained ([GitHub](https://github.com/huggingface/candle)) | 640 stars | 211 stars | Ollama 180k stars, llama.cpp 127k |
| Licence | Apache-2.0 | MIT OR Apache-2.0 | MIT OR Apache-2.0 | MIT OR Apache-2.0 | MIT ([repo](https://github.com/MinishLab/model2vec-rs)) | MIT (both) |
| Added to the 84 MB AppImage | ONNX Runtime CPU library: Microsoft's linux-x64 archive is 10.6 MB compressed, macOS arm64 39.7 MB compressed ([ORT 1.29 release](https://github.com/microsoft/onnxruntime/releases/latest)); uncompressed **unverified**, expect 15–40 MB | same | small — pure Rust, no separate runtime; exact delta **unverified** | llama.cpp CPU toolset is 16 MB compressed for Linux ([releases](https://github.com/ggml-org/llama.cpp/releases)); static delta **unverified** | tiny (safetensors + tokenizer only) | **zero** |
| Model download at run time | Yes by default via `hf-hub`; **can be turned off** and a local model passed with `try_new_from_user_defined` ([docs.rs](https://docs.rs/fastembed/latest/fastembed/struct.TextEmbedding.html)) | we supply the `.onnx` | we supply the safetensors | we supply the `.gguf` | `from_pretrained` takes a local path; `local-only` feature | writer runs `ollama pull` |
| How ONNX Runtime arrives | `ort-download-binaries` (default) fetches a prebuilt library from pyke's CDN **at build time**; or `ort-load-dynamic` to `dlopen` a bundled `libonnxruntime` at run time ([ort features](https://docs.rs/crate/ort/latest/features), [linking doc](https://raw.githubusercontent.com/pykeio/ort/main/docs/content/setup/linking.mdx)) | same | n/a | n/a | n/a | n/a |
| C/C++ toolchain | A **C** compiler for `onig` (the tokenizer's regex library) — both runners have one; ORT itself is prebuilt | same | **none** for CPU (`gemm` is Rust) ([Cargo.toml](https://raw.githubusercontent.com/huggingface/candle/main/candle-core/Cargo.toml)) | **cmake + C++ + libclang (bindgen)** ([build.rs](https://raw.githubusercontent.com/utilityai/llama-cpp-rs/main/llama-cpp-sys-2/build.rs)) | C compiler for `onig`, or `fancy-regex` for pure Rust | none |
| CPU speed, ~500-token chunk | **~10–60 ms** on a desktop CPU, 2–4× that on a handheld APU — **reasoned, unverified**; no vendor publishes this number (§2a) | same | ~1.5–2× slower than ORT on the same model, from one M1 report ([candle #2418](https://github.com/huggingface/candle/issues/2418)); **unverified** at 500 tokens | same order as ORT; only Metal numbers published ([discussion](https://github.com/ggml-org/llama.cpp/discussions/7712)) | **< 1 ms** — 8,000 sentences/s single-threaded ([README](https://github.com/MinishLab/model2vec-rs)) | engine speed + HTTP |
| GPU optionality | `cuda`, `metal`, `mkl`, `accelerate`, `directml` features ([features](https://docs.rs/crate/fastembed/latest/features)) | CPU always; prebuilt macOS arm64 has CoreML; Linux CUDA prebuilt; **ROCm needs a self-built ORT** ([dist.tsv](https://raw.githubusercontent.com/pykeio/ort/main/ort-sys/build/download/dist.tsv)) | `cuda`, `metal`, `mkl`, `accelerate` | `cuda`, `rocm`, `vulkan`, `metal` ([features](https://docs.rs/crate/llama-cpp-sys-2/latest/features)) | none needed | Ollama: CUDA + ROCm on Linux, Metal on Mac — for free |
| macOS | Yes; ORT's official binaries need **macOS ≥ 13.3** ([ORT build docs](https://onnxruntime.ai/docs/build/inferencing.html)) — Tauri's default `minimumSystemVersion` is 10.13 and must be raised ([Tauri](https://v2.tauri.app/distribute/macos-application-bundle/)) | same | yes | yes (Metal linked by default) | yes | `brew install ollama` ([formula](https://formulae.brew.sh/formula/ollama)) |
| CI complexity | low–medium: a network fetch of ORT during `cargo build`; a dylib to bundle if `load-dynamic` | same | **lowest** — plain `cargo build` | **highest** — cmake, clang, long compiles | lowest | none in CI; the cost moves to the writer's machine |

### 2a. On the speed numbers

Nobody publishes "one 500-token chunk on one CPU core" for these models. The
closest primary measurement is Hugging Face's: `all-MiniLM-L6-v2` encodes
1,739 short sentences per second on an i7-13700K with PyTorch, batched
([HF blog](https://huggingface.co/blog/static-embeddings)). A 500-token chunk
is 20–50× the tokens of a benchmark sentence and attention cost grows faster
than linearly, which is where "10–60 ms per chunk" comes from. It is an
estimate. What it means in practice: a 100k-word manuscript is ~560 chunks
(§3), so a **full first index is under a minute on a desktop and a few
minutes on a handheld**, and a single query is one chunk's worth of work plus
a scan. Both belong on a background thread; neither is a problem.

### 2b. Why not the others

- **`ort` directly** is what `fastembed` is built on. Using it bare means
  writing the tokenise → run → pool → normalise pipeline ourselves; that is
  small, but it is exactly the code the doctrine says to get from a library.
- **`candle`** is the honest runner-up and the **fallback if ORT packaging
  fights the CI**: pure Rust, no downloaded runtime, no macOS floor, and the
  same model weights give the same search. Its costs: slower on CPU
  (unverified magnitude), a fatter model file (bge-small's fp16 safetensors
  is about 67 MB against 34 MB for 8-bit ONNX; the fp32 is 127 MB
  ([HF tree](https://huggingface.co/BAAI/bge-small-en-v1.5/tree/main))), and
  we assemble the BERT pipeline from `candle-transformers` rather than
  calling one function.
- **`llama.cpp` bindings** compile llama.cpp from source with cmake and need
  libclang on both runners. That only pays off if the app also wants a local
  LLM in-process — which it deliberately does not (Spark is closed; the MCP
  server and the terminal pane are the agent story).
- **Static embeddings (`model2vec`, `potion-base-8M`)** are tempting — 30 MB,
  pure Rust, sub-millisecond — but they are a bag of token vectors with **no
  word order**: "the letter she never sent" and "she never sent the letter"
  embed identically, and the retrieval score is 31 against bge-small's 52
  ([potion-base-8M card](https://huggingface.co/minishlab/potion-base-8M)).
  For a search over prose that is the wrong trade. Kept in reserve as a
  zero-dependency first pass if we ever want one; not v1.
- **An external tool, the pandoc way.** The appeal is real: nothing added to
  the binary, no CI risk, and NVIDIA/AMD acceleration for free through
  [Ollama's `/api/embed`](https://docs.ollama.com/api/embed) or
  [`llama-server --embedding`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
  Why it is not the *default*: unlike pandoc, Ollama is not a one-line distro
  package on AquariusOS — there is no official Flatpak
  ([ollama#2288](https://github.com/ollama/ollama/issues/2288)), Bazzite
  discourages `rpm-ostree` layering ([Bazzite docs](https://raw.githubusercontent.com/bazzite-org/docs.bazzite.gg/main/src/Installing_and_Managing_Software/rpm-ostree.md)),
  the Linux tarball is 1.36 GB because it bundles CUDA and ROCm
  ([release](https://github.com/ollama/ollama/releases/latest)), and the
  realistic install is Homebrew or a podman quadlet — fine for Royce,
  not for "gamer-focused like SteamOS". A feature the Swift app has out of
  the box should not be a "needs Ollama" card for everyone. It **is** the
  right shape for a later optional GPU accelerator behind the same
  `Embedder` trait (§6).

## 3. Model choice

All small (≤ 35M parameters), 384-dimension, English-first, and permissively
licensed unless noted. Retrieval scores are MTEB-v1 English retrieval
averages (NDCG@10) as published on the model cards; the MTEB leaderboard
itself could not be fetched, so the figures were cross-checked where two
cards publish the same competitor's number.

| Model | Dims | Params | Max tokens | MTEB avg / retrieval | Licence | 8-bit ONNX on disk | Prefix needed |
|---|---|---|---|---|---|---|---|
| [**bge-small-en-v1.5**](https://huggingface.co/BAAI/bge-small-en-v1.5) | 384 | 33.4M | 512 | 62.17 / **51.68** | **MIT** | **34 MB** ([Xenova export](https://huggingface.co/Xenova/bge-small-en-v1.5/tree/main/onnx)); Qdrant's `-Q` variant is 63 MB ([tree](https://huggingface.co/Qdrant/bge-small-en-v1.5-onnx-Q/tree/main)); fp32 127 MB | Query-side only, and optional — the card says leaving it off "only slightly degrades" |
| [snowflake-arctic-embed-s](https://huggingface.co/Snowflake/snowflake-arctic-embed-s) | 384 | 33M | 512 | — / 51.98 | Apache-2.0 | 34 MB ([official onnx/](https://huggingface.co/Snowflake/snowflake-arctic-embed-s/tree/main/onnx)) | Query prefix **required**; retrieval-only by the card's own account ([paper](https://arxiv.org/abs/2405.05374)) |
| [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) | 384 | 22.7M | **256** (trained at 128) | 56.26 / 41.95 | Apache-2.0 | 23 MB | none |
| [gte-small](https://huggingface.co/thenlper/gte-small) | 384 | 33.4M | 512 | 61.36 / 49.46 | MIT | 34 MB | none; not in fastembed's list |
| [e5-small-v2](https://huggingface.co/intfloat/e5-small-v2) | 384 | 33.4M | 512 | 59.93 / 49.04 | MIT | 34 MB | `query:` / `passage:` **required on both sides**; not in fastembed's list |
| [nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) | 768 (Matryoshka to 64) | ~137M | 8192 | 62.28 / 53.25 | Apache-2.0 | **137 MB** | `search_query:` / `search_document:` **required** |
| [potion-base-8M](https://huggingface.co/minishlab/potion-base-8M) (static) | 256 | 7.6M | unlimited | 51.08 / 31.11 | MIT | 30 MB | none — but no word order |

**Pick: `bge-small-en-v1.5`, 8-bit ONNX.** Best retrieval score among the
small models, MIT, no prefix required on documents, a plain BERT graph that
runs on stock ONNX Runtime with no custom code, and it is `fastembed`'s
default — the least surprising thing to pin. Runner-up: `arctic-embed-s`,
statistically level on retrieval but with a mandatory query prefix and a
card that says it is weaker at similarity, which the corkboard or a "related
notes" feature would want later. `nomic` is the model to revisit if we ever
want to embed whole scenes without chunking — four times the download and
mandatory prefixes, for a two-point gain. MiniLM is dominated at the same
size, and its 256-token ceiling would force smaller chunks.

**Why chunking is not optional.** English prose runs about 1.3 tokens per
word (the usual rule of thumb; **unverified** for BERT's WordPiece
specifically, which is if anything higher). A 3,000-word chapter is roughly
3,900 tokens — eight times the 512 cap. Unchunked, only the first ~380 words
of a chapter would ever be searched, silently. The Swift app's **180-word
chunk** (~234 tokens) fits every candidate with headroom and is the right
grain anyway: a hit should land on a paragraph, not a chapter. A chapter is
~17 chunks; a 120-page screenplay is ~120–140; a 100k-word manuscript is
~560. At 384 fp32 floats a chunk's vector is 1.5 KB, so that manuscript's
whole index is under 1 MB.

**Ship it inside the AppImage, or download on first use?** Download. The
AppImage would grow from 84 to ~119 MB and the Mac zip from 10 MB to 45 MB
for a feature not everyone will toggle on. The download is ~35 MB (34 MB
model + 0.7 MB `tokenizer.json` + two small config files): about 6 seconds
at 50 Mbps in theory, 7–10 seconds in practice, once. The model files go on
**our own GitHub release** (tag `models-v1`, say) beside a `SHA256SUMS.txt`,
not fetched from Hugging Face at run time — MIT allows redistribution, we
control availability, and the verification is the updater's existing
`parse_sha256_sums` / `expected_sha256` path
(`src-tauri/src/updater/overlay.rs`) and its `ureq` + `sha2` download
(`updater/net.rs`). They land in Tauri's `app_data_dir`
(`~/.local/share/<bundle-id>/models/` on Linux,
`~/Library/Application Support/<bundle-id>/models/` on macOS —
[PathResolver](https://docs.rs/tauri/latest/tauri/path/struct.PathResolver.html)),
which the AppImage overlay updater never touches, so an app update never
re-downloads the model. `fastembed`'s own `hf-hub` feature is turned **off**
so there is exactly one downloader in the app and it is ours.

## 4. Where the index lives

### 4a. The options

| | Flat files + brute-force scan (Rust) | One SQLite file + [`sqlite-vec`](https://github.com/asg017/sqlite-vec) | [`usearch`](https://github.com/unum-cloud/usearch) file |
|---|---|---|---|
| Dependencies | **none** new | `rusqlite` (`bundled` compiles SQLite via `cc`) + `sqlite-vec` (compiles C via `cc`) ([rust guide](https://alexgarcia.xyz/sqlite-vec/rust.html)) | `usearch` crate builds C++17 via `cxx` — **needs a C++ compiler** ([build.rs](https://raw.githubusercontent.com/unum-cloud/usearch/main/build.rs)) |
| Licence | — | MIT OR Apache-2.0; README says "pre-v1, expect breaking changes" ([README](https://raw.githubusercontent.com/asg017/sqlite-vec/main/README.md)) | Apache-2.0 |
| Search | exact cosine over every vector | exact (brute force) in every stable release; ANN only in the 0.1.10 alphas ([release](https://github.com/asg017/sqlite-vec/releases/tag/v0.1.10-alpha.1)) | HNSW approximate, plus exact mode; f16 / i8 / binary quantisation ([README](https://raw.githubusercontent.com/unum-cloud/usearch/main/README.md)) |
| Speed at 50k × 384 | ~38 MFLOP per query: **~25 ms scalar, ~1.5 ms with SIMD** (from measured per-pair costs, [ashvardanian](https://ashvardanian.com/posts/python-c-assembly-comparison/)) | author's own figure: 100k × 384 in < 75 ms ([blog](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html)) | sub-millisecond |
| Size at 50k chunks | 77 MB fp32 (38 MB f16, 19 MB int8) | same, in one file | same, in one file |
| Behaviour in a syncing folder | small immutable files, atomic replace, no locks — the shape sync daemons cope with | **SQLite's own docs: background copiers snapshot mid-transaction and corrupt the copy; WAL requires one host** ([howtocorrupt](https://www.sqlite.org/howtocorrupt.html), [wal](https://www.sqlite.org/wal.html)). **Apple: "a SQLite database's store file must never be stored in iCloud"** ([iCloud Design Guide](https://developer.apple.com/library/archive/documentation/General/Conceptual/iCloudDesignGuide/Chapters/iCloudFundametals.html)) | `view()` is an mmap over the file — over a syncing file that is a risk (**unverified**) |
| Swift side could read it | trivially — it is a header and floats | no official Swift package; iOS build "work-in-progress" ([docs](https://alexgarcia.xyz/sqlite-vec/android-ios.html)) | **official Swift package in-repo** ([Package.swift](https://raw.githubusercontent.com/unum-cloud/usearch/main/Package.swift)) |

Secondary sources put the brute-force → ANN crossover around 10⁵–10⁶
vectors ([one](https://oneuptime.com/blog/post/2026-01-30-vector-db-hnsw-index/view),
[two](https://endee.io/blog/what-is-hnsw-and-why-is-it-so-fast)). A vault
would need to be a hundred novels before the scan is the slow part.

**Decision: flat files, brute force, pure Rust.** No new native build step,
no database file in a synced folder, and every write is the same
temp-sibling-plus-rename the sessions already use. `usearch` is the named
upgrade path if a vault ever gets large enough to feel it — its file format
and official Swift reader would then be worth the C++ build cost. Not now.

### 4b. Per machine, per model — and why

Two facts force this. The Mac app embeds with Apple's model, which Linux
cannot run (§1). And even the same open model gives byte-different floats
across ONNX Runtime versions and execution providers (CPU vs CoreML) —
expected to be harmless for cosine *ranking* but **unverified**, and not
something to bet the folder-on-disk promise on. So the index is **derived,
disposable state**: it is keyed on the model, it is rebuilt from the
documents whenever the key does not match, and losing it costs a minute of
CPU, never a word of writing.

That is also why it lives in a `.nosync` folder. iCloud Drive leaves
`.nosync` items on the machine (Apple's guidance for exactly the
SQLite-in-iCloud case is to use that suffix — same design guide as above).
On Linux the suffix means nothing, which is fine: there it is just a folder
name, and a vault synced by some other means simply carries a cache the other
machine ignores because the model key does not match. The Swift app could
adopt the same folder tomorrow, writing under its own key, and neither app
would ever read or clobber the other's vectors.

### 4c. Incremental re-embedding

The pieces exist. Every document already has a content SHA-256 stamp
(`fs_ops::stamp`, NOTES §20) and the vault has a file watcher that excludes
`.aquarius/` (NOTES §3c, §22). The index stores the stamp it was built from;
on save or on a watcher event the document's current hash is compared and
only a changed document is re-chunked and re-embedded — one small file
rewritten, atomically. A rename or move re-keys the file the way the session
files are re-keyed (PARITY, session contract); a trashed document's file is
deleted. Opening a vault runs one pass over the tree comparing hashes to the
manifest, which is a read of a few KB per document and no model work unless
something changed.

## 5. The proposed contract

In the style of the session-format section of PARITY.md: deliberately
boring, readable without either app, and something the Swift app can adopt
without changing what it already does.

```text
<vault>/.aquarius/semantic.nosync/
  <model-key>/                     ← one folder per model this machine has used
    manifest.json                  ← what the folder was built with
    docs/<path-hash>.vec           ← one file per document
```

`<model-key>` is `<publisher>--<model>--<file-sha256-first-12>`, for
example `baai--bge-small-en-v1.5--3f9a1c0d2e7b`; Apple's would be something
like `apple--nlembedding-en--rev3`. Different key, different folder, no
collision.

`manifest.json`:

```json
{
  "format": 1,
  "model": {
    "id": "BAAI/bge-small-en-v1.5",
    "file": "model_quantized.onnx",
    "sha256": "3f9a1c0d2e7b…",
    "dims": 384,
    "normalized": true,
    "queryPrefix": "Represent this sentence for searching relevant passages: "
  },
  "chunking": { "words": 180, "overlapWords": 0, "unit": "paragraph-packed" },
  "docs": {
    "Drafts/Ch_03.md": { "stamp": "c0ffee…", "chunks": 17, "updatedAt": 1756800000000 }
  }
}
```

`docs/<path-hash>.vec` — `<path-hash>` is the SHA-256 of the vault-relative
path, so a path with any character in it has a safe filename:

```text
magic   "AQVEC\0"  + u16 format (1)
header  JSON, length-prefixed: { "path", "stamp", "dims", "dtype": "f32",
        "chunks": [ { "line": 0, "words": 180, "preview": "…" }, … ] }
body    chunks × dims little-endian f32, in header order
```

| Key | Meaning |
|---|---|
| `model.sha256` | The hash of the **model file itself**, not a version string. Two builds of "the same" model are two models. |
| `model.normalized` | Vectors are unit length, so the score is a dot product. Both apps store them that way. |
| `model.queryPrefix` | Applied to the *query* only, never to documents. Empty for models that do not want one. |
| `chunking.words` | 180, matching the Swift app. Chunks are built from the document **body with the frontmatter block removed** (the same body the word count uses — session contract), packing whole paragraphs until the next would cross 180 words; a single paragraph over 180 words is split at sentence ends. |
| `chunks[].line` | The chunk's first line, **0-based, counted in body lines** — the same numbering `insert_text` and `replace_lines` use (NOTES §23b), so a hit can jump straight to a line the editor agrees on. |
| `docs[path].stamp` | The document's content SHA-256 at embedding time — the `FileStamp.hash` the conflict guard already computes. |

Rules an implementation has to match, not just the shape:

- **The index is a cache.** Anything may delete `semantic.nosync/` at any
  time; the only consequence is a rebuild. Nothing in the vault ever
  *depends* on it. A corrupt manifest or `.vec` file is skipped and rebuilt,
  never an error dialog.
- **Key mismatch means rebuild, not reinterpretation.** An app never reads a
  folder whose `model.sha256` is not the model it is holding. It may leave
  the other folder alone or prune it; it must not "convert" it.
- **Stamp mismatch means re-embed that document only.** The whole point of
  the per-document file.
- **Writes are atomic** — temp sibling, then rename — and `.aquarius/` is
  already outside the watcher, so indexing never looks like an external edit.
- **Unknown keys survive** in both JSON layers.
- **A rename or move re-keys `docs` and renames the `.vec`; a trashed
  document loses its entry.** No orphaned vectors for a file that is gone.
- **Scoring is cosine (dot product of unit vectors), best chunk per
  document wins,** and results are grouped by document with the winning
  chunk's `line` and `preview` — the same `SearchHit` shape the keyword
  search already returns, plus a `score`.

Read side: `search_semantic` in the app and on MCP. Rust: a new
`src-tauri/src/semantic/` module (`chunk.rs`, `index.rs`, `embed.rs`), with
`chunk.rs` and `index.rs` pure and unit-tested on a machine with no model
installed, the way `compile/assembler.rs` is.

## 6. UX and MCP

### 6a. The toggle, and what it says when there is no model

`FindReplace.tsx` is a single `Find…` / `Replace with…` pair over a hit
list. The toggle is a small two-way segmented control on the input row —
**Exact · By meaning** — defaulting to Exact. The Replace column hides under
By meaning: replacing "everything that means this" is not an operation
anyone should be offered.

Mirroring the pandoc cards (NOTES §19d), the sheet asks a `semantic_probe`
when it opens, so it already knows which of four states it is in before the
writer clicks anything:

| State | What the writer sees under By meaning |
|---|---|
| Model present, index current | Results, ranked by score, grouped by document, "17 chunks · best match line 212" style previews. |
| Model present, index building | Results from what is indexed so far, plus a quiet line: *Indexing 12 of 40 documents…* |
| **No model on this machine** | A card in the empty-results slot: *Search by meaning needs a one-time 35 MB model download (BAAI bge-small, MIT). It runs on this computer and never sends your writing anywhere.* — with **Download** and a progress bar, reusing the updater's overlay pattern. Keyword search keeps working next to it. |
| Offline and no model | The same card, with the button disabled and *No connection — try again when you're online.* No retry loop. |

The download is a **human click**, not an automatic side effect of opening
Find — the same consent line compile draws around its output folder (NOTES
§19i). Settings → About gets a one-line row: model name, size on disk,
"Remove" — so the 35 MB is never invisible.

### 6b. MCP

Doctrine (NOTES §23, PARITY's closing rule): if a human can do it in the
app, an agent can do it too, in the same change. One tool ships:

- **`search_semantic`** `(workflow_id, query, limit?)` → the keyword tool's
  hit shape plus `score`, or — when the model is absent — a structured
  refusal, `{ "available": false, "reason": "model-missing", "hint": "Open
  Find (⇧⌘F), switch to By meaning and choose Download." }`, the way
  `CompileError` carries a `code` and a `hint`. Not an exception: an agent
  should be able to fall back to `search` without parsing an error string.

Deliberately **not** a tool: triggering the download. That is consent to put
35 MB on the writer's disk and it stays a click, exactly as compile's
absolute-path output stays a native dialog. Reindexing needs no tool either —
it is automatic on stamp mismatch; an agent that edits a file through
`replace_lines` gets the re-embed for free through the watcher path.

## 7. Cost, risks, and what to build first

**Size: M** (two to four days), in the PARITY vocabulary — and it starts
with a **half-day spike that is allowed to change the answer**: a
throwaway binary on both runners that embeds one sentence with `fastembed`
(`hf-hub` off, model from a local path), reporting the size delta on the
AppImage and the `.app` and whether the ONNX Runtime linked statically or
needs a bundled dylib with an rpath. If that spike burns more than a day,
switch to `candle` and keep everything else.

**The two risks that matter:**

1. **ONNX Runtime packaging in CI.** `fastembed` pins `ort` to a release
   candidate and, by default, downloads a prebuilt runtime from a third-party
   CDN during `cargo build`; whether that prebuilt is a static archive or a
   shared library is **unverified** (pyke's site refused the fetch), and a
   shared library means an rpath and a bundling step on each platform
   ([Tauri AppImage `files`](https://v2.tauri.app/distribute/appimage/),
   [macOS `frameworks`](https://v2.tauri.app/distribute/macos-application-bundle/)).
   Add the macOS ≥ 13.3 floor and the rc-only crate that has been rc for two
   years. This is the whole reason the spike comes first and `candle` is
   named as the fallback.
2. **Expectation.** A 33M-parameter model is a good small model, not magic.
   "The scene where she decides to leave" will find the scene most of the
   time; a query that names a character the model has never seen will lean
   on the surrounding words. The toggle, the card and the MCP answer all say
   "by meaning", never "AI search", and the keyword path is always one click
   away — that is the honesty the pandoc work established.

Smaller risks, on the record: first-index time on a handheld APU (minutes,
background thread, progress line — acceptable, but must not block the
editor); model files under `app_data_dir` surviving an uninstall (a Remove
row in Settings); and the per-document `.vec` files accumulating for a vault
that renames a lot (the manifest pass on open prunes what it does not
recognise).

**Build order for a minimal honest version:**

1. **Spike** — `fastembed` + local bge-small on both runners; measure; decide
   ORT vs `candle`. Half a day.
2. **`semantic/chunk.rs` + `semantic/index.rs`** — chunking, the `.vec`
   format, the manifest, cosine scan, stamp diffing. Pure, tested without a
   model. One day.
3. **Model download** on the updater's `ureq` + `sha2` path, into
   `app_data_dir/models/`, from a `models-v1` GitHub release with a
   `SHA256SUMS.txt`. `semantic_probe`, `semantic_download` (with progress
   events), `semantic_remove` commands. Half a day.
4. **`semantic/embed.rs`** — the `Embedder` trait with one implementation
   (fastembed, `hf-hub` off, model from disk); background indexing on open
   and on stamp change; `search_semantic` command and MCP tool. One day.
5. **Find sheet** — the segmented toggle, the four-state card, the progress
   bar; Settings → About row. Half a day. NOTES section and this document
   updated to what actually shipped.

The `Embedder` trait is the one piece of deliberate generality: it is what
lets an optional Ollama / `llama-server` backend (NVIDIA and AMD for free) or
a `candle` backend be added later without touching the index, the UI or the
tool — and what would let a future Swift build, if it ever ran the same ONNX
model through ONNX Runtime's
[official Swift package](https://raw.githubusercontent.com/microsoft/onnxruntime-swift-package-manager/main/Package.swift),
share one index by writing under the same key.

---

## Shipped — and what that changed about this document

**Built 2026-09-02, as recommended, on branch `feat/semantic-search`.** The
spike in §7 passed on `ubuntu-24.04` and `macos-14` at the first attempt, so
`candle` was never called for. Six of the unverified items below are now
answered — the ONNX Runtime prebuilt links **statically** (no dylib, no rpath),
the AppImage grew 84.1 → 93.0 MB and the Mac zip 10.3 → 19.1 MB,
`minimumSystemVersion` did have to go to 13.3, warm CI build time is inside the
baseline's noise, and loading the model plus embedding four sentences is about
120 ms. **See `docs/NOTES.md` §32 for the measurements and for what shipped.**
The list below is left as it was written, so it stays a record of what was and
was not known at the time.

## Things this document could not verify

- The uncompressed size of the ONNX Runtime CPU library on either platform,
  and whether pyke's prebuilt binaries link statically. (Spike step 1.)
- Any CPU benchmark of a ~500-token chunk for any candidate runtime.
- `candle`'s exact binary-size delta and its CPU speed relative to ORT beyond
  one issue report.
- BERT WordPiece's tokens-per-word ratio on prose (1.3 is the generic rule).
- Whether cosine ranking is stable across ONNX Runtime versions and execution
  providers for the same model file.
- `usearch`'s behaviour when its mmap'd file is rewritten by a sync daemon.
- Whether Bazzite ships Homebrew preinstalled (search snippets say yes; the
  docs page fetched did not say).
- The Xenova ONNX export's own licence tag (it is a straight export of an MIT
  model; the repo does not display a tag).
