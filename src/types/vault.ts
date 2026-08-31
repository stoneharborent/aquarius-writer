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
