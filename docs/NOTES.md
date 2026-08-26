# Notes — where the handoff and the code disagree

`HANDOFF.md` in this folder is the **product design contract** and is kept
byte-for-byte as delivered. It is never edited. When reality has moved on from
what it says, the discrepancy is recorded here instead.

Last reviewed: 2026-08-25 (Stage 1 of the Linux port).

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

## 2. "Two themes only" — Stage 3 adds a third

**HANDOFF.md §2** lists as a non-negotiable: "Two themes only: Parchment (light,
warm) and Midnight (dark, plum)."

Stage 3 of the Linux port adds a third theme, **AquariusOS**, built from
`os-image/branding/tokens.md`. The reason is that this app is the operating
system's stock writing app, and a stock app that doesn't look like its OS on first
boot is a bad first-boot story.

The amendment is narrow:

- Parchment and Midnight both remain, and remain selectable on every platform.
- Parchment stays the **default on macOS**, exactly as the handoff intends.
- AquariusOS becomes the **default on Linux only**.
- It reuses the existing mechanism (`:root[data-theme]` + `[data-accent]` CSS
  custom properties) — it is additive, not a rework.

Accent hues (blue / purple / sepia / sage) are unaffected.

## 3. The Tauri backend does not exist yet

**HANDOFF.md §3** describes the on-disk folder and file model (`.aquarius/
workflow.json`, `sessions/`, `snapshots/`, `trash/`).

None of that is implemented yet. `src-tauri/src/lib.rs` is a 16-line stub with an
empty `invoke_handler`, and every method of `src/lib/vault/tauri-service.ts`
throws `"not implemented yet"`. The app currently runs on
`browser-service.ts` (sample data) with `aux.ts` keeping version history,
comments, the trash index and search in **localStorage**.

Stage 2 of the port implements §3 for real and moves the `aux.ts` state onto disk.
The handoff's model is the target, not a description of today.

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

## 7. No Tauri capabilities file

Tauri 2 gates every plugin call behind a permission set in
`src-tauri/capabilities/*.json`. This repo has **no `capabilities/` directory**,
so the `fs`, `dialog` and `shell` plugins registered in `lib.rs` are currently
granted nothing. Stage 2 has to create that file alongside the commands it adds.
