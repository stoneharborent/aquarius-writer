/**
 * The renderer's door onto `src-tauri/src/compile/`.
 *
 * Deliberately *not* part of `VaultService`. That interface is the vault seam —
 * nine file operations with a browser mock behind them so the UI can be
 * developed in a tab. Compile has no honest mock: it runs a subprocess and
 * writes a file outside the vault, and a fake that pretends to have made an
 * EPUB is exactly the thing this change exists to delete. So in the browser
 * preview the probe answers "nothing is available" and the sheet says so.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauriShell } from "@/lib/platform";
import type { CompileProbe, CompileReport, CompileRequest } from "@/types/compile";

/** What the browser preview gets: honest about having no backend at all. */
const NO_BACKEND: CompileProbe = {
  pandoc: false,
  pandocPath: null,
  pandocVersion: null,
  pdfEngine: null,
  pdfEnginePath: null,
  pdfLayoutSupported: false,
  availableFormats: [],
  installHint: "Compile runs in the desktop app — this is the browser preview.",
  engineHint: "",
  profiles: [],
  defaultDirectory: null,
};

export async function probeCompile(workflowId?: string | null): Promise<CompileProbe> {
  if (!isTauriShell()) return NO_BACKEND;
  return invoke<CompileProbe>("compile_probe", { workflowId: workflowId ?? null });
}

/** Rejects with a `CompileFailure` object — run it through `asCompileFailure`. */
export async function runCompile(
  workflowId: string,
  request: CompileRequest,
): Promise<CompileReport> {
  return invoke<CompileReport>("compile_run", { workflowId, request });
}

/**
 * Ask for the output folder with the same native dialog the welcome screen
 * uses, so Compile needs no new capability. Null when dismissed.
 */
export async function pickOutputFolder(): Promise<string | null> {
  if (!isTauriShell()) return null;
  return invoke<string | null>("vault_pick_folder", {
    title: "Choose where to save the compiled file",
  });
}

/** Open the compiled file's folder in the desktop's file manager. */
export async function revealCompiled(path: string): Promise<void> {
  if (!isTauriShell()) return;
  await invoke("compile_reveal", { path });
}

/** "1.2 MB" — the size line under a finished compile. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Split "a/b/Name.md" into its folder and its stem, the two things
 * `compile_run` actually wants. Kept here so the sheet can go on showing one
 * path field, which is the design that was already there.
 */
export function splitDestination(value: string): { directory: string; fileName: string } {
  const trimmed = value.trim();
  const cut = trimmed.lastIndexOf("/");
  if (cut < 0) return { directory: "", fileName: stripExtension(trimmed) };
  return {
    directory: trimmed.slice(0, cut) || "/",
    fileName: stripExtension(trimmed.slice(cut + 1)),
  };
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The filesystem-safe name the Rust side would pick — mirrors `slugify`. */
export function slugify(input: string): string {
  const out = input
    .split("")
    .map((ch) => (/[\p{L}\p{N}]/u.test(ch) ? ch : " "))
    .join("")
    .trim()
    .replace(/\s+/g, "-");
  return out.length ? out : "untitled";
}
