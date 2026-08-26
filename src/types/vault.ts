// Vault data shapes. The on-disk contract from HANDOFF.md §3 + §4.

import type { AccentName, ThemeName } from "@/theme/theme";

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
  theme: ThemeName;
  accent: AccentName;
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
  color: AccentName;
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
