# Parity — the Tauri app vs the Swift app

*Written 2026-08-29, against the code in this repo at v0.1.2.*

## Read this first

There are two Aquarius Writers. The **Swift app**
(`Branches/Apps/AquariusWriter/swift/`) is the original, macOS-only, and it has
kept being worked on. **This app** — Tauri + React — was copied out of a
sibling folder on 2026-08-25 and has been getting a Rust backend, a Linux skin,
Linux packaging and an MCP server ever since. It has not been getting the Swift
app's newer *features*, because nobody has been carrying them across.

Royce, on the Linux bench: *"the layout of the app is old… I cannot switch
workflows. There are no favorites, etc."* That is the gap this document
measures, so that the next round of work has a list instead of a feeling.

**This document is for two readers.** The prose is for Royce; the file paths in
the Notes column are for whoever implements the fixes.

---

## ⚠️ How this was sourced — and the one thing missing from it

Everything said about **this repo** was read out of the actual code and is
marked *verified*. Nothing in the port column is guessed.

**The Swift app's source could not be read in this session.** Every attempt —
`ls`, `find`, `head`, the Read tool, `git`, Spotlight — returned
`Operation not permitted` on
`Branches/Apps/AquariusWriter/`. The one file that opened was that folder's own
`CLAUDE.md`. This is a sandbox restriction on the session, not a broken folder:
`stat` works, so the directory is there and healthy.

So the Swift column below is built from four weaker sources, and every row says
which one it used:

| Tag | Source | What it proves |
|---|---|---|
| **[contract]** | `docs/HANDOFF.md` in this repo — the design contract *both* builds were written from (May 2026) | What the feature was specified to do. Says nothing about what Swift did *after* May 2026. |
| **[named]** | This repo's own code cites a specific Swift file it was mirroring (e.g. `// web mirror of WorkflowSwitcher.swift`) | The Swift feature exists and someone read it. Its current behaviour is unverified. |
| **[file]** | A Swift file of that name was confirmed on disk by `test -e` probing (metadata calls are permitted; reads are not) | The file exists. Nothing more. |
| **[unknown]** | No evidence either way | Say so; do not guess. |

**What this means in practice:** the *port* side of this audit is complete and
trustworthy. The *Swift* side is a strong skeleton with no flesh on it. Three
kinds of question cannot be answered until someone reads the Swift source:

1. **What the Swift app's layout actually looks like now** — the single thing
   Royce named first.
2. **How favorites work there** (where they live, what can be favorited).
3. **Anything the Swift app added after May 2026 that this document does not
   know exists.** Absence from this table is not evidence of absence.

**To finish the audit:** re-run it from a session whose working directory is
`Branches/Apps/AquariusWriter` (or run `claude` from inside that folder). The
targets, in order: `swift/AquariusWriter/Views/Sidebar/`,
`swift/AquariusWriter/Views/Main/MainWindow.swift`,
`swift/AquariusWriter/State/`, and `swift/project.yml` (an XcodeGen manifest —
it lists every source file in one readable place, which is the fastest way to
get the real inventory).

### What probing did confirm exists on the Swift side

Directories: `swift/AquariusWriter/{Views,State,Lib,Models,Services,Theme}`,
`Views/{Editor,Sidebar,Main,Overlays,Manuscript,Viewers,Window,Workflow,Spark,Rails,Shared,Terminal}`,
plus `swift/AquariusWriterTests`, `swift/docs`, `swift/project.yml`.

Files: `Views/Sidebar/WorkflowSwitcher.swift`, `Views/Main/MainWindow.swift`,
`Views/Overlays/{CommandPalette,SettingsSheet,CompileSheet,FindReplaceSheet,RecentlyDeletedSheet,VersionDiffSheet,ScreenplayPreviewSheet,CheatSheet}.swift`,
`Views/Editor/{EditorToolbar,EditorFooterStats,ProseEditor,NoteEditor,ScreenplayEditor,ReferencePane}.swift`,
`Views/Rails/{ChapterRail,ScenesRail}.swift`,
`Views/Viewers/{HtmlViewer,VideoViewer,PdfViewer,ImageViewer}.swift`,
`Views/Terminal/TerminalPane.swift`, `Views/Spark/SparkPane.swift`,
`State/{FormatBus,SparkStore,SparkActionRunner,VaultStore,EditorStore}.swift`,
`Lib/{Fountain,ScreenplayPageFormat,SparkAction,FrontMatter}.swift`,
`Lib/TextStyling/`.

A `Views/Workflow/` directory exists but none of the names guessed for it hit.
No file named for favourites, pinning or starring was found anywhere — but
that is a failed guess, **not** a finding: the probe can only confirm names it
thinks of, and Royce says the feature is there.

---

## Royce's three named gaps, answered

### 1. "I cannot switch workflows"

**The switcher is there.** It is the workflow's name at the top of the sidebar,
with a small caret next to it — click it and you get a menu of every connected
workflow plus **← All workflows**, which takes you back to the welcome screen.
There is a second way out in the bottom-left of the window: **← workflows**.
Both were checked in the code and both are wired up correctly
(`src/components/sidebar/Sidebar.tsx:58-96`, `src/App.tsx:104-108`).

So this is very probably **not a missing feature — it is an invisible one**,
and possibly an empty one. Two things make it look dead:

- **It does not look like a button.** It is the sidebar title in bold, with a
  10-pixel caret. Nothing about it says "press me". The Swift app is where
  Royce's expectation of what a switcher looks like comes from, and that
  expectation cannot be met until someone can see the Swift version.
- **It has nothing to offer.** The menu lists the workflows Aquarius already
  knows about. On the Linux bench that is probably just the sample — one entry,
  already ticked. A menu with one item in it reads as a broken menu.

Nothing in the CSS explains a Linux-only failure: the menu is a plain absolute
box with no `backdrop-filter` and its parent is correctly positioned. **If
Royce clicks the workflow name and genuinely nothing appears**, that *is* a new
Linux bug and it needs a bench report, because it cannot be reproduced here.

### 2. "There are no favorites"

**Correct, and there never have been.** Searching this repo for
favourite / star / pin / bookmark in any spelling returns nothing outside a
CSS colour variable called `--starred`, which is the *"drafting" chapter status
colour* and unrelated. There is no store, no persistence, no sidebar section,
no MCP tool.

It is also absent from `docs/HANDOFF.md` — the May 2026 design contract has no
favourites anywhere in its feature list or component map. So this is a **Swift
feature added after the port's design was frozen**, which is exactly the shape
of problem Royce described. It has to be built here from scratch, and it should
be built to match whatever the Swift app does — which needs the Swift read.

### 3. "The layout of the app is old"

**Honest answer: this cannot be diagnosed without the Swift source, and it is
the most important row in the table.**

What can be said is what this app's layout *is*, so the comparison is quick
once someone can see both. Top to bottom, the window is:

- a **38px title bar** — centred workflow name, and on Linux three window
  buttons at the right;
- a **three-column body** — sidebar (tree + a Today/Graph/Find/Trash rail at
  its foot), the editor, and a right pane with **Comments** and **Versions**
  tabs that can be collapsed;
- a **26px status bar** — version number, "← workflows", and icon buttons for
  palette / graph / today / settings plus theme and accent dropdowns.

That is, to the pixel, the layout `docs/HANDOFF.md` §8 specifies — with one
column removed: the Spark AI panel, deliberately cut in Stage 5. **If the Swift
app has moved on from that shape, this app has not moved with it, and nobody
here knows in which direction.** Candidate answers a Swift read would settle:
a different sidebar organisation (sections, favourites, tags?), a mode or tab
bar, a different inspector, document tabs, a library/home screen.

---

## The feature table

Ordered by user impact — what a writer notices first, at the top.

Sizes: **S** ≈ under a day · **M** ≈ two to four days · **L** ≈ a week or more.

| # | Feature | Swift side (source) | Port status | Size | Notes for the implementer |
|---|---|---|---|---|---|
| 1 | **Overall shell layout / navigation model** | Unknown — this is the whole question **[unknown]** | **different** (assumed) | **L** | Port layout is HANDOFF §8 minus the Spark column. Read `Views/Main/MainWindow.swift` + `Views/Sidebar/` before designing anything. Port files: `src/components/window/VaultWindow.tsx`, `src/components/main/MainWindow.tsx`, `src/components/sidebar/Sidebar.tsx`. |
| 2 | **Favorites / pinning** | Exists per Royce; no design record **[unknown]** | **absent** | **M** | Nothing to extend — new store, new persistence, new sidebar section, plus an MCP tool (repo doctrine: if a human can do it, an MCP client can). Persist in `.aquarius/` beside `comments.json` (`src-tauri/src/aux_store.rs`), not `localStorage`. |
| 3 | **Workflow switching** | `Views/Sidebar/WorkflowSwitcher.swift` **[named]** | **present, but unfindable** | **S** | Give it a real control surface — a bordered button, a hover state, an explicit "Switch workflow…" row. `src/components/sidebar/Sidebar.tsx:58`. Also make an empty list say so instead of showing one dead row. |
| 4 | **Create a new file inside a workflow** | Not in the contract; unverified in Swift **[unknown]** | **absent from the UI** | **M** | The backend already does it — MCP exposes `create_document` (`src-tauri/src/mcp/tools.rs`) — but `VaultService` has no `createFile` and the sidebar has no `+`. An AI client can make a file in your vault and you cannot. |
| 5 | **Rename / move a file** | Unverified **[unknown]** | **absent everywhere** | **M** | Not in `VaultService` (`src/lib/vault/service.ts`), not in MCP, no UI. Needs the Rust op, the interface method, the MCP tool and the sidebar affordance. |
| 6 | **Compile / Export** (EPUB, PDF, Word, Markdown, Fountain, FDX) | `Views/Overlays/CompileSheet.swift` **[file]**; contract §5 **[contract]** | **absent — the dialog is a mock** | **L** | `src/components/overlays/Compile.tsx` renders the format cards and the path field, and the **Compile button has no click handler at all**. There is no Pandoc, bundled or shelled. Currently the app cannot produce a manuscript. |
| 7 | **Today panel** — daily goal, streak, per-document word deltas | `Views/Overlays/` — no matching file found **[unknown]**; contract §5 **[contract]** | **partial — hardcoded** | **M** | `src/components/overlays/Today.tsx` opens with a literal `const TODAY = {…}` of made-up numbers. `.aquarius/sessions/*.json` is specified and never written. `goals` exists in the type and only the browser mock fills it. NOTES §3, §8. |
| 8 | **Conflict detection** (external edit while a document is open) | `Views/` — unverified **[unknown]**; contract §5 "Data safety" **[contract]** | **partial — dialog exists, nothing raises it** | **M** | `src/components/safety/ConflictDialog.tsx` is complete and unreachable. A save currently overwrites an external edit; the old text survives only in the version trail. Fix: carry the open-time mtime into `vault_write_file` and refuse a moved write. NOTES §8. |
| 9 | **Chapter drag-to-reorder persists** | Contract §5 (screenplay + manuscript drag) **[contract]** | **partial — UI drag is in-memory only** | **S** | `reorderChapters` in `src/state/vaultStore.ts:356` mutates the store and never writes. The MCP tool `reorder_chapters` *does* persist. Same asymmetry as row 4. NOTES §13h. |
| 10 | **Pop out a document into its own window** (⌃⌘O) | Contract §9.4 **[contract]** | **absent in the real app** | **S** | Works in the browser preview. In the desktop shell `new WebviewWindow(...)` needs `core:webview:allow-create-webview-window`, which is not granted; popout labels also fall outside `"windows": ["main"]` in `src-tauri/capabilities/default.json`. Found while fixing the window drag — NOTES §15d. |
| 11 | **Window buttons on macOS** | n/a | **absent** | **S** | The Mac window is undecorated (`is_decorated` → false) and `WindowControls` renders on Linux only, so there is no close/minimise/maximise button on macOS. ⌘Q/⌘M work. NOTES §15c. |
| 12 | **Per-workflow theme is remembered** | Contract §3 (`workflow.json.settings.theme`) **[contract]** | **partial — read, never written** | **S** | Nothing has ever written `settings.theme` back; the choice lives in `localStorage`. Every `workflow.json` on disk says `parchment`. NOTES §9. |
| 13 | **Terminal pane** (run your own CLI agent inside the app) | `Views/Terminal/TerminalPane.swift` **[file]**; contract §5 **[contract]** | **absent** | **M** | Deliberately deferred, not dropped — the port plan keeps it as the bring-your-own-agent story that pairs with the MCP server. NOTES §13j. |
| 14 | **Spark — the built-in AI panel** | `Views/Spark/SparkPane.swift`, `State/SparkStore.swift`, `State/SparkActionRunner.swift`, `Lib/SparkAction.swift` **[file]** | **absent by decision — not a gap** | — | Royce cut the embedded agent on 2026-08-25; this app exposes an MCP server instead so Claude Code or Claude Desktop drives the vault. The Swift app still has Spark. **Do not port it back without asking.** NOTES §13b. |
| 15 | **Pricing tiers / unlock dialog** | Unverified — may still exist in Swift **[unknown]** | **absent by decision — not a gap** | — | Removed 2026-08-25: the app is free. If the Swift app still gates features, that is a Swift cleanup, not a port task. NOTES §13a. |
| 16 | Prose / note / screenplay editors (CodeMirror 6) | `Views/Editor/{ProseEditor,NoteEditor,ScreenplayEditor}.swift` **[file]** | **present** | — | Three configs on one host, as specified. Fountain via `fountain-js` (the Swift build uses a Swift library — NOTES §1). |
| 17 | Editor toolbar; word / character / read-time footer | `Views/Editor/{EditorToolbar,EditorFooterStats}.swift` **[named]** | **present** | — | The port cites both by name as parity targets. |
| 18 | Chapter rail; scenes rail; screenplay title page | `Views/Rails/{ChapterRail,ScenesRail}.swift` **[file]** | **present** | — | |
| 19 | Manuscript outline + corkboard + drafts row | Contract §5 **[contract]** | **present** | — | Real data from frontmatter. Drafts are switchable; the *order* does not persist (row 9). |
| 20 | Split pane / reference mode (read-only second document) | `Views/Editor/ReferencePane.swift` **[named]** | **present** | — | `src/state/splitStore.ts` cites it. |
| 21 | Version history, snapshots, diff, restore | `Views/Overlays/VersionDiffSheet.swift` **[named]** | **present** | — | Real files under `.aquarius/`. Caveat: a write over MCP does not snapshot first. NOTES §13j. |
| 22 | Margin comments (anchored to a selection) | Contract "planned features" **[contract]** | **present** | — | An addition to the on-disk contract: `.aquarius/comments.json`. NOTES §3. |
| 23 | Recently Deleted (soft delete, 30-day retention) | `Views/Overlays/RecentlyDeletedSheet.swift` **[named]** | **present** | — | |
| 24 | Workflow-wide Find & Replace (⇧⌘F) | `Views/Overlays/FindReplaceSheet.swift` **[named]** | **present** | — | Really searches and really replaces. |
| 25 | Graph view (chapters ↔ characters ↔ worldbuilding) | Contract §5 **[contract]** | **present** | — | Force-directed over real `[[wikilinks]]`, as §6 asks. |
| 26 | Command palette (⌘P), cheat sheet (⌘?), Settings (⌘,) | `Views/Overlays/{CommandPalette,CheatSheet,SettingsSheet}.swift` **[file]** | **present** | — | |
| 27 | Image / PDF / HTML / video viewers | `Views/Viewers/*.swift` **[named]** | **present** | — | Read-only by design. Asset protocol untested on WebKitGTK — NOTES §3b. |
| 28 | Screenplay print-layout preview | `Views/Overlays/ScreenplayPreviewSheet.swift` **[named]** | **present** | — | Page maths mirrored from `Lib/ScreenplayPageFormat.swift`. |
| 29 | File watcher — external edits appear live | Contract §3 **[contract]** | **present** | — | `notify` crate, debounced, ignores the app's own writes. |
| 30 | Themes: Parchment, Midnight, **AquariusOS** | Two themes in the contract **[contract]** | **present, and ahead** | — | The OS skin is this repo's own addition. The Swift app does not have it and does not need it. |
| 31 | MCP server (15 tools, localhost, opt-in) | Not in Swift **[unknown]** | **present, and ahead** | — | This app's answer to "no embedded AI". `src-tauri/src/mcp/`. |
| 32 | Linux: window controls, AppImage, `.desktop`, CI | Not applicable to Swift | **present, and ahead** | — | The entire reason this build exists. |

**Counts.** 32 features audited. **6 absent** (rows 2, 5, 6, 10, 11, 13 — plus
rows 14 and 15, which are absent *by decision* and are not counted as gaps).
**5 partial** (rows 3, 7, 8, 9, 12). **1 different / unknown** (row 1).
**20 present**, three of which the port is ahead on.

Read that with the caveat at the top: the denominator is the features *this
document knows about*. Anything the Swift app grew after May 2026 — favourites
is the proof that such things exist — is not in the count.

---

## Proposed wave plan

### Wave 0 — unblock the audit (half a day, do this first)

Read the Swift app. Everything below is planned partly in the dark until
someone does. From a session rooted at `Branches/Apps/AquariusWriter`:
`swift/project.yml` for the file inventory, then `Views/Sidebar/`,
`Views/Main/MainWindow.swift`, `Views/Workflow/`, `State/`. Come back and
rewrite rows 1 and 2 of the table with real behaviour, and add whatever rows
are missing. **Wave 1's design depends on this; its engineering does not.**

### Wave 1 — the three things Royce named, plus what makes them usable

Everything Royce can see and point at, in the order he raised it.

1. **Favorites** (row 2, M). New feature, built to match Swift. Sidebar
   section, a toggle affordance on tree rows and editor headers, persistence in
   `.aquarius/`, an MCP tool alongside.
2. **Make the workflow switcher findable** (row 3, S). It exists; it does not
   read as a control. Give it a border, a hover, a label, and an honest empty
   state. Cheap, and it retires a complaint on its own.
3. **The layout catch-up** (row 1, L). Scope set by Wave 0. This is the
   expensive one and the one Royce mentioned first — treat the rest of Wave 1
   as things that ship while this is being designed.
4. **Create a file from the UI** (row 4, M). Not on Royce's list, but it
   belongs in Wave 1: an app where a writer cannot make a new note, and where
   an AI client *can*, will not survive a week of real use.

### Wave 2 — the features that are pretending to work

Things that look finished and are not. Each is a trust problem: the app appears
to offer something and then does nothing.

5. **Compile / Export** (row 6, L) — the biggest single hole. A writing app
   that cannot produce a manuscript is not finished.
6. **Today panel on real data** (row 7, M) — write `.aquarius/sessions/`, wire
   goals, retire the hardcoded numbers.
7. **Conflict detection** (row 8, M) — the dialog is built; make it reachable
   before someone loses a paragraph.
8. **Chapter reorder persists** (row 9, S) — small, and it currently loses work
   silently.

### Wave 3 — the Linux and shell debt

9. **Popouts in the real shell** (row 10, S) and **rename/move** (row 5, M).
10. **macOS window buttons** (row 11, S) — a decision for Royce: draw our own
    on macOS too, or turn the system decorations back on there.
11. **Per-workflow theme write-back** (row 12, S).
12. **Terminal pane** (row 13, M) — the bring-your-own-agent story, once the
    layout in row 1 is settled, since it needs somewhere to live.

### Not planned

Spark (row 14) and pricing (row 15) are closed decisions. Parity with the Swift
app does **not** mean bringing them back.

---

## One rule worth keeping

The repo's doctrine since Stage 5 is *"if a human can do it in the app, an MCP
client can do it too"* — new features ship with their MCP tool in the same
change. Rows 4 and 9 show the rule being broken in the other direction: the MCP
client can do things the human cannot. Both halves are worth holding to.
