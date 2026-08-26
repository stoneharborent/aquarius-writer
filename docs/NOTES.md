# Notes — where the handoff and the code disagree

`HANDOFF.md` in this folder is the **product design contract** and is kept
byte-for-byte as delivered. It is never edited. When reality has moved on from
what it says, the discrepancy is recorded here instead.

Last reviewed: 2026-08-25 (Stage 3 of the Linux port — the AquariusOS skin).

---

## 1. Fountain parsing — the handoff names a Swift library

**HANDOFF.md §2 and §7** say Fountain files are parsed by
[nyousefi/Fountain](https://github.com/nyousefi/Fountain) ("Nima Yousefi's
Fountain library").

That is an **Objective-C / Swift** library. It was the right call for the Swift
build of Aquarius Writer, which is where that instruction came from. It cannot be
used from this codebase at all.

**What this repo actually uses:** the [`fountain-js`](https://www.npmjs.com/package/fountain-js)
npm package, pinned in `package.json` at `^1.2.4`, wrapped in `src/lib/fountain.ts`.

The *intent* of the non-negotiable is preserved and still holds: we do not write
our own Fountain parser, we wire through a library and pin it.

## 2. "Two themes only" — Stage 3 added a third

**HANDOFF.md §2** lists as a non-negotiable: "Two themes only: Parchment (light,
warm) and Midnight (dark, plum)."

Stage 3 of the Linux port added a third theme, **AquariusOS**, built from
`os-image/branding/tokens.md`. The reason is that this app is the operating
system's stock writing app, and a stock app that doesn't look like its OS on first
boot is a bad first-boot story.

The amendment is narrow:

- Parchment and Midnight both remain, and remain selectable on every platform.
  Neither theme's values changed by a single digit.
- Parchment stays the **default on macOS**, exactly as the handoff intends.
- AquariusOS becomes the **default on Linux only**.
- It reuses the existing mechanism (`:root[data-theme]` + `[data-accent]` CSS
  custom properties) — it is additive, not a rework.

Accent hues (blue / purple / sepia / sage) are unaffected **for Parchment and
Midnight**. Under AquariusOS the accent is locked — see §2b.

### 2a. Who decides the theme

In order of authority, highest first:

1. **`?theme=` in the URL** — `http://localhost:1420/?theme=aquarius`. A dev and
   screenshot override; it holds for that tab and is never written to disk.
2. **What the writer picked** in Settings, the footer, or the command palette.
   Saved in `localStorage` under `aquarius.theme`, and it wins from then on.
3. **The theme saved in the workflow** being opened (`.aquarius/workflow.json`).
4. **The platform default** — AquariusOS on Linux, Parchment everywhere else.

Rule 2 beating rule 3 is deliberate: once someone has chosen a theme, opening an
older workflow must not silently change the app out from under them. Before Stage
3 the workflow always won, and the Settings panel and the footer each kept their
own copy of the theme, which could drift apart. Both now read one store
(`src/state/themeStore.ts`).

Platform detection is the **user-agent string**, not a Rust call. The theme has to
be on `<html>` before the first paint, `invoke()` is a promise, and the same check
works in the browser preview where there is no Tauri at all. `src-tauri/` was not
touched by this stage.

### 2b. The accent is locked under AquariusOS, and the picker is hidden

tokens.md allows exactly one accent colour: `starlight #8AB4FF`. `nebula` is
explicitly "never a button colour on its own" and `ancient` gold is "rare on
purpose", so **there is no legal value for purple, sepia or sage under this
theme**. Rather than offer three choices that all break the OS look, the accent
picker is hidden while AquariusOS is selected — in Settings, in the window
footer, and in the command palette.

The lock is structural, not just UI: `--accent` is declared on
`:root[data-theme="aquarius"]` itself rather than in four `[data-accent]` rules,
so a stale `accent: "sepia"` sitting in someone's `workflow.json` cannot leak a
non-OS colour. Switching back to Parchment or Midnight restores the four hues
and the picker, with the previous choice intact.

### 2c. The writing surface is deliberately not void black

**This is the decision Royce should look at first in the screenshots.**

The theme's chrome is `void #06070C` — the sidebar, the rails, the window
background. The **editor page is `surface-1 #10121C` with `text-1` text**, and the
editor keeps its serif content font (Source Serif). Nothing about the writing
surface is starlight blue.

The reason: pure void black under a bright blue chrome is a *desktop* look, and
this app is where someone spends three hours writing a chapter. The lifted, calmer
page reads as a sheet sitting on the void, which is also what tokens.md itself
describes surface-1 as ("cards and panels sitting on the void"). The OS identity
lives in the chrome around the page.

The stage plan (Stage 3, item 4) says this call is Royce's, by screenshot review,
not the agent's. What is in the repo is the recommendation, not a final answer —
`docs/screenshots/aquarius/01-main-window.png` shows it, and
`docs/screenshots/parchment/01-main-window.png` is the control. If Royce wants the
page to stay parchment-warm inside the dark chrome instead, that is two variables
(`--surface` and `--ink-prose`); if he wants the page to be void like everything
else, that is one.

### 2d. Where the gold is

`ancient #E6DDB8` appears **once in the whole app**: the streak line in the Today
panel ("🔥 6-day streak"), via a theme-scoped rule at the end of `tokens.css`.

It is not used for `--starred`, which sounds like the obvious home for it but is
really the "drafting" status colour — it paints chapter rows, corkboard cards, the
outline, the graph and the save indicator, several of them on screen at once.
That would break tokens.md's "if you are using it twice on one screen you are
using it wrong". `--starred` takes `warning #E6C069` instead.

### 2e. Type, and why the families are prefixed

Sora (display), Inter (UI) and JetBrains Mono (mono) are bundled as woff2 in
`src/fonts/` with their OFL licence texts. They are registered as **"AQ Sora"**,
**"AQ Inter"** and **"AQ JetBrains Mono"**.

The prefix is the point: Parchment and Midnight already list `"Inter"` first in
`--font-ui`, so registering a webfont named `Inter` would silently change how
those two themes render on any machine that doesn't have Inter installed. The
prefix guarantees only AquariusOS asks for the bundled faces.

Each file is a variable font covering its whole weight range, which is why there
is one file per subset (latin, latin-ext) rather than one per weight. Sora ships
600–700 only, so two headings that asked for weight 500 are bumped to 600 under
this theme rather than left to a synthesised weight.

`--font-display` is new and defaults to `var(--font-serif)`, so the six chrome
headings that now use it render identically under Parchment and Midnight.

### 2f. Radii and motion are declared but nothing reads them

`--radius-input/button/card/panel` (7/9/12/16px) and `--ease` +
`--motion-fast/medium` (120/220ms, `cubic-bezier(.22,1,.36,1)`) are in the theme
block with the correct tokens.md values, but **no component uses them**: all 94
`border-radius` declarations and all 15 transitions in the component CSS are
hardcoded, and parameterising them was out of scope for this stage. They are
there so Stage 4's Linux window chrome has the right values to reach for. Anyone
wiring them up must give Parchment and Midnight the same variables first, or those
two themes will lose their radii.

## 3. The on-disk model — built in Stage 2, with three deviations

**HANDOFF.md §3** describes `.aquarius/` with `workflow.json`, `sessions/`,
`snapshots/` and `trash/`. Stage 2 implemented it. Where the shipped layout
differs from the sketch:

- **`snapshots/` carries an index.** The handoff shows bare files
  (`snapshots/Ch_03/2026-05-18T11-42.md`). The version list also needs a label,
  a "named vs auto" flag and a word count, which a filename can't hold, so each
  document's snapshot folder has an `index.json` beside the body files. The
  bodies are still plain markdown, readable without the app — that was the point
  of the original shape and it is preserved.
- **`sessions/` is not written yet.** Nothing writes per-day session logs, so the
  Today panel still runs on the hardcoded data the handoff itself flags in §6.
  The folder is unused rather than wrong; whoever builds the Today panel for
  real owns it.
- **`comments.json` and `searches.json` are additions.** The handoff has no
  storage for margin comments or recent searches; before Stage 2 they lived in
  `localStorage`. They are now files in `.aquarius/`.

`workflow.json` also round-trips unknown top-level keys, so a future version
adding a field can't have it erased by an older build.

## 3a. Aux state hydrates eagerly, and that has a ceiling

`listVersions` / `listComments` / `listTrash` in `src/lib/vault/aux.ts` are
**synchronous** — they are called during render. Disk reads are not. The seam is
an in-memory cache filled once per workflow by `hydrateAux()` (awaited in
`openWorkflow`), with every mutation writing through to disk immediately.

The consequence: opening a workflow reads *all* of its version bodies. There is a
48 MB ceiling in `aux_store.rs` (`HYDRATION_BUDGET_BYTES`); past it, versions
still list but their bodies come back empty, which would show as an empty diff.
Realistically that is thousands of snapshots and a long way off. Fixing it
properly means making the three list functions async and updating their callers
(`RightPane`, `VersionDiff`, `TrashSheet`) — a renderer change, deliberately not
made in Stage 2.

## 3b. `resolveAssetUrl` uses the asset protocol, not data URLs

Images, PDFs and video resolve through Tauri's asset protocol
(`convertFileSrc`), so a large file streams instead of being inlined. The scope
can't be configured statically — the vault folder is whatever the writer picked
— so it is granted at runtime (`asset_protocol_scope().allow_directory`) when a
workflow is registered or loaded.

If that grant ever fails, the same command falls back to a base64 data URL and
says so in the terminal. Verified working on macOS 2026-08-25
(`asset://localhost/…`). **Untested on Linux/WebKitGTK** — if images turn up
blank there, that is the first thing to check, and the fallback is already in
place if the scope behaves differently.

## 3c. The watcher will not reload on the app's own saves

Every path the app writes is stamped in a ledger (`fs_ops/watcher.rs`) and events
for it are dropped for 1.5 s. Without that, a save would fire the watcher, which
reloads the tree, which re-renders the editor — forever. Paths are canonicalised
before comparison because macOS reports `/private/var/...` for a folder opened as
`/var/...`.

If Stage 3+ adds any code path that writes into a vault **without** going through
`vault_write_file`, it must call `state.note_self_write(&path)` first or it will
cause exactly that loop.

## 4. Window chrome is macOS-shaped

`src-tauri/tauri.conf.json` sets `decorations: false` with `transparent: true`,
`titleBarStyle: "Overlay"` and `hiddenTitle: true`. The last two are **macOS-only**
options, and the renderer only draws macOS traffic lights.

On Linux, `decorations: false` means the window would have **no close/minimise/
maximise buttons at all**. Stage 4 draws platform-correct controls. These settings
were deliberately left untouched in Stage 1.

## 5. App icons were missing entirely, and are now the Swift app's logo

`src-tauri/icons/` arrived **empty**, while `tauri.conf.json` listed five icon
files under it. This is a hard build failure, not a cosmetic gap — Tauri's
`generate_context!` macro reads the icons at compile time, so the Rust crate
would not compile at all:

```
error: proc macro panicked
  = help: message: failed to open icon .../src-tauri/icons/32x32.png:
          No such file or directory (os error 2)
```

Stage 1 generated the full set with `npx tauri icon`, using
`Branches/Apps/AquariusWriter/swift/Logo-Master-4K.png` (the Swift app's own
4096×4096 master logo) as the source — the app's real identity, not a placeholder
shape.

Two things to know:

- The generator also emitted `icons/android/` and `icons/ios/`. This repo is the
  desktop track (macOS + Linux); those folders are unused. They were left in
  place rather than deleted, and `npx tauri icon <source>` regenerates everything
  in one command if the source logo ever changes.
- **Stage 4 owns final Linux identity** — app id `os.aquarius.writer`, the
  `.desktop` entry, and icons generated from `os-image/branding/logo.svg`. If
  Royce wants the OS-branded mark instead of the Writer mark on Linux, that
  decision belongs to Stage 4, and these icons are what it replaces.

## 6. Transparent window without `macOSPrivateApi`

Running the shell prints:

```
The window is set to be transparent but the `macos-private-api` is not enabled.
```

`tauri.conf.json` sets `transparent: true`, but `app.macOSPrivateApi` is not set,
so transparency is silently inactive on macOS. The app runs fine — this is a
warning, not an error.

It was **deliberately not changed in Stage 1**, because enabling
`macOSPrivateApi` has a real consequence: apps using it are rejected from the Mac
App Store. That is a distribution decision for Royce, and the window-chrome work
belongs to Stages 3–4 anyway.

## 7. Capabilities exist now, and are deliberately tiny

Tauri 2 gates every plugin call behind a permission set in
`src-tauri/capabilities/*.json`. Stage 2 created `capabilities/default.json`,
which grants exactly two things: `core:default` and `dialog:allow-open`.

There is **no filesystem permission of any kind** — not even a scoped one. The
vault is reached only through this app's own `#[tauri::command]`s, which are not
permission-gated (app commands never are) and do their own path checking in
`vault::paths::resolve_in_root`. That means a bug in the renderer, or anything
injected into it, cannot read or write an arbitrary file: there is no general
`fs` call available to it at all.

Two consequences for later stages:

- `tauri-plugin-fs` and `tauri-plugin-shell` are still registered in `lib.rs` but
  have **no permissions granted**, so their JS APIs will fail if called. Stage 5
  (Spark, which may want to run a local model process) has to add a narrow
  `shell` permission deliberately, rather than discovering it works by accident.
- Adding a plugin API to the renderer means adding its permission here. If a
  plugin call silently does nothing, this file is the first place to look.

## 8. What Stage 2 left for later

- **`sessions/` and the Today panel** — see §3 above. Nothing writes per-day
  word-delta logs yet.
- **Conflict detection.** `safety/ConflictDialog.tsx` exists in the UI, but
  nothing raises it: a save currently wins over an external edit made while the
  document was open (the editor's copy is written; the version trail holds the
  previous text). Doing this properly means carrying the mtime read at open time
  into `vault_write_file` and refusing the write when it moved.
- **Renaming and creating files** are not in the `VaultService` interface at all
  — nine methods, none of them create or rename. The UI has no affordance for it
  either, so this is a product gap rather than a backend one.
- **`macOSPrivateApi`** (§6) is still unset and transparency still inactive. It
  now matters to Stage 3/4, which own the window chrome.

## 9. What Stage 3 left for later

- **Nothing is verified on Linux.** The whole skin was built and screenshotted on
  macOS in Chrome. WebKitGTK is the renderer on Linux, and the two things most
  likely to differ are `backdrop-filter: blur(20px)` on the sidebar and the
  variable-font weight axis. Worth a look the first time the AppImage runs.
- **The window chrome is still macOS-shaped** (§4, §6). Stage 4 owns it. When it
  draws Linux window controls, `--radius-panel` (16px), `--line`, `--bg-soft` and
  the shadow tokens are already correct for AquariusOS; the same controls need
  Parchment/Midnight values chosen too.
- **The theme is not written back to the workflow.** Nothing in the app has ever
  saved `settings.theme` into `workflow.json` — it is read, never written. The
  writer's choice persists in `localStorage` instead. If per-workflow themes are
  ever meant to be real, that write is the missing piece.
- **Type sizes other than `--ui-size` were left alone.** tokens.md's body copy
  (15px/1.6) and mono label (11px, +0.14em) rules are not applied, because the
  component CSS sets font sizes directly and this stage was not restructuring it.
- **Reproducing the screenshots:** start `npm run dev`, then
  `npm install --no-save playwright-core && node scripts/screenshot-theme.mjs
  aquarius`. `playwright-core` is installed with `--no-save` on purpose — it is
  review tooling, not a dependency of the product — and it drives the copy of
  Chrome already on the machine instead of downloading a browser.
