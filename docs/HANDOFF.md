# Aquarius Writer — Handoff

A local-first writing studio for novels, screenplays, and the worlds you keep around them.
This document is the source of truth for developers picking up the build. Read it once
through before opening the mocks.

---

## 1. What this is

Aquarius is a desktop writing app (macOS first, then Windows / Linux). Three
products in one window:

1. **Vault** — a folder of writing on disk. No cloud, no lock-in. Just files.
2. **Editors** — three of them, switched by file kind:
   - **Prose editor** for chapters of a manuscript (markdown under the hood)
   - **Note editor** (WYSIWYG markdown) for everything else: characters, research, journals, worldbuilding
   - **Screenplay editor** for `.fountain` files
3. **Spark** — an optional in-window writing companion. Either built-in (a thin
   LLM-driven assistant with persona controls) or a terminal pane where the user
   wires in their own CLI agent (Claude Code, aider, etc.).

The bet: writers don't want a database product; they want a folder they can back
up to a thumb drive. Everything else is chrome.

---

## 2. Non-negotiables

These shaped every screen. Don't break them without a fight.

- **Local-first.** No telemetry. No required sign-in. Files live on disk in
  formats other tools can read (`.md`, `.fountain`, `.json` for metadata).
- **Markdown is the wire format**, but never visible to the user. The prose
  editor is "WYSIWYG-ish" — you see styled output, not raw syntax.
- **Fountain is parsed by a library, not by us.** Wire through
  [nyousefi/Fountain](https://github.com/nyousefi/Fountain). Pin a version,
  patch upstream before forking.
- **Two themes only**: Parchment (light, warm) and Midnight (dark, plum).
  Accent hue (blue / purple / sepia / sage) is independent. Theme + accent live
  in user settings and propagate through CSS custom properties.
- **The chapter rail and scenes rail share a vocabulary.** Same drag grip, same
  collapsed 28px gutter, same drop indicator. They're sibling components, not
  copies.

---

## 3. Folder & file model

```
~/Aquarius/
  Lantern, Lantern/                 ← a Workflow (top-level)
    .aquarius/
      workflow.json                 ← metadata, draft list, last-opened, etc.
      sessions/                     ← per-day write logs (for the Today panel)
        2026-05-18.json
      snapshots/                    ← version history (see §5)
        Ch_03/
          2026-05-18T11-42.md
      trash/                        ← soft-deleted files (30d retention)
    Drafts/
      Ch_01.md
      Ch_02.md
      ...
    Characters/
      Old Sennet.md
    Worldbuilding/
      Helmreach.md
  The Long Echo/
    Episodes/
      Pilot — Cold Open.fountain
```

### What's in a Workflow's `workflow.json`

```json
{
  "id": "uuid",
  "title": "Lantern, Lantern",
  "kind": "novel",
  "drafts": [
    { "id": "...", "name": "Working Draft", "active": true, "chapterOrder": ["..."] }
  ],
  "manuscripts": [
    { "id": "...", "title": "Lantern, Lantern", "folder": "Drafts", "chapterOrder": [...] }
  ],
  "settings": { "theme": "parchment", "accent": "blue", "fontSize": 17 },
  "goals": { "dailyWords": 1000, "kind": "daily" }
}
```

A folder is **marked as a manuscript** when it appears in `manuscripts[]`.
That mark is what makes the chapter rail appear inside chapter files. Loose
markdown notes — even inside a manuscript-mode workflow — never get the rail.

### Per-document frontmatter (YAML, optional)

```yaml
---
title: A Door of Letters
status: drafting           # final | drafting | rev | outline
synopsis: |
  Fifty-three letters from her grandfather...
---
```

Status drives the dot colours and corkboard states. Synopsis is what shows on
the corkboard card.

---

## 4. Data shapes the UI consumes

### Chapter
```ts
{ n: number, title: string, words: number, status: 'final'|'drafting'|'rev'|'outline' }
```

### Spark message
```ts
{ role: 'user'|'spark', text: string, refs?: Ref[], actions?: Action[] }
```

### Spark reference chip
```ts
{ kind: 'pinned'|'auto'|'folder', label: string, path: string }
```

The reference chip row tells Spark what's in context. **The user can pin or
unpin chips** to control what the model sees. "Auto" chips are added by the app
(the chapter you're editing); the rest are user-pinned.

### Session log entry (Today panel)
```ts
{
  date: 'YYYY-MM-DD',
  startedAt: ISO,
  endedAt: ISO,
  deltas: [{ docPath: string, words: number, at: ISO }],
}
```

Word counts are *deltas* (gain since last save), not snapshots. Lets us show
"+412 words to Ch 03" rather than "Ch 03 has 2,410 words."

---

## 5. Features the mocks implement

| Mock section            | What it ships                                            |
|-------------------------|----------------------------------------------------------|
| Main window             | Sidebar + editor + Spark, theme/accent toggles            |
| Workflows               | First-run select, sidebar switcher, settings              |
| AI panel                | Spark idle / convo / offline + Terminal pane + errors     |
| Manuscript view         | Outline list + Corkboard (cards) — same data, two modes   |
| Chapter navigator       | Side rail inside the prose editor                         |
| WYSIWYG note            | Character/research files                                  |
| Screenplay              | Scenes rail, title page, drag-reorder                     |
| Compile / Export        | EPUB/PDF/Word/Markdown/.fdx/Fountain, gated by source kind |
| Today                   | Daily goal ring, streak, per-doc breakdown                |
| Graph                   | Vault graph (chapters ↔ characters ↔ worldbuilding)       |
| Overlays                | ⌘P palette, Settings, Agent settings popover              |
| Empty states            | Zero-data baselines for every major surface               |
| Keyboard cheat sheet    | ⌘? overlay                                                 |
| Data safety             | Conflict resolution, Recently deleted, Save states         |
| Image & PDF viewers     | In-vault JPEG + PDF viewers (read-only); inspector / outline rails |
| Planned features        | Version history, find/replace, comments, provider picker  |

---

## 6. Notes for the dev — things the mocks fudge

- **Corkboard card rotation.** The slight tilts in the mock are illustrative.
  Ship the cards **flat**. Reproducing physical rotation in real drag-and-drop
  is fussy and adds zero value.
- **Graph view node positions.** Hand-tuned in the mock for legibility.
  In production this is **force-directed** (cola.js or d3-force) with stable
  seeded positions. Don't pixel-match the mock.
- **Hardcoded session data on the Today panel.** Real data comes from
  `.aquarius/sessions/*.json`. The 14-day spark is the last 14 entries.
- **Spark "context" chip behavior.** The mock shows three chips. In production,
  the auto chip is the active document; folder chips traverse one level deep
  by default and can be configured per-workflow.
- **Compile output paths.** The mock greys out incompatible targets. The
  matrix is in `vault/compile.jsx#FORMAT_MATRIX`. Source kind is detected from
  file extension + frontmatter.
- **Image & PDF rendering.** The mock synthesises both — the "photograph" is
  three banded divs and a rectangle, the PDF page is hand-typeset HTML.
  In production, render images natively (`<img>` + zoom transform) and PDFs
  via **pdf.js** for thumbs + page canvas. The viewer **chrome** in the mock
  (toolbar, breadcrumb badge, inspector grid, outline rail, footer) is the
  contract; the pixel content inside the page is not.
- **PDF outline** comes from the PDF's own `/Outlines` dict. If absent, hide
  the right rail and widen the page viewport — don't show an empty rail.
- **Viewers are read-only by design.** No annotation, no markup, no edit
  fallback. If a writer wants to write *about* an image or PDF, they make
  a sibling `.md` note and `[[wiki-link]]` to it. Keep this discipline.

---

## 7. Tech stack (suggested)

- **Tauri** (Rust + WebView). Smaller than Electron, native file APIs, good
  for "local-first" promise.
- **React + TypeScript** in the renderer. No need for a state library —
  Zustand or Jotai is plenty.
- **CodeMirror 6** for the prose / fountain / markdown editors. Three editor
  configs sharing one host.
- **Nima Yousefi's Fountain library** for parsing `.fountain` files.
- **Pandoc** behind the Compile dialog for EPUB/PDF/Word. Bundled, not
  shelled out.
- **Local LLM via Ollama** for Spark's default (zero-config). Anthropic /
  OpenAI / custom endpoints are configurable in Settings → AI.

---

## 8. Component map

Files in `vault/`:

| File              | Owns                                                    |
|-------------------|---------------------------------------------------------|
| `theme.jsx`       | Tokens, `getTheme()`, accent hues, font stacks           |
| `icons.jsx`       | Stroke-style SVG icon set                                |
| `data.jsx`        | All sample content (manuscripts, notes, scenes, etc.)    |
| `window.jsx`      | `VaultWindow` — macOS chrome wrapper                     |
| `main-window.jsx` | `MainWindow` — assembles sidebar + editor + AI panel     |
| `sidebar.jsx`     | Vault tree + bottom rail (Today / Graph / Spark toggle)  |
| `editor.jsx`      | `ProseEditor` + chapter navigator rail                   |
| `note-editor.jsx` | WYSIWYG markdown editor                                  |
| `manuscript.jsx`  | Outline view + drafts row                                |
| `corkboard.jsx`   | Index-card view                                          |
| `scenes.jsx`      | Screenplay editor + scenes rail + title page             |
| `ai-panel.jsx`    | Spark panel — idle / convo / offline / error states      |
| `terminal.jsx`    | Terminal pane (BYO CLI agent)                            |
| `compile.jsx`     | Compile / Export overlay                                 |
| `today.jsx`       | Daily session overlay                                    |
| `workflows.jsx`   | First-run select + sidebar switcher popover              |
| `overlays.jsx`    | ⌘P palette + Settings + Agent settings + Graph view      |
| `empty-states.jsx`| Zero-data baselines                                      |
| `keyboard.jsx`    | ⌘? cheat sheet                                           |
| `safety.jsx`      | Conflict / trash / save states                           |
| `viewers.jsx`     | `ImageViewer` + `PdfViewer` — read-only research surfaces |
| `planned.jsx`     | Version history / find-replace / comments / providers    |
| `app.jsx`         | Canvas composition + Tweaks panel                        |

---

## 9. Open questions — resolved (May 19, 2026)

The five questions left for the team in earlier drafts have been worked through.
All five mocks live in the design canvas under "Open questions · resolved";
this section is the short version.

| # | Question     | Status   | Decision |
|---|--------------|----------|----------|
| 01 | Sync         | Decided  | Folder default. No sync engine of our own. |
| 02 | Pricing      | Decided  | 3 tiers — Notes free / Studio $50 one-time / Spark $5/mo local AI. |
| 03 | Mobile       | Decided  | Native iPhone + iPad. Ships v1.2. |
| 04 | Multi-window | Decided  | Pop out chapters, notes, Spark threads. ⌃⌘O. |
| 05 | Plugins      | Cut      | Terminal + open folder format covers the use case. |

### 9.1 Sync

Folder sync — point at a folder, any sync provider on the OS handles
the wire. iCloud, Dropbox, Google Drive, OneDrive, Syncthing all tested.
No CRDT engine, no servers on our side, no monthly cost.

Shipping with v1:
- Settings → Sync · folder picker + provider hints
- Conflict-on-disk dialog (see §safety mocks)
- Tested-provider list in About

Not shipping: Our own sync engine. Git mode, peer-to-peer, self-hosted,
and portable / USB are all designed in the canvas but stay in the bag
for v1.1 if writers ask.

### 9.2 Pricing

Three tiers, deliberately simple:

- **Notes** · Free forever. Markdown editor, themes, graph, search, all
  exports except EPUB / Word / FDX, and the Terminal pane.
- **Studio** · $50 one-time. Adds manuscript view (outline + corkboard),
  Fountain screenplay editor with scenes rail, chapter navigator inside
  prose, and the rest of the compile targets.
- **Spark** · $5/month add-on. Built-in local AI — model bundled, runs
  on the user's machine, no cloud, no API keys. Works on any tier.

**Terminal is free on every tier**, including Notes. It's where external
AI lives: writers BYO CLI (Claude Code, aider, Codex, etc.). Spark stays
local; the Terminal pane is the home of everything else.

Upgrade flow: when a Notes user hits a Studio-only feature (corkboard,
Fountain, EPUB export…) a contextual dialog explains the feature and
offers the $50 unlock. See the canvas "Pricing surface" section.

First-launch Spark setup: model downloader (one-time ≈12 GB → ≈4 GB
quantized; SHA-256 verified), then a persona picker. Mocked in canvas.

### 9.3 Mobile

Native iPhone + iPad apps, ships with v1.2 (Aug 2026 target).

- **iPhone** — read-first, light editing, dictation. Vault list and
  chapter editor screens designed; phone is for reading on the bus and
  fixing a typo, not banging out 2,000 words.
- **iPad** — the full Aquarius experience adapted for touch + Pencil +
  Magic Keyboard. Sidebar, chapter rail, manuscript view, Pencil margin
  annotations. With a keyboard, it's a primary writing surface.

Same vault, same files, same themes — the openness of the folder
format means we never have to ship a separate "mobile sync." Use
iCloud Drive (or whatever the writer's already using).

### 9.4 Multi-window

Chapters, notes, and Spark threads can each pop out into their own
window with ⌃⌘O. The host shows a ghost slot where the popped item
used to be, so the user never loses track. Same shortcut from the
popped window reattaches it.

Detached windows have their own titlebar and status footer; no
sidebar. Tiling beyond split view stays out of scope — if the user
wants more, that's macOS's job, not ours.

### 9.5 Plugins

**Cut from scope.** Not v1, not v2. Aquarius is opinionated software;
the extension point is the Terminal pane (BYO CLI agent) plus the
documented folder + frontmatter format. Between them, any external
tool a writer wants is already reachable without us shipping a plugin
API we'd be patching for a decade.

If demand turns out to be loud, revisit — but the design team's
strong recommendation is that the answer is durably no.

---

*Last updated: May 19, 2026. Maintained alongside the design canvas.*
