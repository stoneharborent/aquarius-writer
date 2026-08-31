# The Swift app, actually read — Wave 0 audit

*Written 2026-08-30 from a full read of
`Branches/Apps/AquariusWriter/swift/` (~33,000 lines of Swift, ~140 files).
This completes Wave 0 of `PARITY.md` — the earlier session could not open the
Swift folder at all, so its Swift column was reconstructed from contracts and
filename probes. This document is what the Swift app really is. `PARITY.md`
has been rewritten against it.*

The Swift app builds **three targets from one source tree**: macOS 14+, iPad,
and iPhone. Only the macOS shape matters for this port; iOS details are noted
only where they prove a feature's design is portable.

---

## 1. The design language (the "design cues" Royce is missing)

### 1.1 The palette moved on — the port is still wearing the old one

The Swift app's design system is a named brand palette: **`Aqua`, the
25-color "Aquarius Zodiac" set** (`Theme/Theme.swift`) — electric blue
`#7DF9FF`, turquoise `#40E0D0`, aquamarine `#7FFFD4`, aquarius blue
`#3AA2D6`, deep sky `#00BFFF`, ice blue `#DCF3FF`, and friends. Every theme
and accent is built from these.

There are **two themes**:

**Ice** (light — its raw preference value is still `"parchment"` for
compatibility, which is the tell: *Swift evolved Parchment into Ice and this
port never followed*):

| Token | Value |
|---|---|
| bg | `#EAF1F8` |
| bgSoft | `#DFEAF4` |
| surface | `#F7FBFE` |
| surfaceAlt | `#E4EDF6` |
| panel | `#F0F6FC` |
| sidebar | `#EAF1F8` @ 86% |
| ink | `#16273A` |
| inkProse | `#0E1B2A` |
| inkSoft | `#47586B` |
| inkMute | `#7C90A4` |
| line / lineStrong | `#16273A` @ 10% / 18% |
| success / warn / danger | `#1F9E8C` / `#C2792E` / `#C8463B` |
| starred | `#C28B22` |

**Midnight** (dark — deep-ocean navy, *not* the port's warm neutral dark):

| Token | Value |
|---|---|
| bg | `#0B1220` |
| bgSoft | `#111A2B` |
| surface | `#121C2E` |
| surfaceAlt | `#1B2940` |
| panel | `#152033` |
| sidebar | `#0B1220` @ 84% |
| ink | `#DCE9F4` |
| inkProse | `#E7F2FB` |
| inkSoft | `#93A7BC` |
| inkMute | `#5C6E82` |
| line / lineStrong | `#DCF3FF` @ 8% / 16% |
| success / warn / danger | `#5FC9B0` / `#E0A35A` / `#E07B7B` |
| starred | `#E6B947` |

**Four accents**, all from the Aqua family (light variant deepened for
contrast on Ice, dark variant electric on Midnight):

| Accent | Ice | Midnight |
|---|---|---|
| Aquarius Blue | `#2C8FC4` | `#00BFFF` |
| Indigo | `#6E2BE0` | `#9B82FF` |
| Turquoise | `#0E9AA0` | `#40E0D0` |
| Aquamarine | `#12A07C` | `#7FFFD4` |

Note the port's accent keys are literally still `sepia` and `sage` — colors
that no longer exist in the Swift app. Derived tokens: `accentSoft` = accent
@ 18% dark / 14% light; `selection` = 22% / 18%; `ringFocus` = 40% / 35%.

*(The port's third theme — the AquariusOS skin from `os-image/branding` —
is this repo's own addition and stays. It's Parchment and the old Midnight
that should be retired in favor of Ice and ocean-Midnight.)*

### 1.2 Typography

- **Prose**: `Iowan Old Style` (the port ships Source Serif 4 first with
  Iowan only as a fallback — flip the order, or bundle an equivalent since
  Iowan isn't freely redistributable; the Swift web-mirror fallback chain is
  Palatino → Source Serif 4 → Georgia).
- **UI**: system sans (SF on Mac; the port's Inter is the right equivalent).
- **Mono**: `Courier Prime`; screenplay body renders in plain Courier 12pt.
- **The recurring pattern** that makes it look like Aquarius: uppercase
  10pt-heavy micro-labels with `+0.6` tracking as section eyebrows
  ("WORKFLOW", "CHAPTERS", "ELEMENT"), serif for headlines and prose, mono
  for anything numeric or path-like, *italic serif* for secondary copy.

### 1.3 The window shape (macOS)

```
┌────────────────────────────────────────────────────────┐
│ 30pt title strip (bgSoft) — traffic lights + title     │
├────────────────────────────────────────────────────────┤
│ top bar — Files toggle · search capsule 240pt (⌘K)     │
│           · EditorToolbar centered · Spark/Comments/   │
│             Terminal buttons on the right              │
├─────────┬──────────────────────────┬───────────────────┤
│ Sidebar │ Editor pane              │ Right pane        │
│ 248pt   │ min 320pt                │ 360pt default     │
│ 190–560 │ (rails + page canvas)    │ min 280pt         │
│ resizable│                         │ resizable         │
└─────────┴──────────────────────────┴───────────────────┘
```

- **No status bar.** The port's 26px bottom status bar doesn't exist in
  Swift — its contents live in the top bar and sidebar.
- **Every column is resizable** (7pt splitter hit area; 0.5pt hairline that
  thickens to 2pt accent on hover) and **persists its width**.
- **Everything collapses to a uniform 28pt gutter** — sidebar, right pane,
  rails, even the editor — bgSoft with a rotated −90° heavy 10pt label
  ("CHAPTERS" etc.). This is a signature move.
- Rails (chapters/scenes): 244pt open, 28pt collapsed, subtle vertical
  gradient background, `⋮⋮` grip glyphs.

### 1.4 Sidebar anatomy (top to bottom)

1. Search row / hide button
2. **Quick views: Starred · Today · Manuscript**
3. "WORKFLOW" eyebrow divider + **A−/A+ navigator zoom** (scales tree rows
   0.8–1.8×) + an **add menu** (new Markdown/Screenplay file — segmented
   picker — new folder, add existing file/folder)
4. Recursive file tree: indent guides (14pt/level, 0.5pt line), type icons,
   star, status dot; **keyboard nav** (↑/↓ select, ←/→ collapse/expand)
5. **WorkflowSwitcher as a footer chip** → popover listing connected
   workflows + "Add workflow…" + "Manage workflows…"

Tree rows support: rename, move, drag-reorder, **drag-in from Finder,
drag-out to Finder**, Reveal in Finder, Share, Move to Trash, Star/Unstar,
Mark as Manuscript / Add Draft, Open in Split View.

### 1.5 The page canvas

Prose renders on a **US-Letter page sheet** — fixed-width canvas, 1" (96pt)
margins, drop shadow (`black @ 22%, r14, y1`), custom edge scrollbar knob.
This, more than anything, is why the Swift app "looks like a writing app"
and the port looks like a text field.

### 1.6 Component vocabulary

- Hairlines are always **0.5pt** of the `line` token.
- Corner radii scale: 3 (badges/keycaps) · 4–5 (rows, chips) · 6–7 (buttons,
  toolbar groups) · 8 (action cards) · 10 (cards, composer) · 12 (big cards)
  · 14 (chat bubbles).
- Selection/active state is universally `accentSoft` fill + accent text; the
  chapter rail adds a 2pt accent bar bleeding off the leading edge.
- Search field is a **capsule** with a magnifier and a `⌘K` keycap.
- Sheets are fixed-size chrome on `surface`: palette 620×360, settings
  720×480, graph 760×520, trash 880×600, find 920×620, version history
  980×640, compile 1080×700.
- **Empty states are never a shrug**: hand-drawn line illustrations
  (`ZeroIllustration` — folder, book, people, sparkle, ring, search) + serif
  headline + italic subline + CTA.
- Custom-drawn **AppMark**: deep-ocean gradient `#143A66 → #070D1A` rounded
  square, white fountain-pen nib, two Aquarius wave strokes. Drawn in code,
  used on the welcome screen with a radial accent glow.
- Motion is minimal and fast: 0.18s easeOut pane transitions, 0.22s
  slide-overs, 0.12s scroll flashes.

---

## 2. Features the Swift app has (verified in source)

### 2.1 Editors

- **Prose/Note (WYSIWYG)**: syntax tokens collapsed to zero-width regardless
  of caret position; copy/cut strips hidden tokens; inline image rendering;
  **wiki-link autocomplete**; Backlinks panel; per-document zoom
  (⌘+/⌘−/⌘0, persisted per path); undo history.
- **Screenplay**: in-house Fountain engine (680 lines) with
  **industry-exact page geometry** (612×792pt, Courier 12/12, per-element
  point margins, transition right-aligned at 510.98pt); a **paged canvas
  with real page breaks** and caret-anchored zoom; Final Draft Enter/Tab
  rhythm; smart-type autocomplete for character names and scene headings;
  **Title Page as a second tab** on the same file (Title/Credit/Author/
  Source/Draft date/Contact, written into the Fountain title block);
  **drag-reorder scenes rewrites the script**; dual dialogue; revision
  marks; (OMITTED); scene numbers; ~55 lines/page estimate badge; PDF
  preview sheet.
- **Split editor**: two **fully editable** documents side-by-side,
  independent caret/scroll/undo/autosave, draggable divider, active-pane
  accent line. Plus a separate read-only **Reference pane** (right-pane
  mode) — the port's read-only split covers the reference case only.
- **Viewers**: PDF (outline rail, metadata inspector), Image (zoom modes,
  rotate, EXIF inspector), Video, HTML with an **"Edit Source" toggle**.
- **Toolbar**: mode-aware 1–3 stacked rows; screenplay row has the seven
  ELEMENT buttons ⌘1–⌘7 with live sample text; prose row has paragraph-style
  menu, H1–H3, B/I/U/S/code, lists, link/wikilink/image/table/footnote,
  Focus mode, Hide editor.

### 2.2 Manuscript system

- Folders are **marked as Manuscript** (and subfolders as Drafts) via
  context menu; stored in `workflow.json`.
- **ManuscriptHome**: a grid of manuscript cards (icon, title, chapter +
  word counts) — a home screen the port doesn't have.
- **ManuscriptView**: Outline / Cards / Editor tabs, "WORKING MANUSCRIPT"
  eyebrow, draft chips, **status filter chips with per-status counts**,
  summary bar "N chapters · N words · ~N pages".
- **Corkboard**: synopsis edited in place on the card, committed to
  frontmatter (Scrivener behavior).
- **ChapterRail**: aggregate stats, Working Draft menu pill, FRONT MATTER
  section (Title page · Dedication · Epigraph), right-click Move up/down
  **that persists**.

### 2.3 Files, safety, versions

- Create file (MD/Fountain picker) / create folder / rename / move /
  drag-reorder / add existing / star — all in the sidebar UI.
- **Conflict dialog is wired**: file changed on disk while dirty → Keep
  Mine / Take Theirs / Save Mine As Copy (`*.conflict.md`).
- Snapshots: auto (1 per 5 min on save, pruned at 30 days) + named (never
  purged); Version History sheet (⌥⌘H), split diff sheet, a **"Current
  Version" button in the document header** opening a right-pane versions
  panel.
- Comments: line-anchored, stored per-file at
  `.aquarius/comments/<safe-path>.json`, author `you|spark`, anchor
  drift detection.
- Trash: 30-day expiry *shown* but never auto-purged — user confirms
  "Empty trash". (The port auto-sweeps at 30 days; behavior difference.)

### 2.4 Compile / Export — fully real

`CompileSheet` (⌘E, 1080×700, Source / Contents / Output columns):

- Formats: **EPUB** (KDP-ready), **PDF**, **Word .docx**, **Markdown**,
  **Fountain** round-trip; FDX is a friendly stub.
- Engine: **Pandoc subprocess** (+ xelatex for PDF) with a clear
  "install via brew" error, plus a pure `ManuscriptAssembler` for chapter
  ordering/concatenation.
- Per-kind Include options (front/body/back matter, YAML strip, title page,
  scene numbers, notes, boneyards) and profiles (standard submission /
  trade paperback 5.5×8.5 / reader proof; WGA-margin industry standard for
  Fountain).
- iOS proves a lean fallback shape: native Markdown/Fountain/PDF export
  with "Compile on Mac" for DOCX/EPUB. On Linux, pandoc is an easy distro
  dependency — the port has *less* excuse than iPad.

### 2.5 Search

- Find & Replace (⇧⌘F): case/whole-word/regex, grouped results with
  context, replace-all with correct flush ordering — parity with the port.
- **Semantic search**: on-device embeddings (SHA-256 incremental index in
  `.aquarius/`, 180-word chunks), surfaced as a "search by meaning" toggle
  inside the Find sheet, falling back to keyword. Needs an embedding model;
  a research item for Linux, not a copy-paste.

### 2.6 Overlays and chrome

- Command palette (⌘P) — includes "Reference: <note>" entries that open a
  doc in the reference pane.
- Today (⌘T) — goal ring, streak flame, 14-day sparkline, per-doc deltas.
  **Still sample data in Swift too** (labeled "Sample data — live writing
  stats are coming soon"). The port's fake Today is at parity, not behind.
- Graph (⌘G), Cheat sheet (⌘?), Settings (⌘,) — parity.
- Welcome screen: AppMark logo + radial accent glow, three cards, **recent
  workflows list**, **drag a folder anywhere onto the window to open it**,
  footer "local-first · no telemetry".
- Popout windows (⌃⌘O): document detaches to its own 800×640 window; a
  ghost placeholder holds its slot.

### 2.7 Terminal (macOS)

SwiftTerm pane with **multiple named sessions** (tabs: pinned, connected
dot, model+effort chip), configurable agent command, auto-cwd to the
workflow, drag-a-file-to-paste-its-path. The port defers this deliberately;
when it lands, this is the bar.

### 2.8 Spark + MCP

- Spark (embedded AI panel, skills, action approval cards, five providers,
  on-device MLX models) — **removed from the port by decision 2026-08-25.
  Not a gap. Do not port back without asking.**
- **The Swift app also has an MCP bridge** — 33 tools + a self-contained
  browser Web UI at `/ui`, driving the same action runner as Spark. The
  port's 15 tools are *not* "ahead of Swift" as PARITY v1 assumed — they're
  behind on: `rename`, `move`, `delete-with-confirm`, `toggle_star`,
  `toggle_manuscript_folder`, `toggle_draft_folder`, `list_scenes`,
  `reorder_scenes`, `set_synopsis`, `insert_text`, `replace_lines`,
  `replace_in_document`, `diff_version`, `take_snapshot`, theme/appearance
  setters, and `export_pdf`.

### 2.9 Pricing

The Swift app still has tiers (Notes free / Studio $50 once,
`UnlockDialogSheet`). The port removed pricing by decision — closed, and
a Swift-side cleanup question, not a port task.

### 2.10 Also fake or stubbed in Swift (so the port doesn't chase ghosts)

- Today sheet — sample data (above).
- Corkboard "Add card" — disabled "coming soon"; ChapterRail filter/add
  buttons — disabled placeholders.
- FDX export — friendly stub.
- Sync tab — philosophy + an unwired folder field; no sync engine by
  design (matches the port).

---

## 3. Shortcut map worth matching

⌘O open workflow · ⌘P palette · ⌘K focus search · ⌘, settings · ⌘E compile
· ⌘S save · ⌘F find in doc · ⇧⌘F find in workflow · ⌥⌘H version history ·
⌘1/2/3 editor/outline/corkboard · ⌘G graph · ⌘T today · ⌘? cheat sheet ·
⌘\ sidebar · ⌘⌥\ cycle right pane · ⌃⌘O popout · ⌃⌘E hide editor · ⌘⇧J
terminal · ⌘⇧L toggle theme · ⌘+/−/0 editor zoom.

(The port's ⌘1–⌘7 screenplay element keys match Swift's row-3 capsule.)

---

## 4. Architecture notes for the implementer

- The Swift right pane is **one modal slot**: spark · terminal · comments ·
  versions · reference · hidden, cycled with ⌘⌥\. Minus Spark, the port's
  equivalent set is comments · versions · reference (+ terminal later) —
  the port already has the first two as tabs; reference belongs in there
  rather than as a separate split mechanism.
- One decision point drives all chrome: the file's route (prose-in-
  manuscript / note / screenplay / viewer) picks the toolbar mode AND the
  rail kind. The port's MainWindow already approximates this.
- Swift persists UI state per concern in UserDefaults (`aquarius.theme`,
  `.sidebarWidth`, `.sidebarZoom`, `.rightpane.mode`, `.rightpane.width`) —
  note: **theme is global in Swift, not per-workflow**; the port's unwritten
  `workflow.json.settings.theme` may be chasing a behavior Swift doesn't
  have either.
- Swift's trash never auto-purges (user confirms); the port sweeps on load.
  Pick one — silent deletion after 30 days is the more surprising behavior.
