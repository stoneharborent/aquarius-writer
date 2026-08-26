import { useEffect, useState } from "react";
import { useVault } from "@/state/vaultStore";
import { useEditor } from "@/state/editorStore";
import { collectMarkdown, findBacklinks } from "@/lib/wikilinks";
import { vault } from "@/lib/vault";
import { parse } from "@/lib/frontmatter";
import { LinkIcon } from "@/icons";
import "./Backlinks.css";

interface BacklinksProps {
  path: string;
}

interface Hit {
  path: string;
  name: string;
  context: string;
}

export function Backlinks({ path }: BacklinksProps) {
  const tree = useVault((s) => s.tree);
  const current = useVault((s) => s.current);
  const selectPath = useVault((s) => s.selectPath);
  const setView = useVault((s) => s.setView);
  const editor = useEditor();

  const [hits, setHits] = useState<Hit[] | null>(null);

  useEffect(() => {
    if (!tree || !current) return;
    let cancelled = false;
    void (async () => {
      const files = collectMarkdown(tree);
      const bodies: Record<string, string> = {};
      // Prefer the editor's working copy; fall back to disk via vault().
      for (const f of files) {
        const cached = editor.docs[f.path]?.body;
        if (cached !== undefined) {
          bodies[f.path] = cached;
        } else {
          try {
            const raw = await vault().readFile(current.id, f.path);
            bodies[f.path] = parse(raw).body;
          } catch {
            bodies[f.path] = "";
          }
        }
      }
      if (cancelled) return;
      setHits(findBacklinks(path, files, bodies));
    })();
    return () => { cancelled = true; };
  }, [path, tree, current, editor.docs]);

  if (hits === null) {
    return (
      <div className="backlinks">
        <div className="bl-head">Backlinks</div>
        <div className="bl-empty">Scanning vault…</div>
      </div>
    );
  }

  return (
    <div className="backlinks">
      <div className="bl-head">
        <LinkIcon size={12} color="var(--ink-mute)" />
        <span>Backlinks</span>
        <span className="bl-count">{hits.length}</span>
      </div>
      {hits.length === 0 ? (
        <div className="bl-empty">
          Nothing links here yet. Add <code>[[{strip(path)}]]</code> to another note.
        </div>
      ) : (
        <ul className="bl-list">
          {hits.map((h) => (
            <li key={h.path}>
              <button
                className="bl-link"
                onClick={() => { selectPath(h.path); setView("editor"); }}
              >
                <span className="bl-name">{h.name}</span>
                <span className="bl-ctx">{h.context}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function strip(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}
