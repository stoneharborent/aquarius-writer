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
| 7 | **Compile / Export** | **fully real**: Pandoc + xelatex; EPUB, PDF, DOCX, MD, Fountain; profiles; include options | **mock — Compile button has no click handler**, no Pandoc anywhere | **L** | On Linux pandoc is a package dependency — easier than macOS. FDX is a stub in Swift too; skip it. |
| 8 | **Manuscript management** (mark folder as manuscript, ManuscriptHome grid, status filter chips, front-matter section) | verified | outline/corkboard exist but no marking UI, no home, no filters | **M** | `manuscriptFolders`/`draftFolders` in `workflow.json` is the shared contract. |
| 9 | **Conflict dialog reachable** | verified — Keep Mine / Take Theirs / Save As Copy | dialog built, `raise()` never called | **M** | Carry open-time mtime into `vault_write_file`; refuse a moved write. |
| 10 | **Chapter reorder persists** | verified (rail Move up/down writes) | UI drag is in-memory; the MCP tool persists | **S** | `vaultStore.ts:356`. |
| 11 | **Editable split editor** | verified — two live documents, independent undo/save | split is read-only reference only | **M** | Keep the read-only reference pane too (Swift has both). |
| 12 | **Screenplay depth**: paged canvas with real page breaks, Title Page editor tab, scene drag-reorder, dual dialogue, revision marks, smart-type | verified | element buttons, scenes rail, page estimate, preview overlay | **L** | Industry page geometry is in SWIFT-AUDIT §2.1 in points. |
| 13 | **Wiki-link autocomplete** | verified | plain `[[` typing | **S** | |
| 14 | **Per-document editor zoom** ⌘+/−/0, persisted per path | verified | global body-size slider only | **S** | |
| 15 | **Welcome screen: recents list + drag-a-folder-to-open + AppMark glow** | verified | three cards only | **S** | |
| 16 | **Popouts in the real shell** (⌃⌘O) | verified (ghost-slot design) | works in browser preview; blocked by missing Tauri capability | **S** | `core:webview:allow-create-webview-window` + window scope. NOTES §15d. |
| 17 | **MCP tool catch-up** | **33 tools + a browser Web UI** — v1 of this doc wrongly assumed Swift had no MCP | 19 tools | **M** | Rename and move landed with row 6; `toggle_star` with row 4. Still missing: manuscript/draft toggles, scene tools, set_synopsis, insert/replace-lines, diff_version, take_snapshot, export. Web UI optional. |
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
| Versions: auto + named snapshots, diff, restore | **parity** (Swift adds a "Current Version" header button — nice-to-have; MCP writes still don't snapshot first, NOTES §13j) |
| Margin comments | **parity** (storage differs: port one `comments.json`, Swift per-file — cosmetic) |
| Find & Replace (⇧⌘F) | **parity** |
| Graph, palette, cheat sheet, settings | **parity** |
| Viewers (image/PDF/HTML/video) | **parity**, Swift richer (PDF outline rail, EXIF inspector, HTML "Edit Source") — low priority |
| File watcher | **parity** |
| **Today panel** | **parity in fakeness** — Swift's is *also* hardcoded sample data, labeled as such. Not "the port is behind"; both need `.aquarius/sessions/` built. Whoever builds it first sets the contract. |
| Trash | parity, one behavior difference: Swift never auto-purges (user confirms "Empty trash"); the port sweeps silently at 30 days. Swift's is the safer behavior. |
| Corkboard "Add card", rail filter buttons | disabled placeholders **in Swift too** — don't chase them |
| Sync tab | philosophy-only **in both** — matches |
| **Spark** (embedded AI) | **absent by decision** (2026-08-25). The MCP server is the replacement. **Do not port it back without asking.** |
| **Pricing / unlock dialog** | **absent by decision.** Swift still has $50 Studio tiers; that's a Swift cleanup question, not a port task. |
| AquariusOS theme, Linux packaging, self-updater | **port ahead** — the reason this build exists |

**Counts.** 16 open rows. Everything closed on 2026-08-30, in order: the
workflow-switcher item from §3, then rows 4, 5 and 6 (favourites, create,
rename/move), then row 2 (Ice / Midnight / Aqua accents), and finally rows 1
and 3 (shell layout, page canvas) — which finishes Wave 1. What is left:
1 large-and-structural (screenplay depth), 1 large (Compile), 5 medium,
8 small, 1 research. Spark and pricing stay closed. The v1 claim that the port
was "ahead" on MCP was wrong — Swift has 33 tools and a Web UI.

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

### Wave 2 — the features that are pretending to work

7. **Compile / Export** (row 7, L) — pandoc as a Linux package dependency;
   EPUB/PDF/DOCX/MD/Fountain; skip FDX (a stub in Swift too).
8. **Conflict detection** (row 9, M).
9. **Chapter reorder persists** (row 10, S).
10. **Today on real data** (M) — build `.aquarius/sessions/`; the port would
    actually *pass* Swift here, and the session format should be proposed as
    the shared contract.

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
the palette command and `toggle_star` are all `ops::set_star`. Row 10 is still
open. Row 17 shows the Swift
app holds itself to the same rule with nearly double the tool surface.
