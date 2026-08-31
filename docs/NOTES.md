# Notes — where the handoff and the code disagree

`HANDOFF.md` in this folder is the **product design contract** and is kept
byte-for-byte as delivered. It is never edited. When reality has moved on from
what it says, the discrepancy is recorded here instead.

Last reviewed: 2026-08-29 (v0.2.0 — the AquariusOS self-updater, §16).

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
3. **On Linux, the OS skin.** The app is AquariusOS's stock writing app, so it
   boots looking like the OS unless the writer has said otherwise.
4. **The theme saved in the workflow** being opened (`.aquarius/workflow.json`).
5. **Parchment.**

Rule 2 beating rule 4 is deliberate: once someone has chosen a theme, opening an
older workflow must not silently change the app out from under them. Before Stage
3 the workflow always won, and the Settings panel and the footer each kept their
own copy of the theme, which could drift apart. Both now read one store
(`src/state/themeStore.ts`).

Rule 3 beating rule 4 matters more than it looks, and the first version of this
work got it wrong. **Every `workflow.json` ever written says
`theme: "parchment"`** — it is the Rust struct's default and nothing in the app
has ever written a different value (see §9). Without rule 3, a fresh Linux install
booted in the OS skin and then dropped straight back to Parchment the moment it
opened its first workflow. On macOS nothing changes: the platform default is
Parchment there, so per-workflow themes behave exactly as they always have.

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

### 2f. Radii and motion — declared in Stage 3, first consumed in Stage 4

`--radius-input/button/card/panel` (7/9/12/16px) and `--ease` +
`--motion-fast/medium` (120/220ms, `cubic-bezier(.22,1,.36,1)`) were declared
with the correct tokens.md values in Stage 3 and read by nothing.

**Stage 4 wired the first consumer** — the Linux window controls — and did the
thing this note asked for: the same names are now declared on bare `:root` with
the values Parchment and Midnight were already drawing by hand (5/6/8/12px,
same easing and durations), so overriding them under `[data-theme="aquarius"]`
changes that theme alone. Nothing that existed before renders differently.

Still true: the other 94 `border-radius` declarations and 15 transitions in the
component CSS are literals. Parameterising them is a separate job, and now it
has variables to parameterise *to*.

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

**An event on the vault folder itself is ignored.** FSEvents reports the watched
folder's own creation and extended-attribute touches on the stream — including
ones that happened shortly *before* the watch started — and the ledger can never
match those, because it is keyed by the file paths the app writes. They were
reloading the tree for a folder whose contents had not changed. Anything that
really changes inside the vault also produces an event for the file or subfolder
it touched, which is a path below root and still gets through, so nothing is
lost. Found by CI: this is what made
`writes_recorded_in_the_ledger_do_not_fire` flake on the macOS runner
(reproducible locally 28 times out of 30 under CPU load, 0/30 after the fix).

**Debugging the watcher.** `AQ_WATCH_DEBUG=1` prints every event the filters let
through, with its kind and paths. That is how the above was diagnosed, and it is
the first thing to reach for if the tree reloads at odd moments on Linux, where
inotify's event shapes differ from FSEvents'.

## 4. Window chrome — Linux now draws its own (Stage 4)

`src-tauri/tauri.conf.json` still sets `decorations: false` with
`transparent: true`, `titleBarStyle: "Overlay"` and `hiddenTitle: true`. The
last two are **macOS-only** options; on macOS the system floats its traffic
lights over our title bar and the renderer draws nothing.

> **Correction, v0.1.2 (2026-08-29): that last sentence was wrong**, and §15
> is the write-up. There are no traffic lights on macOS either. `decorations:
> false` makes tao build the window with `NSWindowStyleMask::Borderless`, which
> has no `Titled` bit and therefore no buttons — `titleBarStyle` only decides
> how a title bar that *exists* is painted. Verified in the running shell:
> `plugin:window|is_decorated` answers `false` on macOS. So macOS has our title
> bar and nothing else, and — until v0.1.2 — no way to drag the window either.
> Everything below about *Linux* still holds.
>
> **Superseded on macOS, 2026-08-31 (§15c).** `src-tauri/tauri.macos.conf.json`
> sets `decorations: true` there, which restores the `Titled` bit and with it
> the real traffic lights, top-left; `titleBarStyle: "Overlay"` now has a title
> bar to paint and paints it as a full-size content view. The *base* config —
> and therefore Linux — is exactly as described here and below. One thing this
> did **not** touch: `popoutStore.ts` still opens detached document windows
> with `decorations: false`, so a popout on macOS would have no buttons for the
> same reason the main window used to. That is academic while popouts are still
> permission-blocked (§15d), and is filed with them.

On Linux that same config left the window with **no close/minimise/maximise
buttons at all**. Stage 4 fixed it in the renderer:
`components/window/WindowControls.tsx`, rendered by `VaultWindow` only when
`detectPlatform() === "linux"`. macOS renders exactly what it did before —
verified: `document.querySelectorAll(".wc-btn").length === 0` there.

Four things about it are worth knowing, because three of them are things we
deliberately did **not** write:

- **Dragging** is Tauri's. The title bar carries
  `data-tauri-drag-region="deep"` (upgraded from the bare attribute, which only
  fires on a direct hit — so clicking the title text used to do nothing).
  Tauri's injected handler treats `<button>` as a click and never a drag, so the
  three controls are excluded with no work from us.
- **Double-click to maximise** is Tauri's too, from the same handler — on Linux
  it fires on mousedown, on macOS on mouseup so the gesture can be cancelled.
  **Do not add a `dblclick` listener here**: it would toggle twice and land back
  where it started.
- **Edge resizing** is tao's. `platform_impl/linux/event_loop.rs` hit-tests a
  5px border on `button-press` and calls `begin_resize_drag`, cursor included —
  but only when the window is *undecorated* **and** `resizable`. That makes
  `"resizable": true` in the config load-bearing on Linux rather than
  decorative. Untested on real hardware (§10).
- **Only the styling is ours.** Glyphs `text-2`, hover `surface-3`, close hover
  `danger` with `on-accent` glyph, 9px radius, 120ms at the tokens easing — all
  read from theme variables, so the controls follow Parchment and Midnight too
  (`--chrome-hover` was added to all three; it cannot be `--bg-soft`, which is
  what the title bar itself is painted with).

Screenshot: `docs/screenshots/aquarius/05-linux-window-controls.png`, taken
through the `?platform=linux` override described in §11.

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

- The generator also emitted `icons/android/` and `icons/ios/`, which this
  desktop-only repo has no use for. **Stage 4 deleted both**, from disk and from
  the index. `npx tauri icon <source>` regenerates everything in one command if
  the source logo ever changes — including those two folders, which should be
  deleted again.
- **The Writer's mark stays, and that was Stage 4's call to make.** The stage
  plan suggested generating icons from `os-image/branding/logo.svg` instead.
  We didn't: Aquarius Writer is an app in the Aquarius *suite*, not the
  operating system, and an app wearing the OS's own logo in the OS's own
  taskbar reads as "system settings", not "the writing app". The OS mark belongs
  to the OS. Easily reversed if Royce disagrees — one `npx tauri icon` run.
- Stage 4 added `icons/64x64.png` and the 512×512 `icons/icon.png` to
  `bundle.icon`. The Linux bundler installs each PNG into
  `/usr/share/icons/hicolor/<size>/apps/` by reading its real dimensions, so
  without those two the largest icon Linux would ever have had was 256px.

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

**Stage 4 left it alone too**, and now has a second reason to: our chrome paints
an opaque background over the whole window, so there is nothing for transparency
to reveal. Turning it on would change nothing visible and would cost the App
Store. The warning stays; it is noise. On Linux `transparent: true` is simply
inert.

**Resolved on macOS, 2026-08-31.** `src-tauri/tauri.macos.conf.json` now sets
`transparent: false` there (alongside `decorations: true` — §15c), so the
warning is gone from the Mac build and nothing had to change about
`macOSPrivateApi`: the flag stays off, the App Store stays open, and AppKit
draws the rounded corners and shadow that transparency was reaching for. The
base `tauri.conf.json` keeps `transparent: true` for Linux, where it is inert
and where the undecorated window is ours to paint.

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
- ~~**Renaming and creating *files*** are not in the `VaultService` interface at
  all — nine methods, none of them create or rename.~~ **Closed** (Wave 1, rows
  5–6 of PARITY.md). `createFile` / `createFolder` / `rename` / `move` are on
  the seam, in `vault::ops`, on four Tauri commands, and on the MCP surface as
  `create_folder` / `rename_document` / `move_document`. The sidebar has a
  WORKFLOW eyebrow with a "+" add menu (Markdown/Screenplay segmented picker)
  and a per-row menu with Rename and Move to…. A rename or move carries the
  document's snapshot folder and `comments.json` key with it, repoints
  `workflow.json`'s chapter order, and never rewrites the file's bytes.
  Wave 1 row 4 added **stars** on the same seam: `.aquarius/favorites.json`,
  `ops::set_star` / `ops::trash_entry`, `vault_set_star` / `vault_list_stars`,
  the MCP `toggle_star`, and `starred` in `get_workflow`'s answer. A star
  follows a rename or move (`aux_store::migrate_favorites`) and is dropped
  when the row is trashed.
- **`macOSPrivateApi`** (§6) is still unset and transparency still inactive. It
  now matters to Stage 3/4, which own the window chrome.

## 9. What Stage 3 left for later

- **Nothing is verified on Linux.** The whole skin was built and screenshotted on
  macOS in Chrome. Still true after Stage 4 — see §10, which now carries the
  full first-boot checklist. Stage 4 did guard the `backdrop-filter` half of
  this (§10).
- ~~**The window chrome is still macOS-shaped**~~ — done in Stage 4, see §4.
  The Parchment/Midnight values the note asked for became `--chrome-hover`.
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

## 10. The Linux unknowns — the first-boot checklist

**Nothing in this repo has ever run on Linux.** Stage 4 gave the app a Linux
identity, Linux window controls and a CI job that builds an AppImage, all from a
Mac. Everything below is reasoned from source (tao, tauri, tauri-bundler) rather
than observed, and this is the list to walk the first time the AppImage runs on
the Xbox Ally / 5090 build.

In rough order of "most likely to actually be wrong":

1. **Edge resizing.** tao hit-tests a 5px border on the GTK window's
   `button-press` event and starts a resize drag (§4). The uncertainty is
   whether WebKitGTK swallows that press before the toplevel sees it — the
   webview fills the whole window. **Check:** drag the window's bottom-right
   corner. If it does not resize, the fix is renderer-side handles calling
   `getCurrentWindow().startResizeDragging(direction)` — the API is already in
   `@tauri-apps/api/window`, it is 8 thin strips of CSS and one handler, and it
   was left out only because tao appears to make it unnecessary.

2. **`backdrop-filter` on the sidebar.** WebKitGTK has shipped it behind a flag
   in some builds. Stage 4 inverted the CSS so the *opaque* colour
   (`--sidebar-solid`) is the default and the translucent-plus-blur version sits
   inside an `@supports` guard (`components/sidebar/Sidebar.css`). **Check:** the
   sidebar should be either frosted or flat void — never washed-out and
   see-through with the editor page bleeding through. Both outcomes are correct;
   only the third is a bug.

3. **The asset protocol.** Images, PDFs and video resolve via `convertFileSrc`
   (§3b). On macOS that produces `asset://localhost/…`; on Linux it is
   `http://asset.localhost/…`, which is a different code path in wry. The
   fallback is real and reachable — `vault_asset_ref` in `commands.rs` calls
   `state.grant_asset_access()`, and on `Err` it returns `AssetRef::Data` with a
   base64 data URL while printing "asset protocol refused … falling back to data
   URLs"; the renderer's `resolveAssetUrl` branches on `ref.mode === "file"` and
   uses `ref.url` otherwise. Re-read after Stage 4: that fallback is a genuine
   two-way branch, not dead code. **Check:** open an image in a vault. If it is
   blank, look for that line in the terminal — its presence means the fallback
   fired and something else is wrong; its absence means the scope was granted and
   wry is the problem.

4. **`StartupWMClass`.** The desktop entry claims the window's WM_CLASS is the
   binary name (`aquarius-writer`), which is what GTK derives it from. **Check:**
   with the app running, the taskbar entry should show the app's name and icon,
   not a generic window. If it shows a generic one, run `xprop WM_CLASS`, click
   the window, and put whatever it prints into the template.

5. **Variable-font weight axes.** Sora / Inter / JetBrains Mono are single
   variable-font files per subset (§2e). **Check:** headings should look heavier
   than body text. If everything is one weight, the axis is not being applied.

6. **The Fedora side of AppImage.** The AppImage is built on Ubuntu 22.04 for
   glibc headroom; AquariusOS is Fedora/Bazzite-based and much newer, so this
   should be fine. The classic AppImage failure on Fedora is a missing FUSE —
   if it refuses to start, `./Aquarius*.AppImage --appimage-extract-and-run`
   proves whether that is it.

7. **Nothing has ever handled a file argument.** The desktop entry declares
   `MimeType=text/markdown;` and `Exec=… %U`, which is what makes the MimeType
   line legal, but `main.rs` does not read `argv`. Opening a .md via "Open With"
   launches the app on its last workflow instead of that file. Wire it up when
   the file-opening story is designed (it interacts with workflows: a lone file
   has no vault).

8. **The native folder chooser.** *Added after the first boot, and now the top
   of this list in practice — it is the one thing v0.1.1 could not verify from a
   Mac.* `tauri-plugin-dialog` 2.7 uses `rfd` 0.16, and `Cargo.lock` shows
   `gtk-sys` with **no `ashpd`** — so on Linux this is rfd's **GTK3** file
   chooser, not the XDG desktop portal. Inside an extracted AppImage with a
   bundled GTK (the launcher log already shows host GTK modules failing to load
   into it) that path has more ways to go wrong than the portal would.
   **Check:** press "Open existing". Three outcomes, and the log now tells them
   apart, because `pick_folder` in `commands.rs` prints `[dialog] opening the
   folder picker` before and one of two lines after:
   - a chooser appears → the interesting case is over, it works;
   - the "opening" line appears and nothing else, ever → the dialog never got on
     screen, or it is behind the window (try alt-tab / the window list first);
   - no `[dialog]` line at all → the command was never reached, which is a
     renderer bug and should now come with a toast and a `[webview:error]` line.
   **If it is broken:** the welcome screen's "Open a folder by typing its path
   instead" is a real, complete way in — it goes through the same `register()`.
   The proper fix is to get rfd onto the portal: adding `rfd` as a direct
   dependency with `features = ["xdg-portal"]` unifies the feature onto
   `tauri-plugin-dialog`'s copy, and rfd prefers the portal over GTK3 when both
   are enabled. That was deliberately **not** done blind from a Mac — it is a
   dependency change nobody here can test, and the typed-path fallback makes the
   app usable in the meantime.

## 11. Dev overrides: `?theme=` and now `?platform=`

`?platform=linux` on the dev server forces `detectPlatform()`
(`src/lib/platform.ts`), exactly as `?theme=` forces the theme (§2a). It is how
the Linux window controls get reviewed from a Mac, and it is how
`docs/screenshots/aquarius/05-linux-window-controls.png` was taken. Like
`?theme=`, it holds for that tab only and is never written anywhere.

It composes: `http://localhost:1420/?platform=linux` boots in the AquariusOS
skin *because* it is pretending to be Linux, which is the real first-boot path,
not a separate one.

Note it is a different question from "am I inside Tauri" — `isTauriShell()` in
the same file answers that, and stays false in the preview. That is the point:
the controls draw and do nothing, which is what makes the screenshot possible.

## 12. Packaging decisions Stage 4 made

- **`bundle.targets` is now an explicit list** — `["app", "deb", "appimage"]` —
  rather than `"all"`. Tauri filters the list down to whatever the host platform
  can build, so a Mac run quietly produces the `.app` and ignores the two Linux
  entries. That is not folklore: it was confirmed by running `npm run tauri:build`
  on the Mac with this exact list.
- **`dmg` is deliberately out of that list.** `bundle_dmg.sh` fails when the
  project lives in iCloud Drive, which broke `npm run tauri:build` on the dev
  machine for an artifact nobody can use yet (an unsigned dmg is no better than
  an unsigned .app). Add the word back when signing is wired up.
- **`rpm` is out too**, even though AquariusOS is Fedora-based. The OS ships apps
  as Flatpaks or AppImages, not as rpms layered into the image; a Flatpak is its
  own later task per the port plan.
- **The `.desktop` file is a Handlebars template**, at
  `src-tauri/linux/aquarius-writer.desktop`, wired at
  `bundle.linux.deb.desktopTemplate`. That key reads Debian-only and isn't: the
  AppImage bundler generates a deb data tree first and wraps it, so the AppImage
  gets the same entry. Tauri exposes only `{{name}}`, `{{exec}}`, `{{icon}}` and
  an optional `{{comment}}`; everything else — GenericName, Categories, MimeType,
  StartupWMClass — is written literally, which is why that file has comments in
  it.
- **CI runs on `ubuntu-22.04` on purpose.** An AppImage only runs where glibc is
  at least as new as the one it was built against, so the oldest supported runner
  buys the most compatibility. If GitHub retires that label, `ubuntu-24.04` needs
  no package changes (it also ships `webkit2gtk-4.1`); only the glibc floor
  rises.
- **`scripts/nosync-link.sh` now exits early on CI or non-macOS.** It is iCloud
  housekeeping for one machine, and on a runner it would only turn
  `node_modules` and `src-tauri/target` into symlinks that confuse the build
  cache. This is what lets CI run plain `npm ci` with install scripts enabled,
  which esbuild needs.
- **No signing, notarisation, updater or Releases.** All four need Royce's Apple
  account or a signing key. The TODO block at the end of
  `.github/workflows/build.yml` says what each would take.
  **Two of the four have since happened.** Releases were added on 2026-08-28
  (the `release` job in that same workflow), and v0.2.0 added an updater — but
  *not* the Tauri updater this bullet meant, and not one that needs a signing
  key. See §16. Signing and notarisation are still outstanding.

## 13. Stage 5's two removals, and what replaced them

Royce made two calls on 2026-08-25 and this stage implemented both. They are
recorded here rather than in `HANDOFF.md`, which is never edited.

### 13a. No pricing. The app is free.

**HANDOFF.md §9.2** describes three tiers: Notes (free), Studio ($50 once), and
Spark ($5/month). All of it is gone. Every feature is simply available.

Removed: `src/components/pricing/` (`UnlockDialog.tsx`, `SparkSetup.tsx`,
`Pricing.css`), `src/state/licenseStore.ts`, the Settings **Pricing** tab, the
tier badge in the window footer, the `✦` lock marks on Outline and Cards, the
gate in front of the screenplay editor, the `tier` field and Studio badges on
the compile formats, and the `.lic-badge` / `.pr-*` / `.ul-*` / `.mw-lock` CSS
that dressed them. Six files deleted, eight edited.

Three consequences worth stating plainly, because they are behaviour changes
rather than cosmetic ones:

- **The chapter rail is always in the prose editor.** It used to appear only on
  Studio.
- **`.fountain` files open in the screenplay editor** rather than in an unlock
  pitch.
- **EPUB, Word and FDX are selectable in Compile.** They are still not
  *implemented* — Compile has never actually exported anything — but they are no
  longer marked as something to buy. The remaining greyed-out cards in that
  dialog are source-kind mismatches ("Not available for manuscript"), which is a
  different thing and is correct.

**Old persisted state.** A tier saved in `localStorage` under `aquarius.license`
is not migrated and not deleted: nothing reads that key any more, so a stale
value simply sits there inertly. Deliberate — a cleanup pass would be one more
code path to own forever, for a key nobody will look at again.

**What "spark" still means in this tree.** `SparkleIcon` in `src/icons/glyphs.tsx`
is a four-point star used by the Today and Compile palette entries, and
`spark14` / `.td-spark` in the Today panel is a *sparkline*. Neither has anything
to do with Spark the agent, and a grep for the word will find them.

### 13b. No embedded AI. The app is driven over MCP instead.

The original Stage 5 plan was a bundled Ollama, a provider router and the Spark
panel. It is dead. The app will not talk to a model itself; it exposes an **MCP
server** so Claude Code, Claude Desktop or whatever comes next can drive it.

Removed: the (already-empty) `src/components/ai-panel/`, `SparkSetup.tsx` with
its model download and persona picker, the dead `.mw-ai-*` panel CSS, the
`--spark-bubble` / `--spark-bubble-ink` chat-bubble tokens in all three themes,
the now-unreferenced `--panel` token, and the cheat sheet's whole **AI** section
plus its "Toggle Spark panel" row — five shortcuts that opened nothing.

**The Terminal pane does not exist in this tree.** The port plan says it stays,
and `RightPane.tsx` carried a comment implying it had been considered and cut
before this repo existed. There is no xterm.js host, no dependency, no
component — nothing to keep and, per the stage brief, nothing to build here.
Whoever builds it later gets the BYO-agent story the plan describes, and it
pairs with the MCP server rather than competing with it.

### 13c. Why rmcp rather than a hand-rolled JSON-RPC server

The stage brief allowed either. We took the SDK.

`rmcp` 3.1.4's `transport-streamable-http-server` feature gives a
`StreamableHttpService` that implements `tower::Service`, so hosting it is a
fifteen-line axum router over a plain `TcpListener` — the awkwardness the brief
worried about did not materialise. What we would have owned by hand instead:
session lifecycle, protocol-version negotiation across five known versions,
`Host`-header validation against DNS rebinding, SSE framing, and re-owning all
of it every time the spec moves. That is a lot of surface for a local tool.

The cost is smaller than expected and worth stating accurately, because the
first draft of this note got it wrong. Building `rmcp` + `axum` in an empty
crate pulls 91 packages, which is the number that gets quoted — but Tauri
already brings hyper, tower, http, bytes, tokio, schemars and serde, so the
real delta in `Cargo.lock` is **16 crates** (472 → 495 packages): `axum`,
`axum-core`, `matchit`, `rmcp`, `rmcp-macros`, `sse-stream`, `async-trait`,
`futures`, `httpdate`, `pastey`, `rand`, `rand_core`, `chacha20`,
`tokio-macros`, `tokio-stream`, `tracing-attributes`.

The one real cost is the MSRV: rmcp declares 1.88, so `rust-version` in
`Cargo.toml` went from 1.77 to **1.88**. CI uses
`dtolnay/rust-toolchain@stable`, so nothing there needed changing.

**We left rmcp's transport defaults alone**, including SSE framing and session
mode. The SDK also offers `json_response`, which would answer a tool call with
plain `application/json` — every tool here is request-in/response-out, so
nothing would be lost, and it is friendlier to a hand-written client. It was
tried and reverted: it only applies with `legacy_session_mode` off, and trading
the SDK's best-tested path for a tidier reply is not a bet to make against
clients we cannot test here. The MCP spec requires clients to accept both
framings. If a client ever turns out to need JSON, the change is two lines in
`mcp::start`.

### 13d. The port, and the security posture

**1729.** Clear of 1420 (this app's own Vite dev server), 5173 and 4173 (Vite's
other defaults), 4747 (Miracle OS's HUD on Royce's Mac), and the usual
3000/8000/8080. Configurable in Settings; ports below 1024 and 1420 itself are
refused.

The listener binds `127.0.0.1` explicitly — verified during Stage 5 with `lsof`
(`TCP 127.0.0.1:1729 (LISTEN)`, IPv4 loopback only) and by confirming that the
machine's own LAN address refuses the connection.

**There is no authentication, and that is only safe because of the bind.**
Anything that can reach the socket is a process on this machine running as this
user, which can already read the vault directly, so a token would protect
nothing. **If this is ever bound to any other interface — a `0.0.0.0` default, a
container port mapping, a tunnel — it needs a bearer token first.** That is not
a nice-to-have; without the loopback bind, the current server hands the whole
vault to anyone who can route to the port.

### 13e. Why MCP writes emit `vault://changed` themselves

§3c says any code that writes into a vault outside `vault_write_file` must call
`state.note_self_write()` first. The MCP tools do. But that has a consequence
the UI's own saves do not have: the watcher then *deliberately ignores* the
write, so the open window would never learn that a client had changed a file.

So the tools emit `commands::CHANGE_EVENT` explicitly, once per call, right
after the write. This is better than the alternative of leaving the write
unstamped and letting the watcher notice: exactly one event, no 300 ms debounce
race, and no possibility of the reload loop the ledger exists to prevent.

Verified during Stage 5: seven MCP writes against a scratch vault produced
**zero** `[watch]` lines with `AQ_WATCH_DEBUG=1`, while a control edit made by a
different program produced exactly one. The watcher is alive; the suppression is
specific.

### 13f. A ledger bug the MCP server exposed

`SelfWrites` canonicalises paths so the stamp and the event agree on one
spelling (§3c). It did that by asking the filesystem to resolve the path — but
the ledger is stamped *before* the write, and a brand-new file has no inode yet,
nor does the folder the write is about to create. So a create stamped `/var/…`
and the event came back `/private/var/…`, never matched, and a file the app made
itself looked like an external edit.

Nothing hit this before because nothing in the app could create a file — the
renderer's `VaultService` has no create method (§8). `create_document` does.
`canonical()` now walks up to the nearest ancestor that exists, canonicalises
that, and re-attaches the tail. The mirror-image case is fixed with it: a delete
is checked *after* the file is gone and used to fall back to the literal path
too. Regression test:
`fs_ops::watcher::tests::a_path_stamped_before_it_exists_still_matches_its_event`.

### 13g. Search is a mirror, not a gap

The stage brief said to skip `search` if it lived only in the renderer and note
the gap. It does live only in the renderer — `searchWorkflow` in
`src/lib/vault/aux.ts` — and we implemented it in Rust anyway
(`src-tauri/src/vault/search.rs`). Flagging that as a deliberate deviation.

The reasoning: search is the single most useful thing an AI client can do before
it edits anything, the renderer's version is thirty lines of fully-specified
behaviour (case-insensitive substring, markdown/fountain/txt only, ranked by
count), and the alternative — a client reading every file through
`read_document` to grep it itself — is worse for everyone. This repo already has
the precedent: `vault::frontmatter` is explicitly a mirror of
`src/lib/frontmatter.ts`.

**The parity obligation is real.** If either side's search behaviour changes,
change the other in the same commit. The same now applies to
`frontmatter::upsert`, which is new in this stage and mirrors the TypeScript
`stringify`.

### 13h. `reorder_chapters` is the first thing that ever persists chapter order

`vaultStore.reorderChapters` in the renderer updates React state and stops
there — dragging a chapter in the UI has never written `workflow.json`. The MCP
tool does, through `vault::ops::reorder_chapters`.

So the two are not yet symmetrical, and this is the one place the doctrine in
§13i is not fully honoured in the direction you would expect: the *client* can
do something durably that the *human* cannot. Wiring the UI's drag to the same
`ops` function is a small job and is the obvious next one.

### 13i. The doctrine, written down

The old Spark-drivability rule (AquariusWriter's CLAUDE.md rule 11) is
reinterpreted for this app:

> **If a human can do it in the app, an MCP client can do it too. New
> user-facing features ship with their MCP tool in the same change.**

Concretely: a feature that touches a vault belongs in `src-tauri/src/vault/ops.rs`,
where both doors reach it — `commands.rs` for the renderer, `mcp/tools.rs` for a
client. A tool that needs behaviour `ops` does not have is a sign the feature was
built in the wrong place, not a reason to reimplement it in `mcp/`.

The one deliberate exception is **permanent deletion**. `trash::purge` stays a
UI-only operation. Everything a client can destroy, it can also restore.

### 13j. What Stage 5 left for later

- **The Terminal pane** (§13b) — not built, by instruction.
- **The UI's chapter drag does not persist** (§13h).
- **Snapshots are read-only over MCP, and a client's write does not take one.**
  The version trail is written by the editor's autosave; a `write_document` call
  replaces a file without recording what was there first. A client can read the
  old text and say so, but "undo the AI's edit" is not one click. Taking a
  snapshot inside `ops::write_document` would fix it and would also start
  recording versions for the UI's own path in a way it does not expect — worth
  designing rather than bolting on.
- **`claude mcp add` was not actually run.** The `initialize` result was checked
  against the spec shape by hand (`protocolVersion`, `capabilities.tools`,
  `serverInfo`, `instructions`) and all fifteen tools were driven end-to-end
  with raw JSON-RPC, but registering the server in Royce's real Claude Code
  config is his change to make, not an agent's.
- **The live MCP Settings panel is not in the screenshots.** The switch and the
  `claude mcp add` line only render inside the desktop shell, and the shell's
  window cannot be driven headlessly from a Mac. `docs/screenshots/*/07-settings-mcp.png`
  shows the tab and the preview's explanatory message; the raw MCP exchange is
  the evidence for what sits behind the switch.
- **Nothing about the server has run on Linux**, like everything else in §10.
  The bind is `Ipv4Addr::LOCALHOST` and the transport is portable, so there is
  nothing platform-specific to go wrong — but that sentence has been written
  about four stages now.

## 14. v0.1.1 — the first Linux boot, and what it actually found

The AppImage ran on AquariusOS (KDE Plasma 6.7, Wayland → XWayland, RTX 4090) on
2026-08-28. It launched, drew its window, and could not open, create or try
anything. The launcher's stderr was clean: an `appmenu-gtk-module` load failure
and an `atk-bridge` warning, both cosmetic, and **nothing at all** at the moment
a button was pressed.

The clean log was the most useful part of the report, because it ruled out a
crash and pointed at the renderer. It was right to.

### 14a. All three were app bugs, and none of them were Linux's fault

Reproduced on macOS in the same session. Every one of them would have failed
identically on the Mac — nobody had ever seen it because `AQ_DEV_VAULT` and a
populated registry meant the welcome screen never came up in development.

| Card | What it did in v0.1.0 |
|------|-----------------------|
| Open existing | **No `onClick` at all.** The card took an `onClick` prop and was rendered without one. `vault_add_workflow_from_folder` — picker, registration, asset scope — has worked since Stage 2 and nothing has ever called it. |
| Create new | **No `onClick`, and nothing to call.** There was no create path anywhere: not in `VaultService`, not in `commands.rs`, not in `ops.rs`. |
| Try the sample | `openWorkflow("lantern")`. `lantern` is the id of the **browser mock's** fixture (`src/lib/vault/browser-service.ts`); the real backend answers `unknown workflow: lantern`, `vaultStore` caught it into `error`, and **nothing rendered `error`.** A grep for it found one hit in the whole UI, and that was the MCP panel's own field. |

`git log --follow` on `SelectWorkflow.tsx` shows one commit — the original
import. These were never wired, never regressed.

The same `"lantern"` mistake was in `PopoutWindow.tsx`, where a popped-out
document in the real shell would have stayed empty forever. It calls
`bootstrap()` now, like the main window.

### 14b. Creating a workflow is not creating a file

`vault::scaffold` makes a **folder**: subfolders by kind, one starter document,
and `.aquarius/workflow.json`. §8's gap — no create or rename for files *inside*
a workflow — is untouched and still open.

Two details worth knowing:

- **The kind is written, not inferred.** `workflow::infer` can only answer
  novel / screenplay / notes from the shape of a folder, so a brand-new
  worldbuilding workflow would come back as "notes". The scaffold infers (to
  pick up the manuscript folder and chapter order) and then overwrites `title`
  and `kind` with what the writer chose.
- **The name is validated before the dialog opens**, and strictly: it is joined
  onto a folder the writer picked, so a `/` or a `..` in it would put the
  workflow somewhere they did not choose. A bad name is a message under the text
  field, not a discovery made after choosing a location.

The sample is idempotent — pressing it twice reopens the same folder, and files
are only ever added, never replaced, so work done inside the sample survives.

### 14c. The silence was the real bug

Three buttons doing nothing is a morning's work. Three buttons doing nothing
*with a clean log* is a bug report that cannot be acted on remotely, which is
what this actually cost. So v0.1.1 fixes the silence as its own feature:

- **`noticeStore` + `components/notices/`** — the app's one failure surface.
  Anything that fails in response to a click shows the backend's own words.
  `notices.fail()` also prints to stderr, so the toast expiring does not lose it.
- **`lib/logging.ts`** — `window.onerror` and `unhandledrejection` are forwarded
  to `app_log`, a plain `#[tauri::command]` that `eprintln!`s. **Release builds
  included**, deliberately: a log that only exists in development is a log that
  is never there when it is needed. `AQ_WRITER_DEBUG=1` additionally mirrors
  `console.error` / `console.warn`.
- **`[dialog]` and `[vault]` lines** around every picker and every registration,
  so the next report of "the button did nothing" arrives with evidence (§10.8).
- **`pending` state on the welcome screen** — a card that is waiting says so.
  The failure mode being guarded against here is a native dialog that opened
  behind the window, which is indistinguishable from a dead button unless the
  app admits it is waiting.

One deliberate quiet spot: `bootstrap` opens candidates in turn and expects some
to fail (a vault on an unplugged drive). Those go to the log, not to a toast.
Only a workflow the writer just asked for interrupts them.

### 14d. `vault_add_workflow_by_path` is no longer debug-only

It was guarded on `debug_assertions` because "in release the picker is the only
way a folder should get registered". The first Linux boot showed the flaw: an
app whose only door is a native dialog is a brick on any desktop where that
dialog misbehaves. The welcome screen now offers a typed path as a fallback, and
that command is what it calls.

The trade-off, stated plainly: a compromised renderer can now register a folder
without a dialog, and registering a folder is what grants read/write to it. The
renderer already has no general `fs` permission (§7) and every registration is
logged. The alternative was worse.

### 14e. What v0.1.1 verified, and where

On macOS, in the real Tauri shell: `AQ_DEV_SMOKE=welcome npm run tauri:dev` runs
`src/lib/dev/welcome-smoke.ts`, which drives the sample, all four create kinds,
the name guards and the typed-path door against real folders on disk, and prints
`ok` / `FAIL` per check. Both themes' rendering of the new panel and the toast
were checked in the browser preview.

What it cannot reach is the native folder chooser itself — that needs a human
and a display server. §10.8 is the bench instruction for it.

## 15. v0.1.2 — the window could not be moved, and why

Royce, on the AquariusOS bench (KDE, XWayland, NVIDIA): *"the app window itself
cannot be moved."* It was not a Wayland problem, a WebKitGTK problem or a
markup problem. It was §7 coming true: **a plugin call was silently doing
nothing, and `capabilities/default.json` was the first place to look.**

### 15a. The mechanism

Dragging an undecorated Tauri window is a round trip. Tauri injects a
`mousedown` listener (`tauri/src/window/scripts/drag.js`), decides from the
event's composed path whether the click landed in a drag region, and if it did
calls `plugin:window|start_dragging` — a **plugin command**, and therefore
subject to the Tauri 2 permission system like any other.

`capabilities/default.json` granted `core:default`. That set is generous with
*getters* and stingy with anything that changes the window. Tauri's own
`build.rs` carries the table, one boolean per command — `true` means "in the
default set":

```
("is_maximized",             true )
("internal_toggle_maximize", true )   ← double-click to maximise
("start_dragging",           false)   ← dragging the title bar
("minimize",                 false)   ← our minimise button
("toggle_maximize",          false)   ← our maximise button
("close",                    false)   ← our close button
```

So the title-bar markup was right all along, and the diagnosis has a signature
that matches the report exactly: **double-click to maximise worked, dragging did
not** — because the double-click path uses `internal_toggle_maximize`, which is
in the default set, and the drag path uses `start_dragging`, which is not.

The same line also explains three buttons nobody had reported yet: the Linux
minimise / maximise / close controls added in Stage 4 were calling
`plugin:window|minimize`, `|toggle_maximize` and `|close`, and all three were
being refused. They looked like buttons and did nothing.

The refusal is not silent to a *log* — the IPC layer answers with, verbatim:

```
window.set_title not allowed. Permissions associated with this command:
core:window:allow-set-title
```

— but nothing in the renderer was listening for it, because `drag.js` fires the
invoke and never inspects the promise.

### 15b. The fix

Four permissions, added to `capabilities/default.json`:

```
core:window:allow-start-dragging     the drag region
core:window:allow-minimize           the minimise button
core:window:allow-toggle-maximize    the maximise button
core:window:allow-close              the close button
```

That is the whole change. No renderer code moved: the `data-tauri-drag-region
="deep"` on `.vw-titlebar` was already correct, `<button>` children were already
excluded by Tauri's own handler, and edge resizing was never involved (it is
tao's Rust-side hit test — §4).

Deliberately **not** granted: `start_resize_dragging` (tao does resizing itself),
`set_title`, `maximize`/`unmaximize` and everything else the app never calls.
The capability stays as narrow as §7 promised.

### 15c. macOS was broken the same way, and has a bigger gap

The probe that proved this ran on macOS, not Linux, because the bug was never
Linux-specific: `is_decorated` answers `false` on macOS too (§4's correction).
macOS drags through the same `start_dragging` call and was refused by the same
permission, so v0.1.2 fixes dragging on both.

What v0.1.2 does **not** fix, and is worth Royce knowing: with no `Titled` style
mask there are no traffic lights on macOS, and `WindowControls` renders on Linux
only — so the macOS build has no close, minimise or maximise button at all. ⌘Q
and ⌘M still work, so it is awkward rather than fatal. The two honest options
are to render `WindowControls` on macOS as well, or to turn decorations back on
there; both change how the Mac app looks and neither belongs in a hotfix.

**Closed 2026-08-31 — the second option, native traffic lights.** Royce, on the
Mac bench: *"the minimise, close and expand buttons in the top right of the app
are gone."* They were never there. The fix is decorations, not our own buttons:
a Mac app's window controls are traffic lights, top-**left**, and the Swift
original has them because AppKit gives them away for nothing. Drawing three
Breeze-ish glyphs on the right would have been a Linux app wearing a Mac's
clothes.

The change is one new file and one CSS block:

```
src-tauri/tauri.macos.conf.json     decorations: true, titleBarStyle "Overlay",
                                    hiddenTitle: true, transparent: false
src/components/window/VaultWindow.css   [data-platform="macos"] insets the bar
```

Three things about that file are easy to get wrong:

1. **The platform config replaces arrays, it does not merge into them.** Tauri
   merges `tauri.<platform>.conf.json` over `tauri.conf.json` with **JSON Merge
   Patch (RFC 7396)** — `tauri-utils/src/config/parse.rs` calls
   `json_patch::merge`, and RFC 7396 replaces a whole array rather than
   descending into it. `app.windows` is an array. So the macOS file has to
   repeat the *entire* window object — title, size, min size, resizable — and
   not just the two keys that differ. **If you change a window property in
   `tauri.conf.json`, change it in `tauri.macos.conf.json` too**, or macOS
   silently keeps the old value. There is no way to leave a comment saying so in
   the file itself; this paragraph is the comment.

   And a trap found on the bench the same day the file was born: **the config
   is embedded into the binary at compile time** (`tauri::generate_context!`),
   and a `tauri.<platform>.conf.json` that did not exist at the last build is
   not in the build script's rerun-if-changed list — so `tauri dev` happily
   reuses the cached binary and the new file does nothing, with no warning.
   The tell was the old "window is set to be transparent" warning still
   printing after a full dev restart. Fix: `touch src-tauri/tauri.conf.json`
   (which *is* watched) to force the build script to re-run and re-embed the
   merged config. This only bites the first build after the platform file
   appears; afterwards it is tracked like any other config change.
2. **`transparent` goes back to `false` on macOS.** A transparent window there
   needs the `macos-private-api` Cargo feature (`app.macOSPrivateApi` in the
   config), which this app has never enabled — so `transparent: true` was doing
   nothing on the Mac anyway. With real decorations, AppKit draws the rounded
   corners and the shadow, which is what the flag was reaching for. Linux keeps
   `transparent: true` in the base config, untouched.
3. **The drag region is unaffected.** `titleBarStyle: "Overlay"` is
   `fullSizeContentView` + a transparent titlebar: the webview still owns the
   whole window, so `data-tauri-drag-region="deep"` and the
   `core:window:allow-start-dragging` permission from §15b are still what moves
   the window on both platforms. Nothing in `capabilities/default.json` changed.

On the frontend, `VaultWindow` still renders `WindowControls` **only** when
`detectPlatform() === "linux"` — that is now correct rather than merely
harmless. The 38px bar gets `padding: 0 78px` on macOS: the traffic lights sit
in roughly the first 78px, and the inset is applied to *both* sides on purpose,
because padding the left alone would shove the centred title ~39px right of the
window's true centre and read as a bug.

Bench check on the Mac: quit and restart `tauri dev` — **a platform config file
is read at build/dev start, so a running dev process will not pick it up from a
vite hot reload.** Then: three traffic lights top-left; no duplicate system
title text beside ours; our title still centred; dragging the bar still moves
the window; double-click still zooms. On Linux nothing should have changed at
all — the app-drawn controls stay on the right.

### 15d. Popouts are still permission-blocked

`popoutStore.ts` opens a detached document window with `new WebviewWindow(...)`,
which is `plugin:webview|create_webview_window` — also `false` in the default
set, and also not granted. So ⌃⌘O in the real shell fails the same way the
title bar did. It is left alone here because a popped-out window would then
need its own capability entry (`capabilities/default.json` lists
`"windows": ["main"]`, and the popout labels are `aquarius-*`), and because a
window-move hotfix is not the place to bring a whole feature back. Filed, not
forgotten.

### 15e. How to check this class of bug in future

Anything that reaches for a `plugin:` command from the renderer — window, webview,
dialog, shell, fs — is off unless `capabilities/default.json` names it. The
cheapest test is the one used here: a temporary `invoke("plugin:…")` in the DEV
block of `src/main.tsx`, reporting through `dev_log` so the answer lands in the
terminal running `tauri dev`. A permitted command answers `OK`; a refused one
answers with the permission it wants, by name.

---

## 16. v0.2.0 — the app can update itself on AquariusOS

Aquarius Writer is the operating system's stock writing app. That is a nice
thing to be and one awkward thing to be: the OS image is **read-only**, so the
app cannot overwrite itself the way a normal desktop app does. Before this
version, a new Aquarius Writer meant a whole new AquariusOS image.

Aquarius Editor solved this first, in TypeScript
(`../aquarius-editor/desktop/overlay-update.ts`). v0.2.0 is the same idea in
Rust, with the same agreement with the operating system, so both apps behave
identically and the OS only has to know one trick.

### 16a. How it works, in plain language

The app downloads a newer copy of *itself* into a folder in the home directory,
and the OS launcher starts whichever copy is newer.

```text
~/.local/share/aquarius/aquarius-writer/     ← "the overlay"
  ├── versions/
  │   └── 0.3.0/        a complete unpacked copy of the app, AppRun on top
  ├── tmp/              scratch space, emptied after every attempt
  └── current -> versions/0.3.0    (a RELATIVE symlink)
```

`/usr/bin/aquarius-writer` — the launcher — reads `current`, compares its
version with the one baked into the image, and starts the newer of the two. The
image copy is never touched, which is what makes the whole thing safe: the worst
case is that the OS-supplied version starts instead.

The order of operations matters and is not negotiable:

1. download the release's AppImage into `tmp/install-<random>/`
2. fetch that release's `SHA256SUMS.txt` and check the download against it —
   **hard failure** on a mismatch, or on the file not being listed at all
3. mark it runnable and let it unpack itself (`--appimage-extract`, which needs
   no FUSE)
4. fix the unpacked copy's permissions and one packaging line (§16c)
5. `rename()` the unpacked folder into `versions/<version>`
6. repoint `current` **atomically** — a new symlink under a temporary name,
   renamed on top of the old one, so a launcher reading it at that instant sees
   the old target or the new one and never a gap
7. delete every older version
8. delete the scratch folder, whatever happened

Steps 1–4 happen entirely inside the overlay's scratch folder. Nothing outside
it is touched until step 5, and `current` is not moved until step 6. A failure
anywhere leaves the machine running exactly what it was running.

### 16b. What the code is, and where

| File | What it does |
|---|---|
| `src-tauri/src/updater/overlay.rs` | All of the above, in plain `std`. No Tauri, no network — which is why `cargo test` can exercise the whole install against temp directories, including every way it can fail. |
| `src-tauri/src/updater/net.rs` | The bits that touch the outside world: `ureq` for HTTP, `sha2` for the checksum, a child process for the unpack. |
| `src-tauri/src/updater/mod.rs` | The state machine (idle → checking → available → downloading → installing → ready) and the `updater://state` event the panel redraws on. |
| `src/state/updateStore.ts` | Mirrors that state. Decides nothing itself. |
| `src/components/overlays/Settings.tsx` | The Updates section of the About tab. |

Three crates were added to `src-tauri/Cargo.toml`: `ureq` (HTTP, with rustls
built in — no OpenSSL needed on any build machine), `sha2`, and `semver`. No new
Tauri capability was needed: the four commands are the app's own, and
`core:default` already allows the renderer to listen for events.

### 16c. Two things done to a downloaded copy that the OS build also does

`os-image/build_files/creator-apps.sh` does not ship the baked copy exactly as
the AppImage unpacks. It fixes two things, and a copy downloaded here would miss
both — so `overlay.rs` does the same two:

- **Permissions.** What comes out of `--appimage-extract` is whatever the
  packaging tool left behind, and it has been wrong: Writer v0.1.0's AppImage
  carried `AppRun.wrapped` as `0770`, and the Editor's extractor once produced
  *every* directory as `0700`. The launcher checks a downloaded copy before
  trusting it and quietly starts the baked one instead when something is
  unreadable — safe, but the update would appear to install and then never run.
  So the same rule is applied: directories `0755`, runnable files `0755`,
  everything else `0644`, and `AppRun`, `AppRun.wrapped` and
  `usr/bin/aquarius-writer` runnable whatever they arrived as.
- **`GDK_BACKEND`.** The linuxdeploy GTK plugin generates a start-up snippet
  containing `export GDK_BACKEND=x11`, sourced *after* anything the launcher
  sets — so the launcher's documented `AQUARIUS_GDK_BACKEND` escape hatch would
  silently do nothing on a downloaded copy. It is rewritten to
  `export GDK_BACKEND="${GDK_BACKEND:-x11}"`, which is upstream's own fix
  (tauri-apps/tauri#15786). Behaviour is unchanged with nothing set; the knob is
  merely reachable. A missing file or missing line is not an error — packaging
  changes, and an update must not fail because there was nothing to patch.

### 16d. Deliberate limits

- **Nothing is automatic except the check.** One quiet check at launch, whose
  failures are silent. Downloading is one deliberate press — it is a large file
  and the connection may be someone's phone — and nothing ever restarts on its
  own.
- **This is not the Tauri updater.** No signing key, no update manifest, no
  `bundle.createUpdaterArtifacts`. The release feed is GitHub's own API and the
  release's `SHA256SUMS.txt`, which the OS image build already trusts for the
  same files. If Tauri's updater is ever adopted for the Mac build, this stays
  as it is: it solves a problem Tauri's updater cannot, on a read-only OS.
- **Off AquariusOS the whole module is asleep.** The switch is
  `AQUARIUS_OS_MANAGED_INSTALL=1`, and only the OS launcher sets it. On macOS
  it is ignored even if exported by hand. The Settings section is not drawn.
- **Installs older than v0.2.0 cannot self-update**, because this did not exist
  in them. They reach v0.2.0 through an AquariusOS image update, once; from then
  on the app updates itself.
- **This half cannot change alone.** The overlay layout, the bare-semver folder
  name, the atomic swap and `/usr/bin/aquarius-writer` as the restart path are
  an agreement with `os-image/system_files/usr/libexec/aquarius-app-overlay`.
  Change one side and the update silently stops taking effect.

### 16e. What has not been tested on real hardware

Everything above is covered by `cargo test` against temporary directories, and
the checksum, permission and `GDK_BACKEND` steps are exercised with a fake
extractor that reproduces the exact breakages seen in the field. What no test
here can cover, because Royce's Mac is Apple Silicon:

- a real `--appimage-extract` of a real x86_64 AppImage,
- the launcher actually preferring the overlay copy on next start,
- and the restart itself, which spawns `/usr/bin/aquarius-writer` and exits.

Those three want one pass on the x86 bench: install an update, confirm the
version in Settings → About changes after the restart, and confirm
`versions/` holds only the new copy afterwards.

---

## 17. The shell layout catch-up — the top bar, and where the status bar went

PARITY rows 1 and 3, the last of Wave 1. The port had been wearing the May 2026
HANDOFF §8 shape: a 38px title bar, a fixed `240px 1fr 320px` grid that nothing
could resize, an editor toolbar buried inside each editor pane, and a 26px
status bar along the bottom. SWIFT-AUDIT §1.3 says the Swift app has none of
that below the title strip and one thing above the columns: a **top bar**.

### 17a. The new shape

```
┌──────────────────────────────────────────────────────────────┐
│ 38px title strip — drag region + (Linux) window controls     │  unchanged
├──────────────────────────────────────────────────────────────┤
│ 48px top bar: [Files] (⌘K capsule) ·· toolbar ·· Comments    │  new
│                                          Versions  [pane]    │
├────────┬─┬───────────────────────────────┬─┬─────────────────┤
│Sidebar │▏│ Editor (rails + page canvas)  │▏│ Right pane      │
│248 def │ │ min 320                       │ │ 360 def, min 280│
│190–560 │ │                               │ │                 │
└────────┴─┴───────────────────────────────┴─┴─────────────────┘
              ▲ 7px splitter, 0.5px hairline → 2px accent
```

Four files carry it, all new:

- `src/state/shellStore.ts` — widths, collapse flags, right-pane tab, the
  search text, and a `focusTick` that ⌘K bumps.
- `src/state/toolbarStore.ts` — which document the top bar's toolbar is
  driving. The toolbar used to be a prop-fed child of each editor pane; now the
  **primary** pane publishes `{kind, path, element}` on mount and clears it on
  unmount, and the top bar draws whatever is there. Only the primary pane
  publishes: one row, one owner.
- `src/components/shell/TopBar.tsx` — the row itself.
- `src/components/shell/{Splitter,Gutter}.tsx` — the two new primitives.

### 17b. Where every status-bar item went

Nothing that was reachable became unreachable. The bar held four kinds of
thing:

| Was in the status bar | Lives now |
|---|---|
| `v0.2.0` version string | **Settings → About** (it was already there — the status bar was the duplicate) |
| "← workflows" | the sidebar footer chip's **"All workflows"** — same `closeWorkflow()` call, in the control people actually look at for workflows |
| Palette / Graph / Today / Settings icon buttons | the **sidebar bottom rail**, which grew from four buttons to six (Palette · Today · Graph / Find · Trash · Settings) and became a 3×2 grid so six labels still read at the 190px minimum width. ⌘P, ⌘G, ⌘T and ⌘, are unchanged. |
| theme + accent `<select>`s | **Settings → Appearance**, which has had both as chip pickers all along. Deleted rather than moved. |

`src/app.css` is now a comment: `.vw-toggle`, `.vw-link` and `.vw-icon-btn`
existed only for that bar.

### 17c. The title bar was left alone, deliberately

38px, not 32px. The drag region (`data-tauri-drag-region="deep"`) and the
Linux-only `WindowControls` were the entirety of v0.1.1 and v0.1.2 (§15), they
are tuned against this height, and neither can be re-tested from an Apple
Silicon Mac. Six pixels is not worth a second bench trip. The only change to
`VaultWindow` is that `footerLeft` / `footerRight` and the `<footer>` are gone
and the grid is `38px minmax(0, 1fr)`.

(2026-08-31: still 38px. macOS now draws its traffic lights *into* this bar and
the content is inset 78px each side to clear them — §15c. The height did not
move, which is the point.)

### 17d. Splitters, clamps and persistence

The column track list is written in `MainWindow.tsx` from the current state,
because a collapsed pane drops **its splitter track as well as its width** —
that way a hidden splitter can never be grabbed, and the number of grid tracks
always matches the number of children.

Clamping happens in two places. During a drag, the ceiling is computed live
from the host's width so the editor keeps 320px. On a window resize a
`ResizeObserver` does the same sum and, if the editor would fall short, takes
the space back from the right pane first and the sidebar second — the sidebar
is what you navigate with.

Persisted, in the spirit of the existing `aquarius.*` keys (and named after the
Swift UserDefaults keys in SWIFT-AUDIT §4):

```
aquarius.sidebarWidth        190–560, default 248
aquarius.sidebarCollapsed    "true" | "false"
aquarius.rightpane.width     ≥ 280, default 360
aquarius.rightpane.collapsed "true" | "false"
aquarius.rightpane.mode      "comments" | "versions"
```

The search text is **not** persisted: a filter that survived a restart would
look like a broken file tree.

### 17e. One gutter, four panes

`Gutter` is 28px of `--bg-soft` with a hairline on the editor-facing edge and
the pane's name rotated −90° in heavy, 0.16em-tracked 10px caps. The sidebar,
the right pane, the chapter rail and the scenes rail all collapse to it — the
rails used to have their own `.rail-collapsed` with a `⌃` glyph, and that is
gone. The rails also went 220px → 244px, the audit's number.

The **editor pane itself** does not collapse. Swift's ⌃⌘E "hide editor" is not
ported; the shell now has the bones for it, and it is listed as Wave 1 leftover
work in PARITY rather than pretended done.

### 17f. ⌘K and what the capsule actually searches

The capsule is a real input, 240px, hairline-stroked, with a `⌘K` keycap that
becomes a clear button once there is text. Typing **filters the file tree by
name** (folders survive because a descendant matched, and the filtered tree
auto-expands — a folded filter result is useless). Pressing **Enter** hands the
same words to the Find-in-workflow sheet, which is the half a name filter
cannot do: look inside the documents. `OverlayPayload` grew a `query` field for
that hand-off.

⌘K was previously advertised in the cheat sheet as "insert wiki link" and was
bound to nothing at all, so nothing was displaced. ⌘\ (sidebar) and ⌘⌥\
(right-pane cycle: comments → versions → hidden) were also only ever cheat-sheet
entries; they are real now. On macOS ⌥\ types `«`, so the matcher accepts
`e.code === "Backslash"` as well as `e.key`.

### 17g. The page canvas, and why the screenplay does not get one

SWIFT-AUDIT §1.5: prose renders on a US-Letter sheet, and that "more than
anything is why the Swift app looks like a writing app and the port looks like
a text field". Prose and note documents now render `.mw-canvas` (the desk,
`--bg`) holding `.mw-sheet` — 850px wide, 96px side and 64px top/bottom
margins as the 1" rule, `--surface`, a `--radius-card` corner and
`black @ 22%, blur 14, y 1` (much lighter on Ice, where that shadow would be a
smudge). The document header stays on the desk above the sheet; the title, the
editor and the footer stats are on the page.

It is **one continuous canvas, not paged** — Swift's prose canvas has no page
breaks either.

The screenplay keeps its old surface on purpose. Its canvas is *paged*, with
real page breaks at industry geometry (PARITY row 12, a later wave); dropping
Fountain onto the prose sheet now would fake a page geometry the port does not
have yet.

The CodeMirror embed is untouched by any of this. `.mw-prose` is still the
scroll container and the editor still grows to its content, which is the exact
arrangement `ProseEditor.css` and `lib/cm-embed.ts` describe and the reason
they exist — putting a scroller inside the sheet would reintroduce the
viewport-virtualisation bug they were written to kill.

---

## 18. Dragging a row in the tree, and the four things it refuses

Royce, on the bench: *"I can't drag or move folders or files."* Half of that was
already untrue — the row's ⋯ menu has had **Rename** and **Move to…** since
PARITY row 6 shipped — but the half he reached for first was: the tree looked
like a tree, so he dragged, and nothing happened.

`useTreeDrag` in `Sidebar.tsx` is the whole feature. It is deliberately thin,
because **it does not move anything itself**: it calls the same
`vaultStore.moveEntry` the Move to… menu calls, which is `vault_move` →
`EntryReport` → `applyRelocation`, with open editor buffers, the selection, the
split pane, the stars and the manuscript's chapter order all following the file
in one `set`. One move path, two ways to reach it. If a drag ever moves a file
that the menu would not have, something has been duplicated that should not be.

### 18a. HTML5 drag, not pointer maths

The codebase already drags with the native events — `ChapterRail` and `Outline`
both do — so this does too rather than inventing a second idiom. Two WebKit
details that are not obvious, and that WebKitGTK on the Linux bench shares:

- **The drag source is `.sb-rowwrap`, not the `<button className="sb-row">`
  inside it.** WebKit treats a form control as its own drag source, and the
  wrapper is also the element that has to carry the drop ring (the button's
  background is already spoken for by `:hover` and `.selected`).
- **`-webkit-user-drag: element` is required.** `.sb-tree` sets
  `user-select: none`, and WebKit will not start a drag on content it considers
  unselectable. Without that one line the feature is silently inert on exactly
  the platform that matters. It is in `Sidebar.css` under
  `.sb-rowwrap[draggable="true"]`.

`dragleave` also fires when the pointer crosses from the row into one of its own
children — the label, the caret, the ⋯ — so the handler ignores a
`relatedTarget` that the row still contains. Without that the drop ring
flickers on and off as you move along a row.

### 18b. The refusals, and why they are drawn twice

Only **folders** accept a drop, plus one "move to the vault root" strip that
appears at the bottom of the tree while a drag is in flight (and only when the
row is not already at the root — a target that refuses the drop is worse than no
target). A file row is not a target: "into the folder this file happens to live
in" is a guess, and a guess that moves files is the wrong kind of convenience.

Three rules, in `TreeDrag.allows`:

```
folder === dragged path            a folder into itself
folder.startsWith(`${path}/`)      …or into one of its own descendants
folder === parentOf(dragged path)  already there — a no-op
```

The first two are also enforced in Rust (`ops::move_entry`) and in the browser
mock (`relocate`), and the third returns `unchanged_report` there. Drawing them
in the UI as well is not redundancy for its own sake: an illegal target must
never `preventDefault()` on `dragover`, because that is the only way to tell the
engine "not here" and get the no-drop cursor. A UI that accepts the drop and
then shows a failure notice is a UI that lied for 300ms.

Spring-open: hovering a **closed** folder for 700ms opens it, so a drag can
reach a nested destination without being let go of first. One timer, because
only one folder can be under the pointer, cleared on leave, drop, drag-end and
unmount. It reads `useVault.getState()` rather than a closed-over `expanded`,
since 700ms is plenty of time for that set to go stale. A completed drop opens
the tree down to the destination for the same reason: a chapter dropped into a
folded folder otherwise reads as "my file vanished", which is the one thing a
move must never look like.

Esc cancels. The engine already aborts a native drag on Escape and answers with
`dragend`, which is what really clears the state; the `keydown` listener is the
belt to those braces, because WebKitGTK has not always delivered key events to
the page mid-drag. Both routes end in the same `end()`, so a double fire is
harmless.

### 18c. What is still not draggable

- **In and out of the OS file manager.** Still PARITY row 6's leftover, and now
  the only one. It is a different mechanism entirely — Tauri's own file-drop
  handler on the way in, a `DownloadURL` / `text/uri-list` payload on the way
  out — not an extension of this.
- **Reordering rows inside a folder.** Not a gap. The tree is sorted
  folders-then-name to match the backend's order, and manuscript order is the
  chapter rail's job (PARITY row 10). Two different orderings of the same files
  in two panes would be a bug, not a feature.
