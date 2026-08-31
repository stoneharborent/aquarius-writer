/**
 * The Compile wire types — the TypeScript half of `src-tauri/src/compile/`.
 *
 * Same rule as `types/vault.ts`: these mirror the Rust structs field for field
 * (serde renames everything to camelCase), so an `invoke()` result drops
 * straight into the sheet. If one side changes, change the other in the same
 * commit.
 */

/** The five formats that actually exist. FDX is not one of them — see NOTES §19. */
export type CompileFormatId = "markdown" | "pdf" | "epub" | "docx" | "fountain";

export interface CompileProfileInfo {
  id: string;
  label: string;
  /** One line under the name: what this profile does to the page. */
  note: string;
  /** Which formats offer it. */
  formats: CompileFormatId[];
}

/** What Compile can do on this machine, asked once when the sheet opens. */
export interface CompileProbe {
  pandoc: boolean;
  pandocPath: string | null;
  pandocVersion: string | null;
  pdfEngine: string | null;
  pdfEnginePath: string | null;
  /** False when the engine found is not a LaTeX one and ignores the layout. */
  pdfLayoutSupported: boolean;
  availableFormats: CompileFormatId[];
  installHint: string;
  engineHint: string;
  profiles: CompileProfileInfo[];
  /** `Exports/` inside the vault, absolute. Null with no workflow open. */
  defaultDirectory: string | null;
}

export type CompileSource =
  | { kind: "manuscript"; manuscriptId?: string | null; draftId?: string | null }
  | { kind: "document"; path: string };

export interface CompileOptions {
  stripFrontmatter?: boolean;
  chapterHeadings?: boolean;
  pageBreaks?: boolean;
  titleBlock?: boolean;
  titlePage?: boolean;
  stripNotes?: boolean;
  sceneNumbers?: boolean;
  author?: string;
}

export interface CompileRequest {
  format: CompileFormatId;
  source: CompileSource;
  profile?: string;
  options?: CompileOptions;
  /** Absolute path of the folder to write into. Created if missing. */
  outputDirectory: string;
  /** File name without an extension; slugified on the Rust side. */
  fileName?: string;
}

export interface CompileReport {
  path: string;
  fileName: string;
  directory: string;
  format: CompileFormatId;
  profile: string;
  bytes: number;
  chapters: number;
  words: number;
  /** Chapters that were not on disk. Reported, never fatal. */
  missing: string[];
  engine?: string;
  /** True when the name was taken and a " 2" was used. */
  renamed: boolean;
}

/**
 * A structured failure, not a string.
 *
 * `code` is what lets the sheet offer "here is how to install pandoc" instead
 * of printing a sentence and shrugging.
 */
export interface CompileFailure {
  code:
    | "pandocMissing"
    | "pdfEngineMissing"
    | "pandocFailed"
    | "noChapters"
    | "badRequest"
    | "io"
    | string;
  message: string;
  hint?: string;
}

/** Narrow whatever `invoke()` rejected with into a failure we can render. */
export function asCompileFailure(err: unknown): CompileFailure {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const e = err as { code: unknown; message: unknown; hint?: unknown };
    if (typeof e.code === "string" && typeof e.message === "string") {
      return {
        code: e.code,
        message: e.message,
        hint: typeof e.hint === "string" ? e.hint : undefined,
      };
    }
  }
  return { code: "io", message: typeof err === "string" ? err : String(err) };
}
