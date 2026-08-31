# Parity — the Tauri app vs the Swift app

*Written 2026-08-29 against v0.1.2 with the Swift side unreadable; rewritten
2026-08-30 against v0.2.0 after a full read of the Swift source; updated the
same day as Waves 0 and 1 closed. The complete Swift inventory — features,
palette hex values, layout measurements, shortcut map — lives in
[`SWIFT-AUDIT.md`](SWIFT-AUDIT.md); this file is the gap list and the plan.*

## Read this first

There are two Aquarius Writers. The **Swift app**
(`Branches/Apps/AquariusWriter/swift/`) is the original, macOS-only, and it
has kept being worked on. **This app** — Tauri + React — was copied out of a
sibling folder on 2026-08-25 and has been getting a Rust backend, a Linux
skin, Linux packaging and an MCP server ever since. It has not been getting
the Swift app's newer *features or design*, because nobody was carrying them
across.

Royce, on the Linux bench: *"the layout of the app is old… I cannot switch
workflows. There are no favorites, etc."* Both sides are now verified, so
this document is a real list, not a feeling.

---

## Royce's three named gaps, answered (now with the Swift side verified)

### 1. ~~"The layout of the app is old"~~ — ✅ **done 2026-08-30**

The port was the May 2026 HANDOFF §8 layout minus the Spark column. The Swift
app had moved on. Every row below is now closed:

| | Swift app | This port |
|---|---|---|
| Top of window | 30pt title strip + a **top bar**: Files toggle, **⌘K search capsule**, centered editor toolbar, right-pane buttons | ✅ **same shape** — 38px title strip (unchanged on purpose, NOTES §15) + a 48px top bar |
| Bottom of window | **No status bar** — nothing down there | ✅ **retired**; its four kinds of content moved (NOTES §17) |
| Columns | Sidebar **248pt, resizable 190–560, width persisted** · editor min 320 · right pane **360pt, resizable, persisted** | ✅ **same numbers**, dragged on 7px splitters, persisted in localStorage |
| Collapsing | Everything collapses to a **28pt gutter with a rotated label** (sidebar, rails, right pane, even the editor) | ✅ one shared `Gutter` for sidebar, right pane, chapter rail and scenes rail. The *editor* itself still does not collapse (⌃⌘E "hide editor" is not ported). |
| Sidebar top | **Quick views: Starred · Today · Manuscript**, then a "WORKFLOW" eyebrow with A−/A+ tree zoom and an **add menu** | ✅ quick views + eyebrow + add menu (done earlier the same day). **A−/A+ tree zoom is still missing.** |
| Prose surface | **US-Letter page canvas** — fixed-width sheet, 1" margins, drop shadow | ✅ **shipped** — see row 3 |
| Theme | **Ice** (light `#EAF1F8`) + ocean **Midnight** (`#0B1220`), 4 Aqua accents | ✅ shipped (row 2) |

Two pieces of the audit's §1.3–1.4 are deliberately left for later and are the
only layout debt: the **navigator zoom** (A−/A+ scaling tree rows 0.8–1.8×) and
**collapsing the editor pane itself** (⌃⌘E). Both are additions to a shell that
now has the right bones, not rebuilds.

### 2. ~~"There are no favorites"~~ — ✅ **done 2026-08-30**

Swift: star/unstar on any tree row (context menu + star glyph), a **Starred
quick view** at the top of the sidebar, and MCP/Spark `toggle_star`.

Shipped: `.aquarius/favorites.json` (a sorted array of vault-relative paths,
written atomically beside `comments.json`), `favoritesStore` for the reactive
copy, a star on every tree row (hover-revealed, always on once starred) plus
Star/Unstar in the row's ⋯ menu and in the command palette, the **Starred**
quick view, and the `toggle_star` MCP tool with `get_workflow` reporting the
starred paths. A star follows a rename or a move and is dropped when the row
is trashed — both doors go through `ops::set_star` / `ops::trash_entry`.

### 3. ~~"I cannot switch workflows"~~ — ✅ **done 2026-08-30**

Swift puts the switcher as a **chip in the sidebar footer** opening a
popover: connected workflows, "Add workflow…", "Manage workflows…".

Shipped: the switcher is now a bordered, hover-highlighted chip pinned at the
sidebar footer (workflow name + kind + caret) whose popover lists the
connected workflows with the current one checked, then "Add workflow…"
(native folder picker), "All workflows", and "Manage workflows…" (Settings →
Workflows). It says so plainly when there is only one workflow. The sidebar
title is now just a title. The "← workflows" status-bar link stays until the
layout wave (row 1) retires the status bar.

---

## The feature table

Ordered by user impact. Sizes: **S** ≈ under a day · **M** ≈ two to four
days · **L** ≈ a week or more. Swift side is **verified from source**
throughout (SWIFT-AUDIT.md has file names).

### Absent or wrong in the port

| # | Feature | Swift app | Port | Size | Notes |
|---|---|---|---|---|---|
| ~~1~~ | ~~**Shell layout** (top bar, ⌘K capsule, resizable + collapsible panes, no status bar)~~ | verified | ✅ **done** — 48px top bar (Files toggle · 240px ⌘K capsule · centred toolbar · Comments/Versions), splitter-resized persisted columns, 28px collapse gutters, no status bar | **L** | New: `shellStore.ts`, `toolbarStore.ts`, `shell/{TopBar,Gutter,Splitter}`. The toolbar moved out of the editor panes into the top bar, so a pane now *publishes* its kind/path to `toolbarStore` instead of rendering its own row. Left for later: navigator zoom, collapsing the editor pane. |
| 2 | **Ice / Midnight themes + Aqua accents** | verified (full hex tables in SWIFT-AUDIT §1.1) | ✅ **done** — Ice + ocean Midnight + the four Aqua accents in `tokens.css`; the AquariusOS skin untouched | **M** | Shipped 2026-08-30. |
| ~~3~~ | ~~**Prose page canvas** (US-Letter sheet, 1" margins, shadow)~~ | verified | ✅ **done** — 850px sheet on `--bg`, 96px/64px margins, `black @ 22% r14 y1` (lighter on Ice), continuous canvas | **M** | Prose + notes only. The screenplay keeps its current surface: its *paged* canvas with real page breaks is row 12. |
| ~~4~~ | ~~**Favorites / Starred** + quick views (Starred · Today · Manuscript)~~ | verified | ✅ **done** — row star + ⋯ menu + palette, Starred quick view, `favorites.json`, `toggle_star` | **M** | `aux_store::{read,save,set,toggle,forget}_favorite` + migration, `ops::set_star` / `ops::trash_entry`, `vault_set_star` / `vault_list_stars`, `favoritesStore`. Quick views: Starred (collapsible), Today (⌘T overlay), Manuscript (⌘2 outline). |
| ~~5~~ | ~~**Create file / folder from the UI**~~ | verified — add menu with MD/Screenplay picker | ✅ **done** — WORKFLOW eyebrow + "+" add menu, inline name field, segmented Markdown/Screenplay picker; the new file opens in the editor | **M** | `ops::create_file` / `create_folder`, `vault_create_file` / `vault_create_folder`, MCP `create_folder` (`create_document` already existed). |
| ~~6~~ | ~~**Rename / move files in the tree**~~ | verified — plus drag-in/out of the file manager | ✅ **done** — row menu (right-click or "⋯") with Rename (inline) and Move to… (folder picker), **plus drag a row onto a folder** (2026-08-31) | **M** | `ops::rename_entry` / `move_entry`, `vault_rename` / `vault_move`, MCP `rename_document` / `move_document`. Names de-duplicate " 2"/" 3"; snapshots, comments and chapter order follow the file; bytes are never rewritten. Drag-to-move is `useTreeDrag` in `Sidebar.tsx` and goes through the *same* `moveEntry` the menu calls — folders spring open after 700ms, a drop into the current parent is a no-op, and a folder cannot be dropped into itself or a descendant (the UI refuses what `ops::move_entry` refuses). **Still open: drag in and out of the OS file manager.** Manual ordering *within* a folder is deliberately not this row's job — the tree sorts folders-then-name, and chapter order belongs to the manuscript rail (row 10). |
| ~~7~~ | ~~**Compile / Export**~~ | **fully real**: Pandoc + xelatex; EPUB, PDF, DOCX, MD, Fountain; profiles; include options | ✅ **done 2026-08-31** — five real formats, eight profiles, a pure assembler, pandoc located and run for EPUB/Word/PDF, `compile_document` on MCP | **L** | `src-tauri/src/compile/{mod,assembler,pandoc}.rs` + `compile_probe` / `compile_run` / `compile_reveal` + `src/lib/compile.ts`. **Markdown and Fountain need nothing installed**; EPUB/Word/PDF need pandoc, PDF also a TeX engine, and the cards say "needs pandoc" *before* they are clicked instead of dying on it. Nothing is overwritten (" 2" de-dup); a chapter missing from disk is skipped and reported, never fatal. **Deferred:** FDX (dropped — a stub in Swift too), industry screenplay *pagination* (the screenplay PDF is a Courier reader PDF at WGA margins, not paginated — that is row 12), a reference .docx / EPUB CSS. NOTES §19. |
| 8 | **Manuscript management** (mark folder as manuscript, ManuscriptHome grid, status filter chips, front-matter section) | verified | outline/corkboard exist but no marking UI, no home, no filters | **M** | `manuscriptFolders`/`draftFolders` in `workflow.json` is the shared contract. |
| ~~9~~ | ~~**Conflict dialog reachable**~~ | verified — Keep Mine / Take Theirs / Save As Copy | ✅ **done 2026-08-31** — optimistic concurrency on the save path: every read carries a `FileStamp`, every save carries the baseline, a moved file is **refused** and raises the dialog. All three Swift answers wired, and each one snapshots what it discards | **M** | The plan said "carry the open-time mtime"; the implementation carries a **SHA-256 of the bytes** instead — this vault lives in iCloud and the File Provider re-stamps files it never rewrote, so an mtime guard would have raised the dialog at the sync daemon rather than at a real edit (`src-tauri/src/fs_ops/stamp.rs`, NOTES §8). New: `fs_ops/stamp.rs`, `model::{FileStamp,FileRead,WriteResult}`, `ops::{read_file,write_document_checked,agent_write_document}`, `readFileStamped` on the service seam, `baseline` per open buffer, `editorStore.{reconcile,resolveConflict}`. The **watcher** raises it too — a dirty buffer is told the moment the file moves, not at its next save (the Swift trigger). MCP `write_document` got the same guard (`expected_hash`, opt-in) **and** an auto-snapshot before every overwrite, which closes the NOTES §13j gap in the same change. NOTES §20. |
| ~~10~~ | ~~**Chapter reorder persists**~~ | verified (rail Move up/down writes) | ✅ **done 2026-08-31** — the rail's drag and the outline's drag both write `workflow.json` through the *same* `ops::reorder_chapters` the MCP tool calls | **S** | New: `vault_reorder_chapters`, `VaultService.reorderChapters` (both services), `vaultStore.reorderChapters` is now async — optimistic paint, then the write, and a refused write puts the old order back and says so. Which drafts follow is the backend's rule mirrored in the store (a draft still showing the manuscript's order follows; a draft the writer has re-cut keeps its shape), so the screen and the file cannot disagree. `ops::a_reordered_manuscript_survives_the_next_open` pins the part that was actually at risk: the open-time `reconcile_chapter_order` must not re-sort what the writer just arranged. |
| 11 | **Editable split editor** | verified — two live documents, independent undo/save | split is read-only reference only | **M** | Keep the read-only reference pane too (Swift has both). |
| 12 | **Screenplay depth**: paged canvas with real page breaks, Title Page editor tab, scene drag-reorder, dual dialogue, revision marks, smart-type | verified | element buttons, scenes rail, page estimate, preview overlay | **L** | Industry page geometry is in SWIFT-AUDIT §2.1 in points. |
| 13 | **Wiki-link autocomplete** | verified | plain `[[` typing | **S** | |
| 14 | **Per-document editor zoom** ⌘+/−/0, persisted per path | verified | global body-size slider only | **S** | |
| 15 | **Welcome screen: recents list + drag-a-folder-to-open + AppMark glow** | verified | three cards only | **S** | |
| 16 | **Popouts in the real shell** (⌃⌘O) | verified (ghost-slot design) | works in browser preview; blocked by missing Tauri capability | **S** | `core:webview:allow-create-webview-window` + window scope. NOTES §15d. |
| 17 | **MCP tool catch-up** | **33 tools + a browser Web UI** — v1 of this doc wrongly assumed Swift had no MCP | 21 tools | **M** | Rename and move landed with row 6; `toggle_star` with row 4; `compile_document` with row 7 (vault-relative output only — NOTES §19i); `writing_stats` with the Today row, and that one **Swift does not have at all**. Still missing: manuscript/draft toggles, scene tools, set_synopsis, insert/replace-lines, diff_version, take_snapshot. Web UI optional. |
| 18 | **Terminal pane** | verified — multi-session tabs, agent config, drag-file-for-path | deliberately deferred | **M** | Still deferred; Swift sets the bar for when it lands. |
| 19 | **Semantic search toggle in Find** | verified (on-device embeddings) | keyword only | research | Needs a Linux embedding story first — not a copy-paste. |
| ~~20~~ | ~~macOS window buttons~~ | n/a (native) | ✅ **done** (2026-08-31) — **native traffic lights**, top-left, like the Swift original | **S** | Decision taken: re-enable decorations on macOS rather than draw our own. `src-tauri/tauri.macos.conf.json` sets `decorations: true` + `titleBarStyle: "Overlay"` + `hiddenTitle: true`; the base config keeps `decorations: false` so Linux still uses the app-drawn `WindowControls`. The title bar insets its content 78px on macOS so the lights have their space. NOTES §15c. |
| 21 | Per-workflow theme write-back | **Swift's theme is global**, not per-workflow | `settings.theme` read, never written | **S** | May be chasing a behavior Swift doesn't have — decide, then either wire it or drop the field. |
| 22 | Empty-state illustrations ("never a shrug") | verified — drawn `ZeroIllustration` set | plain text | **S** | |

### At parity (or intentionally different)

| Feature | Verdict |
|---|---|
| Prose / note / screenplay editors, three configs on one host | **parity** (CodeMirror vs NSTextView; Fountain via `fountain-js` vs Swift's in-house parser) |
| Toolbar, footer stats, ⌘1–⌘7 element keys | **parity** |
| Versions: auto + named snapshots, diff, restore | **parity** (Swift adds a "Current Version" header button — nice-to-have). **Port ahead since 2026-08-31:** an MCP write snapshots what it replaces ("Before AI write"), and a conflict resolution snapshots whichever version it discards — Swift does neither. NOTES §13j, §20. |
| Margin comments | **parity** (storage differs: port one `comments.json`, Swift per-file — cosmetic) |
| Find & Replace (⇧⌘F) | **parity** |
| Graph, palette, cheat sheet, settings | **parity** |
| Viewers (image/PDF/HTML/video) | **parity**, Swift richer (PDF outline rail, EXIF inspector, HTML "Edit Source") — low priority |
| File watcher | **parity** |
| **Today panel** | **port ahead since 2026-08-31.** It was *parity in fakeness* — Swift's Today is still a hardcoded `TODAY = {…}`, and so was this one. This side now runs on real data from `.aquarius/sessions/`, and since whoever built it first was going to set the contract, **the format below is the proposed shared one**. Swift can adopt it as-is: same folder, same filenames, same keys, and the Rust side ignores keys it does not know rather than dropping them. NOTES §21. |
| **Daily word goal** | **port ahead.** `goals.dailyWords` was read by both apps and written by neither. The ring's "/ 1,000" is now editable in place and writes `workflow.json` (`vault_set_daily_goal`), and every session file records the goal that was in force on the day it describes. |
| Trash | parity, one behavior difference: Swift never auto-purges (user confirms "Empty trash"); the port sweeps silently at 30 days. Swift's is the safer behavior. |
| Corkboard "Add card", rail filter buttons | disabled placeholders **in Swift too** — don't chase them |
| Sync tab | philosophy-only **in both** — matches |
| **Spark** (embedded AI) | **absent by decision** (2026-08-25). The MCP server is the replacement. **Do not port it back without asking.** |
| **Pricing / unlock dialog** | **absent by decision.** Swift still has $50 Studio tiers; that's a Swift cleanup question, not a port task. |
| AquariusOS theme, Linux packaging, self-updater | **port ahead** — the reason this build exists |

---

## The session format — proposed shared contract

HANDOFF §3 named `.aquarius/sessions/` in May 2026 and neither app ever built
it. This one now does, so this is the format on offer. It is deliberately
boring: a writer who loses both apps can still read their year in a text
editor.

```text
<vault>/.aquarius/sessions/2026-08-31.json     ← one file per calendar day
```

```json
{
  "date": "2026-08-31",
  "goal": 1000,
  "words": {
    "Drafts/Ch_03.md": { "start": 2410, "latest": 2822 },
    "Characters/Imogen.md": { "start": 300, "latest": 480 }
  },
  "updatedAt": 1756662000000
}
```

| Key | Meaning |
|---|---|
| `date` | The file's own name, `YYYY-MM-DD`, in the **writer's local timezone** — someone working past midnight expects those words in the day they think they are in. |
| `goal` | The daily word goal as it stood *that day*. History, not configuration: changing the goal today does not rewrite last week. |
| `words` | Vault-relative document path → `{ start, latest }`. `start` is the word count at the **first observation of that document that day** (on open, and on every save); `latest` is the most recent. |
| `updatedAt` | Epoch milliseconds of the last observation. Diagnostic only. |

Rules an implementation has to match, not just the shape:

- **The day's total is `Σ max(0, latest − start)`.** A document that lost
  words counts as zero for the day; it never eats another document's gain and
  a day is never negative.
- **Words are counted as runs of non-whitespace, over the document body** with
  its frontmatter block removed. Editing a status chip is not writing.
- **A first observation is a baseline, not a gain.** Opening a 2,410-word
  chapter must not read as having written 2,410 words — which is why the
  baseline is taken when the document opens and not only when it saves.
- **The streak** is consecutive days with any words written, ending **today or
  yesterday** — not having sat down this morning does not lose last night's
  work.
- **Unknown keys survive**, at both levels. Anything either app adds (session
  minutes, a mood, a project id) round-trips through the other untouched.
- **Never fatal.** A corrupt day file reads as an empty day and is replaced by
  the next write. A writing streak is not worth an error dialog.
- **A rename or move re-keys the day files; a trashed file does not.** History
  is history: a Tuesday does not quietly lose four hundred words because the
  chapter was cut on Friday.
- **Writes are atomic** (temp sibling + rename), and `.aquarius/` is already
  outside the file watcher, so recording a session never looks like an
  external edit.

Read side: `session_today` / `session_range(days)` in the app,
`writing_stats` on MCP. Rust: `src-tauri/src/sessions.rs`.

---

**Counts.** 12 open rows. Everything closed on 2026-08-30, in order: the
workflow-switcher item from §3, then rows 4, 5 and 6 (favourites, create,
rename/move), then row 2 (Ice / Midnight / Aqua accents), and finally rows 1
and 3 (shell layout, page canvas) — which finishes Wave 1. **Wave 2 is
finished**, all on 2026-08-31: row 7 (Compile), row 9 (conflict detection),
row 10 (chapter reorder persists) and Today-on-real-data. What is left:
1 large-and-structural (screenplay depth, row 12), 4 medium (8, 11, 17, 18),
6 small (13, 14, 15, 16, 21, 22) and 1 research (19) — all of it Wave 3.
Spark and pricing stay closed. The v1 claim that the port
was "ahead" on MCP was wrong — Swift has 33 tools and a Web UI, though the
port is now ahead on two things Swift has not built at all: real session data
and the `writing_stats` tool that reads it.

---

## Wave plan (revised)

### ~~Wave 0 — read the Swift app~~ ✅ done 2026-08-30 → `SWIFT-AUDIT.md`

### ~~Wave 1 — make it look and feel like Aquarius Writer~~ ✅ done 2026-08-30

The three things Royce named, plus the file basics.

1. ~~**Themes** (row 2, M)~~ ✅ done — Ice / ocean-Midnight + the four Aqua
   accents; the AquariusOS skin untouched.
2. ~~**Workflow switcher as a footer chip** (row from §3 above, S)~~ ✅ done.
3. ~~**Favorites + quick views** (row 4, M)~~ ✅ done — shipped with
   `toggle_star` in the same change.
4. ~~**Shell layout catch-up** (row 1, L)~~ ✅ done — top bar with the ⌘K
   capsule, splitter-resized persisted panes, 28px collapse gutters, status bar
   retired.
5. ~~**Page canvas** (row 3, M)~~ ✅ done — shipped alongside the layout, as
   planned.
6. ~~**Create / rename / move files in the UI** (rows 5–6, M+M)~~ ✅ done —
   shipped with their MCP counterparts (`create_folder`, `rename_document`,
   `move_document`) in the same change. Drag-a-row-onto-a-folder followed on
   2026-08-31; drag in and out of the OS file manager is the part of row 6
   still outstanding.

Wave 1 leftovers, small enough to fold into a later wave rather than hold it
open: sidebar navigator zoom (A−/A+), a collapse for the editor pane itself
(⌃⌘E), and drag in and out of the OS file manager.

### ~~Wave 2 — the features that are pretending to work~~ ✅ done 2026-08-31

7. ~~**Compile / Export** (row 7, L)~~ ✅ **done 2026-08-31** — pandoc as a
   Linux package dependency; EPUB/PDF/DOCX/MD/Fountain; FDX dropped (a stub in
   Swift too). Shipped with its MCP tool (`compile_document`) in the same
   change, per the rule below. NOTES §19.
8. ~~**Conflict detection** (row 9, M)~~ ✅ **done 2026-08-31** — a content
   hash, not an mtime, carried as a per-buffer baseline; the save path refuses
   a moved write and the watcher raises the dialog the moment a *dirty*
   document changes underneath. Shipped with its MCP counterpart
   (`write_document`'s opt-in `expected_hash`) in the same change, per the rule
   below, and with the auto-snapshot that closes NOTES §13j. NOTES §20.
9. ~~**Chapter reorder persists** (row 10, S)~~ ✅ **done 2026-08-31** — the
   rail's drag and the outline's drag now call the same
   `ops::reorder_chapters` the MCP tool has been calling since Stage 5, and
   the store follows the backend's own rule about which drafts come with it.
10. ~~**Today on real data** (M)~~ ✅ **done 2026-08-31** — `.aquarius/sessions/`
    is built and the port *passes* Swift here. The format is written out above
    as the proposed shared contract, and the goal became real in the same
    change (the ring's number is editable and writes `workflow.json`). Shipped
    with its MCP counterpart, `writing_stats`, per the rule below. NOTES §21.

### Wave 3 — depth and shell debt

11. **Screenplay depth** (row 12, L) and **editable split** (row 11, M).
12. **MCP tool catch-up** (row 17, M).
13. **Popouts** (row 16, S), **wiki autocomplete** (13, S), **editor zoom**
    (14, S), **welcome recents** (15, S), **empty states** (22, S),
    **macOS buttons** (20, S), **theme write-back decision** (21, S),
    **trash purge behavior** (align to Swift's confirm-first, S).
14. **Terminal pane** (row 18, M) — once the Wave 1 layout gives it a home.
15. **Semantic search** (row 19) — research the Linux embedding story first.

### Not planned

Spark and pricing are closed decisions. Parity does **not** mean bringing
them back.

---

## One rule worth keeping

The repo's doctrine since Stage 5 is *"if a human can do it in the app, an
MCP client can do it too"* — new features ship with their MCP tool in the
same change. Rows 5 and 10 showed the rule broken in the other direction:
the MCP client could do things the human could not. Row 5 is closed, and row
6 closed it in both directions at once — the sidebar's add menu, the row
menu, and `create_folder` / `rename_document` / `move_document` are the same
four functions in `vault::ops`. Row 4 held to it in one motion: the row star,
the palette command and `toggle_star` are all `ops::set_star`. Row 7 held to it
in the same motion: the Compile sheet and `compile_document` are the same
`compile::run` — with one deliberate narrowing on the MCP side, which writes
inside the vault only (NOTES §19i). That is a *smaller* capability for the
tool, not a bigger one, and it is written down rather than silent. **Row 10
closed the last inversion**: the chapter rail's drag and `reorder_chapters`
are now the same `ops::reorder_chapters`, so there is nothing left the MCP
client can do that a human cannot. The Today work ran the rule the other way
for the first time — the panel and `writing_stats` are the same
`sessions::view`, and the tool exists because the feature does, not the other
way round. Row 17 shows the Swift app holds itself to the same rule with
nearly double the tool surface.
