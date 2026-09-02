//! Search by meaning — the embedding model, the index, and the scan.
//!
//! See `docs/semantic-search-research.md` for why every piece is the shape it
//! is, and `docs/NOTES.md` §32 for what the build actually found.

pub mod chunk;
pub mod embed;
pub mod index;
pub mod model;
pub mod service;
