import { useEffect, useMemo, useRef, useState } from "react";
import { comboLabel } from "@/lib/shortcuts";
import { Overlay } from "./Overlay";
import { useVault } from "@/state/vaultStore";
import { useOverlay } from "@/state/overlayStore";
import { collectMarkdown } from "@/lib/wikilinks";
import {
  BookIcon,
  CommandIcon,
  FileIcon,
  GraphIcon,
  ImageIcon,
  PdfIcon,
  ScreenplayIcon,
  SearchIcon,
  SettingsIcon,
  SparkleIcon,
  StarIcon,
} from "@/icons";
import { ACCENTS, ACCENT_LABEL, THEMES, THEME_LABEL, themeLocksAccent } from "@/theme/theme";
import { useTheme } from "@/state/themeStore";
import { useFavorites } from "@/state/favoritesStore";
import "./CommandPalette.css";

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: JSX.Element;
  run: () => void;
}

export function CommandPalette() {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const tree = useVault((s) => s.tree);
  const selectedPath = useVault((s) => s.selectedPath);
  const selectPath = useVault((s) => s.selectPath);
  const setView = useVault((s) => s.setView);
  const openOv = useOverlay((s) => s.open);
  const close = useOverlay((s) => s.close);
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
  const setAccent = useTheme((s) => s.setAccent);
  const starred = useFavorites((s) => s.starred);
  const toggleStar = useFavorites((s) => s.toggle);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];

    // Commands
    const view = (v: "editor" | "home" | "outline" | "corkboard") => () => { setView(v); close(); };
    out.push({ id: "v:editor", group: "View", label: "Switch to Editor", hint: "⌘1",
      icon: <BookIcon size={13} color="var(--ink-soft)" />, run: view("editor") });
    out.push({ id: "v:outline", group: "View", label: "Switch to Manuscript outline", hint: "⌘2",
      icon: <BookIcon size={13} color="var(--ink-soft)" />, run: view("outline") });
    out.push({ id: "v:cards", group: "View", label: "Switch to Corkboard", hint: "⌘3",
      icon: <BookIcon size={13} color="var(--ink-soft)" />, run: view("corkboard") });
    // No shortcut of its own: ⌘2 goes straight to the manuscript you were in,
    // which is the common act. This is the way to the grid of all of them.
    out.push({ id: "v:home", group: "View", label: "Switch to All manuscripts",
      icon: <BookIcon size={13} color="var(--ink-soft)" />, run: view("home") });

    // The star for whatever is open. The sidebar's row star needs a hover and
    // a mouse; this is the same flip from the keyboard.
    if (selectedPath) {
      const on = starred.has(selectedPath);
      out.push({
        id: "star:current",
        group: "Action",
        label: on ? "Unstar this document" : "Star this document",
        hint: selectedPath,
        icon: <StarIcon size={13} filled={on} color={on ? "var(--starred)" : "var(--ink-soft)"} />,
        run: () => { void toggleStar(selectedPath); close(); },
      });
    }

    out.push({ id: "ov:compile", group: "Action", label: "Compile / Export…", hint: "⌘E",
      icon: <SparkleIcon size={13} color="var(--ink-soft)" />, run: () => { openOv("compile"); } });
    out.push({ id: "ov:today", group: "Action", label: "Today", hint: "⌘T",
      icon: <SparkleIcon size={13} color="var(--ink-soft)" />, run: () => { openOv("today"); } });
    out.push({ id: "ov:graph", group: "Action", label: "Graph view", hint: "⌘G",
      icon: <GraphIcon size={13} color="var(--ink-soft)" />, run: () => { openOv("graph"); } });
    out.push({ id: "ov:settings", group: "Action", label: "Settings…", hint: "⌘,",
      icon: <SettingsIcon size={13} color="var(--ink-soft)" />, run: () => { openOv("settings"); } });
    out.push({ id: "ov:cheats", group: "Action", label: "Keyboard cheat sheet", hint: "⌘?",
      icon: <CommandIcon size={13} color="var(--ink-soft)" />, run: () => { openOv("cheatsheet"); } });

    // Theme + accent. Both go through the theme store, so picking one here
    // counts as an explicit choice and sticks — same as picking it in Settings.
    for (const t of THEMES) {
      out.push({
        id: `theme:${t}`, group: "Theme",
        label: `Theme · ${THEME_LABEL[t]}`,
        icon: <SettingsIcon size={13} color="var(--ink-soft)" />,
        run: () => { setTheme(t); close(); },
      });
    }
    // AquariusOS locks the accent to starlight — no accent commands under it.
    if (!themeLocksAccent(theme)) {
      for (const a of ACCENTS) {
        out.push({
          id: `accent:${a}`, group: "Theme",
          label: `Accent · ${ACCENT_LABEL[a]}`,
          icon: <SettingsIcon size={13} color="var(--ink-soft)" />,
          run: () => { setAccent(a); close(); },
        });
      }
    }

    // Files
    if (tree) {
      const files = collectMarkdown(tree).map((f) => ({ ...f, kind: "markdown" as const }));
      // Manual additions for fountain / image / pdf
      walkExtras(tree, (n) => files.push({ path: n.path, name: n.name, kind: n.kind as never }));
      for (const f of files) {
        out.push({
          id: `file:${f.path}`,
          group: "Files",
          label: f.name,
          hint: f.path,
          icon: pickIcon(f.kind),
          run: () => { selectPath(f.path); setView("editor"); close(); },
        });
      }
    }

    return out;
  }, [tree, selectPath, setView, openOv, close, theme, setTheme, setAccent,
      selectedPath, starred, toggleStar]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter((i) =>
      i.label.toLowerCase().includes(q) ||
      i.hint?.toLowerCase().includes(q) ||
      i.group.toLowerCase().includes(q),
    );
  }, [items, query]);

  useEffect(() => { setActiveIdx(0); }, [query]);

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[activeIdx]?.run();
    }
  }

  return (
    <Overlay width={620}>
      <div className="cp">
        <div className="cp-search">
          <SearchIcon size={14} color="var(--ink-mute)" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Jump to anywhere, run a command…"
          />
          <span className="cp-esc">esc</span>
        </div>
        <ul className="cp-list">
          {filtered.length === 0 && (
            <li className="cp-empty">Nothing matches "{query}"</li>
          )}
          {filtered.slice(0, 80).map((i, idx) => (
            <li
              key={i.id}
              className={`cp-row${idx === activeIdx ? " active" : ""}`}
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => i.run()}
            >
              <span className="cp-icon">{i.icon}</span>
              <span className="cp-label">{i.label}</span>
              <span className="cp-group">{i.group}</span>
              {i.hint && <span className="cp-hint">{comboLabel(i.hint)}</span>}
            </li>
          ))}
        </ul>
      </div>
    </Overlay>
  );
}

function pickIcon(kind: string): JSX.Element {
  if (kind === "fountain") return <ScreenplayIcon size={13} color="var(--ink-soft)" />;
  if (kind === "image") return <ImageIcon size={13} color="var(--ink-soft)" />;
  if (kind === "pdf") return <PdfIcon size={13} color="var(--ink-soft)" />;
  return <FileIcon size={13} color="var(--ink-soft)" />;
}

function walkExtras(node: import("@/types/vault").VaultNode, push: (n: import("@/types/vault").VaultNode) => void) {
  if (node.kind === "fountain" || node.kind === "image" || node.kind === "pdf") push(node);
  node.children?.forEach((c) => walkExtras(c, push));
}
