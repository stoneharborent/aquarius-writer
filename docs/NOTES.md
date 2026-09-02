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

##### Addendum, 2026-08-31: the follow-up landed, and it split the token in two

**Courier Prime is bundled** — `src/fonts/courier-prime-{,bold-,italic-}latin{,-ext}.woff2`,
six slices, SIL OFL 1.1 with `LICENSE-CourierPrime-OFL.txt` beside them, from
the same `fonts.googleapis.com/css2` source as the other four families (v11).
Registered as **"AQ Courier Prime"** per the `AQ `-prefix rule.

One token became two, because they were never one job:

| token | is | leads with |
|---|---|---|
| `--font-screenplay` | **the page** — the paged canvas, the print-preview overlay, the Title Page tab, the scenes rail's slug chips | `AQ Courier Prime`, on **every** platform |
| `--font-mono` | **the chrome** — keycaps, rail numbers, footer badges, the terminal | `AQ JetBrains Mono`, on every platform |

Both leads are bundled, so neither surface resolves differently on the two
engines any more. The chrome change is the smaller half but it is the same fix:
Ice and Midnight used to draw their keycaps in Courier New on a Mac and DejaVu
Sans Mono on Linux, where AquariusOS had always drawn JetBrains Mono.

**The 0.6em assertion, checked rather than assumed.** `screenplay-metrics.ts`
sets `CHAR_PT = 7.2` — 0.6 × 12pt — and every column count in
`fountain-pages.ts` is `floor(width / 7.2pt)` on that basis. Measured out of
these exact files with fontTools: `unitsPerEm` is **2048** and every glyph in
all three faces has one advance, **1228**.

```
1228 / 2048 = 0.599609375 em     (0.6 × 2048 = 1228.8, rounded down)
```

So the advance is 0.6em rounded onto Courier Prime's own grid, 0.00039em short
— and short is the direction we want. At the 16px base line box a full-width
60-column action line paints **575.625px** inside a text column that is exactly
**576px** (verified in the browser, not calculated: `getBoundingClientRect` on a
60-glyph run in the loaded face). An advance of exactly 0.6em would paint
576.000px into a 576px box and sit on the knife edge where one device pixel of
rounding wraps the last glyph and desynchronises `wrapRows` from the paint.
**If the face is ever swapped, re-run that check**: the column model is only
correct while `60 × advance ≤ 576px`.

Roman, bold and italic are all bundled — bold is the cue and the slug, italic
is the parenthetical and the synopsis, and a synthesised weight or oblique has
different metrics again. Bold-italic is deliberately not bundled: no screenplay
element asks for both. The character cue's weight moved 600 → **700** at the
same time, because 700 is a real file and 600 was a synthesis request.

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

---

## 26. The terminal pane — a real PTY, and where the agent actually runs

*2026-08-31. PARITY row 18, the last item in Wave 3, deferred on purpose until
the layout settled. Files: `src-tauri/src/pty/mod.rs`, five commands in
`commands.rs`, `src/lib/pty.ts`, `src/state/terminalStore.ts`,
`src/components/terminal/{registry.ts,TerminalPane.tsx,TerminalPane.css}`, plus
additive wiring in `shellStore`, `RightPane`, `MainWindow`, `TopBar`,
`CheatSheet`, `Settings` and one shortcut in `App.tsx`.*

### 26a. What it is for

The MCP server (§23) gave an external agent a door onto the vault, and Settings
prints the `claude mcp add …` line that opens it. What was missing was
somewhere to *run* the agent. That is this pane, and the whole flow is one
sentence: **open the terminal, type `claude`, and it drives the vault over
MCP** — in the app, in the workflow's own folder, with the manuscript beside
it.

This is the deliberate opposite of the thing Stage 5 cut. There is still no
embedded model, no chat panel, no second copy of the writer's files. The app
supplies a shell; the writer supplies the agent.

### 26b. Sessions map one-to-one onto PTYs, and the split that matters is
config vs process

Swift's terminal (SWIFT-AUDIT §2.7) has named session tabs, so this one does
too. Each tab is exactly one pseudo-terminal:

```text
  tab "Angel"  ──►  session id "t1m3x…"  ──►  one PTY  ──►  one login shell
```

The id is made up by the **renderer**, not by Rust, because the tab outlives
the process by design. Rust's `PtyState` is a `HashMap<String, Session>` of the
ones running *now*; the renderer's `localStorage` holds the ones that exist at
all.

What persists (`aquarius.terminal.sessions`, `aquarius.terminal.active`):

* the tab's **name** (default: the workflow's title, as in Swift),
* its **font size** (integer px, 9–24, stepped by the A− / A+ pair),
* its **startup command**,
* which tab was active.

What never persists: the PTY, the scrollback, the exit code, the cwd, the
"live" dot. A relaunched app shows its saved tabs **cold**, with an idle dot,
and spawns a shell for the one you look at. The alternative — restoring a tab
as though it were still connected — puts a dead prompt on screen that silently
swallows what the writer types, and there is no honest way to draw that.

Sessions are launched **lazily and only for the visible tab**: four saved tabs
should not mean four shells the moment the pane opens.

### 26c. Two threads per session, and the second one is the reaper

```text
  pty_spawn ─► openpty ─► shell -l ─┬─► reader thread ─► pty://output
                                    └─► waiter thread ─► pty://exit
```

* The **reader** blocks on the master fd and ends at EOF — which the kernel
  only delivers once the last slave handle is closed, which is why the parent's
  copy of `pair.slave` is dropped immediately after the spawn. Forget that drop
  and a shell that exits leaves a reader blocked forever.
* The **waiter** blocks in `Child::wait()`. This is not bookkeeping, it is the
  zombie reaper: a killed child nobody waits on stays in the process table for
  the life of the app, and a writer who opens and closes ten terminals would
  leave ten of them. `wait()` needs its own thread precisely because a kill can
  arrive while it is blocked — that is what `portable_pty`'s `clone_killer()`
  is for, and why the `Session` holds a killer rather than the child.

Kills happen at three doors and all three go through the same code: closing a
tab (`pty_kill`), replacing an id (`HashMap::insert` drops the old `Session`,
whose `Drop` kills), and the window being destroyed (`PtyState::clear()` in the
`WindowEvent::Destroyed` arm, next to `mcp::stop`).

### 26d. UTF-8 does not respect a read boundary

A PTY read lands wherever it lands, including the middle of an em dash or a
box-drawing rule in someone's prompt. Decoding each 8 KiB chunk on its own
turns that into a replacement character **permanently** — the two halves never
meet again. So `Utf8Chunker` holds the tail of an incomplete sequence and
prepends it to the next chunk, while *genuinely* invalid bytes are replaced and
dropped so a binary file dumped to the terminal cannot wedge the decoder. Three
unit tests cover the three cases.

The alternative was shipping `Vec<u8>` over the event bridge, which Tauri
serialises as a JSON array of numbers — several times the bytes, for a problem
15 lines of Rust solves properly.

### 26e. The xterm instances live outside React

A terminal is not a view; it is a running process with scrollback, and the pane
it lives in collapses. If the `Terminal` were owned by a component, hiding the
right pane — ⌘⌥\, or just clicking Comments — would dispose it and take a
running `claude` session with it.

So `registry.ts` holds a module-level `Map<id, {term, fit, el, …}>` and the
component only **borrows**: on mount it appends the entry's element to its
host, on unmount it hands the element back to an off-screen parking lot. Only
closing the tab calls `dispose()`. Two consequences worth naming:

* Output keeps arriving into a terminal whose element is not on screen. xterm
  buffers it as scrollback, so re-opening the pane shows what happened — the
  same as switching away from a terminal window.
* The parking lot is a real, sized, off-screen div rather than a floating
  element, because xterm measures a character cell by rendering into the DOM
  and `open()` on something never laid out yields a zero-sized cell. Nothing
  fits to the parking lot: `safeFit()` is only ever called by the mounted view,
  and it refuses to run on a box under 8px either way — a `fit()` against a
  hidden div would drive the PTY to a 1×1 grid that the shell then really
  redraws into.

Font sizes are integers only, per §1a. A fractional cell grid is exactly the
kind of half-pixel geometry that contract exists to forbid, and on a terminal
it is visible immediately.

### 26f. The startup command is typed, not spawned

Swift calls this the "agent command" and lets you set an executable plus args.
Here the shell is always the process and the command is **typed into it** after
a 300 ms delay. That is a deliberate difference and it is better for the flow
this pane exists for: when `claude` quits you land at a prompt in the right
directory, instead of the tab dying under you.

It also means a startup command is **executable content**, so the store says
plainly where it may come from: the gear button in the pane header and nowhere
else. It is never read out of a document, a vault file, or the MCP server, and
it is not synced. The delay is about not interleaving with the shell's own
startup output rather than about losing bytes (the kernel buffers the write) —
it is the one timing-dependent thing here and it is on the bench list.

### 26g. Drag a file, get its path

The sidebar's tree rows have set `dataTransfer.setData("text/plain", node.path)`
since the move/reorder work, so nothing had to be coordinated: the pane accepts
a plain-text drop, sends the vault-relative path to `pty_resolve_path`, and
types the absolute answer with a trailing space, ready for a command in front
of it. Paths needing it are shell-quoted.

`pty_resolve_path` goes through `paths::resolve_in_root` like every other path
command, so it is also the safety check — a crafted drag cannot name a file
outside the workflow. A path that will not resolve is simply not typed; the
ring going away is the whole answer a drop needs.

### 26h. Where it lives, and why not a fourth column

It is the **right pane's third tab**, beside Comments and Versions. Swift has
one right-pane slot and everything takes turns in it (SWIFT-AUDIT §1.3), and a
dedicated bottom drawer would have meant a second resizable axis, a second
persisted geometry and a fight with the editor's 320px floor.

So: `RightTab` gained `"terminal"`, ⌘⌥\ cycles comments → versions → terminal →
hidden, the TopBar gained a third button, and the collapsed gutter now names
the tab that will come back rather than always saying "Comments". **⇧⌘J**
toggles straight to it — the terminal is the one tab a writer reaches for
mid-thought, three presses of ⌘⌥\ is not that, and J was completely unbound in
this app (it is also the muscle memory from VS Code's terminal drawer).

The pane draws two header rows: the shared Comments/Versions/Terminal row from
`RightPane`, and its own session strip under it. That costs ~28px and buys the
way back out.

### 26i. Security posture, stated rather than implied

**The pane runs the writer's own login shell, as the writer, with the writer's
environment and privileges.** Exactly what Terminal.app or GNOME Console would
give them, in a pane. No sandbox, no elevation, no `sudo`, no setuid, nothing
remote: a PTY is reachable only through this process's own Tauri commands,
which only this app's webview can call.

That is the *point* — an agent that could not read the writer's files as the
writer would be no use — and the cost is written down rather than left to be
discovered: **anything typed into this pane runs**, and a session's startup
command is therefore executable content with exactly one author (§26f).

Two things that did **not** change, and should stay that way:

* **The capability file.** The PTY is our own Rust code, so nothing was granted
  to `tauri-plugin-shell` and no scope widened. `pty://output` and `pty://exit`
  are covered by the listener permission already inside `core:default`, the
  same way `updater://state` is.
* **`-l`, and only for shells that know it.** A login shell is what sources
  `.zprofile` / `.bash_profile`, which is where `PATH` picks up Homebrew,
  `~/.local/bin` and nvm — i.e. where `claude` actually is. Without it the
  marquee flow fails with "command not found" on a machine where the command
  plainly exists. `login_args()` returns `-l` for zsh/bash/fish/sh/dash/ksh and
  nothing for anything else.

### 26j. Workflow switching is answered, not silently obeyed

A new session spawns in the current workflow's root. A session that is *already
running* does not get moved: killing a live `claude` because the writer clicked
another workflow in the sidebar would be the worst possible reading of "auto-cwd
to the active workflow".

Instead the status line says where the shell actually is — `in Angel — restart
here` — and the button next to it kills that shell and starts a fresh one in
the current workflow, keeping the old screen so the writer can still read what
it said. Same treatment for a shell that exited on its own: an honest `exited`
dot, the exit code written into the screen, and a **Relaunch** button.

### 26k. What this did not do

* **No shell-integration niceties.** No cwd tracking after a `cd`, no command
  detection, no OSC 7 / OSC 133 handling. The status line reports the directory
  the shell *started* in and says nothing about where it went.
* **No search, no link detection, no clickable paths in the output.** Those are
  xterm addons and each is a dependency; none is needed for the flow this pane
  exists for.
* **No MCP tool.** The repo's doctrine is "if a human can do it in the app, an
  MCP client can do it too", and this is the one place it must not hold: a
  `run_command` tool would hand every connected agent a shell on the writer's
  machine, which is a far larger capability than anything else in the catalogue
  and is not what the writer opted into when they enabled the server. The pane
  is a door for the *writer*, not for the agent. Stated here so the omission
  reads as a decision rather than an oversight.
* **No session restore.** See §26b — deliberate.
* **Windows is untested.** `portable-pty` covers ConPTY and `default_shell()`
  falls back to `COMSPEC`, but nothing on that path has been run.

### 26l. Bench checklist (Linux, and the parts of macOS not covered by tests)

`cargo test` covers the pipe itself — a real spawn/echo/kill round trip
(`spawn_echo_kill_round_trip`), the chunker and the shell fallbacks. Everything
below is a real run:

- **WebKitGTK rendering.** xterm's canvas renderer under WebKitGTK at both
  themes; glyph crispness at 9px and at 24px; the cell grid staying on whole
  pixels after a splitter drag.
- **The startup delay** against a slow `.zshrc` — does `claude` still land
  cleanly, or does it interleave with the shell's banner? 300 ms is a guess
  made on a fast Mac.
- **`claude` end to end**: run it in the pane, have it connect to the MCP
  server, and watch a vault edit land in the editor beside it.
- **Resize behaviour**: drag the right-pane splitter while `htop` or `vim` is
  running and check the child gets SIGWINCH and redraws.
- **Drag-and-drop** from the sidebar onto the pane under WebKitGTK — the tree's
  drag is HTML5 (§18a), so this should work, but it has not been watched.
- **Zombies**: open and close ten tabs, then check `ps` for defunct children.
- **Quit with a live shell** and confirm nothing survives the window closing.

---

## 27. The screenplay is paged now, and the pages are arithmetic

*PARITY row 12, closed 2026-08-31. SWIFT-AUDIT §2.1: "industry-exact page
geometry … a paged canvas with real page breaks … Title Page as a second tab
on the same file … drag-reorder scenes rewrites the script … smart-type
autocomplete for character names and scene headings."*

Four things shipped and two were deferred. Only the first is interesting, and
what makes it interesting is that **nothing in it is measured**.

### 27a. Why the pages are not elements

The obvious way to draw a paged screenplay is a `<section>` per page. It is
also the way that cannot work here, twice over:

- **One document, or nothing works.** CodeMirror holds a single `EditorState`.
  Splitting the script into a view per page would take undo, Find & Replace,
  the caret, the smart-typing rhythm, the element pills, the zoom registration
  and the scene rail's scroll with it. Every extension in the tree assumes one
  document, because there is one document.
- **A measured overlay drifts.** The other approach — one continuous editor
  with absolutely-positioned page sheets painted behind it, their tops read
  off `coordsAtPos` — has to re-measure on every keystroke, every resize,
  every font load and every zoom step, and it is wrong for one frame each
  time. On WebKitGTK, where §1a's whole story is that measurement and paint
  disagree, "wrong for one frame" becomes "wrong until something else forces
  a re-layout".

So the pages are **a repeating background gradient on `.cm-content`**, and the
document is padded so that it lands on them. No `getBoundingClientRect`
anywhere in the feature.

### 27b. The arithmetic, and why it is exact

`src/lib/markdown/screenplay-metrics.ts` holds the geometry. The point values
are SWIFT-AUDIT §2.1's, unchanged: a 612×792pt page, a text block from 72pt to
720pt, Courier 12 on 12, and element blocks at 108→540 (action, scene, shot),
252→522 (character), 216→396 (parenthetical), 180→432 (dialogue), with
transitions right-aligned ending at 510.98pt.

Everything derives from **one integer**: the line box in pixels.

```
line  = round(16 × zoom)          16 = 12pt at 4/3
u(pt) = round(pt × line / 12)
```

Every *vertical* point value in the format is a multiple of 12, so `u()` on it
is an exact integer multiple of `line` and never actually rounds:

| | points | in lines | at line = 16 |
|---|---|---|---|
| page height | 792 | 66 | 1056px |
| top / bottom margin | 72 | 6 | 96px |
| body | 648 | **54** | 864px |
| page width | 612 | 51 | 816px |
| left / right margin | 108 / 72 | 9 / 6 | 144 / 96px |

`6 + 54 + 6 = 66` and `9 + 36 + 6 = 51` hold at *every* rung of the zoom
ladder — 13, 14, 16, 18, 20, 22, 26, 29 — which is the property the whole
design rests on. §1a said a fractional line box is the caret bug; this section
says a page whose parts are rounded independently is the same bug wearing a
sheet of paper.

**On 4/3 rather than 1/1.** The Wave-3 brief said "1pt = 1px at baseline
zoom". CSS defines a point as exactly 4/3 of a pixel — a point is 1/72", a CSS
pixel is 1/96" — so 1pt = 1px is not the identity, it is a 25% shrink, and it
puts the writer on a 12px line box. At 4/3 the page is 816×1056: a US Letter
sheet at 96dpi, exactly, with 16px Courier set solid, which is what 12-on-12
*is*. The print-preview overlay still draws at 1pt = 1px, because that sheet
is a picture of the PDF rather than a surface to write on. The row model is
scale-free, so both read their page breaks off the same engine.

One consequence worth knowing before it surprises anyone: **a page is 816px
and does not reflow.** Beside both the sidebar and the right pane on a 1440
screen that is about 40px too wide and the article scrolls sideways, the way
Final Draft does. The 90% rung is a 714px page and fits everywhere, and the
zoom is remembered per document. Reflowing instead was never an option: a
narrower column wraps at a different number of characters than the engine
counted, and then every page below drifts off its sheet.

### 27c. The pagination engine, and the double-count it replaced

`src/lib/markdown/fountain-pages.ts`. The old `estimatePages` was honestly
named: it added a `SPACE_BEFORE` allowance of one or two virtual blank rows
before scene headings, action and character cues — **on top of** the blank
lines the Fountain source already contains, which it was also counting. Every
scene heading in a script cost three or four rows instead of one, and the page
count ran long by a third on a dialogue-heavy script. Nobody noticed because
nothing depended on it but a footer badge.

The engine's rules, in full, are written out at the top of the file. The short
version:

1. **A page is 54 rows**, from the geometry. Not "about 55".
2. **A row is a wrapped visual row of one source line**; a blank line is one
   row. Wrapping is greedy word wrap at that element's column count — 60
   action, 37 character, 25 parenthetical, 35 dialogue, all `floor(width /
   7.2pt)` — which is what the browser does to `pre-wrap` text in a box of
   exactly that many monospace glyphs.
3. **Nothing is added for element spacing.** Fountain's blank lines *are* the
   spacing and they are already in the document.
4. **A break falls between source lines**, never inside one.
5. **Orphan control moves a break earlier, never later**: a page may not end on
   a scene heading, a heading and its blank, a character cue, or a cue and its
   parenthetical.
6. **Blank lines at a break stay on the page above**, so a page never opens on
   a blank row.
7. **`fill` = `54 − used`, and it is signed.**

Rule 7 is the one that was wrong first. Rule 6 can leave a page at 55 or 56
rows — the extra rows are blank and sit invisibly in the bottom margin — and
clamping `fill` at zero looked completely harmless. It walks every page below
down by one line box per absorbed blank, and by page six the text is a third
of a page off the sheet it is printed on. The padding is clamped at zero in
CSS; the row count is not.

Rule 2 has one detail that is *checked* rather than assumed: `lineWrapping`
sets `overflow-wrap: anywhere` on `.cm-content` (plus `word-break: break-word`
for Safari), so an over-long word is chopped rather than overhung, and
`wrapRows` chops it at the same place.

### 27d. Where the padding goes

Three numbers, and between them they close every sheet:

- **`.cm-content` padding-top** = the top margin. `background-origin` is
  `padding-box`, so the gradient's zero is page 1's top edge.
- **Each page-break line** is a line decoration carrying
  `style="--sp-fill:N"` — a *unitless row count*, not a length, so the CSS
  multiplies it by the line box and the value survives a zoom without a second
  rounding. Its padding-top is
  `fill·line + bottom margin + desk gap + top margin`, which closes the sheet
  above at exactly `--sp-page-h` and drops the next line exactly one top
  margin below the next sheet's edge.
- **`.cm-content` padding-bottom** = `tailrows·line + bottom margin`, written
  on the host element by the editor from the same pagination result. Without
  it the last page stops mid-sheet.

The page number is the break line's `::before`, absolutely positioned 0.5"
below the new sheet's top edge and flush right — which is where `right: 0`
already is, because a line element spans the text column. It contributes no
layout, so it cannot disturb the grid.

**The grid had to be set solid for any of this to work.** Every element
padding-top in `fountainTheme` is gone: scene 18px, character 9px, transition
15px, section 15px, and the 2px per-line gap. The scene heading's rule is now
an inset `box-shadow` rather than a `border-bottom`, because a border is 1px of
layout. A screenplay line is one line box tall, always. The same double-count
was removed from `ScreenplayPreview.css`, which had the visual half of it.

If a future change adds one pixel of vertical padding inside `.cm-content`,
the symptom will be text sliding off the sheets, further with every page. That
is the thing to look for.

Two CodeMirror base-theme rules had to be beaten, and both would have been
mystifying:

- `.cm-content { flex-grow: 2 }` — the content is a flex item in
  `.cm-scroller`, and flex-grow overrides `width`. The page needs `flex: none`
  or it stretches to the pane.
- The base `.cm-content` selector has the same specificity as
  `.screenplay-editor .cm-content`, and the injection order of a StyleModule
  against a Vite-injected stylesheet is not ours to decide. The page rules use
  `.screenplay-editor .cm-editor .cm-content` so they always win.

The sheet is centred with `margin: 0 auto` on the content and the host is a
plain block — not a flex row with `justify-content: center`, which would
overflow both ways at narrow widths and put the binding margin somewhere the
scrollbar cannot reach.

### 27e. The Title Page is a page, and it writes the title block

`Script` / `Title Page` is a tab pair on the document header. The tab renders
a real sheet — the same `--sp-*` tokens, the same size, the same zoom — with
the six fields where a title page puts them, each an input that only looks
like an input once the caret is in it. A labelled settings form would have
been the one place in the app where a document is edited somewhere other than
on its page.

What it writes is the **Fountain title block** at the top of the same file.
No frontmatter is involved and none is created: a `.fountain` file's metadata
is its title block. It goes back through `editorStore.edit` like a keystroke,
so it debounces, snapshots and conflict-guards identically.

`parseTitleBlock` / `mergeTitleEntries` / `withTitleBlock` in
`src/lib/fountain.ts` carry two rules the writer never sees but would notice:

- **Unknown keys survive, in place, with their own spelling.** Writers put
  `Copyright:`, `Notes:`, `Revision:`, `WGA:` up there. The form edits six
  fields and leaves everything else exactly where it found it. A key the file
  already has keeps its position; a new one is inserted where the canonical
  order says it belongs among the known keys, so a first `Title:` lands at the
  top and not under someone's copyright line.
- **A field is removed by emptying it.** An `Author:` with nothing after it is
  a title page with a blank line on it, which is not what anyone meant.

Continuation lines (an indented address under `Contact:`) are joined with a
newline rather than a space, and written back out indented. `splitTitlePage`
is now a thin wrapper over the same parser, so the preview overlay and the
popout cannot disagree with the form about where the block ends.

**The script editor is hidden, not unmounted, by the tab switch** — unmounting
would take the undo history, the caret and the zoom registration with it. That
buys one obligation back: everything in a `display: none` subtree measures as
zero, so the pane that un-hides it calls `requestMeasure()`. That is §1a's
failure mode arriving by a new road.

### 27f. Scene drag-reorder, and the file it deliberately mirrors

The rail's rows are draggable and slide into place — the gap the scene will
land in opens before the writer lets go. The chapter rail draws an insertion
bar instead; a scene is a *block* of script, and the writer is choosing where
the block lands, not where a line goes. Only a `transform` moves, so it
composites, and the list order is untouched until the drop.

The rewrite is `src/lib/markdown/fountain-scenes.ts`, and it is **a deliberate
mirror of `src-tauri/src/vault/fountain.rs`** — the same operation reached
through two doors, the writer's drag and the MCP `reorder_scenes` tool. A
script that came out differently depending on which one moved the scene would
be a genuinely unpleasant surprise. The Rust file is the reference; change it
first, then mirror. Its two hard-won rules come across intact, and both have
tests on the Rust side:

- **Nothing above the first heading moves** — the title block and any opening
  `FADE IN:`.
- **A moved last scene gets the blank line a heading needs.** The last scene
  in a script has no trailing blank of its own, so moving it anywhere but the
  end would glue the next heading onto the line above and that heading would
  stop being a heading. One blank is inserted only where that would happen,
  which keeps an identity permutation byte-identical.

One asymmetry is inherited on purpose: the Rust scanner matches slug prefixes
case-insensitively and the renderer's `SCENE_HEAD_RE` does not. This module
follows the **Rust** rule, because the rail must be able to drag every scene
the tool can see. A permutation that is not a permutation is refused whole
rather than half-applied.

The result goes back in through the pane's normal body edit, so the rewrite is
one ⌘Z away and one conflict-guarded save away.

### 27g. Smart-type

`src/lib/markdown/fountain-complete.ts`, on `@codemirror/autocomplete` — the
same mechanism as the `[[` completion (§22a), including the `override` source
so nothing inherited can appear in the popup, and the popover themed in tokens
as chrome. It sits before the Fountain keymap in the extension list;
`autocompletion`'s own keymap is `Prec.highest`, so ⏎ accepts a highlighted
name when the popup is open and falls straight through to the Final Draft
Enter rhythm when it is not.

Two sources behind one entry point, chosen from the caret's position so a
character name can never be offered where a slug belongs:

- **Character cues**, on a line that is a cue *position* — blank line above,
  nothing but a name on it, nothing after the caret. Every character who has
  spoken, **most recent first**, because the person who just spoke is
  overwhelmingly the person about to. A `(V.O.)` extension and the `^` dual
  mark are stripped from the offered name.
- **Scene headings**, once a line has started one: the locations the script has
  already used with that prefix, ranked by recency, then the bare slug
  prefixes below them so a brand-new location still gets its slug free.

The vocabulary is read off the document on each request rather than cached. A
screenplay is one file, the pass is the same `classifyLines` the decorations
already run, and a cache is one more thing that can disagree with the buffer.

### 27h. What was deferred, and why one of them is not a styling job

**Dual dialogue** (`CHARACTER ^` rendering two speakers side by side) and
**revision marks** (a `*` in the margin on changed lines) did not ship.

Revision marks are simply not started — they want a revision *set* stored per
draft, which is a document-model question, not a rendering one.

Dual dialogue is the one worth writing down, because it looks like CSS and is
not. The paged canvas is built on **one source line is N grid rows, and rows
are the only thing that exists**. Two dialogue blocks sharing a horizontal band
break that: six source lines occupy three rows, the rows are not in document
order, and the pagination, the page fill, the sheet gradient and the caret's
height map all disagree at once. Doing it properly needs a real column
primitive — a block-level widget decoration holding both speakers, with its own
height contributed back to the row model — and widget decorations are exactly
what wedged CodeMirror's viewport updates in this nested-scroll embed the last
time (which is why the page breaks are line decorations). It is a wave of its
own, not a rule in `fountainTheme`.

### 27i. What this did not do

- **No caret-anchored zoom.** §22f parked it here; it is still parked. The type
  and the page scale together correctly, but the line under the cursor does not
  stay under the cursor.
- **The compile path is unchanged.** The screenplay PDF is still a Courier
  reader PDF at WGA margins (§19f) rather than a paginated one. The engine that
  would fix it now exists and is shared; wiring it into `compile::run` is a
  separate change.
- **No `(MORE)` / `(CONT'D)`.** A dialogue block that crosses a page break is
  split without the continuation marks a production draft carries. The break is
  never left on the cue itself, which is the part that would actually confuse a
  reader.
- **Scene numbers are displayed, never assigned.** `#12#` shows in the rail if
  the script has it; nothing generates or renumbers them, and a reorder does
  not renumber either — which is correct, because locked scene numbers are
  supposed to survive a move.
- **The popout still renders the old read-only title-page block** above the
  script rather than offering the tab. It is a second surface with its own
  chrome and was out of scope.

### 27j. Bench checklist (Linux, on top of §1a's and §22e's)

The pagination is arithmetic and was verified as arithmetic — the painted
offset of every page's first line was walked against the gradient's period on a
seven-page script and came out at zero drift, and the metrics were checked for
`6 + 54 + 6 = 66` at all eight zoom rungs. What cannot be checked without a
window:

1. **The sheets actually line up.** Open a script of 4+ pages and scroll to the
   bottom. The last line of every page must sit inside its sheet, and the first
   line of the next must sit one margin below the next sheet's edge. Any drift
   grows with page number, so page 6 is where to look, not page 2.
2. **The same, zoomed.** ⌘+ to 180% and 0.8, and repeat (1). This is the test
   that catches a token that rounds independently.
3. **Click at the bottom of page 5.** §1a's test, on the new grid. The caret
   must land on the character clicked.
4. **Hold ↓ across a page break.** No skipped or doubled lines. The break line
   carries ~200px of padding and is the most likely place for a vertical step
   to land oddly.
5. **A page that absorbed a blank.** Find a break where the page above ends on a
   blank line (`--sp-fill` will be negative in the DOM) and check the next
   sheet still lines up. This is rule 7.
6. **Courier.** The column model assumes a 0.6em advance. If the mono face
   falls through to something else the wrap count is wrong and pages drift —
   confirm the body is Courier (macOS) or the bundled JetBrains Mono fallback,
   and that a full-width action line is 60 characters at the right margin.
7. **Title Page tab, both directions.** Fill all six fields, switch to Script,
   confirm the block is at the top of the file and the script did not move.
   Then add a `Copyright:` line by hand in the script view, return to the tab,
   edit `Author:`, and confirm the copyright line is still there in its
   original position.
8. **Tab round-trip and the caret.** Script → Title Page → Script, then click
   in the middle of page 3. This is the `requestMeasure` in §27e; if it is
   wrong the caret will be badly off after the switch and fine before it.
9. **Drag a scene.** Move scene 4 above scene 2 and confirm the script rewrote,
   ⌘Z restores it, the rail renumbered, and the save badge went dirty → clean.
   Then move the **last** scene up and confirm the heading below it still
   parses as a heading (that is the Rust test that exists because this went
   wrong once).
10. **Smart-type.** Type a blank line then two letters of a character who has
    already spoken — the popup should show them most-recent-first. ⏎ accepts.
    Then type `INT. ` and confirm past locations appear above the bare
    prefixes. Esc must dismiss without inserting, and ⏎ with no popup must
    still do the Final Draft paragraph rhythm.
11. **Narrow pane.** Open a screenplay with the sidebar and right pane both
    open on a small screen. The article should scroll sideways, the left
    binding margin must stay reachable, and nothing should reflow.
12. **Both themes and AquariusOS.** The sheet is `--surface` on a `--bg` desk
    with a `--line` hairline at each page edge; the gap shadow should read as a
    shadow on all three, not as a black band on Midnight.

### 27k. Addendum — Final Draft chrome, and the scroll that was not a renderer problem

*Bench, 2026-08-31, v0.4.0 on AquariusOS: "scrolling still feels sluggish", and
`WEBKIT_DISABLE_DMABUF_RENDERER=1` made no difference. That last part is the
useful half of the report — it rules out the compositor and says the cost is in
**what we paint and what we recompute**, not in how it gets to the screen. Plus
three chrome findings: the sheets did not look like Final Draft, scene headings
were underlined, and ⌘1–⌘7 did not reach the editor.*

Nothing in §27's arithmetic changed. The row model, the 54-row page, the
`u(pt)` conversion, the `--sp-fill` padding and the gradient's period are
untouched, and were re-verified after the change: the painted top of every
page's first line lands at exactly `n × (pageH + gap) + marginT`, with a
constant zero drift across pages.

#### The scroll cost was three whole-document rebuilds per frame

This is the finding, and it is not subtle once it is written down.

`watchAncestorScroll` (`cm-embed.ts`) calls `view.requestMeasure()` on **every
scroll event of the surrounding article**. It has to: both editors are
grow-to-content embeds where the article scrolls, and without that nudge
CodeMirror never re-renders below the initial fold. Every measure that moves
the viewport raises `viewportChanged` on the next update — and three
`ViewPlugin`s were rebuilding their **entire** decoration set on it:

| plugin | what ran, per scrolled frame |
|---|---|
| `fountainDecorations` | `doc.toString()` + `split` + a full `paginate` + `classify` of every line + a `RangeSetBuilder` pass over every line |
| `wysiwygDecorations` | a full `syntaxTree` iteration over the document |
| `wikilinks` | a full regex scan of the document — **and** `collectMarkdown()`, a walk of the whole vault tree, on *every* update, rebuild or not |

None of the three is viewport-scoped. `build()` returns a decoration set for
the whole document in all three cases, and a whole-document decoration set is
**already correct for any viewport** — so a viewport change had literally
nothing to recompute. Dropping the trigger is exact, not an approximation.
NOTES §1 said the wysiwyg restyle was viewport-scoped; it never was. What hid
it on macOS is that nothing there forces a measure per scroll event.

What replaced each trigger:

- `fountainDecorations` and `wikilinks` → `docChanged` only. `wikilinks` also
  compares the vault tree by identity (it is replaced wholesale by the store)
  instead of re-walking it, so a scroll costs nothing at all there now.
- `wysiwygDecorations` → `docChanged || selectionSet || syntaxTree(startState)
  !== syntaxTree(state)`. That third clause is the one that is easy to lose:
  Lezer parses a long document in the background and hands the rest of the tree
  over in an update that changed neither doc nor selection, and rebuilding on
  every scroll used to cover that case by accident.

**The rule for anything added to these plugins:** if the work is O(document),
it belongs behind `docChanged`. If it is genuinely scoped to
`view.visibleRanges`, it may watch the viewport — and then it must.

Two smaller ones in the same family:

- **`paginate` ran twice per keystroke.** `fountainDecorations` wants the break
  positions and their fill; `pageBreaks` wants the page count and the tail
  rows. `paginateDoc(text)` is a one-entry memo on the document text, so the
  second caller pays a string compare. A single entry is the right size — there
  is one screenplay per editor and the question is always "again, for the
  document I just asked about" — and keying on the text means it cannot go
  stale.
- **`pageBreaks` is debounced at 120ms.** Both of its outputs are slow-moving:
  a page count in a footer badge, and the bottom padding of the last sheet
  ninety pages below the caret. Neither can visibly change mid-word, and
  recomputing them inside every keystroke's update cycle put an O(document)
  pass on the typing path. 120ms is under the autosave debounce, so the badge
  is always settled before a save.

#### The paint taxes, which are the same change as the Final Draft look

The two goals turned out to be one edit. Final Draft draws flat near-white
paper, a crisp 1px edge, and **no soft drop shadow at all** — and a soft drop
shadow is precisely what costs a scroll frame.

- **The 14px blurred `box-shadow` is gone from both canvases.** A blur is a
  per-pixel convolution that cannot be cached across the element, so WebKit
  re-rasterises it for every tile a scroll exposes, down both edges, for the
  full length of the document — and `.mw-sheet` (prose) and `.cm-content`
  (screenplay) are single elements as tall as the whole chapter or script.
  Screenplay: a spread-only `0 0 0 1px var(--page-line)` ring, no blur at all.
  Prose: the brief said cap anything over 4px, so the audit's `r14` is now
  `0 1px 3px` — the same shadow at a glance, a fraction of the work.
- **The sheet gradient is all hard stops now.** It carried a 6px
  `rgba(0,0,0,0.18) → transparent` ramp between sheets, which is a real
  interpolation across the full page width, once per page period, per tile.
  It is a 2px solid offset hairline instead. Every band in the repeating
  gradient is now a solid colour-stop pair, so the whole thing rasterises as
  fills. **Keep it that way**: one soft stop here is paid on every frame of
  every scroll.
- **The gradient moved off `.cm-content` onto `.cm-content::before`.**
  CodeMirror mutates `.cm-content` constantly — viewport re-render, caret,
  selection, decorations — and every invalidated rectangle was repainting the
  sheets underneath it. A pseudo-element at `inset: 0` is *by construction*
  exactly the padding box whose origin the gradient already used, so the
  geometry is bit-identical and cannot round apart from the text the way an
  independently-centred sibling layer could.
  Two deliberate non-choices: `contain: layout paint`, **not** `contain:
  strict` (size containment buys nothing when `inset: 0` already gives a
  definite size, and it is the one part of `strict` with a real chance of
  collapsing the layer on an engine that gets the absolutely-positioned case
  wrong); and **no forced compositing** — a `translateZ` layer 100,000px tall
  is a backing store WebKitGTK would rather not be asked for.
  This needs `position: relative; z-index: 0` on `.cm-content`, and the
  `z-index` is load-bearing, not decoration: `.cm-scroller` is `position:
  relative; z-index: 0` in CodeMirror's base theme, so without a stacking
  context on `.cm-content` the `z-index: -1` layer escapes past it and paints
  *behind the desk*, i.e. vanishes.
- **`will-change: transform` came off every scene row.** It was standing on
  `.rail-item.rail-scene` — a permanent compositing layer and backing store per
  row, two hundred of them sitting idle on the same GPU the editor scrolls on.
  It is scoped to `.rail-list.rail-dragging` now, a class the rail puts on
  while a drag is live, so the promotion is in place before the first row
  slides (which `.sliding` alone would not have managed — it arrives with the
  transform) and gone again on drop.

**Swept and found clean:** no `filter`, no `mix-blend-mode`, no
`background-attachment` anywhere in `src/`. The desktop gradient is on `body`,
which has `overflow: hidden` and does not scroll; the scrolling article
(`.mw-prose`) has no background of its own and its children paint a flat
`var(--bg)` desk. The sidebar's `backdrop-filter` was already removed on
2026-08-30. The only other `will-change` is on xterm's screen, where it belongs.

#### The chrome, before → after

| | was | is |
|---|---|---|
| sheet | `--surface` (a theme colour: pale blue on Ice, navy on Midnight, `#10121C` on AquariusOS) | `--page-surface` — paper on every theme. `#FFFFFF` on Ice, `#DFE4EA` on Midnight, `#DCDFE8` on AquariusOS: dimmed so a full-window white page is not punishing on a dark desk, but unmistakably paper |
| ink | `--ink-prose` (Midnight's is a pale blue) | `--page-ink` — `#0B0D12` / `#10141B` / `#0C0E15`. Near-black on every theme, because ink is |
| page edge | a 1px `--line` ring + a 14px blurred shadow | a 1px `--page-line` ring, a 1px hairline at the head **and** the foot of every sheet, a 2px `--page-shadow` offset hairline. No blur |
| desk gap | 24px, with 6px of blur ramp eating into it | 24px of flat desk |
| page number | `--font-mono`, `--ink-mute` | `--font-screenplay` (Courier Prime), `--page-ink-soft`, same place: 0.5" down, flush right, inside the margin — where Final Draft puts it |
| scene heading | bold caps **+ an inset `box-shadow` rule under it** | bold caps. Nothing else — see below |
| character cue | weight 600 | weight **700** (a real file rather than a synthesis; FD sets cues bold) |
| parenthetical / synopsis | `--ink-soft` | `--page-ink-soft` |
| `#` section / `=` synopsis colour | `--accent` (Midnight's electric cyan, illegible on paper) | `--page-accent`, one steel blue for all three themes. These are notes to the writer, not script |
| Title Page sheet | `--surface`, 14px blur | the same paper tokens as the script's sheets, 2px offset hairline |
| preview overlay | `--font-mono`, 14px blur, `--ink*` on a `#fff` page | `--font-screenplay`, 2px offset hairline, ink literals. It stays a literal white page: it is a picture of the printed PDF, not a writing surface |
| prose sheet | unchanged look, `0 1px 14px` | unchanged look, `0 1px 3px` |

**One cosmetic compromise, recorded so nobody rediscovers it as a bug.** The
1px ring runs continuously down the left and right of the *stack*, including
alongside the desk gaps, rather than closing each sheet individually. Per-page
side rails need a second background layer that a single vertical gradient
cannot clip to the sheet bands, and a bound stack of pages is what it reads as.
The sheets' own top and foot hairlines are in the gradient and are per-page.

#### The spacing audit against Final Draft

Royce: *"spacing is all off."* Audited, and the grid itself was already right —
what was wrong was one decoration and one weight. What was checked, and what it
was checked against:

1. **Set solid.** `font-size == line-height == --sp-line` in `fountainTheme`,
   `.cm-line { padding: 0; margin: 0 }`. Verified in a browser against the
   built CSS: a dialogue row measures exactly **16px**, a wrapped action line
   exactly **32px**. Single-spaced Courier, as FD.
2. **No element padding-top survives anywhere.** §27 removed scene 18px,
   character 9px, transition 15px, section 15px and the 2px per-line gap from
   `fountainTheme`, and the matching 24/12/12px from `ScreenplayPreview.css`.
   Re-checked both files and every theme block: none has come back, and no
   `[data-theme]` rule reaches into `.cm-fnt-*`. Fountain's blank lines are the
   spacing; they are in the document and they are counted as rows.
3. **Scene headings get no extra top space.** They are one line box tall like
   everything else. The blank line above a slug in a script is a blank line the
   writer typed.
4. **THE UNDERLINE IS GONE.** Final Draft does not rule a scene heading — a
   slug is bold uppercase Courier and nothing else. This port drew one from the
   beginning (a `border-bottom`, which §27 converted to an inset `box-shadow`
   because a border is 1px of layout). Removed from `fountainTheme`; there was
   never one in `ScreenplayPreview.css` or anywhere else — `.sp-scene` is
   `font-weight: 700` and no more — so this was the only site.
5. **Weight is FD's.** Bold on scene headings, character cues and transitions.
   Action and dialogue are regular. Nothing else is emphasised.
6. **Horizontal geometry unchanged.** 60 / 37 / 25 / 35 columns off the point
   margins, and the text column measured at exactly 576px with a 60-glyph run
   at 575.625px inside it.

#### ⌘1–⌘7 in the screenplay, and why `defaultPrevented` was not enough

The app binds ⌘1/⌘2/⌘3 to Editor / Outline / Corkboard on `window`; the
screenplay binds `Mod-1`…`Mod-7` to the seven elements inside CodeMirror. Both
are real bindings on the same keys, and the collision is settled at the window
listener — CM's element keymap is already `Prec.highest` *in its own editor*
and cannot outrank a listener it never sees.

In theory `if (e.defaultPrevented) return` settles it: CM's keymap handler is
on `contentDOM`, the global listener is on `window` in the bubble phase, so CM
runs first and calls `preventDefault()`. In practice there is a hole, and it is
the case a writer lands in. CodeMirror's DOM observer defers `runHandlers` to a
**microtask** when a keystroke arrives while the view is mid-update
(`Promise.resolve().then(…)` in `DOMObserver.handleEvent`), and a microtask
runs after the whole synchronous dispatch of the event — i.e. after the global
listener has already switched the view out from under the editor. On a paged
screenplay, where every keystroke schedules measure work, "mid-update" is most
of the time.

So the digits yield explicitly: `screenplayOwnsDigit` in `lib/shortcuts.ts`
returns early for `mod + 1…7` when the event target is an **editable** content
box inside a `.screenplay-editor`. Deliberately narrow — the read-only
reference pane (whose `contentDOM` is `contenteditable=false`), the rails, the
sidebar and every prose editor are untouched, and ⌘0 (zoom reset) and ⌘8/⌘9
(unbound) are untouched too.

While in there:

- **The global handler already accepted Ctrl on Linux.** `mod(e)` is
  `e.metaKey || e.ctrlKey` and always was, and it accepts either on both
  platforms on purpose — a Mac keyboard on a Linux box, and the `?platform=`
  preview, both want the other one to work. CodeMirror's `Mod-` resolves the
  same way. Nothing needed fixing; it is now commented so the next reader does
  not have to re-derive it.
- **Modifier glyphs are platform-correct now.** Every combo in the app is
  authored in the macOS glyphs, because that is what the Swift app shows and
  what SWIFT-AUDIT quotes. `comboLabel()` rewrites them at render time rather
  than duplicating the strings — `⌘E → Ctrl+E`, `⇧⌘F → Ctrl+Shift+F`, `⌘⌥\ →
  Ctrl+Alt+\` — applied to the element pills, the cheat sheet and the command
  palette's hints. `⌃⌘O` collapses to `Ctrl+O` on Linux, which is what the key
  combination actually is there.
- **The cheat sheet lists the seven element keys**, which it never did. They
  are the only keys in the app a writer could not discover from a menu.

#### The frame meter — `AQ_PERF=1`

Everything above is a claim about paint cost, and none of it can be checked
from the Mac: Apple Silicon runs the same CSS through CoreAnimation and reports
a flat 120fps whatever we do. So there is a meter, and it runs on the shipped
build.

```
AQ_PERF=1 ./AquariusWriter*.AppImage        # the bench command
npm run dev -- and open ?perf=1              # the browser preview
```

A chip in the bottom-right corner — tokens, mono, 10px, no shadow and no blur,
because a meter that costs a frame to draw is measuring itself. Three numbers,
from one `requestAnimationFrame` loop and nothing else (no `PerformanceObserver`,
no long-task API, nothing WebKitGTK might not have):

- **fps** — frames in the last half second, scaled to the second.
- **ms worst** — the slowest single frame in that window. This is the number
  that matters for "sluggish": an average of 60 with one 90ms frame in it *is*
  a stutter, and the average hides it. The chip colours itself off this
  number, not the average.
- **jank** — a running count of dropped frames since launch. It only goes up,
  so the bench move is: scroll a long script, note what it climbed by, change
  something, scroll the same distance again.

The frame budget is learned from the fastest frame observed rather than
assumed to be 16.7ms, so a 144Hz handheld is not permanently reported as
janking.

A rAF callback runs immediately before its frame's style/layout/paint, so a
long gap between two callbacks means the *previous* frame's work — paint and
compositing included — overran. That is exactly the quantity this section is
about.

**Zero cost when it is off**, and that is structural rather than a promise: the
meter is a dynamic `import()`, so it builds as its own 1.3 kB chunk that a
normal launch never fetches, parses or evaluates. The flag is read through the
`dev_context` command that `installLogBridge` already invokes — one new `perf:
bool` field off `AQ_PERF`, read in **release** builds too, because the whole
point is to measure the AppImage on the machine that feels slow.

#### Bench checklist (Linux, on top of §1a's, §22e's and §27j's)

1. **The meter itself.** `AQ_PERF=1 ./AquariusWriter*.AppImage` — the chip
   should appear bottom-right and read something. Nothing here could be
   exercised on this Mac: the review harness runs with the tab backgrounded and
   the browser suspends `requestAnimationFrame` in a hidden tab, so the loop
   was never allowed to tick. It mounts, it is positioned and styled, and it
   code-splits — that much is verified. The numbers are not.
2. **The actual question.** Open a 40+ page screenplay, put the caret in it,
   and scroll from the top to the bottom with the wheel at a steady rate.
   Watch `jank`. Then do the same in a long prose chapter. This is the whole
   reason for the pass; if it is still bad, the next suspects are CM's own
   viewport re-render and the measure cycle, not the decorations.
3. **Type a paragraph in the middle of a 40+ page script.** The debounced
   pagination should mean the page-count badge settles ~120ms after you stop,
   and typing itself should not stutter. If the badge never updates, the
   debounce is firing into a destroyed view.
4. **Scroll to the bottom of a long screenplay, then scroll back up.** Every
   page break must still be decorated and every sheet must still line up. This
   is the test for the dropped `viewportChanged`: if a page-break rule or a
   `--sp-fill` were viewport-dependent after all, the symptom is a break that
   renders correctly once and then not again.
5. **Scroll a long markdown chapter to the bottom.** The syntax marks must
   still hide on lines that were never on screen when the file opened. That is
   the `syntaxTree` clause in `wysiwygDecorations` — if it is wrong, the far
   end of a big document shows raw `**bold**`.
6. **Courier Prime is actually loading.** The script body should be Courier
   Prime, not Courier New and not DejaVu Sans Mono. Check a `(parenthetical)` —
   it must be a true italic Courier, not a slanted roman. Then check a
   full-width action line ends at the right margin at 60 characters.
7. **The paper, all three themes.** Ice, Midnight, AquariusOS. The sheet must
   read as paper on a desk in every one, the ink must be black-ish, the page
   edges crisp, and there must be **no** soft glow around the stack. Midnight
   and AquariusOS should be dimmed paper, not white.
8. **No rule under a scene heading**, in the editor and in the print preview.
9. **⌘1–⌘7 with the caret in the script.** Each must set its element and the
   view must NOT switch to Outline or Corkboard. Then click the file tree and
   press ⌘2 — the view *must* switch. Then open the split pane's read-only
   half, click in it, press ⌘2 — the view must switch there too.
10. **The element pills and the cheat sheet on Linux** should read `Ctrl+1`,
    not `⌘1`.
11. **Drag a scene in the rail.** It must still slide, and the promotion is now
    scoped to the drag — if the slide became janky, `will-change` is arriving
    too late and belongs back on the row.

---

### 27l. The typing cost — and the one that was 67 disk reads per keystroke

*Bench, 2026-09-01, on Linux natively for the first time: "the app is sluggish
and delayed when typing and scrolling". §27k had taken the paint cost out of
scrolling and explicitly ruled out the compositor (`WEBKIT_DISABLE_DMABUF_RENDERER=1`
made no difference), so this pass went after the other half — what a single
keystroke costs before the frame that shows it.*

#### First, an instrument, because "sluggish" is not a number

`src/lib/dev/typing-bench.ts`, behind `VITE_AQ_BENCH=1`. It seeds a corpus of
realistic size (a 5,000-word chapter, sixty cross-linked notes, a ninety-page
script), then dispatches single-character inserts one at a time and stops the
clock after the frame containing that character. It reports p50 / p95 / worst
— typing lag is a tail phenomenon, and a mean of 1ms with a p95 of 90ms is
exactly what "delayed" feels like — **and it counts `readFile` calls made
during the burst. A keystroke should make zero.**

Two things about how it is run are worth keeping.

- **It runs in real WebKitGTK.** There is no Rust toolchain on the Linux box
  and the prebuilt binaries in `src-tauri/target.nosync` are Mach-O arm64, so
  the shell could not be built or launched. A ~60-line GTK3 + `WebKit2-4.1`
  host loads the Vite dev server instead and relays the page's console to
  stdout. That is the *same engine* Tauri v2 uses on Linux — same 2.52.5, same
  NVIDIA/Wayland stack — so the numbers transfer. What it cannot measure is
  Tauri IPC, and that turned out to matter enormously (below).
- **The probe does not trust the compositor.** `requestAnimationFrame` is the
  honest way to wait for a painted frame, but WebKitGTK stops servicing it the
  moment the window is occluded or unmapped, which wedges an unattended run
  forever. The default probe drains React's scheduler and forces style +
  layout by hand; `VITE_AQ_BENCH_RAF=1` opts back into rAF.

**The instrument caught its own first bug, and this is worth remembering:**
`formatBus.target(path)` falls back to "the only registered view" when the path
it was asked for has none. The first three runs measured the *previous*
scenario's document through a detached editor and reported it as this one — the
note pane's 2,998-character note came back as 28,528 characters. Any harness
that asks the format bus for an editor must check `view.dom.isConnected`.

#### The finding: 4,690 file reads for 70 keystrokes

| pane | before | after |
|---|---|---|
| prose, 5,000 words | p50 1ms · p95 2ms · worst 3ms · **readFile ×0** | p50 1ms · p95 1ms · worst 2ms · readFile ×0 |
| note, 60-note vault | p50 2ms · p95 3ms · worst 3ms · **readFile ×4,690** | p50 1ms · p95 1ms · worst 2ms · **readFile ×0** |
| screenplay, 90 pages | p50 6ms · p95 8ms · worst 10ms · readFile ×0 | p50 5ms · p95 6ms · worst 9ms · readFile ×0 |

**67 file reads per keypress.** `Backlinks` held `const editor = useEditor()` —
the whole store, no selector — and `editor.docs` was in its effect's dependency
list. `edit()` replaces the `docs` map wholesale on every keystroke, so the map
had a new identity every character, so the effect re-ran every character, and
the effect *walks the entire vault and reads every markdown file in it*.

In the browser preview each of those reads is a map lookup and the whole thing
costs 2ms, which is why it had never shown up. **In the shell every one is an
IPC round trip that reads a file off disk.** That is what "typing in a note is
delayed" was, and it is invisible to any measurement taken outside Tauri —
which is exactly why the read *count* is reported alongside the milliseconds.

Nothing was given up to fix it. Backlinks answer "what links **here**", so
typing in this note cannot change them; the working copies are read from
`useEditor.getState()` at scan time, so an unsaved edit elsewhere is still
preferred over disk. What changed is the refresh moment: a link typed in
another document appears when the tree next reloads rather than on this
document's next keystroke. The `cancelled` check also moved *inside* the loop —
it sat after it, so a superseded scan still read every remaining file before
throwing its answer away.

#### The same mistake, 52 times

`grep -nE "= use(Editor|Vault|Shell|…)\(\)"` finds **52 selector-less store
subscriptions**. Each one re-renders on *any* change to that store. For the
editor store that means every keystroke in every open buffer woke the other
split pane, the popout, the right pane and the overlays. The ones on the typing
path are now selected (`useEditor((s) => s.docs[path])`, and the actions
separately — zustand actions are stable, so those never re-fire). **The other
~40 are still there**, mostly on `useVault`, and are a real but quieter cost.

#### Work that cannot change mid-word does not belong in the keystroke

This is §27k's rule — *"if the work is O(document), it belongs behind
`docChanged`"* — with a React-side sibling: **if the result cannot visibly
change mid-word, it does not belong inside the keystroke at all.** New hook,
`useDeferredText` (`src/lib/defer.ts`), settling at 150ms — under the 800ms
autosave debounce, so every derived number is settled before a save records it,
and above a fast typist's inter-key gap so a burst collapses to one recompute.

Moved behind it: the footer's word and character counts (a full scan of the
chapter, per keypress, in both the prose and note panes), and the screenplay's
scene rail, page count and word count. The scene rail is *drawn* from the
settled copy but a click or a drag re-indexes off the **live** body — a
permutation built from a stale index would move the wrong span of a document
the writer has typed into since.

Three other whole-document passes went at the same time:

- **`parseTitleBlock` split the entire document to read its first four lines** —
  one string allocated per line of a ninety-page script — and `ScreenplayPane`
  called it *twice* per keystroke (`splitTitlePage` does it internally, and
  `titleBlockText` did it again). It scans a 4096-character head now, with a
  guard that falls back to the whole text when the block did not end inside it.
  Verified identical to the old implementation on 15 hand-picked cases and
  4,000 random documents, including the byte offset it returns, which is used
  to slice the body.
- **The controlled-editor echo.** All three editors run
  keystroke → `onChange` → store → React → the `value` effect, for every
  character. That effect had to serialise the whole document again and compare
  it to itself just to learn it had nothing to do. They now remember the last
  text they emitted; for prose and notes that comparison is a pointer check.
- **`fountainDecorations` classified the whole script a second time.**
  `paginate` cannot place a page break without classifying every line, so it
  now publishes `kinds` and `lines` and the decoration builder reuses them,
  walking offsets as it goes instead of asking the Text tree for a thousand of
  them. Proven identical on 1,780 lines across 8 scripts. **It did not move the
  measurement** — see below — but it is strictly less work and is kept.

#### What is left in the screenplay is layout, not JavaScript

The screenplay only came down from 6ms to 5ms, so the remaining cost was
profiled directly rather than guessed at again. On a 41,005-character,
995-line script the *entire* JS pipeline is **0.35ms**:

| step | per keystroke |
|---|---|
| `doc.toString()` | 0.061 ms |
| `classifyLines` | 0.061 ms |
| `paginate` (classify + wrapRows + pages) | 0.193 ms |
| `RangeSetBuilder` over every line | 0.038 ms |

So ~5ms of the screenplay keystroke is CodeMirror's DOM update plus WebKit
style and layout — and the reason is structural. `fountainTheme` sets
`height: auto` with `overflow: visible` on `.cm-scroller` so that the
*article* scrolls, because a fixed height and an internal scroller broke the
embed (§1a). That arrangement also **defeats CodeMirror's viewport
virtualization**: every line of a ninety-page script is live DOM at all times,
so every keystroke re-styles the whole script.

That is the next real win in this file and it is not a tuning change — it means
giving the screenplay editor its own scroller and making the paged canvas work
inside it. **Do not start it without deciding what happens to the grow-to-content
embed**, which the prose and note editors share. Nothing in this pass touched
it, and the §27 geometry is unchanged.

#### One more thing, for whoever picks this up on Linux

`node_modules` in this repo was installed on the Mac: `esbuild` and `rollup`
are `Mach-O 64-bit arm64`, and so are both binaries under
`src-tauri/target.nosync`. `npm run dev`, `npm run build` and the app itself
therefore cannot run on the Linux machine until a native `npm install` — and,
for the shell, a Rust toolchain, which that box does not have yet.

### 27m. The other forty — and what a selector-less store actually costs

*§27l counted 52 selector-less store subscriptions, fixed the ones on the
typing path, and left the rest with "a real but quieter cost". This is the
rest. `grep -rnE "= use(Editor|Vault|Shell|Overlay|Toolbar|Settings|Update)\(\)"
src` found **38**; a wider grep across all fifteen stores in `src/state` found
**45**. Both are zero now.*

#### The cost was never in the keystroke — it was in every other click

The first surprise was that the remaining 38 were **not** on the typing path at
all, and the measurement says so plainly: with a render counter on the nine
components at the top of the tree, typing twenty characters into a note
re-rendered **none of them, before or after**. §27l had already taken the
editor store off the shared path, and the vault store does not move when a
character is typed.

What the leftovers cost was everything *else*. `const overlay = useOverlay()`
subscribes to the whole overlay store, and the overlay store changes when any
sheet opens or closes. `App`, `Sidebar`, `TopBar` and `RightPane` all held one.
So opening the Today sheet re-rendered the entire application — including the
editor column and every row of the file tree — and closing it did the same
again:

**Opening and closing the Today sheet four times (eight state changes):**

| component | before | after |
|---|---|---|
| `App` | 8 | **0** |
| `MainWindow` | 8 | **0** |
| `SplitHost` | 8 | **0** |
| `TopBar` | 8 | **0** |
| `RightPane` | 8 | **0** |
| `Sidebar` | 8 | **0** |
| `QuickViews` | 8 | **0** |
| `WorkflowChip` | 8 | **0** |
| `TreeBranch` (16 rows) | 128 | **0** |

Nothing outside the sheet needs to know a sheet is open. Nothing outside it
now does.

The same shape, one store over. Expanding a folder in the sidebar writes a new
`expanded` set into the vault store, and every whole-store `useVault()`
subscriber woke for it — including the editor column, which cannot see the
sidebar at all:

**Expanding and collapsing one folder eight times:**

| component | before | after |
|---|---|---|
| `App` · `MainWindow` · `SplitHost` · `TopBar` · `RightPane` | 8 each | **0 each** |
| `Sidebar` · `QuickViews` · `WorkflowChip` | 8 each | 8 each |
| `TreeBranch` | 120 | 120 |

**Selecting eight documents in a row:**

| component | before | after |
|---|---|---|
| `App` | 8 | **0** |
| `MainWindow` | 8 | **0** |
| `TopBar` | 16 | 7 |
| `SplitHost` · `RightPane` | 8 each | 7 each |
| `Sidebar` · `QuickViews` · `WorkflowChip` | 8 each | 8 each |
| `TreeBranch` | 128 | 128 |

`App` reads two things — the workflow's title and whether boot has finished —
and neither changes when the selection does, so it now sits still through all
eight. `TopBar` halved because `useToolbar()` was a whole-store read: a pane
switch calls `setContext` and then `setElement`, which is two store writes and
was two renders; selecting `kind`, `path` and `element` separately makes it
one.

The rows that did not move are not a failure, and the numbers are left in to
say so. `Sidebar` genuinely paints the selection and the expansion, so it
genuinely re-renders. `QuickViews`, `WorkflowChip` and `TreeBranch` are its
children and are not memoised, so they follow it down regardless of what they
subscribe to. **That is the next win in this file, and it is a different
change** — `React.memo` on the tree row plus a stable row callback — not more
selectors.

#### Two more of the Backlinks bug, in `useMemo` rather than `useEffect`

§27l's 67-reads-per-keystroke bug was a whole-store subscription putting a
wholesale-replaced map (`editor.docs`) into an effect's dependency list. Two
more of exactly that turned up, both in `useMemo`, both in overlays that sit
open beside the editor:

- **`VersionDiff`** held `const { docs } = useEditor()` and listed `docs` as a
  dependency of the memo that computes the line diff. `edit()` replaces `docs`
  wholesale, so with the diff sheet open, a character typed in *any* buffer —
  including a different document in the split pane — re-serialised the compared
  document and re-ran the whole line diff. It selects `s.docs[path]` now, so
  only an edit to the document actually being diffed re-runs it.
- **`ScreenplayPreview`** had the same subscription and re-paginated the entire
  script — `splitTitlePage`, `classifyLines`, `paginate` — on any editor-store
  change at all. It selects `s.docs[path]?.body` now. The preview still updates
  live as that script is typed, which is the point of it; it just no longer
  updates when something else is.

#### The rules used, so the next pass does not have to re-derive them

- **One selector per field**, never an object literal. A selector returning
  `{a, b}` allocates a fresh object every render and compares unequal every
  time, which is the whole-store subscription wearing a disguise. `useShallow`
  exists in the installed zustand (4.5.7, `zustand/react/shallow`) and was not
  needed anywhere in these 45.
- **Actions are stable**, so selecting them is free and they never re-fire.
  `useVault((s) => s.selectPath)` costs nothing.
- **A field a component only reads inside an event handler is not a
  subscription.** `App` reads `selectedPath`, the overlay store and the popout
  store through `getState()` at the moment the shortcut fires — the pattern
  `VersionsTab` adopted in §27l, and the one the file's own `shell` handle
  already used.

#### How it was measured

A temporary counter — `rc(name)` incrementing a `window.__rc` map, called at
the top of nine component bodies — plus `React.StrictMode` removed for the
duration, since StrictMode double-invokes every render and doubles every number
in the tables above. Two worktrees, `4831524` and this branch, on the same
`node_modules`, the same browser and the same mock-backend sample workflow;
each scenario driven from the page's own console with a 120–150ms pause between
clicks so React could not batch eight interactions into one render. None of
that scaffolding is in the commit — the diff is the selectors and nothing else.

---

---

## 28. The Linux box can build the shell now

*Setup pass, 2026-09-01, straight after §27l. That section ends with a note for
"whoever picks this up on Linux": the app could not be built here, so the
typing bench had to run in a bare WebKitGTK window with Tauri IPC excluded.
This section closes that gap. The toolchain is installed, `cargo test` and
`npm run build` are green, the real window opens on this desktop, and the bench
has now been run **inside the shell** — which is where the readFile count
finally means something.*

### 28a. First, where "here" actually is

This matters more than it sounds, and getting it wrong will waste an afternoon.

The coding agent's shell runs in an **Ubuntu 24.04 container** whose hostname is
`aquarius`. That is **not** AquariusOS. AquariusOS is the Fedora/Bazzite system
underneath — immutable, updated by rebuilding an image, never by installing
packages into it. The container is an ordinary mutable Ubuntu that happens to
share three things with the desktop around it:

- **the home directory**, so the repo is visible from inside;
- **the screen** (`WAYLAND_DISPLAY=wayland-0`, `DISPLAY=:0`), so a window
  launched in the container appears on the real desktop;
- **the GPU device nodes**, though see §28e — the NVIDIA *driver* is not in
  the container, only the hardware.

So `sudo apt-get install` is fine and correct in this shell, and it is also
completely irrelevant to AquariusOS. Nothing here is a step toward shipping.
When the container is rebuilt everything below is gone, which is why it is a
script (`scripts/linux-dev-env.sh`) rather than something anyone should
remember.

`uname -a` is the thing most likely to confuse you: it reports the *host's*
kernel (`7.2.1-ogc3.1.fc44.x86_64` — Fedora), because a container shares the
kernel it runs on. `cat /etc/os-release` reports Ubuntu, and for anything to do
with packages, `/etc/os-release` is the one that is true.

### 28b. The setup, in order

All of this is in `scripts/linux-dev-env.sh`; run that instead of typing it.
What the script does, and why:

**One — the libraries Tauri compiles against.**

```
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev \
  pkg-config build-essential patchelf file curl
```

Tauri v2 on Linux draws its window with GTK3 and renders the page with
WebKitGTK. The `-dev` packages are the header files a compiler needs; the
runtime halves were already here, which is exactly why §27l could run a
WebKitGTK window but could not *build* one. `build-essential` is the C compiler
and linker — Rust needs a linker and there was none. `patchelf` and `file` are
used by `tauri build` when it assembles the AppImage.

The WebKitGTK that landed is **2.52.6**. §27l measured against 2.52.5 on the
host. Same series, and the numbers in §28f line up with §27l's, so nothing
about that minor difference appears to matter.

**Two — Rust.**

```
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh
sh /tmp/rustup-init.sh -y --default-toolchain stable --profile default --no-modify-path
export PATH="$HOME/.cargo/bin:$PATH"
```

This installs into `~/.cargo` — inside the home directory, nothing system-wide,
no root. Landed `rustc 1.98.0` / `cargo 1.98.0`. Because the home directory is
shared with the desktop, the toolchain **survives a container rebuild** even
though the apt packages do not.

**Three — a build folder that is not the Mac's.** This one is a real trap.

`src-tauri/target` is a symlink to `target.nosync` (see `scripts/nosync-link.sh`
for why), and on the Mac that folder holds **Mach-O arm64** output. Building
Linux into the same folder mixes two architectures in one cargo cache. So:

```
export CARGO_TARGET_DIR="$HOME/.cache/aquarius-writer-target"
```

Linux output goes there and never touches `target.nosync`. It also keeps a
multi-gigabyte build folder off the synced drive the repo lives on, which is
the same reason `target.nosync` exists at all. As it happens a *fresh* worktree
has no `src-tauri/target` at all — it is gitignored, and `nosync-link.sh`
deliberately no-ops away from macOS — so the symlink is only a hazard in the
main checkout. Set `CARGO_TARGET_DIR` anyway; it costs nothing and removes the
question.

**Four — the JavaScript packages, natively.** §27l's closing paragraph is
correct and still bites: `node_modules` in the repo was installed on the Mac,
so `esbuild` and `rollup` are arm64 binaries. One `npm ci` per checkout fixes
it. On Linux the `postinstall` nosync script prints
`nosync: no iCloud here — nothing to do` and exits, which is expected.

Two lines in `~/.bashrc` make every new shell able to build:

```
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
export CARGO_TARGET_DIR="$HOME/.cache/aquarius-writer-target"
```

(`~/.local/bin` is where Node 24 and npm live on this box — they are not in
`/usr/bin`.)

### 28c. Proving it works

```
cd src-tauri && cargo test        # 268 passed, 0 failed
npm run build                     # tsc -b && vite build — green
```

**268 tests**, not the ~113 the handoff expected; the suite has roughly doubled
since. First `cargo test` compiles the whole dependency tree and takes a few
minutes. After that it is about two seconds.

### 28d. The window opens, and it needs no special environment

```
npm run tauri:dev
```

opens the real Aquarius Writer window on the desktop — GTK3 title bar, the
tree, the panes, all of it. **No `GDK_BACKEND`, no
`WEBKIT_DISABLE_DMABUF_RENDERER`, nothing.** The escape hatches §27k and the
os-image launcher carry are for the packaged AppImage on the real desktop
session; from inside this container the plain command is enough.

One wrinkle worth knowing. A Wayland-native window **cannot be found with
`xdotool` or `wmctrl`**, and GNOME refuses both the shell's screenshot and its
window-list D-Bus calls to a client like this. So there is no way to confirm
from a script that the window is really on screen. If you need to *prove* it —
which is worth doing once — relaunch under XWayland:

```
GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run tauri:dev
```

and the window becomes an ordinary X client:

```
xdotool search --name "Aquarius Writer"
import -window <id> shot.png        # ImageMagick; grabs the real pixels
```

**Use that for looking, never for measuring** — see §28f.

### 28e. The EGL warnings are noise

Every launch prints a wall of:

```
libEGL warning: pci id for fd 16: 10de:2684, driver (null)
libEGL warning: egl: failed to create dri2 screen
```

`10de:2684` is the NVIDIA card. The device nodes are visible in the container
but the NVIDIA userspace driver is not installed in it, so EGL cannot find a
driver and WebKit falls back to software rendering. The app works fine. It is
not a bug in the app, it does not happen to the packaged AppImage on the real
desktop, and it is not worth chasing — but it does mean **this container is the
wrong place to measure anything that depends on the GPU**, paint and
compositing included.

### 28f. The bench, in the real shell at last

This is the measurement §27l could not take. Same instrument, same corpus, but
now inside Tauri, so every `readFile` is a real IPC round trip to a real disk
read rather than a map lookup.

```
AQ_DEV_VAULT="$HOME/aq-bench-vault" VITE_AQ_BENCH=1 npm run tauri:dev
```

| pane | p50 | p95 | worst | readFile |
|---|---|---|---|---|
| prose, 28,458 chars | 1 ms | 3 ms | 4 ms | **×0** |
| note, 2,998 chars, 60-note vault | 1 ms | 2 ms | 4 ms | **×0** |
| screenplay, 41,551 chars | 6 ms | 10 ms | 12 ms | **×0** |

**Zero disk reads per keystroke in all three panes.** That is the number that
mattered: §27l's 4,690 reads were invisible to it because it measured outside
Tauri, and the fix could only ever be *assumed* to hold in the shell. It holds.

The milliseconds also land on top of §27l's post-fix figures (1 / 1 / 5–6),
which is a useful cross-check in both directions: it says the WebKitGTK host
§27l improvised was an honest stand-in for the real shell on everything except
IPC, and it says the screenplay's remaining ~5–6ms really is CodeMirror DOM and
WebKit layout, exactly as §27l concluded. That work is still open.

**Do not bench under `GDK_BACKEND=x11`.** The same run through XWayland with
software rendering reports:

| pane | p50 | p95 | worst | readFile |
|---|---|---|---|---|
| prose | 32 ms | 33 ms | 33 ms | ×0 |
| note | 31 ms | 33 ms | 36 ms | ×0 |
| screenplay | 35 ms | 41 ms | 45 ms | ×0 |

That is a flat **~30ms added to every pane**, which is the environment, not the
app — note that the differences between panes survive intact (screenplay minus
prose is 3ms here, 5ms native, 4ms in §27l). A constant offset across three
workloads that differ by 15× in document size is always the harness. Read the
deltas if you are stuck with such a run; do not compare the absolutes to
anything.

### 28g. The mistake to not repeat: the bench wrote into the real vault

This one cost real cleanup, and it will happen to the next person too unless
they do the thing at the end of this section.

`typing-bench.ts` seeds its corpus two different ways. The chapter and the
screenplay go through `vault().writeFile(workflowId, …)` — an explicit
workflow id, which is the one `AQ_DEV_VAULT` registered, so those are safe. But
the sixty cross-linked notes go through `useVault.getState().createFile(…)`,
**which writes to whichever workflow the store currently has open** — no id
passed, no id checked.

Those are usually the same workflow. They were not here. The app boots into the
most recently registered workflow (`vault::registry` — "most recent wins the
launch slot"), and this machine's registry already had Royce's real Workflow
vault in it, so that is what the window opened. The bench's own
`openWorkflow(devId, { quiet: true })` did not win the race. Result: sixty
`Bench Note NN.md` files created in a brand-new `Characters/` folder at the
root of the real vault, and a bench that then measured that vault — the log
said `seeded: 3540 editable files in the tree`, against 62 for the scratch
folder, which is the tell. **If that count is not ~62, stop: it is pointed at
the wrong vault.** The prose and screenplay scenarios also reported
`SKIPPED — no buffer`, because those paths existed only in the scratch vault.

The fix needs no app change — give the app a registry of its own:

```
export XDG_CONFIG_HOME="$HOME/aq-dev-config"
export XDG_DATA_HOME="$HOME/aq-dev-data"
export AQ_DEV_VAULT="$HOME/aq-bench-vault"
VITE_AQ_BENCH=1 npm run tauri:dev
```

`app_config_dir()` follows `XDG_CONFIG_HOME`, so the registry starts empty,
`AQ_DEV_VAULT` becomes the only workflow the app has ever heard of, and there
is nothing else for `createFile` to fall through to. Every number in §28f was
taken this way.

The deeper issue was still standing when the above was written:
**`seed()` mixes an explicit-id write path with an ambient-current-workflow
one.** A harness that takes a workflow id should use it for every write it
makes. Until that was fixed the isolated config dir was the only guard, and it
belonged in the command line every single time — the header comment in
`typing-bench.ts` already said "point it at a scratch folder", and this is the
sharp edge that warning was about.

**Fixed.** `seed()` has one write path now: all sixty notes go through
`vault().writeFile(workflowId, …)`, the same explicit id the chapter and the
screenplay always used. `createFile` is gone from the bench, and with it the
branch that decided per-note which of the two paths to take. The tree reload
afterwards is an explicit `loadWorkflow(id)` rather than `refreshTree()`, which
reads the store's ambient "current" and is the same mistake wearing a different
coat.

The command line is no longer the only thing standing between the bench and a
real vault. `assertBenchTarget` runs after `openWorkflow` and before the first
byte is written, and it throws unless the workflow can account for itself:
`dev_context` reported this id (i.e. `AQ_DEV_VAULT` registered it), or its
title or path says "bench", or it is the browser mock, which has no disk. In
every case the store must have *that* workflow open — the §28g failure was a
right id with a wrong store, and that is now the first thing checked. A refused
run says which workflow it found, why it will not write to it, and repeats the
four export lines above. It writes nothing.

The isolated `XDG_CONFIG_HOME` is still worth setting; it is now belt rather
than braces. And `seeded: 62 editable files` is still the number to read — the
bench prints the workflow it settled on directly above it.

### 28h. Re-entering later

Nothing above needs redoing unless the container has been rebuilt. A fresh
shell needs only:

```
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
export CARGO_TARGET_DIR="$HOME/.cache/aquarius-writer-target"
cd <the checkout>
```

and then the one-liner for tests:

```
(cd src-tauri && cargo test)
```

If `cargo` is missing, the container was rebuilt — run
`bash scripts/linux-dev-env.sh` again. If `cargo` is there but the build fails
on a missing `.h` file, it is the same cause: the apt packages went, the home
directory stayed.

---

## 29. An emoji killed the app, and the culprit was not the app

*Bug pass, 2026-09-01. Royce reported "the app froze when opening a .md file"
on AquariusOS. It was not a freeze and it was not that file: v0.5.2's Linux
download quit the moment it was asked to paint a colour emoji, and every one
of Royce's vault documents has emoji in its headings.*

### 29a. What the log actually said

`~/.local/state/aquarius/aquarius-writer.log` from the crashing run — v0.5.2,
the downloaded overlay copy, Wayland, GNOME, NVIDIA — carried one line that is
not ours:

```
././/include/c++/12/bits/stl_vector.h:1123: … colrv1_configure_skpaint(FT_Face,
  const SkSpan<unsigned int>&, SkColor, const FT_COLR_Paint&, SkPaint*) …
  ::ColorStop … : Assertion '__n < this->size()' failed.
```

Unpacked, in order:

* `colrv1_configure_skpaint` is a function in **Skia**, the graphics library
  inside WebKit. It turns one COLRv1 glyph — a modern colour-emoji glyph, drawn
  as shapes and gradients rather than as a picture — into something to paint.
* `ColorStop` is the type of the little list of colours along one gradient.
* `Assertion '__n < this->size()'` is the C++ standard library catching a read
  past the end of that list, and killing the process rather than reading
  rubbish. Ubuntu builds with that check switched on, which is the only reason
  we got a message at all instead of a mystery.

So: something asked for colour stop number *n* of a list that had fewer than
*n* entries. Not our code, not even close to our code — this is the browser
engine painting a font.

### 29b. The font on the machine

`fc-list` on AquariusOS shows three emoji fonts, and the one that wins is the
new kind:

```
/run/host/usr/share/fonts/google-noto-color-emoji-fonts/Noto-COLRv1.ttf
/run/host/usr/share/fonts/twemoji/Twemoji.ttf
/run/host/usr/share/fonts/google-noto-emoji-fonts/NotoEmoji-Regular.ttf
```

`Noto-COLRv1.ttf` is exactly the COLRv1 kind of font the crashing function
exists to draw. That is the "why now": Fedora switched Noto Color Emoji from
the old picture-based format to COLRv1, and AquariusOS inherited it.

### 29c. Reproducing it, and the first two dead ends

Two things made this awkward to reproduce in the Ubuntu container (§28a).

**Dead end one: you cannot click the app from a script here.** The window opens
and can be screenshotted through XWayland, but XTest pointer warping does not
reach a Wayland compositor's real pointer — every synthetic click landed
nowhere. There is no way to drive the UI from this shell. Do not spend an hour
on it a second time.

**Dead end two: the container prefers a different emoji font.** Launching the
real 0.5.2 overlay against a scratch vault, with an emoji in a filename so the
sidebar had to paint it, produced a `.notdef` box and no crash. The container's
fontconfig ranks `Symbola`, then monochrome `Noto Emoji`, then `Twemoji` ahead
of `Noto Color Emoji` for U+1F9E0, so WebKit's own fallback never reached the
COLRv1 file. On Royce's Fedora host the ordering is the other way round. The
container is not a faithful stand-in for the desktop's fonts.

The way through was to stop driving the app and drive the *engine*, with the
font named outright rather than left to fallback. That is
`scripts/emoji-probe.py`, which is in the repo because this will come round
again: a bare GTK window, a `WebKit2.WebView`, one page of emoji with
`font-family: "Noto Color Emoji"`, a `web-process-terminated` handler, and a
timer that prints `survived paint` and quits. Roughly thirty lines of Python
through `gi`, run twice — once against the system WebKitGTK, once against the
copy the AppImage carries.

Pointing it at the bundled engine takes three things:

```
LD_LIBRARY_PATH=<staged libs>     # libwebkit2gtk-4.1.so.0, libjavascriptcoregtk,
                                  # libicu*.so.70, libwoff2*
cd <dir containing lib/x86_64-linux-gnu/webkit2gtk-4.1/>
```

The second one is the surprise: linuxdeploy rewrote the engine's path to its
helper processes as the **relative** string
`././/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess`, so the
directory you launch from has to contain that layout or the engine dies at
startup saying it cannot spawn a child. (`WEBKIT_EXEC_PATH` is not consulted.)
That relative path is also why the launcher log carries a
`getcwd: cannot access parent directories` line just above the crash.

The result, immediately:

| engine | version | result |
|---|---|---|
| system, in this container | **2.52.6** | `PROBE: survived paint`, emoji in full colour |
| the copy inside v0.5.2 | **2.50.4** | the exact assertion from Royce's log, web process dead |

Every emoji tried crashed it — 🧠 🏗️ 🧭 💾 ⚡ 🎯 👤 🎬 🚀 ✅ ☑️ 🔥 💡 📊 🐛 😀,
sixteen for sixteen. That "all of them" is the tell: a bug in one glyph's
gradient would hit one glyph. Something structural was wrong.

(The versions came from a two-line script calling
`WebKit2.get_major_version()` and friends against each library — the `.so` has
no readable version string in it.)

### 29d. The actual cause: two libraries disagreeing about a struct

An AppImage carries its own copy of the browser engine. It does **not** carry
its own copy of **FreeType**, the font engine — linuxdeploy deliberately leaves
that on the excludelist, so it always comes from the computer the app is
running on. Confirmed: there is no `libfreetype` anywhere under
`versions/0.5.2/usr/lib`.

FreeType 2.13 changed `FT_ColorStopIterator` — the little bookmark that walks a
gradient's colour stops. Its current definition, all four fields marked
"since 2.13":

```c
typedef struct FT_ColorStopIterator_ {
  FT_UInt   num_color_stops;
  FT_UInt   current_color_stop;
  FT_Byte*  p;
  FT_Bool   read_variable;      /* the new one */
} FT_ColorStopIterator;
```

v0.5.2's engine was compiled on **ubuntu-22.04**, against FreeType **2.11.1**,
which has no `read_variable`. AquariusOS runs FreeType **2.13.3**. So Skia
hands FreeType a struct of the old shape, FreeType reads and writes a field
that is not there, the stop count it reports back stops matching the vector
Skia sized from it, and the loop indexes past the end. Hence: every emoji,
not one.

Proved by A/B, which is the part worth keeping. Same engine, same page, same
font, one variable changed — the FreeType it loads:

```
bundled engine + host FreeType 2.13.2  →  Assertion failed, web process dead
bundled engine + FreeType 2.11.1       →  PROBE: survived paint
```

(2.11.1 came from jammy's `libfreetype6` .deb, unpacked into the staged lib
directory so the loader found it first.)

So this is not a WebKit bug to wait for a fix to. It is a **build/run skew**
that our own workflow created, and nothing in the app's own code is involved.
There is no upstream patch to point at because nothing upstream is broken.

### 29e. The fix: build the Linux download on ubuntu-24.04

One line in `.github/workflows/build.yml`, plus the `if:` conditions that name
the runner, plus a long comment saying why.

`ubuntu-22.04` was chosen on purpose and for a good reason: an AppImage only
runs on systems whose glibc is at least as new as the build machine's, so the
oldest runner gives the widest reach. That reasoning was right about glibc and
silently wrong about everything the AppImage does *not* carry. FreeType is one
of those things; so, in the same way, are fontconfig and harfbuzz.

`ubuntu-24.04` ships FreeType 2.13.2 — the same generation AquariusOS has —
and WebKitGTK 2.52.6. Everything else the bundle carries (GTK, Pango, Cairo,
all of which also talk to FreeType) is built against that same 2.13 there.
The cost is a glibc floor of 2.39; AquariusOS is far newer, so it is headroom.

Rejected, with reasons:

* **A fontconfig rule in the AppRun hook that refuses COLRv1 fonts.** Would
  work, and works on any host, but it throws away colour emoji to dodge a
  problem that has a real fix — and on a machine whose only emoji font is the
  COLRv1 one it leaves `.notdef` boxes.
* **Bundling an emoji font of the older kind.** Same objection, plus megabytes,
  plus it does not stop fallback reaching the COLRv1 face on its own.
* **Bundling `libfreetype` in the AppImage.** Tempting — it would make the app
  immune to the host's FreeType forever — and it is proved to work by the A/B
  above. But linuxdeploy excludes FreeType by design, overriding that is not a
  supported knob in Tauri's bundler, and a bundled FreeType then has to agree
  with the *host's* fontconfig, which is the same class of skew wearing the
  other hat. Left alone.

**The residual risk, stated plainly:** the AppImage now assumes the machine it
runs on has FreeType 2.13 or newer. Every current distribution does — 2.13 is
from February 2023 — and the struct is unchanged in 2.14. If FreeType ever
breaks that ABI again, this crash comes back in the same shape, and
`scripts/emoji-probe.py` is how to confirm it in ten minutes.

### 29f. Proving the fix

This container **is** Ubuntu 24.04 with FreeType 2.13.2 and WebKitGTK 2.52.6,
so a local `npm run tauri:build -- --bundles appimage` produces the same thing
the changed workflow will. Three checks on the result:

1. The engine it carries reports **2.52.6**, not 2.50.4.
2. `scripts/emoji-probe.py` run against *that* engine — the one from the new bundle,
   staged the same way as §29c — prints `PROBE: survived paint` and paints the
   emoji in colour. The identical run against 0.5.2's engine, same page, same
   font, same machine, dies with Royce's assertion.
3. The AppImage itself starts, opens a window and loads the app against a
   scratch vault holding one plain-ASCII note and one emoji note, with an
   isolated `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` (§28g — the
   same discipline, for the same reason). So the runner change did not break
   packaging.

What could **not** be checked from this shell is the last mile: clicking the
emoji note in the packaged app, for the reason in §29c's first dead end. The
proof stops at the engine, which is where the bug is — the app's own code never
enters into it. The one thing worth doing on the real desktop when the next
build lands is exactly what Royce did the first time: open a vault file with
emoji in the headings.

A curiosity noticed along the way and deliberately left alone: an emoji in a
*filename* renders as a `.notdef` box in the sidebar even with the emoji font
forced to the front of fontconfig's list, on both engines. Whatever the file
tree's font stack does, it stops WebKit falling back for that string. Cosmetic,
unrelated to this crash, and not worth touching in a fix commit.

Nothing here needs the AppRun hook, which matters for the delivery path: the
updater unpacks the whole AppImage into
`~/.local/share/aquarius/aquarius-writer/versions/<version>/` and the OS
launcher runs `AppRun` out of that folder (`src-tauri/src/updater/overlay.rs`).
The fix travels in `usr/lib` inside that copy, so it arrives the same way
whether the file is run as a single AppImage or unpacked into the overlay.
Royce simply needs the next build; the broken engine is baked into the 0.5.2
file already on his disk and no configuration change can rescue it.

---

## 30. Manuscript management, and the two things the Swift audit never said

*PARITY row 8, closed 2026-09-02. The outline and the corkboard have existed
here since the port landed; everything around them — marking a folder as the
manuscript, the home screen, the status filters, the front matter, the working
draft — did not. This section is what shipped, and, more usefully, the two
places where SWIFT-AUDIT §2.2 names a behaviour without saying how it works,
where a decision had to be taken and written down rather than guessed at
silently.*

### 30a. The inversion the roadmap had already admitted to

`docs/PARITY.md`'s closing section says the rule is *"if a human can do it in
the app, an MCP client can do it too"*, and then names four tools that broke
the rule in the other direction. Two of them were this row's:
`toggle_manuscript_folder` and `toggle_draft_folder` shipped in Wave 3, and the
sidebar had no button for either.

Both are now in the row's ⋯ menu, and they call the same two `vault::ops`
functions the tools call, through four new thin Tauri commands
(`vault_toggle_manuscript_folder`, `vault_toggle_draft_folder`,
`vault_set_active_draft`, `vault_set_synopsis`). Nothing in `commands.rs` for
this row does any work of its own; every one of them is `root_of` plus a call
into `ops`.

Two tools went the *other* way in the same change, because the rule runs both
directions and the UI now does two things an agent could not:

* **`set_active_draft`** — the chapter rail's Working Draft pill. New
  behaviour in `ops`, so it shipped with its tool.
* **`list_manuscripts`** — the read side of ManuscriptHome: chapters, words,
  pages, per-status counts, front matter and drafts in one call. The UI does
  not call it (it already holds the tree and computes the same numbers from
  `lib/manuscript.ts`); it exists because a model asking "how long is the book"
  should not have to read every chapter to find out.

**31 tools → 33.** `mcp/tools.rs`'s `EXPECTED` list is the test that pins it.

### 30b. Decision one: front matter is a file-name convention

SWIFT-AUDIT §2.2 says the ChapterRail has a "FRONT MATTER section (Title page ·
Dedication · Epigraph)" and never says how those three files are found or
stored. So this side decided, and the decision is written into the code twice
so the two halves cannot drift:

> **A manuscript's front matter is a markdown file sitting *directly* in the
> manuscript's own folder whose name, extension aside, is `Title Page`,
> `Dedication` or `Epigraph`, compared case-insensitively.**

`tree::FRONT_MATTER_NAMES` / `tree::is_front_matter` on the Rust side,
`FRONT_MATTER_NAMES` / `isFrontMatter` in `src/lib/manuscript.ts` on the other.

The consequence that matters is the one *not* in the audit: **front matter is
not a chapter.** `tree::chapter_paths_in` is `markdown_paths_in` minus the
front matter, and it is what seeds a manuscript's `chapterOrder` — at
`workflow::infer`, at `toggle_manuscript_folder`, and at the open-time
`reconcile_chapter_order` (which would otherwise put them straight back). So a
title page is never chapter one, never counted in "N chapters", and never
assembled into a compile as prose. `markdown_paths_in` keeps its old meaning
for anything that wants every file.

Two smaller rules fall out of "directly in the folder":
`Book/Part One/Title Page.md` is an ordinary document, and
`Book/Dedication of the Bell.md` is a chapter — the match is on the whole stem,
not a prefix.

The rail shows **all three rows, always.** A slot with no file behind it is a
"+" that creates one through the normal `createFile` path. The alternative —
showing only what exists — means the section materialises out of nowhere the
first time somebody happens to name a file correctly, which is not a feature
anyone could find.

One knock-on in `MainWindow.DocView`: the test for "should this document get a
chapter rail" used to be `chapters.includes(path)`, and front matter is
deliberately not in `chapters`. It is now *in the chapter order **or** this
manuscript's front matter*, or opening the title page would make the rail
vanish.

### 30c. Decision two: where ManuscriptHome lives

The audit calls ManuscriptHome "a home screen the port doesn't have" and does
not say what opens it. The choice taken:

* **The sidebar's Manuscript quick view opens the home grid.** It is the entry
  that already means "the manuscript", so the feature gets one door rather than
  a second one invented for it.
* **⌘2 still goes straight to the outline** of whichever manuscript you were
  last in. The common act stays one keystroke; the grid is how you reach the
  *other* manuscripts. The command palette carries "Switch to All manuscripts"
  with no shortcut of its own.

`EditorView` gained `"home"` for this. The store gained `activeManuscriptId`
beside `activeDraftId`: every manuscript surface in the app used to mean
`manuscripts[0]` silently, which was fine while a vault could only really have
one. Both cursors are re-pointed at a record that still exists on every
`refreshTree`, because an MCP client can unmark the manuscript you are looking
at while you look at it.

### 30d. Pages are `words / 250`, in exactly one place

`pagesFor` in `src/lib/manuscript.ts`, and `words.div_ceil(250)` in
`ops::list_manuscripts`. 250 words is the paperback rule of thumb — roughly
what a 6×9 trade page holds — and it is rounded **up**, so seven words are
still a page rather than none.

The point of putting it in one file is that four surfaces quote it now (the
summary bar, the ManuscriptHome card, the chapter rail's stats line and the
MCP tool) and no two of them may ever give a different length for the same
book. This is emphatically **not** the screenplay's page count: that one is
real pagination (`fountain-pages.ts`, §27b), because a script's page is a legal
unit and not an estimate.

### 30e. The status filter has to un-filter before it reorders

The chips filter the outline and the corkboard **together** — one `filter` set
in `ManuscriptView`, not one per view, because they are two drawings of one
list and a filter you had to set twice would be a bug wearing a feature's
clothes.

The interesting part is dragging inside a filtered view.
`ops::reorder_chapters` refuses anything that is not a permutation of the whole
chapter order — it rearranges, it never adds or drops — so sending it the four
visible rows out of twelve would be refused, correctly. `spliceFiltered` puts
the rearranged visible order back into the full one: the hidden chapters keep
their exact indices and only the shown slots are re-filled. So a drag in a
filtered outline moves what you dragged and nothing else, and the write is
still a permutation.

### 30f. The corkboard synopsis is the only place that writes a file nobody opened

Scrivener's behaviour, and the audit's ("committed to frontmatter"). Two rules
make it safe:

* **Commit on blur, not per keystroke** (Escape abandons, ⌘⏎ commits). A card is
  a box you type a sentence into and click away from; a write per letter would
  be a disk write and a snapshot per letter.
* **Never a whole-file write.** `vaultStore.setSynopsis` flushes any open buffer
  for that chapter first (its unsaved text belongs to the writer, and the file
  is about to change underneath it), calls `ops::set_synopsis` — which is
  `frontmatter::upsert`, line surgery, so the body and every other key survive
  byte for byte — and then `reconcile`s the buffer so it ends up holding the
  file that now exists. The §20 conflict apparatus is untouched: nothing here
  overwrites a file it last read some time ago.

### 30g. A real bug this found: a folder-backed draft was never active

`ensure_one_active_draft` was called when a draft mark came **off** and not when
one went **on**. A vault whose only cut arrived via `toggle_draft_folder` —
which is every vault that starts from a folder of chapters rather than from
`workflow::infer` — therefore had no active draft at all, so Compile's "the
active draft" and the rail's Working Draft pill had nothing to point at. One
line, and `the_working_draft_is_a_choice_that_survives_the_next_open` pins it.

### 30h. What was verified, and the one thing this container cannot do

`cargo test`: **272 passing** (268 before; four new). `npm run build` green.

Verified in the real Tauri shell on a scratch vault (`$HOME/aq-ms-vault`, an
isolated `XDG_CONFIG_HOME`/`XDG_DATA_HOME` per §28g):

* the window opens on a vault with no manuscript inferred (the folder is called
  `Book`, which is not in `MANUSCRIPT_FOLDERS`);
* `toggle_manuscript_folder` over raw MCP JSON-RPC seeded four chapters and
  left `Title Page.md` out of them;
* `toggle_draft_folder` on `Book/Second Pass` was accepted and came back active
  (29g);
* `list_manuscripts` reported 4 chapters / 65 words / 1 page, one count per
  status, and the front matter as `[["Title Page", "Book/Title Page.md"]]`;
* `set_active_draft` moved the flag and refused an unknown id **by listing the
  ids the vault actually has**;
* `set_synopsis` wrote the key into `Book/Ch_02.md` with the body untouched;
* **and the sidebar grew its `MS` chip on `Book` with no restart** — the MCP
  notify → `refreshTree` path, which is the half of "the tree reflects the mark"
  that could have gone wrong.

**What this container cannot do is click.** Under `GDK_BACKEND=x11`, xdotool's
*motion* events reach the webview (hover states appear exactly where you put
the pointer) but its *button and key* events do not — no click opens a menu, no
⌘2 changes the view. This is the harness, not the app: every one of those
interactions was then driven against the same React build in the browser
preview on `http://localhost:1420`, where the mark menu, the two-card home
grid, the status chips, the in-place synopsis and the front-matter "+" all
behave. If you need to prove a *click* on the real shell, you need a human at
the machine or a different automation route; do not spend an afternoon on
xdotool the way this session started to.

The browser preview is a real test surface for this row on purpose: the mock
service in `browser-service.ts` implements the **rules** and not just the
shapes — the front-matter exclusion, the "a draft folder needs a manuscript
above it" refusal, and the one-active-draft invariant — so a rule that only
existed in Rust would be a rule `npm run dev` could not show you breaking.

---

## 31. Delete asks first, and there was only one door to put the question in

*2026-09-02. Royce: "add a delete confirm message when a file is deleted just
in case it was pressed on accident." That is the whole brief, and the whole
change — a gate in front of the existing delete, and nothing after it touched.*

### 31a. There is exactly one human-facing delete

The task came in expecting several entry points to unify — a "Delete" in the
row's ⋯ menu, a Delete/Backspace binding on the selection, a drop-on-trash
target, something in the command palette, something in the manuscript surfaces
that v0.5.3 added. **None of those exist.** The app has one:
`DeleteAffordance`, the hover-revealed `×` on a *file* row in the sidebar
(`components/sidebar/Sidebar.tsx`). What the search actually found:

- **The ⋯ / context menu** (`RowMenu`) is Star, Open in Split View, Mark as
  Manuscript, Mark as Draft folder, Rename, Move to… — no delete. It is Swift's
  row menu minus the Finder items, and Swift's has no delete either.
- **No keyboard delete.** Nothing in `App.tsx`'s shortcut table or
  `lib/shortcuts.ts` binds Delete or Backspace to anything, and the tree rows
  are `<button>`s with no key handling of their own.
- **Drag** (`useTreeDrag`, §18) has exactly one destination kind — a folder, or
  the vault-root strip. The sidebar's `Trash` rail button *opens* the Recently
  Deleted sheet; it is not a drop target.
- **The command palette** has no delete verb, and neither do the outline, the
  corkboard, the chapter rail or the manuscript home screen.
- **`RightPane`'s "Delete"** is a *comment*, not a document. Left alone.

So this is one gate, not a shared one retro-fitted across five callers. The new
`deleteQuestion()` sits beside the affordance and is written to be the single
place a second caller would come to, if one ever appears.

**Folders are a latent branch, on purpose.** `DeleteAffordance` renders on file
rows only, so nothing in the shipping UI can hand it a folder — but the copy
for one is written and the count is recursive, because a folder delete is the
obvious next thing to want and a half-written question is worse than none. It
was exercised by temporarily rendering the affordance on folder rows in the
browser preview (see 31d) and then reverting that line.

### 31b. What the gate does NOT change

Everything after the confirmation is the code that was there before, moved
inside an `if`: evict the buffer first (a pending debounced save would
resurrect the file), `trashFile`, `removeFromTree`, `forget` the star. No new
notice, no new error handling, no change to what the editor does when the open
document goes — `removeFromTree` already clears the selection and closes the
split, and the editor falls back to its empty state. The brief was a gate.

**The MCP `trash` tool stays unconfirmed**, and that divergence is commented at
the affordance. `mcp/tools.rs` calls `ops::trash_entry` straight through: an
agent has no hand to slip, its caller already asked for the delete in words,
and a modal in a headless surface is a hang, not a safeguard. The safety net is
the same either way — the file is in Recently Deleted, not gone (§24c).

### 31c. The confirm pattern, and the inconsistency this leaves behind

The brief said to prefer "the in-app styled one" over `window.confirm`. There
was no in-app styled one. Every confirmation in the app was a `window.confirm`:
Empty trash (with its count, §24c), Purge one trash row, Restore a version. The
closest thing to a house style was `ConflictDialog` — a store, a component in
`components/safety`, one instance mounted in `App` — so the new confirm is
built to that shape: `state/confirmStore.ts` (`ask()` returns a promise) plus
`components/safety/ConfirmDialog.tsx`.

**The other three were left for a separate pass, and that pass happened the
same day.** The reasoning at the time was that they are not on the accident
path — every one is reached from inside a sheet the writer opened on purpose,
and two of them are the *permanent* delete, which already reads as a different
question. Royce asked for them anyway ("move those three onto the new dialog
too"), and moving them turned up something the tidy-up framing had no way to
see: **inside the app those three were not asking anything at all.** See §31f.

### 31d. Focus, Enter, and the two things that went wrong getting there

Focus lands on **Cancel**. That is the entire safety property and it is worth
being blunt about why: a `window.confirm` puts focus on OK, so the writer who
catches the `×` on the way past and then taps Enter out of habit has confirmed
a delete without reading a word. Enter is **not** bound globally — it does
whatever the focused button does, and the focused button is Cancel. Tab to
Delete and Enter deletes, which is a deliberate act and reads as one. The only
explicit Enter handling is a fallback for Enter arriving with focus on neither
button, which answers "no"; a dialog that swallows a key is a dialog the writer
presses again, harder.

Getting focus onto Cancel took two tries, and both failures are worth keeping:

1. **`Overlay` focuses its own panel on mount**, and effect order does not beat
   it. `Overlay` is a newly-mounted subtree, so **StrictMode runs its mount
   effect twice** — and the second pass lands *after* `ConfirmDialog`'s single
   one. The panel wins. Any dialog that wants focus somewhere specific inside
   an `Overlay` has this problem.
2. **`requestAnimationFrame` was the wrong escape.** It never fired at all,
   because the browser preview was running in a backgrounded pane and a parked
   compositor does not run frame callbacks. A dialog that only focuses Cancel
   when somebody is watching is exactly the wrong way round. It is a
   `setTimeout(…, 0)` now; timers fire regardless.

### 31e. Checked in the browser preview

`npm run dev`, mock backend, on the Ch 01 row of the Lantern vault:

- The `×` opens the dialog instead of deleting. Title
  `Delete “Ch 01 · A Door of Letters”?`, body "It moves to Recently Deleted,
  where you can put it back.", buttons Cancel and a red Delete.
- `document.activeElement` is `.ask-cancel` when the dialog opens.
- **Enter on a fresh dialog does not delete** — the file stays in the tree.
- Escape cancels; a click on the backdrop cancels; Cancel cancels. Eleven files
  before, eleven after, every time.
- Delete confirms: the row leaves the tree, the open editor falls back to
  "Nothing open yet", and `Drafts/Ch_01.md` is listed in Recently Deleted —
  i.e. the post-confirm path is unchanged.
- Folder copy, with the affordance temporarily rendered on folder rows:
  `Delete “Characters” and the 3 files inside it?`; `Delete “Episodes” and the
  1 file inside it?` (singular); adding an *empty* subfolder left it at 3, and
  putting one note inside that subfolder took it to 4 — so the count is files
  only, and recursive.

`npm run build` green. No Rust changed, so `cargo test` was not re-run.

### 31f. The other three, and the confirm that was never a confirm

*Same day, straight after 31e. Royce: "move those three onto the new dialog
too." Three call sites, one dialog, and a Linux question attached — and the
Linux question turned out to be the whole story.*

**What moved.** All three, and there is now no `window.confirm` left in `src/`
(the only hits are the comments in `confirmStore.ts` and `ConfirmDialog.tsx`
explaining why it is gone):

| Where | Question | Button |
|---|---|---|
| `overlays/TrashSheet.tsx` — Empty trash | `Empty the trash?` / "N items will be deleted for good — removed from disk, not moved anywhere. This cannot be undone." | `Empty Trash`, destructive |
| `overlays/TrashSheet.tsx` — Purge one row | `Delete “Drafts/Ch_02.md” for good?` / "It is removed from disk, not moved anywhere — this cannot be undone." | `Delete Forever`, destructive |
| `rightpane/RightPane.tsx` — Versions Restore | `Restore “Drafts/Ch_01.md”?` / "The document goes back to “<label>”. What is in the editor now is snapshotted first, so you can come back to it from this same list." | `Restore`, **not** destructive |

The count stays in the Empty trash copy, as §24c intended. It is one sentence
for both counts on purpose — the obvious phrasing gives you "1 item … *They*
are removed", and that seam is what makes a warning read as machine output.
Purge was a synchronous inline `onClick`; it is a `purge(t)` beside `empty()`
now, for no reason other than that the answer is awaited. Everything after each
`if (!ok) return;` is byte-for-byte the code that was there before.

**The finding: `window.confirm` inside the app returned a Promise.** This was
supposed to be a cosmetic pass. It was not.

`tauri-plugin-dialog` (a dependency in `src-tauri/Cargo.toml`) injects an
initialization script into every webview — `init-iife.js` in the crate:

```js
window.alert = function (i) { n("plugin:dialog|message", { message: i.toString() }) },
window.confirm = async function (i) { return await n("plugin:dialog|confirm", { message: i.toString() }) }
```

`window.confirm` is replaced by an **async** function. Called from synchronous
code it returns a pending Promise *immediately*, and a Promise is truthy. So

```js
if (!window.confirm(`Restore …`)) return;   // never returns
const ok = window.confirm(`Permanently delete ${n} …`);  // always truthy
```

**All three gates were dead.** Empty trash, Purge and Restore ran the instant
the button was pressed, every time, inside the shell — no question, no way to
back out, and the answer to whatever the plugin did ask discarded. They only
ever behaved like gates in `npm run dev` in a plain browser, which is exactly
where they were last looked at. This is not a Linux quirk: the shim is in the
plugin, so it applies on every platform the app ships to.

So §31c's "the closest thing to a house style was `ConflictDialog`" understated
the case. There was no house style *and* no working confirm. The delete gate
that started this was never at risk — `confirmAsk` was new code and never
touched `window.confirm`.

**Measured, not reasoned.** `src/main.tsx` carried a temporary probe behind
`VITE_AQ_DIALOG_PROBE` that called the two dialogs and painted the result into
the page, run under `npm run tauri:dev` on this box (X11 per §28d, scratch
`XDG_CONFIG_HOME`/`AQ_DEV_VAULT` per §28g, so nothing went near a real vault).
It printed:

```
PROBE confirm=[object Promise] ms=1
```

One millisecond, no dialog, a Promise. The probe was reverted before the
commit.

**`window.prompt` is fine, and is staying.** The plugin's shim covers `alert`
and `confirm` and does **not** touch `prompt`, so the Versions "Snapshot
label:" input falls through to WebKitGTK's own script dialog — which renders
perfectly well: a real GTK modal titled `JavaScript - http://localhost:1420/`,
with the default text selected, blocking the page until Cancel or OK. It was
photographed doing exactly that in the same probe run. So the answer to "are
script dialogs invisible on Linux?" is **no** — WebKitGTK draws them, and the
old confirms were broken by the Tauri plugin, not by the platform. `prompt`
stays a `window.prompt` for now; it is ugly and system-styled, and turning it
into an in-app text field is a real piece of work (a new overlay with an input,
not a re-labelled `confirmAsk`), so it is a separate task and not this one.

**One behaviour change that is not the gate.** `Overlay` registers its Escape
handler on `window`, and every mounted `Overlay` has one. Empty trash and Purge
are asked from *inside* the Recently Deleted sheet, so a single Escape would
have cancelled the question *and* closed the sheet behind it. `ConfirmDialog`
now takes Escape itself in the **capture** phase and stops it there, so Escape
does exactly one thing. A capture listener on `window` runs before every
bubble-phase one, which is why it is the phase and not the ordering that
settles this.

### 31g. Checked in the browser preview (the other three)

`npm run dev`, mock backend, Lantern vault. Two files deleted first to fill the
trash:

- **Empty trash, 2 items.** `Empty the trash?` / "2 items will be deleted for
  good — removed from disk, not moved anywhere. This cannot be undone." /
  `Empty Trash` in red. `document.activeElement` is `.ask-cancel`.
- **Enter on the fresh dialog does not confirm** — dialog still open, still 2
  rows in the sheet.
- **Escape cancels the question and leaves the sheet open** — dialog gone,
  sheet still there, still 2 rows. That is the capture-phase fix doing its job.
- **Purge.** `Delete “Drafts/Ch_02.md” for good?` / `Delete Forever` in red.
  Cancel → 2 rows. Confirm → 1 row, and the remaining row is `Drafts/Ch_01.md`.
- **Empty trash, 1 item** reads "1 item will be deleted for good — removed from
  disk…". Confirm → the sheet shows "The trash is empty" and the notice says
  `Trash emptied — 1 item deleted for good`, i.e. the post-confirm path is
  unchanged.
- **Versions Restore.** `Restore “Drafts/Ch_01.md”?` / "The document goes back
  to “Bench snapshot”…" / `Restore` in the ordinary blue, not red — the one
  non-destructive question of the four. Focus on Cancel; Enter does not
  restore; Escape cancels and the version list still has one entry. Confirm →
  the list has two, `Before restore ★` above `Bench snapshot ★`, which is the
  "snapshotted first" behaviour it always had.

`npm run build` green. No Rust changed, so `cargo test` was not re-run.

### 31h. The last script dialog: `window.prompt` becomes a real field

*2026-09-02, the separate task §31f said this would be. One call site, and the
question was never whether to convert it but where to put the input.*

**What was converted.** One hit: `rightpane/RightPane.tsx`, the Versions
"Take snapshot" button, which asked for a label with

```js
const label = window.prompt("Snapshot label:", "Snapshot");
```

`tauri-plugin-dialog` does not shim `prompt` (§31f), so inside the shell this
fell through to WebKitGTK's own script dialog — a real, working, blocking GTK
modal titled `JavaScript - http://localhost:1420/`, in the system font, in the
system palette, with system buttons. It worked. It just did not belong to this
app. `grep -rn "window.prompt\|window.confirm\|window.alert" src` now returns
comments only, and `ConfirmDialog.tsx`'s header comment says outright that all
three globals are off-limits here and why, so the next person does not have to
find §31f to learn it.

**A sibling, not a fork.** `confirmStore` grew `askText()` (and `promptAsk()`
beside `confirmAsk()`) rather than getting a `promptStore` next to it, and
`ConfirmDialog` renders the two variants off one `pending` slot that is now a
tagged union — `{ kind: "confirm" | "prompt" }`. Two stores would have been
less code to read in isolation and the wrong shape: each dialog mounts its own
`Overlay`, every mounted `Overlay` puts an Escape listener on `window`, and
§31f had already had to reach for a capture-phase handler to make one Escape do
one thing. One slot means one mount, one Escape handler, and no ordering
question between them. The cancel value differs per kind (`false` vs `null`),
so backing out goes through a `dismiss()` on the store — the dialog should not
be the thing that knows what "no" is worth.

**Focus goes to the field, and that is the opposite of §31d on purpose.** The
confirm focuses Cancel because the reflex Enter must not delete a chapter. A
prompt creates a snapshot; the worst a reflex Enter does is make one called
"Snapshot", which is exactly what the writer would have got from the old
`prompt`'s pre-filled, pre-selected default anyway. Focusing Cancel here would
buy nothing and cost a click before every label. So: focus the input, `select()`
the initial text so the first keystroke replaces it, Enter submits. The safety
rule from §31d is about the *destructive* question, not about dialogs in
general, and it is worth writing that down before someone "fixes" this one for
consistency.

The focus still rides the `setTimeout(…, 0)` from §31d — same reason, same
StrictMode double-mount of `Overlay`, and `requestAnimationFrame` is still
wrong in a parked compositor.

**Enter is handled on the panel, not on the `<input>`.** Focus arrives on a
zero timer, so an Enter that beats the timer lands on the panel; bound to the
input alone it would do nothing and the writer would press it again. The
handler skips events whose target is a `<button>`, which the engine activates
itself.

**Empty means "the usual".** `askText` takes a `fallback` (defaulting to
`initial`) and resolves `typed.trim() || fallback`, so the store does the trim
and the empty-field default that the caller used to do inline. The caller
passes `fallback: "Snapshot"`, which is the old
`label.trim() || "Snapshot"` moved one level down; everything after it —
`takeSnapshot(wf, path, label, bodyNow())` then `reload()` — is byte-for-byte
what it was.

The copy changed with the box. `Snapshot label:` was a field label for a
system dialog; the in-app one has a title, "Name this snapshot", a line of
plain language under it, and a button that says `Take snapshot` rather than OK.

### 31i. Checked in the browser preview (the prompt)

`npm run dev`, mock backend, Lantern vault, `Drafts/Ch_01.md` open, right pane
on Versions:

- **Take snapshot** opens the in-app dialog, not a GTK modal.
  `document.activeElement` is `.ask-input`, its value is `Snapshot`, and
  `selectionStart`/`selectionEnd` are `0`/`8` — focused *and* selected.
- **Enter on an untouched dialog** adds one version, named `Snapshot`.
- **A typed label then Enter** adds `Second pass`.
- **Escape** closes the dialog and adds nothing (2 versions before, 2 after).
- **Cancel** adds nothing. **A click on the backdrop** adds nothing.
- **A field of spaces + Take snapshot** adds one version named `Snapshot` —
  the trim and the fallback.
- Regression on the confirm variant, which now shares the slot: Versions
  **Restore** still reads `Restore “Drafts/Ch_01.md”?`, still focuses
  `.ask-cancel`, has no input, cancels on Escape with the version list
  unchanged, and on confirm still writes `Before restore ★` to the top of the
  list.

`npm run build` green. No Rust changed, so `cargo test` was not re-run, and the
shell was not rebuilt for this — there is no `prompt` call left for WebKitGTK
to draw a modal for, so the §31f photograph has nothing to reproduce.
