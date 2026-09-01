# Notes — where the handoff and the code disagree

`HANDOFF.md` in this folder is the **product design contract** and is kept
byte-for-byte as delivered. It is never edited. When reality has moved on from
what it says, the discrepancy is recorded here instead.

Last reviewed: 2026-08-31 (v0.3.1 — the WebKitGTK caret fixes, §1a).

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

### 1a. WebKitGTK and the caret

Royce, on the bench (v0.3.0, AquariusOS): *"inside the editor, clicking puts the
cursor in the wrong place, and the arrow keys skip lines."* Everything outside
the editor clicked fine, so it was not display scaling, and the macOS build was
clean.

**How CodeMirror turns a click into a caret.** It does not hit-test the DOM
first. It keeps a **height map** — a running total of every line's height,
measured with `getBoundingClientRect()` — and `posAtCoords` divides the click's
Y through that map to pick a *line*, then does real glyph hit-testing inside
that one line. Arrow keys go through the same map: `moveVertically` steps down
in half-line increments and asks `posAtCoords` what it hit.

So there is exactly one way to break the caret: **let the painted document and
the height map disagree about where a line is.** Everything below is a way that
was happening.

#### The margins CodeMirror could not see

`getBoundingClientRect()` returns a **border box**. Margins are outside it.
The prose theme's line rule was:

```
".cm-line": { padding: "0", margin: "0 0 0.55em 0" }
```

That is 9.35px of paragraph rhythm on every single line that the height map
never counted. The map thought line *n* started at *n* × 28.05px; the compositor
painted it at *n* × 37.4px. Twenty lines down the page, the map and the document
are 187px — about five lines — apart, and a click lands five lines off. It gets
worse the further you scroll, which is exactly what a caret bug of this shape
looks like.

`moveVertically` has an explicit recovery for landing on a line's **padding**
(`posAtCoords` re-scans when the Y falls in the pad rather than on a glyph). It
has no equivalent for margins, because CodeMirror's contract is that lines do
not have them — its own base theme spaces lines with `padding: 0 2px 0 6px`.
Land a vertical step in a margin and there is nothing to recover to; the step is
resolved against the wrong block and the caret jumps a line. That is the arrow
keys.

**Every margin in the editor content path is now padding.** Prose lines,
headings, the Fountain scene/character/transition/section indents, and the page
break rule in `ScreenplayEditor.css` (which carried a 22px `margin-top`, folded
into its existing `padding-top`). Where a heading's margin used to *collapse*
with the previous line's, the replacement padding-top is the old value minus the
9px the previous line already contributes, so the painted gap is unchanged in
running text. A heading on line 1 sits 9px higher than it did. That is the whole
visual cost.

This one was never Linux-specific — it was wrong on macOS too, just with the
same wrongness in both places often enough that a short document felt fine.

#### The fractional line box

`--prose-size: 17px` × `--prose-leading: 1.65` = **28.05px**. WebKitGTK snaps a
fractional line box to device pixels; CoreText carries the fraction. Same CSS,
two different painted layouts — and CodeMirror's height map, built from
measurement, matches only one of them. The rounding error is small per line and
strictly cumulative, which is why the caret was roughly right at the top of a
document and badly wrong at the bottom.

The editor content path now uses whole pixels for everything: font sizes, line
heights, paddings, letter-spacing. `--prose-line-px` (28px) and
`--prose-para-gap` (9px) are the new tokens; `--prose-leading` survives for
chrome that wants the ratio, and **nothing inside `.cm-content` may read it**.
The heading sizes were `em` multiples of 17px and are now the same numbers
rounded once, at design time: 31 / 25 / 20 / 18px. The screenplay grid went from
14px × 1.55 (21.7px) to a flat 22px.

Rounding has to happen where the two numbers *meet*, and CSS cannot round — so
the Settings "Body size" and "Line height" sliders no longer write
`--prose-size` / `--prose-leading` at the root and let the editor multiply them.
They both call `applyProseMetrics(size, leading)` in `src/theme/theme.ts`, which
rounds the product and writes `--prose-line-px`. The Line height slider now also
shows the resulting pixel value, because that is the number that matters.

#### The serif nobody bundled

`--font-serif` was a pure fallback chain, per SWIFT-AUDIT §1.2:

```
"Iowan Old Style", Palatino, "Source Serif 4", Georgia, serif
```

with the note that on Linux it "simply falls through, which is the intent". None
of those faces was bundled. macOS resolved it to **Iowan Old Style**; Linux fell
all the way to **DejaVu Serif**. Different advance widths, different text height
for the same string, and therefore a different height map from the identical
document — plus a different answer to "which glyph is under this X".

**Source Serif 4 is now bundled** (`src/fonts/source-serif-4-*.woff2`, SIL OFL
1.1, `LICENSE-SourceSerif4-OFL.txt` beside it, from the same Google Fonts source
as the other three) and registered as **"AQ Source Serif"**, following the
`AQ `-prefix rule in §2e. It leads `--font-serif` on **both** platforms. Iowan
stays behind it as a webfont-failure fallback only.

That is a deliberate trade: the port loses the Iowan look on macOS and gains
identical text metrics on both platforms. For an editor whose caret position is
computed from those metrics, that is not close. Roman *and* italic are bundled —
`.cm-em`, the blockquote and the Fountain synopsis all ask for italic, and a
WebKitGTK-synthesised oblique has different metrics again.

`--font-mono` had the same unbundled-chain hazard (Courier Prime is not bundled
either, so Ice/Midnight on Linux landed on DejaVu Sans Mono). The bundled
`AQ JetBrains Mono` now sits ahead of the generics as a floor. It is not put
first: Courier is the industry face for a screenplay and macOS has it.
Full mono parity wants a bundled Courier Prime, and that is a follow-up.

#### What was already clean

`src/lib/markdown/wysiwyg.ts` hides markdown syntax with
`Decoration.replace({})` — the real CodeMirror mechanism, which removes the
characters from the layout in a way the measurement understands. It was never
the `font-size: 0` / `letter-spacing: -1em` / `display: none` kind of trick that
breaks measurement, and it did not need changing. Same for
`wikilink-ext.ts`, which uses plain `Decoration.mark`. Suspect number one turned
out to be the one innocent party.

The percentage left-indents on the Fountain elements (`26%` / `20%` / `14%`) are
gone anyway, replaced by the pixels they resolved to at the 696px design width.
They were not a height-map problem — horizontal padding does not affect a line's
height — but they resolved to fractions (26% of 696px is 180.96px) and moved
with the pane. A screenplay indent is an absolute grid measured in inches, so
fixed pixels are also closer to the PARITY row 12 target.

#### Bench checklist

Verify on AquariusOS, not on the Mac; the Mac cannot reproduce any of this.

1. **Long prose document, click at the bottom.** Open a chapter of 100+ lines,
   scroll to the very end, click in the middle of the last visible paragraph.
   The caret must land on the character you clicked. This is the test that
   failed before — the error grew with distance from the top.
2. **Click at the top, middle, bottom.** Same document, three clicks. All three
   exact.
3. **Arrow keys down the whole document.** Hold ↓ from line 1 to the end. No
   skipped lines, no doubled lines, and the column should hold.
4. **Arrow keys across headings.** ↓ and ↑ through an H1, an H2 and an H3. A
   heading has more padding than a body line and is the most likely remaining
   place for a step to land oddly.
5. **Arrow keys across a blockquote and a wrapped paragraph.** Wrapped lines
   are one block with several visual rows; ↓ must walk the rows.
6. **Click on a hidden syntax mark's line.** Put the caret on a `**bold**` line
   so the markers fade in, then click a line above and below it. The document
   reflows when markers appear; the caret must stay accurate through it.
7. **Screenplay editor, same three clicks and the ↓ hold.** Then check a
   character cue and a dialogue block specifically — those carry the largest
   indents.
8. **Screenplay page break.** Scroll past an estimated page break (the rule with
   the `p. N` label) and click below it. The 22px that used to be a margin is
   the exact thing this checks.
9. **Settings → Reading → Body size and Line height.** Move both sliders, then
   click and arrow through the document again at the new size. The pixel value
   next to the Line height slider should always be a whole number.
10. **Confirm the serif actually loaded.** The editor body text should be Source
    Serif 4, not DejaVu Serif — check an italic word too (`*like this*`), which
    should be a true italic and not a slanted roman. If it looks like DejaVu,
    the webfont did not load and every metric fix above is running on the wrong
    face.
11. **All three themes.** Ice, Midnight and AquariusOS. AquariusOS sets
    `--ui-size: 13.5px`, which is the only fractional type size left in the app;
    it must not reach the editor content.

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
- ~~**Conflict detection.** `safety/ConflictDialog.tsx` exists in the UI, but
  nothing raises it: a save currently wins over an external edit made while the
  document was open (the editor's copy is written; the version trail holds the
  previous text). Doing this properly means carrying the mtime read at open time
  into `vault_write_file` and refusing the write when it moved.~~ **Closed**
  2026-08-31 (Wave 2, row 9 of PARITY.md) — see **§20**, which is also where
  the one deviation from the plan above is argued: it carries a **content
  hash**, not an mtime, because this vault lives in iCloud and the File
  Provider re-stamps files it never rewrote.
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
- ~~**Snapshots are read-only over MCP, and a client's write does not take one.**
  The version trail is written by the editor's autosave; a `write_document` call
  replaces a file without recording what was there first. A client can read the
  old text and say so, but "undo the AI's edit" is not one click. Taking a
  snapshot inside `ops::write_document` would fix it and would also start
  recording versions for the UI's own path in a way it does not expect — worth
  designing rather than bolting on.~~ **Closed** 2026-08-31, alongside row 9.
  The design the note asked for: the snapshot went into a *separate* door
  (`ops::agent_write_document`) rather than into `ops::write_document`, so the
  UI's own save path is untouched and still records exactly what it always did.
  A client's overwrite now leaves a named **"Before AI write"** version behind,
  capped at 25 per document. Making that survive took one more change than it
  looks — `aux_store::save_versions` now keeps named rows the renderer's list
  never mentioned, because the renderer sends the whole list from a cache it
  hydrated when the vault opened and would otherwise delete a snapshot taken
  after that. See §20d. Snapshots are still *read*-only over MCP: there is no
  `take_snapshot` tool, and `write_document` takes one whether the client
  thinks to or not.
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

**§18a — and then it still didn't work (2026-08-31).** The hook was fine; the
window was eating the events. Tauri's `dragDropEnabled` window option defaults
to **true**, which installs a *native* drag handler on the webview for OS
file-drops — and on macOS (WKWebView) that handler consumes `dragover`/`drop`
before the page sees them. `dragstart` still fires, so a row lifts, shows a
ghost, and then nothing responds: no ring, no drop, no error. The fix is
`"dragDropEnabled": false` in **both** window configs (`tauri.conf.json` and
`tauri.macos.conf.json` — §15c's merge-patch rule). The cost is that Tauri's
native file-drop events are off, which loses nothing today: drag-in from the
OS file manager was never built, and when it is, it should be done with the
HTML5 events that this flag makes usable.

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

---

## 19. Compile is real now, and pandoc is a dependency we do not hide

PARITY row 7 was the largest thing in the app that was pretending to work: six
format cards, a path field, and a Compile button with **no click handler**. The
footer said *"Pandoc bundled; exports run locally."* Half of that was true.
Pandoc was never bundled and is not bundled now.

### 19a. What actually ships

`src-tauri/src/compile/`, three files with three different jobs:

| File | Job | Runs a process? |
|---|---|---|
| `assembler.rs` | Selection → ordered chapters → one markdown document. All the ordering, frontmatter and include-option rules. | no |
| `pandoc.rs` | Finding pandoc and a PDF engine; running them; turning stderr into a sentence. | yes |
| `mod.rs` | Policy: the five formats, the eight profiles, where the file lands, what the writer is told. | no |

The split is not decoration. `assembler.rs` is pure, so the part with all the
rules in it has 18 unit tests that run on a machine with nothing installed —
which is exactly what this machine was when the module was written.

**Two of the five formats need nothing at all.** Markdown (combined) and the
Fountain round-trip are written directly, because they are text and a round
trip through pandoc's parser could only lose something. EPUB, Word and PDF go
through pandoc; PDF additionally needs a PDF engine.

### 19b. Finding pandoc: PATH, then the places a package manager uses

`pandoc::find_program` walks `$PATH` first and then a fixed list —
`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/opt/local/bin`,
the TeX bin directories, the Nix profile, the Flatpak export dir.

That fallback is not belt-and-braces, it is the actual bug class. A `tauri dev`
process inherits the shell's PATH; an app launched from Finder or from a
`.desktop` entry frequently does not. "It works in my terminal" is how that
failure always presents, and a PATH-only lookup would have shipped it.

PDF engines are tried in order: **xelatex**, lualatex, pdflatex, tectonic,
typst, weasyprint, wkhtmltopdf. xelatex is first because it is the one the
Swift app uses and the only common engine that accepts a `mainfont` name — the
profiles are written for it. If a *non-LaTeX* engine is what is installed, the
LaTeX layout variables are **not sent** (typst would refuse them), and the
report says which engine rendered the file so the writer knows why the margins
are not what the profile promised.

### 19c. Never a shell string

Every pandoc argument goes into `Command::arg`. Nothing is interpolated into a
string that something else parses, and two tests hold that line: one proves a
failing program's own stderr comes back, and one proves an argument containing
`;` is one argument rather than a second command. A chapter called
`Ch 01; rm -rf ~.md` is a file name.

### 19d. What a missing pandoc looks like

Not a stack trace and not a shrug. The sheet asks `compile_probe` when it
opens, so EPUB / Word / PDF cards carry a quiet **"needs pandoc"** (or "needs a
PDF engine", when pandoc is there and the engine is not) *before* they are
clicked, and the opening selection falls back to Markdown rather than landing
on a dead card. If one is clicked anyway, `CompileError` comes back with a
`code` the renderer can branch on and a `hint` naming the actual command:

- macOS → `brew install pandoc` (and `brew install --cask basictex` for PDF)
- Linux → `sudo apt install pandoc` / `sudo dnf install pandoc` /
  `rpm-ostree install pandoc`, "on AquariusOS it ships with the image"

The footer no longer claims anything is bundled. With pandoc present it names
the version it found; without it, it says which two formats always work.

### 19e. Profiles, and what they actually change

Eight, split by format exactly as Swift splits them. Prose (`pdf`/`epub`/`docx`):
**standard-submission** (12pt Courier, double spaced, 1" margins, US Letter —
the default, and the shape submission guidelines ask for), **trade-paperback**
(5.5 × 8.5in, 11pt, 0.75"), **reader-proof** (Letter, 12pt, 1.5). Markdown:
**clean** (default), **web-ready**, **plain**. Screenplay: **industry-standard**
(WGA margins — 1.5" left, 1" elsewhere, 12pt Courier) and **reader-copy**
(notes, boneyards and scene numbers removed).

They become `--variable=` flags for PDF and assembler options everywhere else.
A profile asked for with the wrong format is refused with a message that names
the ones that would work — the same shape as every other refusal in the app.

### 19f. The screenplay PDF is honest about what it is not

Pandoc has no Fountain reader, and this repo does not have a Rust one. So a
screenplay bound for PDF is **escaped into markdown** — every `*`, `#`, `>` and
`[` that means something different in a screenplay gets a backslash — and
rendered with `hard_line_breaks`, smart quotes off, 12pt Courier and WGA
margins.

That produces a **Courier reader PDF at screenplay margins**. It is not
industry pagination: no dialogue indents, no MORE/CONT'D, no page-break rules.
Real screenplay pagination is PARITY row 12 (screenplay depth) and belongs with
the paged canvas, not here. The `.fountain` round-trip is the export a
screenwriting app should be given, and it is exact: no headings, no page
breaks, no escaping, ever.

### 19g. Nothing is overwritten, and a missing chapter is not fatal

Output names de-duplicate " 2" / " 3" through `vault::ops::dedupe` — the same
function the sidebar's "New document" uses, now `pub(crate)` for this. The
report says `renamed: true` and the sheet says so in words.

A chapter in `chapterOrder` that is no longer on disk **drops out and is
listed** in `missing`. A writer pressing Compile at 2am wants the other
nineteen chapters, not a refusal. Only reading *nothing* is an error.

### 19h. `compile_reveal` adds no capability

"Show in folder" is a Rust command that spawns `open` / `xdg-open` with an
argument array. It is not the shell plugin's JS API, which would need
`shell:allow-open` — a blanket "open anything" permission for the whole
renderer. `capabilities/default.json` is **unchanged by this entire feature**;
the output folder comes from `vault_pick_folder`, the same native dialog the
welcome screen already uses.

### 19i. The MCP tool writes inside the vault only

`compile_document` mirrors `compile_run` — same formats, same profiles, same
assembler — with one deliberate narrowing: its `output_folder` is
**vault-relative** (default `Exports`), not an absolute path.

The UI can write anywhere because the writer chose the folder by hand in a
native dialog; that click *is* the consent. A tool call carries no such
consent, and every other MCP path in this server is already vault-relative and
`resolve_in_root`-checked. Making compile the one exception would have been a
new class of capability smuggled in behind a feature. The tool surface is now
**20 tools**.

### 19j. Deferred, on purpose

- **FDX.** Dropped from the sheet rather than gated. It is a friendly stub in
  the Swift app too (SWIFT-AUDIT §2.4), and a card that can never work is the
  same lie the footer used to tell. The fine print points at Fountain, which
  Final Draft imports.
- **Industry screenplay pagination** — §19f. Row 12's job.
- **A reference .docx / custom EPUB CSS.** Profiles shape the PDF; DOCX and
  EPUB get metadata and a table of contents, not typography. A `--reference-doc`
  is the obvious next step and needs a designed template, not more code.
- **Compiling a folder or a selection of arbitrary files.** The sources are the
  manuscript (or one of its drafts) and the open document, which is what the
  Swift sheet offers.

---

## 20. Conflict detection: a hash, not a timestamp

PARITY row 9. The dialog had been sitting in `src/components/safety/` since the
port was copied out, complete and unreachable — `conflictStore.raise()` had no
callers. Underneath it, a save always won: open a chapter, let anything else
edit the file, and the next autosave wrote the editor's copy straight over it.
The version trail held the previous text, so nothing was *unrecoverable*, but
nobody was ever told.

### 20a. Why the plan changed on the way in

§8 and the PARITY row both said the same thing: carry the mtime read at open
time into `vault_write_file` and refuse the write when it moved. That would
have worked on a filesystem nobody else touches.

This one is not that filesystem. The repo — and Royce's vaults — live in iCloud
Drive, and the File Provider **re-stamps files whose bytes it never rewrote**
(the same daemon that has been resurrecting deleted files and breaking
`codesign` all week; see the project CLAUDE.md). On top of that, mtime
precision is per-filesystem: whole seconds on HFS+, nanoseconds on APFS,
nanoseconds-only-with-big-inodes on ext4, which matters the moment a vault is
opened on AquariusOS instead of a Mac.

An mtime guard on that setup raises the dialog at the sync daemon rather than
at a real edit, and a dialog the writer learns to dismiss protects nothing. So
the baseline is a **SHA-256 of the exact bytes** (`src-tauri/src/fs_ops/stamp.rs`).
Same bytes, same answer, on every filesystem and after any number of sync round
trips. `sha2` was already a dependency — the updater checks downloads against
`SHA256SUMS.txt` — so this cost nothing.

The mtime is still carried in the stamp and is still *reported*; it is simply
never *decided on*. The one place it is consulted is `stamp::mtime_moved`,
which turns "the clock jumped but the bytes are identical" into a line in the
log instead of a refusal. `MTIME_TOLERANCE_MS` is 2 s — enough to clear
whole-second filesystems — and exists only for that diagnostic.

Hashing **bytes and not the string** matters more than it looks: `read_text` is
lossy UTF-8, so a file with one stray `0xff` in it would hash differently going
out than coming in, and every single save of that file would look like somebody
else's edit. `fs_ops::stamp` has the test.

### 20b. The contract

Three wire types, mirrored field-for-field between `src-tauri/src/model.rs` and
`src/types/vault.ts`:

- `FileStamp { hash, mtimeMs, bytes }` — what the app last saw of a file.
- `FileRead { path, content, stamp }` — what `vault_read_file` now answers with.
- `WriteResult` — a tagged union: `{ status: "written", changed, stamp }` or
  `{ status: "conflict", theirs, stamp }`.

**A refusal is a result, not an error.** The frontend needs the on-disk text to
draw a diff, and an error string cannot carry it. Real failures — a path
outside the vault, a permission problem — still come back as `Err(String)` and
still reject the promise, so nothing that already handled those changed.

The guard is `ops::write_document_checked`, and it refuses exactly one thing: a
write whose `expected.hash` no longer matches what is on disk. Three cases it
deliberately lets through:

1. **No baseline at all.** Every pre-existing caller — a version restore, a
   find-and-replace, `set_frontmatter_status`, the trash restore — passes
   `None` and behaves precisely as it did before. Opting in is what made this
   safe to land in one change.
2. **A file that is gone.** Deleted underneath an open editor, the write
   recreates it. There is nothing on disk to lose, and refusing would strand
   the writer's paragraph in a buffer with nowhere to put it.
3. **Somebody else having written the identical bytes.** Two routes to the same
   text is agreement, reported as an unchanged write.

The byte-for-byte rule survives untouched: a guarded save of identical content
still does not open the file, and a document with no frontmatter still cannot
gain one.

### 20c. Two ways in, and the one that matters

The save path is the obvious one: `editorStore` keeps a `baseline` per open
buffer, set on open and after every successful save, and hands it to
`writeFile`. A refusal parks the buffer in a new `conflict` status — every
character intact, nothing written — and raises the dialog.

The one that matters more is the **watcher**. Swift's trigger is "the file
changed on disk while the document was dirty", not "the save failed", and
waiting for the next save means the writer types for another minute into a
document that is already in disagreement. So `vaultStore`'s watch callback now
calls `editorStore.reconcile()` alongside `refreshTree()`: every open buffer
re-reads its file's stamp, and

- a **clean** buffer takes the new text silently — which is what an MCP
  client's edit is supposed to look like from the writer's side, and is the
  behaviour that was already there;
- a **dirty** one raises the dialog immediately.

Two guards keep `reconcile` from arguing with itself: a buffer whose status is
`saving` is skipped (its baseline is about to move, and reading disk underneath
it would compare new bytes against an old stamp), and only one conflict is
raised at a time. The self-write ledger (§3c) is untouched and still does its
job — the app's own saves never reach the watcher at all, so a save can never
raise a conflict against itself.

### 20d. Nothing is lost by any of the three answers

Swift offers Keep Mine / Take Theirs / Save Mine As Copy. All three are wired,
and each one **snapshots whatever it is about to discard**:

| Answer | What happens | What is snapshotted |
|---|---|---|
| **Keep mine** | force-write (no baseline), buffer re-baselines on what it wrote | *theirs*, as "Theirs, before keeping mine" |
| **Take disk version** | buffer reloads from disk, marked clean | *mine*, as "Mine, before taking the disk version" |
| **Save mine as a copy** | mine → `<name>.conflict.md` beside the original, then theirs loads into the buffer | nothing — the copy *is* the record |
| **Decide later** | dialog closes, buffer stays dirty and unsaved | nothing — nothing happened |

The copy goes through the same `vault().createFile` the sidebar's add menu
uses, so it de-duplicates (`Ch_03.conflict 2.md`) and patches the tree like any
other new file. It keeps the document's *own* extension rather than always
`.md`, because a `.fountain` renamed to `.md` stops opening in the screenplay
editor. `vaultStore.createFile` grew two options for this — `content` and
`open: false` — and nothing else uses them.

The MCP snapshot ("Before AI write", named, capped at 25 per document) needed
one non-obvious supporting change. The renderer's aux cache is hydrated when a
vault opens and `saveVersions` sends the **whole list** back, so the writer's
next autosave would have deleted a snapshot taken after that hydration. So
`aux_store::save_versions` now keeps named rows it was not told about;
unnamed rows still obey the renderer's retention, which is how the 25-autosave
cap prunes anything at all. `replace_versions` is the unguarded door, used
where the caller just read the list it is rewriting.

### 20e. What this did not do

- **No merge.** The dialog shows a line-level diff and takes a decision; it
  does not offer to combine the two versions. Swift does not either.
- **The browser preview implements the same contract** in memory (FNV-1a, not
  SHA-256 — it is comparing its own strings against each other, and
  `crypto.subtle` is async and secure-context-only). Nothing external can edit
  a preview file, so a conflict there means the app argued with itself, which
  is exactly the bug worth catching in `npm run dev`.
- **`expected_hash` is opt-in on MCP.** A client that omits it writes
  regardless, which keeps every existing caller working. The tool description
  is where a model learns to send it, so that wording is load-bearing and has a
  test.
- **The `conflict` save status is not a failure state.** It renders as "changed
  on disk" in `--warn`, not "save failed" in `--danger`, because nothing failed
  — a write was held back on purpose.

---

## 21. Today runs on real data, and the session format is a proposal

*2026-08-31 — closes PARITY row 10 and the Today row; finishes Wave 2.*

Two things in this app were pretending. The chapter rail's drag reordered
chapters in memory and forgot them on the next open, while the MCP
`reorder_chapters` tool had been persisting the same order since Stage 5. And
the Today panel — goal ring, streak, 14-day sparkline, per-document deltas —
was painted from a `const TODAY = {…}` at the top of the file. So is the Swift
app's (SWIFT-AUDIT §2.6). Both were fixed in one change because they share a
premise: the manifest on disk is the truth, and the screen should be showing
it.

### 21a. The reorder was three lines and one real risk

`vault::ops::reorder_chapters` already existed, already validated, already
wrote `workflow.json`, already carried mirroring drafts along. The UI simply
was not calling it. So: a `vault_reorder_chapters` command, a
`reorderChapters` on the service seam (both implementations), and
`vaultStore.reorderChapters` became async — paint the new order immediately,
write it, and **put the old order back if the write is refused**. A rail that
silently forgets a drag is worse than one that never offered it.

The store mirrors the backend's rule about drafts rather than inventing its
own: a draft still showing the manuscript's order follows it, a draft the
writer has re-cut keeps its shape. Before, the store updated the *active*
draft regardless, which would now be a screen that disagreed with the file.

The part that was actually at risk is not the write — it is
`workflow::reconcile_chapter_order`, which runs on every
`vault_load_workflow` and merges the manifest against what is on disk. If that
pass had re-sorted, the rail would have snapped back to alphabetical the next
time the vault opened and the bug would have looked identical to the one being
fixed. `ops::a_reordered_manuscript_survives_the_next_open` pins it: reopen,
reconcile, assert nothing moved — then add a chapter outside the app and
assert it lands at the *end* rather than re-sorting the writer's arrangement.

### 21b. `.aquarius/sessions/` — one file per calendar day

HANDOFF §3 sketched this folder in May 2026 and nothing built it. The exact
shape, the rules, and the note that it is offered to the Swift app as a shared
contract live in **PARITY.md → "The session format"**; the code is
`src-tauri/src/sessions.rs`. What is worth recording here is *why* it is
shaped that way.

**Absolute counts, not deltas.** HANDOFF §4 proposed logging
`{ docPath, words, at }` deltas — "+412 words to Ch 03". That is the right
thing to *display* and the wrong thing to store: an append log of deltas
double-counts on a retry, cannot be reconciled against a file that changed
outside the app, and turns a corrupt tail into a wrong number rather than a
missing one. Storing `{ start, latest }` per document per day makes every
write idempotent — the same save landing twice changes nothing — and makes the
day's total a pure function of the file. `latest` is simply the last count we
saw.

**Local dates.** A writer working until one in the morning expects those words
in the day they think they are in. So the filename comes from
`chrono::Local`, and the browser preview's equivalent walks days at noon so a
DST shift cannot skip one.

**A first observation is a baseline.** This is the whole trick and it is easy
to get wrong. If the count were only recorded on save, opening a 2,410-word
chapter and writing four hundred words before the first autosave would record
`start = 2,822` and credit the writer with nothing. So `editorStore.open`
notes the count too — the baseline is taken when the document appears, and
every save moves `latest`.

**Losses floor at zero, per document.** The day's total is
`Σ max(0, latest − start)`. Cutting six hundred words out of chapter one does
not cancel the two hundred and fifty written into chapter two. A day is never
negative, and it also means a day spent revising downward reads as zero — the
one place this is stricter than it looks, and deliberate: the number claims
"words written", not "net change".

**Words are counted one way.** `src/lib/words.ts` is now the single
`countWords`, used by the footer stats, the version trail and the session
notes, over the document **body** with its frontmatter removed. Three
near-identical private copies were how the footer and the Today panel could
have quietly disagreed about the same paragraph.

**Nothing here is fatal.** A corrupt day file reads as an empty day and is
replaced by the next write. Unknown keys survive at both levels (`extra`,
flattened), because the format is being offered to another app and a field
this version has never heard of must not be dropped on the way through.

### 21c. Renames migrate; the trash does not

Sessions are keyed by path like snapshots and comments, so they ride the same
door: `aux_store::migrate_document` / `migrate_folder` now re-key every day
file, which means `vault::ops` did not have to change at all.

Trashing is the deliberate asymmetry. A star is dropped when a row is trashed
(PARITY row 4) because a star points at something you want to open. A
session entry points at something that *happened*, and a Tuesday that quietly
loses four hundred words because a chapter was cut on Friday would be a lie
about the past. History is history.

### 21d. The goal became real in the same change

`goals.dailyWords` had been in `workflow.json` since Stage 2, read by the ring
and written by nothing — in both apps. A ring measured against a number the
writer cannot change is the same pretend as a ring measured against sample
data, so the "/ 1,000" beside the day's count is now an in-place editor
(`vault_set_daily_goal` → `ops::save_workflow`). Every session file records
the goal that was in force **on the day it describes**, so changing the goal
today does not rewrite what last week was measured against.

### 21e. Where the numbers surface

- **Today (⌘T / the sidebar quick view)** — the same layout as before, now
  fed by `sessionsStore`: ring, streak, per-document list (top five, real),
  and the fortnight. It refreshes when it opens, because an MCP client may
  have been writing while it was shut.
- **Empty states**, two of them, because a fresh vault is the first thing
  anyone sees: *"nothing written today yet"* under the ring, and a sentence
  where the sparkline or the document list would be. No shrug, no blank
  rectangle.
- **`writing_stats` on MCP** — read-only, today plus the last fourteen days
  plus the streak. Swift has no equivalent, which makes this the second thing
  (after the conflict guard's auto-snapshot) where the port is ahead on
  behaviour rather than on platform.

### 21f. Two things this did not do

- **No idle-time tracking.** HANDOFF §4's session entry had `startedAt` /
  `endedAt`. Wall-clock time in an editor measures how long a window was open,
  not how long anyone wrote, and the format has room to add it later without
  breaking a reader — which is the point of `extra`.
- **The watcher was already right.** `.aquarius/` is excluded by
  `paths::is_metadata`, so writing a session file cannot look like an external
  edit and no self-write ledger entry was needed. The conflict-guard save path
  is untouched: the session note happens *after* a successful write, off the
  result, and a refused save records nothing.

## 22. Wiki-link autocomplete, and a zoom that keeps whole pixels

PARITY rows 13 and 14, both from SWIFT-AUDIT §2.1 ("wiki-link autocomplete;
per-document zoom (⌘+/⌘−/⌘0, persisted per path)"). They shipped together
because only one of them is interesting, and it is the zoom.

### 22a. `[[` completion — `@codemirror/autocomplete` was already in the tree

The package was **already installed at 6.20.2**, pulled in transitively by
`@codemirror/lang-markdown` (and by `lang-html`, `lang-css`,
`lang-javascript` under it). It is now a **direct dependency** in
`package.json` — the same version, resolved from the same lock entry, so no
install changes and nothing new is downloaded. Declaring it is not ceremony:
importing a package you only get by accident means a future `lang-markdown`
bump can delete your feature.

The source lives beside the rendering it completes, in
`src/lib/markdown/wikilink-ext.ts` (`wikilinkCompletion`), and is wired into
the **prose and note editors only** — a screenplay has no wiki links.

What it does: caret inside an unclosed `[[` → every markdown document in the
vault by display name, the current document excluded. It bails out the moment
the caret is not really inside a link — a `]]` already passed, a second `[`,
a newline, or the alias half of `[[Name|alias]]`. Accepting inserts the name
and the closing `]]`, unless a `]]` is already sitting there (re-editing an
existing link must not double it), and leaves the caret after the brackets.

Filtering is CodeMirror's own — prefix beats word-boundary beats fuzzy
subsequence, with the matched characters highlighted — plus a `boost` so a
true prefix hit wins its ties. Arrow keys, Enter and **Esc to dismiss** come
from `autocompletion`'s own high-precedence keymap, which is why the
extension can sit *after* the editors' `defaultKeymap` and still get Escape
first. Two files with the same display name show their folder as the detail;
one file shows nothing, because a disambiguator that is always there
disambiguates nothing.

`override` is used deliberately, so the popup can only ever be this: the
markdown language package ships HTML completions that would otherwise appear
inside embedded blocks.

The popover is themed through `EditorView.theme` in tokens — `--surface` on a
`--line` border, `--accent-soft` for the selected row, `--font-ui` at 12px —
matching the sidebar's menu idiom. CodeMirror mounts a tooltip inside
`.cm-editor` when no `parent` is configured, so the theme class reaches it,
and base themes are `Prec.lowest`, so these rules win.

**It touches nothing in the content path.** No decoration, no widget, no
styling inside `.cm-content`; the popup is a tooltip in the editor's chrome.
The `Decoration.replace` hiding in `wysiwyg.ts` and the `Decoration.mark`
wiki-link rendering are exactly as §1a left them.

### 22b. Zoom is a multiplier that never reaches CSS

This is the part §1a constrains. A zoom step **cannot** be a CSS
multiplication: `calc(var(--prose-size) * 1.25)` is 21.25px, `calc(21.25px *
1.65)` is a 35.06px line box, and a fractional line box is the v0.3.0 caret
bug with a new coat of paint. CSS cannot round.

So the arithmetic is in TypeScript and there is exactly one path to the DOM:

1. `proseMetrics(sizePx, leading)` in `src/theme/theme.ts` is now the shared
   rounding step. `applyProseMetrics` (the Settings sliders) calls it; so does
   the zoom. Same function, same three integers, so a zoom of 1 is
   arithmetically identical to no zoom at all.
2. `applyEditorZoom(host, kind, zoom)` multiplies **the writer's own body
   size** by the step — `proseMetrics(base.size × zoom, base.leading)` — and
   writes `--prose-size`, `--prose-line-px` and `--prose-para-gap` as whole
   pixels. The zoom **composes with** Settings → Reading; it does not replace
   it. 17px at 1.65 zoomed to 125% is 21px on a 35px line box, both integral.
3. Every other content length is a design-time constant, so each one is
   multiplied by the step and rounded once: the four heading sizes / line
   boxes / paddings, inline code, and the whole Fountain grid — element
   padding-tops, the character / parenthetical / dialogue indents, and the
   page-break rule's 32px.

Those constants used to be literals in `wysiwyg.ts`, `fountain-ext.ts` and
`ScreenplayEditor.css`. They are now `var(--token, <the same literal>)`, and
**nothing defines those tokens globally** — only `applyEditorZoom` does, on
one editor's host element. An unzoomed document therefore resolves every one
of them to the fallback and is byte-for-byte the layout v0.3.1 shipped. At
zoom 1 the overrides are *removed* rather than restated, so that is literally
true of the DOM as well.

The variables being scoped to the host is also why **the page canvas does not
move**: `.mw-sheet` is 850px with 96/64px margins in the sheet's own CSS, and
the zoom never reaches it. The text grows inside a stationary page.

After every apply, `view.requestMeasure()`. The height map is built from
measurement; changing the line box without telling CodeMirror to measure
again would leave the caret computed against the old geometry, which is the
original bug.

### 22c. Where the zoom lives

`src/lib/markdown/editor-zoom.ts`, and it owns three things:

- **The persisted map.** One localStorage key, `aquarius.editorZoom`, holding
  `{ "<vault-relative path>": <step> }`. A document at 100% is *absent* from
  the map rather than stored as 1, so the file stays small and a reset is a
  delete. Reads snap onto the ladder and treat anything unparseable as 100% —
  a corrupt preference is not worth an error. Writes are wrapped, so a webview
  with storage off loses the persistence and keeps the feature.
- **The ladder.** `0.8 · 0.9 · 1 · 1.1 · 1.25 · 1.4 · 1.6 · 1.8`, matching the
  Swift range. ⌘+ and ⌘− step it and clamp at the ends; ⌘0 returns to 1.
- **The live panes.** Each editor registers `{path, kind, host, view}` on
  mount (which is where the saved zoom is *restored*) and unregisters on
  unmount. A ⌘+ lands on the focused pane — the same focus signal the editors
  already send to `formatBus` — falling back to the most recently mounted one.
  Both halves of a split showing the same document zoom together, because they
  are the same document.

`onProseBaseChange` re-applies every open pane when the Settings sliders move,
because a zoomed pane's numbers are a product of the base and would otherwise
be stale.

### 22d. ⌘+ / ⌘− / ⌘0 are global, on purpose

They are three additive entries in `App.tsx`'s shortcut list, not CodeMirror
keymap bindings, because the target is "the active editor" and that is a shell
question. `useGlobalShortcuts` calls `preventDefault()` on every match, which
is the thing that stops the **webview** from zooming instead — and a webview
zoom scales the whole page by a fraction, which is precisely the surface §1a
says the editor must never be.

Matching goes through `key` *and* `code`: ⌘+ is an unshifted `=` on a US
layout, a shifted `+` elsewhere, and `NumpadAdd` on a third. All three are
in the cheat sheet, with the `[[` completion under Editing.

### 22e. Bench checklist (Linux, on top of §1a's)

1. **Zoom a long chapter to 180%, scroll to the bottom, click.** The caret
   must land on the character clicked. This is §1a's test at a new line box,
   and it is the only test that really matters here.
2. **Hold ↓ through a zoomed document**, across an H1, H2 and H3. No skipped
   or doubled lines.
3. **⌘0, then reopen the document.** It comes back at 100%; another document
   left at 125% comes back at 125%.
4. **Zoom, then move Settings → Reading → Body size.** The zoomed pane
   follows the slider and the pixel value stays whole.
5. **Zoom a screenplay past a page break.** The `p. N` rule's gap must scale
   with the grid and the caret must stay accurate below it.
6. **The sheet must not move.** At every step the page canvas keeps its width
   and its margins; only the type changes.
7. **Type `[[` in a note and in a chapter.** The popup appears, ↑↓ walks it,
   ⏎ inserts `Name]]`, Esc dismisses without inserting. Then type `[[` inside
   an existing `[[…]]` and confirm the closer is not doubled.

### 22f. What this did not do

- **No zoom for the sidebar tree.** The navigator's A−/A+ (SWIFT-AUDIT §1.3)
  is still open, and is a different control on a different surface.
- **No caret-anchored zoom.** Swift's screenplay keeps the caret's line under
  the cursor while the type scales; that belongs with the paged canvas
  (PARITY row 12).
- **A rename does not carry the zoom yet.** `remapZoomPath` exists and is
  correct; nothing calls it, because the rename path is `vaultStore` and
  `editorStore.remapPath`, which this wave deliberately did not touch.

---

## 23. The MCP surface caught up — ten tools, and the line numbers they count

*PARITY row 17, closed 2026-08-31. The surface went from 21 tools to 31.*

The Swift app has 33 MCP tools; this side had 21. The gap was never the
plumbing — it was ten operations that existed in Swift's `WriterToolbox` and
had no counterpart here: `set_synopsis`, `insert_text`, `replace_lines`,
`replace_in_document`, `take_snapshot`, `diff_version`,
`toggle_manuscript_folder`, `toggle_draft_folder`, `list_scenes` and
`reorder_scenes`. All ten now exist, all ten live in `vault::ops` where the
UI's Tauri commands can reach them too, and the tool functions in
`mcp/tools.rs` stayed what they have always been: argument shuffling and a
`json()` call.

### 23a. What was deliberately not ported

Swift has four appearance setters — `set_theme`, `set_accent`, `set_body_size`,
`set_line_height`. They are **not** here and are not an oversight. They are
Spark-era: they existed because an in-app assistant sat next to the editor and
"make it darker" was a thing you said to it. Spark was removed by decision on
2026-08-25, and what is left is a remote client on the other side of a socket
reaching into an app the writer is looking at. Changing the theme under
someone's hands is not an edit to their manuscript; it is an edit to their
room. A model that wants a different font size can say so.

`export_pdf` is not missing either — `compile_document` does PDF along with
four other formats, and doing it twice would mean two answers to "where did the
file go" (NOTES §19i).

The browser Web UI at `/ui`, the other half of row 17, **stays deferred**.
Nothing in the app depends on it, Claude Code is the client that matters, and
a self-hosted HTML console is a surface to maintain rather than a capability
to gain.

### 23b. Line numbers count body lines, and that is the whole footgun

`insert_text` and `replace_lines` address a document by line. The question
that decides whether they are usable is *which* lines, and there are two
honest answers:

- **File lines**, which is what Swift does. Simple, and wrong here for one
  reason: a document with a five-line YAML frontmatter block would have its
  first paragraph at line 7, and a client that read the body — which is what
  `read_document` hands back as `body`, and what the writer sees in the editor
  — would be off by six every time.
- **Body lines**, which is what this side does. Line 1 is the first line of
  the body, `frontmatter::parse`'s definition of body. The frontmatter block
  is carried across untouched, and a client can count lines in the `body` it
  was given and be right.

`ops::split_body` does the split, and it is arithmetic rather than a re-render:
the parser only ever drops leading lines, so `body` is a byte-exact suffix of
`content` and `prefix + body == content` holds. There is a `debug_assert` on
exactly that and a test for the empty case.

The rule is shouted in three places, because a client that gets it wrong edits
the wrong paragraph *silently*: the tool descriptions (`LINES ARE 1-BASED AND
COUNT BODY LINES ONLY`), each field's own schema doc, and the server's
`INSTRUCTIONS`. A test asserts all three still say it.

`fountain::collect_scenes` numbers scenes the same way, which is the point: a
scene's `startLine`/`endLine` can be handed straight to `replace_lines` to
rewrite that scene, with no conversion in between.

### 23c. Every write goes through the one guarded door

`insert_text`, `replace_lines`, `replace_in_document` and `reorder_scenes` all
end at `ops::agent_write_document` — the same function `write_document` has
used since NOTES §20. So all four get, without any of them implementing it:

- the auto-snapshot of what they replaced ("Before AI write" in the Versions
  panel),
- the optional `expected_hash` guard, returning `status: "conflict"` with the
  on-disk text rather than overwriting,
- the self-write ledger stamp, without which the watcher reports the app's own
  save as an external edit and the tree reloads in a loop (§3c),
- and the no-op rule: byte-identical content does not touch the file at all,
  and takes no snapshot.

That last one is why `replace_in_document` finding nothing is **not an error**.
Swift refuses with "no occurrences of…". Here it writes the identical bytes,
which is a no-op all the way down, and answers `replacements: 0` with the
current stamp. A model that asked a reasonable question gets an answer instead
of an exception, and the file is provably untouched.

### 23d. A folder mark is a manifest edit, and the two models did not match

Swift stores manuscripts and drafts as two flat lists of folder paths on the
workflow (`manuscriptFolders`, `draftFolders`). This side has a richer
manifest: a `Manuscript` carries an id, a title and a chapter order, and a
`Draft` carries an id, a name, an active flag and a cut. So "mark this folder"
could not be a string appended to a set — it builds or removes a record.

Marking seeds the chapter order from the markdown already in the folder, in
name order, which is exactly what `reconcile_chapter_order` would have
produced on the next open. Unmarking removes the record **and never touches a
file**; unmarking a manuscript also drops the draft folders that were only
drafts by virtue of sitting under it, which is Swift's rule. Drafts that are
*not* folder-backed are left alone — those are the writer's own named cuts.

Two rules came across unchanged, and one thing had to be added:

- **A draft folder needs a manuscript strictly above it.** A draft is an
  alternate cut *of something*. The refusal names the fix
  ("mark its parent as a manuscript first").
- **The manuscript folder cannot be its own draft.** Two records fighting over
  the same chapters on every reconcile is not a feature.
- **`Draft` gained an optional `folder`.** Without it there is nowhere to
  record *which* folder a folder-backed draft came from. It is
  `skip_serializing_if = "Option::is_none"`, so an existing `workflow.json`
  round-trips unchanged and the renderer — which never writes the manifest
  itself, only through Rust commands — does not need to know about it.

### 23e. The bug the `folder` field exists to prevent

`workflow::reconcile_chapter_order` runs on every open. For each manuscript it
lists the folder's markdown, merges that against the recorded order, and then
brings the drafts along: a draft that mirrored the manuscript follows it, and
any other draft gets `merge_order`'d against **the manuscript folder's**
listing.

That last step is fine when every draft is a cut of the manuscript's own
chapters. It is destructive the moment a draft's chapters live somewhere else:
an alternate cut in `Drafts/Second Pass/` has none of its files in
`markdown_paths_in(root, "Drafts")` — the listing is one level, not recursive —
so `merge_order` would drop every one of them as "gone from disk" and then
append the manuscript's chapters in their place. The writer's second pass would
be silently replaced by the first, on open, with no event to notice.

So the reconcile now skips folder-backed drafts in the manuscript pass and
gives them a pass of their own against their own folder. `ops::reorder_chapters`
got the same exemption, for the same reason. There is a test that adds a file
to each folder, runs the reconcile and checks that the two cuts stayed
separate.

### 23f. A snapshot bug found on the way through

`take_snapshot` and `diff_version` both lean on `aux_store::snapshot_document`,
and writing a test that took two snapshots in a row turned up something older
and worse than anything in this wave.

Version bodies are stored as files named `{stamp(at)}-{short(id)}.{ext}`.
`stamp` has **one-second** resolution. `short` keeps the first six alphanumeric
characters of the id — and `snapshot_document` builds its ids as `"s"` plus the
timestamp in hex, so those six characters are `s` plus five hex digits of a
clock that only changes them every few hours. Two backend snapshots of the same
document within the same second therefore resolved to **the same file**: the
second write clobbered the first one's body, the index kept both rows, and the
version history listed two versions and served the same text for both.

The fix is in `write_versions`, not in the id scheme: a generated file name is
de-duplicated against the names already in use (`-2`, `-3`, …), which closes
the hole for any id scheme rather than for this one. `aux_store` has a
regression test that takes two snapshots 4ms apart and reads both bodies back.

### 23g. The Fountain scanner is a scanner, not a parser

The renderer parses Fountain properly, through `fountain-js`. None of that is
reachable from Rust, and `list_scenes` / `reorder_scenes` need exactly one
thing out of a script: where the headings are. So `vault::fountain` is ~90
lines of line scanning, mirroring `SCENE_HEAD_RE` in `src/lib/fountain.ts`:
`INT.` / `EXT.` / `EST.` / `INT./EXT.` / `I/E.` at the start of a trimmed line,
or a forced heading — a single `.` followed by something that is neither a dot
nor whitespace.

One deliberate asymmetry: this side matches the prefixes **case-insensitively**
and the TypeScript regex does not. A tool that cannot see a scene the writer
can see is worse than one that sees a scene the syntax highlighter missed.

`reorder_scenes` takes a permutation of the scene indices rather than Swift's
`from`/`to` pair. A permutation is checkable — every index once, none invented,
refused otherwise — where a from/to pair can only be clamped, and "moved scene
7 to 40, which became 12" is not an answer anyone wants. Two details that are
easy to get wrong and are tested:

- **Everything above the first heading does not move.** In a screenplay that is
  the Fountain title page and any opening `FADE IN:`.
- **A moved last scene gets the blank line a heading needs.** The last scene in
  a script has no trailing blank of its own; moving it anywhere but the end
  would glue the next heading onto the line above and that heading would stop
  being a heading. One blank line is inserted only where that would happen, so
  an identity permutation is still byte-identical.

### 23h. What `diff_version` is for, and what it refuses to be

It answers "what has changed since this version" without pulling two full
texts into a model's context. Line counts, then the changed passages: each hunk
carries the line it starts at on both sides, the lines that went, and the lines
that came. No unified-diff header, no context lines, no rename detection —
`read_snapshot` and `read_document` are right there when the actual words are
wanted.

Two caps, both reported in the answer rather than silent. `truncated` means the
hunk list stopped (60 hunks, 40 lines per side); `approximate` means the two
texts were too large to align line by line (past a million LCS cells) and the
middle is reported as one replacement. **The counts are always the real ones.**
Common prefix and suffix are trimmed before the table is built, which is what
keeps the quadratic part small for the actual case — one paragraph changed in a
chapter.

### 23i. What this did not do

- **No `revert_to_version` tool.** Swift has one. Here it is `read_snapshot`
  followed by `write_document`, which is two calls and one auto-snapshot of
  what was replaced — strictly safer than a single tool that overwrites.
- **No UI for the folder marks yet.** Swift's sidebar has "Mark as
  manuscript" / "Mark as draft" in a row's context menu; ours does not, so for
  the moment these two tools can do something a human cannot do by clicking.
  That is a sidebar gap, written down in PARITY's closing section, not a
  capability the agent was given over the writer.
- **`replace_in_document` is one document.** A vault-wide rename is
  `search` + a loop, which keeps the per-file conflict guard meaningful.
- **Permanent deletion is still absent**, and nothing here moved it.

---

## 24. The shell and welcome polish — and one thing a webview cannot do

Wave 3's small-and-visible bundle: PARITY rows 15 (welcome), 16 (popouts), 21
(theme write-back) and 22 (empty states), plus the navigator zoom Wave 1 left
behind and the trash behavior SWIFT-AUDIT §4 said was the wrong way round.

### 24a. A folder dropped on the welcome window cannot be opened, and why

Swift's welcome screen lets you drag a folder from Finder anywhere onto the
window and it opens as a workflow (SWIFT-AUDIT §2.6). **This side cannot do
that, and it is not for want of trying.** Written down here so nobody spends
another afternoon on it.

The *events* are fine. `dragDropEnabled` is `false` in both window configs
(§18a), so Tauri's native file-drop handler is out of the way and the page
receives real HTML5 `dragover` / `drop`. What the drop carries is the problem.
Everything a webview will tell you about a dropped directory:

| What you can ask | What you get for a folder |
|---|---|
| `DataTransferItem.webkitGetAsEntry()` | a `FileSystemDirectoryEntry` whose `fullPath` is `/TheFolderName` — a path inside the drag's *own* sandbox root. Never the parent, never the volume. |
| `DataTransfer.files` | usually empty; at best a 0-byte `File` whose `name` is the leaf again |
| `File.path` | **not present.** This is Electron's nonstandard property. WKWebView does not have it, WebKitGTK does not have it, and Tauri 2 does not inject it. |
| `FileSystemHandle` (`showDirectoryPicker`) | not a path either — an opaque handle, and unimplemented in WebKit anyway |

The supported route to a real path is Tauri's **native** drop event
(`tauri://drag-drop`), which is precisely the thing that had to be switched off
to make tree drag work at all (§18a). One or the other, and tree drag is the
one Royce asked for.

So the drop **degrades instead of failing silently**, which is the actual
deliverable here:

- The window visibly reacts while a folder is over it — a dashed accent ring
  and a card. A window that lets a folder fall straight through it reads as a
  broken app, which is the impression this screen exists to stop giving.
- On drop it names the folder (`Can't open "My Novel" from a drop`), gives the
  one true reason — "this window can see the folder's name but not where it is
  on disk" — and then puts both ways in under the pointer: "Open existing", and
  the type-a-path box, revealed and focused.
- A dropped **file** gets a different sentence ("A workflow is a folder, not a
  file"), because being told the wrong thing about your own action is worse
  than being told nothing.

`readDroppedFolder` in `SelectWorkflow.tsx` still *asks* for `File.path` rather
than assuming it is absent. It costs one line, and if a future Tauri or WebKit
exposes it the feature starts working with no other change.

### 24b. Popouts, and the second half of the capability

⌃⌘O had been permission-blocked since §15d. Two things were needed, and the
second is the one that is easy to miss:

```jsonc
"windows": ["main", "aquarius-*"],        // ← not just the grant
"permissions": [ …, "core:webview:allow-create-webview-window" ]
```

`new WebviewWindow(...)` is `plugin:webview|create_webview_window`, so the
grant is obvious. But a Tauri capability applies **to the windows it names**,
and the popout is a *different window*: without the glob it would open and
then be a window with no permissions at all — no `core:event` listener for
`vault://changed`, no `data-tauri-drag-region`, no working reattach. The labels
are `aquarius-<flattened path>`, produced by the exported `popoutLabel()` in
`popoutStore.ts` so the glob has exactly one thing to match.

Three smaller repairs went in with it:

- **The ghost no longer lies.** `popped` used to flip the instant ⌃⌘O was
  pressed, so a refused window left the host showing a placeholder for a
  document that had gone nowhere. It now flips on `tauri://created`, and
  `tauri://error` raises a notice with the refusal's own words — which is how
  a missing permission will announce itself next time instead of being silent.
- **Reattach closes the real window.** The store kept a `Map` of `window.open`
  handles, which is a browser-only thing; the Tauri branch had nothing to
  close. It now keeps the `WebviewWindow` too. `close()` is
  `core:window:allow-close`, which the title bar already needed — nothing new
  granted.
- **The popout inherits the platform's chrome.** It was hardcoded
  `decorations: false, transparent: true`, which on macOS means an undecorated
  window with no traffic lights next to a main window that has native ones
  (§15c), plus the `macOSPrivateApi` warning §6 got rid of. It now matches the
  platform, and sets `dragDropEnabled: false` for the same reason the main
  window does.

### 24c. The trash never empties itself any more

SWIFT-AUDIT §4: *"Swift's trash never auto-purges (user confirms); the port
sweeps on load. Pick one — silent deletion after 30 days is the more surprising
behavior."* Swift's behavior wins.

`fs_ops::trash::sweep_expired` is gone, and with it the call at the top of
`vault_load_workflow`. Opening a workflow now destroys nothing. `RETENTION_DAYS`
survives as a **label**: `trash_retention_days` hands the number to the
Recently Deleted sheet, which marks anything older as "kept past 30 days" and
then leaves it exactly where it is, still restorable.

The one bulk destruction is `trash::purge_all`, behind `trash_empty` and behind
a confirm that counts what is about to go ("Permanently delete 41 items from
the trash?" is a different question from "Empty the trash?"). It rewrites the
index *after* the payload folders are gone, so a crash half way leaves rows
that still point at something rather than folders no UI can reach. Unlike the
single-row purge it is awaited rather than backgrounded — it is the one action
here a writer might quit straight after, and the one whose failure they need
to hear about.

Tests changed with the behavior: `the_sweep_drops_only_deletions_past_thirty_days`
became `age_alone_never_destroys_a_deletion` (a 400-day-old deletion is still
on disk and still restorable after a read), plus
`empty_trash_destroys_everything_and_only_when_asked` and a test pinning
`RETENTION_DAYS` at 30 — a number that no longer *does* anything can drift
without anyone noticing, so it is nailed down.

### 24d. The theme is global. Row 21 closed as "matches Swift"

PARITY row 21 asked whether the port should write `workflow.json`'s
`settings.theme` back. The answer is neither: **stop reading it**.

Swift keeps the theme in `UserDefaults` under `aquarius.theme` — one value for
the app — and has no concept of a per-workflow look at all (SWIFT-AUDIT §4).
The port was reading a field that nothing on either side has ever written, so
`themeStore.adoptWorkflow` implemented a behavior nobody could observe and the
only thing it could ever do was change the app's appearance under someone who
had not asked. It is gone, along with its `useEffect` in `App.tsx`.

`settings.theme` and `settings.accent` are still **tolerated**: the Rust struct
keeps them, `workflow.json` round-trips them untouched (unknown-key
preservation covers the rest), and an older file loses nothing. localStorage is
the truth. If Swift ever grows a per-workflow theme, the field is still there
to read.

### 24e. Navigator zoom is one CSS variable

A− / A+ in the WORKFLOW eyebrow, 0.8–1.8× in 0.1 steps, persisted as
`aquarius.sidebarZoom` — the same key Swift uses (SWIFT-AUDIT §4).

The whole mechanism is `--sb-zoom`, set inline on `.sb-tree`. `.sb-row` reads
it for its font size and vertical padding; the per-row indent, which is
computed in JS (`10 + depth * 14`) and so cannot be a plain rule, goes through
a `scaled()` helper that hands the arithmetic to `calc()`. Every reader uses
`var(--sb-zoom, 1)`, which is what keeps the blast radius at zero: the quick
views, the rail and the rename field all use `.sb-row` from *outside* the tree,
the variable is unset there, and they render exactly as they did before this
existed. Middle-click either button to reset to 1×.

Deliberately not scaled: the row icons. They are 12–13px glyphs whose props
take numbers, and threading a scale through them would have meant touching the
tree-row internals that §18's drag code lives in. Text and spacing are what
the zoom is for.

### 24f. Empty states are a component now, and one of them was lying

`components/shell/EmptyState.tsx` — inline SVG line illustration (folder, book,
star, search; `currentColor`, 44–60px), serif headline, italic subline,
optional single CTA, in `page` and `inline` sizes. Tokens only, so Ice,
Midnight and the AquariusOS skin all come out right with no second rule.
SWIFT-AUDIT §1.6: *empty states are never a shrug*.

Applied to the empty Starred quick view, a fresh workflow's empty tree (with a
"New document" button — the only one of these with something to *do*), a name
filter with no hits, an empty trash, an empty recents list on the welcome
screen, and the editor placeholder.

That last one is why this row was worth more than its size. The no-document
pane said *"Phase 4 wires up the WYSIWYG note editor for non-chapter
markdown"* — Phase 4 shipped months ago, and the sentence had been quietly
lying about the app's own state ever since. The case it was covering is real
but different: markdown, Fountain, images, PDFs, HTML and video all route
above it, so anything reaching that branch is a file type the app genuinely
has no editor for, and it now says so and names the extension.

### 24g. The sidebar is opaque, and that is a performance fix

Royce, on the Linux bench: navigation and scrolling felt sluggish. The sidebar
was the only frosted surface in the app — a translucent `--sidebar` plus
`backdrop-filter: blur(20px)`, behind an `@supports` test meant to catch
WebKitGTK builds that lack the property.

The test asked the wrong question. WebKitGTK *claims* support and then pays
for it in its compositor: a 20px backdrop blur beneath a scrolling file tree is
re-blurred every frame, over the full height of the column. `@supports` cannot
ask "and is it fast", so the honest answer was to stop asking. The block is
**deleted, not guarded** — a blur that runs only where it happens to be quick
is two sidebars to look at and one of them untested — and `.sidebar` now uses
`--sidebar-solid` unconditionally on every theme and platform. The translucent
`--sidebar` token went with it (nothing else consumed it; `--sidebar-solid`
stays and is now simply "the sidebar's background").

This pairs with `transparent: false` on the Linux window: there is nothing
behind the sidebar to blur either way now.

### 24h. What this did not do

- **Drag a folder in from the OS file manager.** Not deferred — *not possible*
  from the webview, for the reasons in §24a. It stays open on PARITY row 6 as
  a native-drop question, which is a different mechanism and a different
  trade-off against tree drag.
- **Popouts verified on real hardware.** The capability is correct against the
  generated ACL manifest and the label glob matches what `popoutLabel()`
  produces, but ⌃⌘O opening a real second window has not been watched on the
  Linux bench. §15e's `invoke("plugin:…")` probe is still the cheapest way to
  confirm it.
- **Row icons do not follow the navigator zoom** (§24e).
- **Empty states for the corkboard, the graph and the version list.** The
  component is there; those three panes were not in this bundle.

---

## 25. The split is two editors now, and one of them refuses to be the same document

PARITY row 11. The port's split pane was a read-only look at a second file —
useful, and exactly half of what Swift has. Swift's split is **two fully
editable documents side by side, with independent caret, scroll, undo and
autosave**, a draggable divider, and an accent line marking the pane you are
in (SWIFT-AUDIT §2.1). It *also* keeps a separate read-only Reference pane.

Both are here now, on one mechanism: the split, with an **Editable ↔
Reference** toggle in the secondary pane's slim header.

### 25a. The second pane is not a second system

The whole point of the change is how little it added. A document in the split
is an **ordinary open document**: `editorStore.open(workflowId, path)`, the
same buffer map keyed by path, the same 800ms debounce, the same `FileStamp`
baseline and conflict guard (§20), the same auto-version and session
word-count trail. The split store holds no text and never has.

That falls out of `editorStore` already being keyed by path rather than by
"the open document". Two panes on two paths are two entries in `docs`, and
everything downstream is already per-path:

- **Undo** is CodeMirror's, per `EditorView` — two views, two histories, no
  shared state to leak between them.
- **Autosave** is per buffer, so each pane's debounce runs on its own timer
  and each save carries its own baseline.
- **Session word counts do not double** (`useSessions.note(wf, path, n)` is
  keyed by path): two panes editing two documents note two documents. Two
  panes on *one* document cannot happen — see §25b — so there is no path
  where one file's words get counted twice.

### 25b. The same document in both panes is read-only, on purpose

This is the one real decision in the change.

CodeMirror does not support two views over one `EditorState`; the supported
shape is two views that *sync* to each other. The port's editors are already
sync'd to something else — the `editorStore` buffer, through a `value` prop
and an effect that replaces the whole document when `value` stops matching.
Point two of those at one buffer and every keystroke in pane A rewrites pane
B's entire document, which throws away pane B's selection, its scroll position
and (because a full-range replace is one transaction) its undo history. It
would also bounce back through `edit()` and re-dirty the buffer that had just
been saved.

Options were: sync the two views properly (a real CodeMirror collab-style
setup, for a case nobody asked for), refuse to open the document twice, or
open it and make the second copy honest.

**The second copy is read-only, and the pane header says "already open in the
other pane".** The Edit button is disabled while it is the same document; the
Reference button is lit. Nothing is lost — it is still a live view of the same
buffer, so it shows the other pane's typing as it happens, which is what a
second look at chapter one *while writing chapter twelve* actually wants.
That is also what the primary pane's `⫲` button now does and says, since the
document it can offer the split is by definition the one it is already
holding. Two **different** documents, both editable, is what "Open in Split
View" on a sidebar row gives you.

Read-only means read-only, not a CSS trick. The old implementation was
`pointer-events: none` on `.cm-content`, which a keyboard walks straight past.
The editors now take a `readOnly` prop that adds **both**
`EditorState.readOnly.of(true)` and `EditorView.editable.of(false)` — either
one alone still leaves a door (a paste handler, a drop, an IME commit). It is
read at mount and the pane is keyed by `path|mode`, so flipping the toggle
remounts: a document that stops being editable should also lose the undo
history that belonged to editing it.

### 25c. The active pane owns the toolbar

There is one editor toolbar for the window (§1's top bar), so exactly one pane
may drive it. It used to be the primary, unconditionally — right when the
second pane could not be typed in, wrong the moment it could.

`splitStore.active` is now the answer. A pointer-down or a focus anywhere
inside a pane claims it (`onPointerDownCapture` / `onFocusCapture` on the
`<section>`), selecting a file in the sidebar claims the primary, and opening
the split claims the secondary — you asked for that document, so that is where
you are. `useToolbarContext(kind, path, pane, readOnly)` publishes to
`toolbarStore` only while `active === pane`, and a reference pane never
publishes at all.

The hand-off is safe because React runs **every effect cleanup in a commit
before any effect setup**: the pane losing the row clears it before the pane
gaining it writes, so there is no ordering in which the toolbar ends up blank
or owned by the wrong document.

`formatBus` needed no change. It has been keyed by path with a stack per path
since the popouts landed, and `EditorToolbar` already sends to
`formatBus.target(toolbarStore.path)`. Two panes on two paths are two entries;
the toolbar's path is the active pane's path; the command lands where the
caret is. The one addition is negative: **a read-only view does not register**,
so ⌘B can never be delivered to a pane that cannot accept it.

The screenplay's lit element pill follows the same flag — `onElement` writes to
`toolbarStore` only from the pane that drives the toolbar.

Footer stats did not need routing. Each pane renders its own footer over its
own buffer, which is strictly better than one shared readout that has to guess.

### 25d. The divider is a grid track, not a flexbox

`.mw-split-host` was `display: flex` with two `flex: 1` children. It is now a
grid whose template is written by `MainWindow`:

```
`${left}px 1px minmax(0, 1fr)`
```

That shape is the **whole-pixel metrics contract** (§1a) applied to a
draggable divider. `left` is an integer computed once per resize from the
persisted ratio; the divider gets its own 1px track (the shared
`shell/Splitter`, the same component the sidebar and right pane use, with its
7px hit area and hairline-to-accent hover); `1fr` takes the integer remainder
of an integer container. No transform, no percentage width, nothing fractional
reaches `.cm-content`. Even the too-narrow fallback is `Math.floor(available /
2)` rather than `1fr 1px 1fr`, because an odd remainder split by two `1fr`
tracks hands each pane a half pixel.

Persistence follows the shellStore idiom exactly: one localStorage key,
**`aquarius.split.ratio`**, holding the primary pane's share, clamped to
0.1–0.9 on read and rounded to four places on write. Each pane is clamped to
**320px** minimum during the drag (`SPLIT_MIN`, the same number
`EDITOR_MIN` uses for the whole editor column), and double-clicking the
divider resets to 50/50 through `Splitter`'s existing `onReset`.

The active-pane cue is a 2px accent line drawn on `.mw-pane::before`, not a
border: a border would move the document two pixels every time focus changed,
which is the exact class of jitter §1a exists to prevent.

### 25e. Doors in, and the chrome that does not come with them

- **Sidebar row ⋯ → "Open in Split View"** (files only, not folders) — the
  Swift row-menu item from SWIFT-AUDIT §1.4. Opens the document **editable**
  and switches to the editor view, since the split only exists there.
- **`⫲` in the primary pane header** — a second view of the document you are
  in, which is the read-only case of §25b. Its tooltip now says so.
- **A wiki-link clicked in the split pane navigates the split pane.** In the
  primary it still moves the window's selection, exactly as before. `NoteEditor`
  takes an `onNavigate` that defaults to the old behaviour; the split passes
  its own opener, through a ref because the handler is baked into the
  CodeMirror extension at mount.
- **No duplicate chrome in the secondary pane** (the Swift rule). It does not
  get the chapter rail, the scenes rail, the Outline/Cards buttons, the
  screenplay Preview button, the backlinks list, the pop-out button, its own
  split button, or a second copy of the path — the slim pane header already
  carries the path, the mode toggle and the close button. What it keeps is the
  save badge, because that is about the document and not about the window.
- **Viewers stay viewers.** An image, PDF, HTML or video in the split renders
  through the same read-only components as in the primary; `readOnly` is not
  even threaded to them because there is nothing there to disarm.

A trashed file now closes the split as well as clearing the selection
(`vaultStore.removeFromTree`) — a pane left holding a deleted path is an
editor writing to nothing. Rename and move already followed the split; that
was wired when `applyRelocation` was written.

### 25f. What this did not do

- **The editor column does not widen when the split opens.** `MainWindow`'s
  ResizeObserver still defends one `EDITOR_MIN` (320px) for the whole column,
  so opening a split in a narrow window cramps both panes rather than pushing
  the sidebar or right pane out of the way. The divider clamp handles it
  gracefully (§25d's floor-half fallback) but Swift's behaviour here has not
  been checked.
- **No shortcut opens or closes the split.** The doors are the ⋯ menu, the
  `⫲` button and the header's ✕. ⌃⌘E is still unbound and still means what it
  meant — nothing, in this port; collapsing the editor pane remains PARITY
  row 1's leftover.
- **The split is not persisted across launches.** Which document is beside
  the primary is session state, like the selection; only the *ratio* survives.
  Swift's behaviour here is unverified.
- **Nothing bench-verified on Linux.** Everything below wants a real run on
  the AquariusOS bench: the divider drag under WebKitGTK (the caret in *both*
  panes after a drag, per §1a), the accent line at both themes, focus
  hand-off with a trackpad and with Tab, an autosave firing in one pane while
  the other is being typed in, and the conflict dialog raised against a
  document that is open in the split.
