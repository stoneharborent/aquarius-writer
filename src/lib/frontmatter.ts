// Minimal YAML frontmatter reader/writer.
// HANDOFF §3 says frontmatter is optional and limited (title, status, synopsis).
// We support flat key: value pairs and `|`-style multi-line values.
// Anything more exotic, the on-disk file wins on next save — we don't lose data.

import type { DocFrontMatter } from "@/types/vault";

const FENCE = "---";

export interface ParsedDoc {
  frontmatter: DocFrontMatter;
  body: string;
  /** Raw frontmatter text (between fences) — preserves unknown keys on save. */
  raw: string | null;
}

export function parse(input: string): ParsedDoc {
  const lines = input.split("\n");
  if (lines[0]?.trim() !== FENCE) {
    return { frontmatter: {}, body: input, raw: null };
  }

  // Find closing fence.
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FENCE) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { frontmatter: {}, body: input, raw: null };
  }

  const yamlLines = lines.slice(1, end);
  const bodyLines = lines.slice(end + 1);
  if (bodyLines[0] === "") bodyLines.shift();

  return {
    frontmatter: parseYaml(yamlLines),
    body: bodyLines.join("\n"),
    raw: yamlLines.join("\n"),
  };
}

export function stringify(fm: DocFrontMatter, body: string): string {
  const keys = Object.keys(fm);
  if (keys.length === 0) return body;
  const out: string[] = [FENCE];
  for (const k of keys) {
    const v = fm[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.includes("\n")) {
      out.push(`${k}: |`);
      for (const line of v.split("\n")) out.push(`  ${line}`);
    } else {
      out.push(`${k}: ${formatScalar(v)}`);
    }
  }
  out.push(FENCE, "", body);
  return out.join("\n");
}

function parseYaml(lines: string[]): DocFrontMatter {
  const fm: DocFrontMatter = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (rawVal.trim() === "|") {
      // Multi-line block — collect indented continuation.
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        i++;
        block.push(lines[i].replace(/^\s\s?/, ""));
      }
      fm[key] = block.join("\n");
    } else {
      fm[key] = stripQuotes(rawVal.trim());
    }
  }
  return fm;
}

function stripQuotes(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function formatScalar(v: unknown): string {
  if (typeof v === "string") {
    if (/[:#\-?]|^\s|\s$/.test(v) && !/^[A-Za-z0-9_/.\s,'-]+$/.test(v)) {
      return `"${v.replace(/"/g, '\\"')}"`;
    }
    return v;
  }
  return String(v);
}
