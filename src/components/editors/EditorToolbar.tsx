// Editor toolbar — web mirror of the desktop `Views/Editor/EditorToolbar.swift`.
// Markdown docs get format command groups; screenplays get the element bar.
// Commands route through the formatBus to the focused pane's EditorView.
import { UndoIcon } from "@/icons";
import { formatBus, type FormatCommand } from "@/lib/format/formatBus";
import { applyMdCommand } from "@/lib/format/mdCommands";
import {
  applyElement,
  type FountainElement,
} from "@/lib/markdown/fountain-smart";
import "./EditorToolbar.css";

interface MdBtn {
  cmd: FormatCommand;
  label: React.ReactNode;
  title: string;
}

const INLINE: MdBtn[] = [
  { cmd: "bold", label: <b>B</b>, title: "Bold (⌘B)" },
  { cmd: "italic", label: <i>I</i>, title: "Italic (⌘I)" },
  { cmd: "strike", label: <s>S</s>, title: "Strikethrough" },
  { cmd: "code", label: <code>{"<>"}</code>, title: "Inline code" },
];
const HEADINGS: MdBtn[] = [
  { cmd: "h1", label: "H1", title: "Heading 1" },
  { cmd: "h2", label: "H2", title: "Heading 2" },
  { cmd: "h3", label: "H3", title: "Heading 3" },
];
const BLOCKS: MdBtn[] = [
  { cmd: "bulletList", label: "•", title: "Bullet list" },
  { cmd: "numberedList", label: "1.", title: "Numbered list" },
  { cmd: "taskList", label: "☐", title: "Task list" },
  { cmd: "blockquote", label: "❝", title: "Quote" },
  { cmd: "divider", label: "—", title: "Divider" },
];
const INSERT: MdBtn[] = [
  { cmd: "link", label: "🔗", title: "Link" },
  { cmd: "wikilink", label: "[[ ]]", title: "Wiki link" },
  { cmd: "table", label: "⊞", title: "Table" },
];

export const FOUNTAIN_ELEMENTS: { el: FountainElement; label: string; kb: string }[] = [
  { el: "scene", label: "Scene", kb: "⌘1" },
  { el: "action", label: "Action", kb: "⌘2" },
  { el: "character", label: "Character", kb: "⌘3" },
  { el: "parenthetical", label: "Paren", kb: "⌘4" },
  { el: "dialogue", label: "Dialogue", kb: "⌘5" },
  { el: "transition", label: "Transition", kb: "⌘6" },
  { el: "shot", label: "Shot", kb: "⌘7" },
];

export function EditorToolbar({
  kind, path, activeElement,
}: {
  kind: "md" | "fountain";
  path: string;
  activeElement?: FountainElement | null;
}) {
  const md = (cmd: FormatCommand) => {
    const view = formatBus.target(path);
    if (view) applyMdCommand(view, cmd);
  };
  const element = (el: FountainElement) => {
    const view = formatBus.target(path);
    if (view) applyElement(view, el);
  };

  if (kind === "fountain") {
    return (
      <div className="ed-toolbar" role="toolbar" aria-label="Screenplay elements">
        <span className="ed-tb-label">ELEMENT</span>
        <div className="ed-tb-pills">
          {FOUNTAIN_ELEMENTS.map(({ el, label, kb }) => (
            <button
              key={el}
              className={`ed-tb-pill${activeElement === el ? " on" : ""}`}
              title={`${label} (${kb})`}
              onClick={() => element(el)}
            >
              {label}
              <span className="ed-tb-kb">{kb}</span>
            </button>
          ))}
        </div>
        <span className="ed-tb-spacer" />
        <button className="ed-tb-btn" title="Undo (⌘Z)" onClick={() => md("undo")}>
          <UndoIcon size={13} />
        </button>
      </div>
    );
  }

  const group = (btns: MdBtn[]) => (
    <div className="ed-tb-group">
      {btns.map((b) => (
        <button key={b.cmd} className="ed-tb-btn" title={b.title}
          onMouseDown={(e) => e.preventDefault() /* keep editor focus */}
          onClick={() => md(b.cmd)}>
          {b.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="ed-toolbar" role="toolbar" aria-label="Formatting">
      {group(INLINE)}
      <span className="ed-tb-sep" />
      {group(HEADINGS)}
      <span className="ed-tb-sep" />
      {group(BLOCKS)}
      <span className="ed-tb-sep" />
      {group(INSERT)}
      <span className="ed-tb-spacer" />
      <button className="ed-tb-btn" title="Undo (⌘Z)"
        onMouseDown={(e) => e.preventDefault()} onClick={() => md("undo")}>
        <UndoIcon size={13} />
      </button>
      <button className="ed-tb-btn ed-tb-redo" title="Redo (⇧⌘Z)"
        onMouseDown={(e) => e.preventDefault()} onClick={() => md("redo")}>
        <UndoIcon size={13} />
      </button>
    </div>
  );
}
