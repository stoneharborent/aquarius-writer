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
      { combo: "⌘K", label: "Focus the search capsule (filters the file tree)" },
    ],
  },
  {
    name: "Editing",
    rows: [
      { combo: "⌘S", label: "Force save (auto-save runs continuously)" },
      { combo: "⌘B", label: "Bold" },
      { combo: "⌘I", label: "Italic" },
      { combo: "⌘F", label: "Find in document" },
      { combo: "⇧⌘F", label: "Find in workflow" },
      { combo: "[[", label: "Wiki-link autocomplete — ↑↓ to pick, ⏎ to insert, Esc to dismiss" },
    ],
  },
  {
    name: "View",
    rows: [
      { combo: "⌘\\", label: "Toggle sidebar" },
      { combo: "⌘⌥\\", label: "Cycle the right pane (comments → versions → hidden)" },
      { combo: "⌘⇧L", label: "Toggle theme (Ice / Midnight)" },
      { combo: "⌘+", label: "Zoom this document in (remembered per document)" },
      { combo: "⌘−", label: "Zoom this document out" },
      { combo: "⌘0", label: "Reset this document's zoom to 100%" },
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
