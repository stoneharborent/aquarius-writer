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
  // Deliberately NOT `useEditor()`. Subscribing to the whole editor store put
  // `docs` — a map that `edit` replaces wholesale on every keystroke — into
  // this effect's dependency list, so every character typed re-scanned the
  // entire vault: 67 file reads per keypress on a sixty-note vault
  // (docs/NOTES.md §27l). In the browser preview those are map lookups and
  // cost 2ms; in the shell every one is an IPC round trip that reads a file
  // off disk, which is what "typing in a note is delayed" actually was.
  //
  // Nothing is lost by dropping it. Backlinks answer "what links HERE", so
  // typing in *this* note cannot change them, and the working copies are read
  // at scan time below, so a scan still prefers unsaved text over disk. What
  // changes is the refresh moment: a link typed in ANOTHER document shows up
  // when the tree next reloads (the file watcher fires on save) rather than on
  // that document's next keystroke.
  const [hits, setHits] = useState<Hit[] | null>(null);

  useEffect(() => {
    if (!tree || !current) return;
    let cancelled = false;
    void (async () => {
      const files = collectMarkdown(tree);
      const open = useEditor.getState().docs;
      const bodies: Record<string, string> = {};
      // Prefer the editor's working copy; fall back to disk via vault().
      for (const f of files) {
        // Bail INSIDE the loop. The check used to sit after it, so a
        // superseded scan still read every remaining file off disk before
        // throwing its answer away.
        if (cancelled) return;
        const cached = open[f.path]?.body;
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
  }, [path, tree, current]);

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
