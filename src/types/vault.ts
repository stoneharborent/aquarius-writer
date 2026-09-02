// Vault data shapes. The on-disk contract from HANDOFF.md §3 + §4.

export type WorkflowKind = "novel" | "screenplay" | "worldbuilding" | "notes";

export type ChapterStatus = "final" | "drafting" | "rev" | "outline";

export interface Chapter {
  n: number;
  title: string;
  words: number;
  status: ChapterStatus;
}

export interface DocFrontMatter {
  title?: string;
  status?: ChapterStatus;
  synopsis?: string;
  [key: string]: unknown;
}

export interface Draft {
  id: string;
  name: string;
  active?: boolean;
  chapterOrder: string[]; // relative paths under the manuscript folder
  /**
   * The folder this draft's chapters come from, when it is a *folder-backed*
   * draft — one marked with `toggleDraftFolder`. Absent for the manuscript's
   * own named cut, which follows the manuscript rather than a folder of its
   * own. `Draft::folder` in `src-tauri/src/model.rs`.
   */
  folder?: string;
}

export interface Manuscript {
  id: string;
  title: string;
  folder: string; // relative path inside the workflow
  chapterOrder: string[];
}

export interface WorkflowSettings {
  /**
   * Raw off disk, so it is a `string` and not a `ThemeName`: a `workflow.json`
   * written before the Ice palette landed says `"parchment"`, and the Rust
   * struct's default still does. Run it through `normalizeTheme` before use.
   */
  theme: string;
  /** Raw off disk — may still be `purple` / `sepia` / `sage`. See above. */
  accent: string;
  fontSize: number;
}

export interface Goals {
  dailyWords: number;
  kind: "daily" | "weekly" | "project";
}

export interface Workflow {
  id: string;
  title: string;
  kind: WorkflowKind;
  drafts: Draft[];
  manuscripts: Manuscript[];
  settings: WorkflowSettings;
  goals: Goals;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  path: string;
  kind: WorkflowKind;
  items: number;
  active?: boolean;
  /** The workflow's saved accent, raw off disk — normalize before rendering. */
  color: string;
  updated: string; // "now" | "yesterday" | ISO etc
}

export type NodeKind = "folder" | "markdown" | "fountain" | "image" | "pdf" | "other";

/**
 * One file that matched a Find query — the shape `vault::search::SearchHit`
 * serialises to. `line` is 0-based, the same numbering the editor and the MCP
 * tools count in.
 */
export interface SearchHit {
  path: string;
  line: number;
  preview: string;
  /** Matches in this file. Results are ordered by it, descending. */
  count: number;
}

export interface VaultNode {
  name: string;
  path: string; // relative to workflow root
  kind: NodeKind;
  children?: VaultNode[];
  frontmatter?: DocFrontMatter;
  words?: number;
}

/** The two document kinds the sidebar's add menu offers. */
export type NewFileKind = "markdown" | "fountain";

/**
 * A manuscript's chapter order after it was rearranged — `ReorderReport` in
 * `src-tauri/src/vault/ops.rs`, the answer to both the rail's drag and the MCP
 * `reorder_chapters` tool.
 */
export interface ReorderReport {
  manuscriptId: string;
  order: string[];
}

/**
 * A folder after its manuscript / draft mark was flipped — `FolderRoleReport`
 * in `src-tauri/src/vault/ops.rs`, the answer to both the sidebar row's ⋯ menu
 * and the MCP `toggle_manuscript_folder` / `toggle_draft_folder` tools.
 */
export interface FolderRoleReport {
  path: string;
  role: "manuscript" | "draft";
  /** True when the folder now has the role, false when the mark came off. */
  marked: boolean;
  /** The manifest record's id, when there is one now. */
  id?: string;
  /** The chapter order the record ended up with. */
  chapters: string[];
}

/** Which draft is now the working one — `ActiveDraftReport` in `ops.rs`. */
export interface ActiveDraftReport {
  id: string;
  name: string;
  chapters: string[];
}

// ── the conflict contract (PARITY row 9) ─────────────────────────────────
//
// Mirrors `FileStamp` / `FileRead` / `WriteResult` in `src-tauri/src/model.rs`,
// field for field. A read hands back a stamp, the editor keeps it as that
// buffer's baseline, and a save that carries the baseline is refused when the
// file on disk has stopped matching it.

/**
 * What the app last saw of a file on disk.
 *
 * `hash` is the only field anything decides on — SHA-256 of the exact bytes.
 * `mtimeMs` and `bytes` are for diagnostics. The reason is written out in
 * `src-tauri/src/fs_ops/stamp.rs`, and the short version is that this vault
 * lives in iCloud, and iCloud re-stamps files whose bytes it never touched.
 */
export interface FileStamp {
  hash: string;
  /** Epoch milliseconds, or 0 when the filesystem would not say. */
  mtimeMs: number;
  bytes: number;
}

/** A document's text plus the stamp of the bytes it was read from. */
export interface FileRead {
  path: string;
  content: string;
  stamp: FileStamp;
}

/**
 * What came of a write.
 *
 * A refusal is a `conflict` **result**, not a thrown error: the caller needs
 * the on-disk text to show a diff, and an exception cannot carry it usefully.
 * Real failures (a path outside the vault, a permission problem) still reject.
 */
export type WriteResult =
  | {
      status: "written";
      path: string;
      /** False when the bytes were already identical and the file was not touched. */
      changed: boolean;
      stamp: FileStamp;
    }
  | {
      status: "conflict";
      path: string;
      /** The text that is on disk right now. */
      theirs: string;
      stamp: FileStamp;
    };

/**
 * A file or folder after it was created, renamed or moved — the answer from
 * `vault_create_file` / `vault_create_folder` / `vault_rename` / `vault_move`
 * (`EntryReport` in `src-tauri/src/vault/ops.rs`).
 *
 * Enough to patch the tree without reloading the whole vault.
 */
export interface EntryReport {
  /** Where it is now, vault-relative. */
  path: string;
  /** Display name for the tree row — markdown drops its extension. */
  name: string;
  kind: NodeKind;
  /** Where it was before a rename or move; absent for a fresh create. */
  from?: string;
  /** True when the name was taken and a " 2" / " 3" suffix was used. */
  renamed: boolean;
}
