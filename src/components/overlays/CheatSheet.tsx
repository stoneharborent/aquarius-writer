import { Overlay } from "./Overlay";
import "./CheatSheet.css";

interface ShortcutRow {
  combo: string;
  label: string;
}

const GROUPS: { name: string; rows: ShortcutRow[] }[] = [
  {
    name: "Navigation",
    rows: [
      { combo: "⌘P", label: "Command palette" },
      { combo: "⌘O", label: "Open workflow" },
      { combo: "⌃⌘O", label: "Pop chapter/note out into its own window" },
      { combo: "⌘1", label: "Switch to editor" },
      { combo: "⌘2", label: "Manuscript outline" },
      { combo: "⌘3", label: "Corkboard" },
      { combo: "⌘G", label: "Graph view" },
      { combo: "⌘T", label: "Today" },
    ],
  },
  {
    name: "Editing",
    rows: [
      { combo: "⌘S", label: "Force save (auto-save runs continuously)" },
      { combo: "⌘B", label: "Bold" },
      { combo: "⌘I", label: "Italic" },
      { combo: "⌘K", label: "Insert wiki link" },
      { combo: "⌘F", label: "Find in document" },
      { combo: "⇧⌘F", label: "Find in workflow" },
    ],
  },
  {
    name: "View",
    rows: [
      { combo: "⌘\\", label: "Toggle sidebar" },
      { combo: "⌘⇧L", label: "Toggle theme (Parchment / Midnight)" },
    ],
  },
  {
    name: "System",
    rows: [
      { combo: "⌘,", label: "Settings" },
      { combo: "⌘E", label: "Compile / Export" },
      { combo: "⌘?", label: "This cheat sheet" },
      { combo: "Esc", label: "Close overlays" },
    ],
  },
];

export function CheatSheet() {
  return (
    <Overlay title="Keyboard shortcuts" width={760}>
      <div className="cs">
        {GROUPS.map((g) => (
          <section key={g.name} className="cs-group">
            <h3>{g.name}</h3>
            <ul>
              {g.rows.map((r) => (
                <li key={r.combo}>
                  <span className="cs-label">{r.label}</span>
                  <kbd className="cs-kbd">{r.combo}</kbd>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Overlay>
  );
}
