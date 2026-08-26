// [[wiki-link]] resolution + backlink discovery.
// Names match the file's display name (without .md extension) case-insensitively.

import type { VaultNode } from "@/types/vault";

export interface ResolvedLink {
  raw: string; // "[[Imogen]]" or "[[Imogen|her]]"
  target: string; // "Imogen"
  alias?: string;
  path: string | null;
}

export const WIKILINK_REGEX = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;

/** Flatten the tree into [path, displayName] pairs for markdown files. */
export function collectMarkdown(tree: VaultNode): Array<{ path: string; name: string }> {
  const out: Array<{ path: string; name: string }> = [];
  walk(tree, out);
  return out;
}

function walk(node: VaultNode, out: Array<{ path: string; name: string }>) {
  if (node.kind === "markdown") {
    out.push({ path: node.path, name: displayName(node.path) });
  }
  node.children?.forEach((c) => walk(c, out));
}

function displayName(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.md$/i, "").replace(/^Ch_\d+\s*[·-]?\s*/i, "");
}

/** Best-effort name → path lookup. Case-insensitive on the leaf name. */
export function resolveName(name: string, files: Array<{ path: string; name: string }>): string | null {
  const target = name.trim().toLowerCase();
  const hit = files.find((f) => f.name.toLowerCase() === target);
  return hit ? hit.path : null;
}

/** Extract every [[link]] in text with resolution info. */
export function extractLinks(text: string, files: Array<{ path: string; name: string }>): ResolvedLink[] {
  const out: ResolvedLink[] = [];
  let m: RegExpExecArray | null;
  WIKILINK_REGEX.lastIndex = 0;
  while ((m = WIKILINK_REGEX.exec(text))) {
    const target = m[1].trim();
    out.push({
      raw: m[0],
      target,
      alias: m[2]?.trim(),
      path: resolveName(target, files),
    });
  }
  return out;
}

/** Find all docs that link to `targetPath`. Requires reading every doc's body
 * — caller supplies them. */
export function findBacklinks(
  targetPath: string,
  files: Array<{ path: string; name: string }>,
  bodies: Record<string, string>,
): Array<{ path: string; name: string; context: string }> {
  const targetName = displayName(targetPath).toLowerCase();
  const hits: Array<{ path: string; name: string; context: string }> = [];

  for (const f of files) {
    if (f.path === targetPath) continue;
    const body = bodies[f.path];
    if (!body) continue;
    WIKILINK_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_REGEX.exec(body))) {
      const name = m[1].trim().toLowerCase();
      if (name === targetName) {
        hits.push({
          path: f.path,
          name: f.name,
          context: extractContext(body, m.index, m[0].length),
        });
        break; // one entry per source file
      }
    }
  }
  return hits;
}

function extractContext(text: string, start: number, len: number): string {
  const radius = 60;
  const a = Math.max(0, start - radius);
  const b = Math.min(text.length, start + len + radius);
  const before = a > 0 ? "…" : "";
  const after = b < text.length ? "…" : "";
  return (before + text.slice(a, b) + after).replace(/\s+/g, " ").trim();
}
