# Notes — where the handoff and the code disagree

`HANDOFF.md` in this folder is the **product design contract** and is kept
byte-for-byte as delivered. It is never edited. When reality has moved on from
what it says, the discrepancy is recorded here instead.

Last reviewed: 2026-08-25 (Stage 5 — the MCP server, and two features removed).

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
