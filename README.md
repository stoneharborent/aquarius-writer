# Aquarius Writer

A local-first writing studio for **novels, notes, and screenplays**. Your writing
lives in a plain folder on your disk — real `.md` and `.fountain` files you can
copy to a thumb drive. No cloud account, no database, no lock-in.

This is the app that ships with **AquariusOS** as its stock writing/vault app —
the slot Obsidian would fill on someone else's system.

---

## Where this came from (read this once)

There are **two** builds of Aquarius Writer, and they are not the same program:

| Build | Lives at | What it is |
|---|---|---|
| **The Swift app** | `Branches/Apps/AquariusWriter/swift/` | The original. macOS only, forever — it's built on Apple-only frameworks. Still the macOS-native track. Untouched. |
| **This repo (Tauri + React)** | you are here | The cross-platform rebuild. Runs on macOS **and Linux** from one codebase. This is the one that becomes the AquariusOS app. |

This repo was copied out of `Branches/Apps/AquariusWriter/app/` on 2026-08-25 and
made into its own git repo here. **Nothing was deleted** — the original folder is
still sitting where it always was. Royce clears it out himself once this new home
has proven itself.

The full plan lives at `AquariusOS/docs/aquarius-writer-port-plan.md`.
The product design contract lives at [`docs/HANDOFF.md`](docs/HANDOFF.md) — that
document is the law for how the app is supposed to look and behave.

---

## What you need installed

Two things. You only ever install them once.

**1. Node 22** — already on this Mac at `/opt/homebrew/bin/node`.
Check it with:

```bash
node -v      # should print v22.something
```

**2. Rust** — needed only for the real desktop app, not the browser preview.
Installed at the user level (no admin password, nothing touched system-wide):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
```

Rust installs itself into `~/.cargo`. Every terminal that runs the desktop app
needs that on its PATH:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

Check it worked:

```bash
cargo --version   # should print cargo 1.9x.x
```

---

## First-time setup

From inside this folder, run once:

```bash
npm install
```

That downloads the app's JavaScript libraries (~145 MB) into `node_modules`.

---

## The two ways to run it

### Way 1 — the browser preview (fast, no Rust needed)

```bash
npm run dev
```

Then open **http://localhost:1420** in a browser.

This is the quick way to look at the interface and click around. It runs on
**fake sample data** held in your browser's memory — it is not reading or writing
any real files on your disk. Use it for design work and UI changes.

Stop it with `Ctrl+C`.

### Way 2 — the real desktop app (needs Rust)

```bash
export PATH="$HOME/.cargo/bin:$PATH"
npm run tauri:dev
```

This compiles the actual desktop program and opens it as a real app window.

**The first run takes 5–15 minutes** — it is compiling around 500 Rust libraries
from scratch. It looks frozen. It isn't. Let it finish. Every run after that
starts in a few seconds because the work is cached.

Quit it by closing the window, or `Ctrl+C` in the terminal.

---

## Where the app is right now

**The whole interface is built. The part that touches your real files is not.**

Concretely:

- The full UI exists — sidebar and vault tree, the prose editor, the note editor,
  the screenplay (Fountain) editor, manuscript outline and corkboard, PDF and
  image viewers, the Spark panel, command palette, settings, pricing dialogs.
- All of it currently runs on a **mock backend** (`src/lib/vault/browser-service.ts`)
  that serves sample documents and remembers changes in browser storage.
- The real file-on-disk backend is a **16-line Rust stub**. Every method in
  `src/lib/vault/tauri-service.ts` deliberately throws
  `"not implemented yet"`.

So in the desktop app (Way 2), the **window opens and the app loads, but opening a
real vault folder will throw an error.** That is expected, and it is exactly what
Stage 2 builds. Until then, use the browser preview to see the app working.

---

## The plan, in stages

From `AquariusOS/docs/aquarius-writer-port-plan.md`:

| Stage | What it does | Status |
|---|---|---|
| **1** | Land the repo here, install the toolchain, prove both dev modes boot on the Mac | ✅ **done** — this commit |
| **2** | **The Rust vault backend.** Implement the 9 file operations for real: open a folder, walk the tree, read/write files with safe atomic saves, soft-delete to trash, watch for outside edits. Move version history / comments / trash off browser storage and onto disk in `.aquarius/`. | next |
| **3** | **The AquariusOS skin.** A third theme matching the OS design tokens, with the Sora / Inter / JetBrains Mono fonts bundled. Default on Linux; Parchment stays default on macOS. | next (runs alongside Stage 2) |
| **4** | **Linux identity + packaging.** Draw our own window buttons on Linux, app id `os.aquarius.writer`, desktop entry and icons, AppImage built by CI. | after 2 |
| **5** | **Spark on Linux.** Local model lifecycle (Ollama is Linux-native), provider routing, and the rule that every feature is drivable by Spark. | last |

---

## How the code is laid out

```
src/                     the interface (React + TypeScript)
  components/            every screen and panel
  lib/vault/             ← the important seam, see below
  theme/                 Parchment + Midnight themes (CSS variables)
  state/                 app state (zustand stores)
src-tauri/               the desktop shell (Rust)
  src/lib.rs             the 16-line stub Stage 2 replaces
  tauri.conf.json        window size, app id, build commands
docs/HANDOFF.md          the product design contract — the law
docs/NOTES.md            where the code and the handoff disagree
scripts/nosync-link.sh   iCloud housekeeping (see below)
```

**The seam that matters:** `src/lib/vault/service.ts` defines nine methods.
`browser-service.ts` implements them with fake data (works today).
`tauri-service.ts` implements them by throwing (Stage 2 fills these in).
`index.ts` picks whichever one fits where the app is running. Nothing else in the
app knows or cares which is in use — that's the whole design.

---

## One quirk: iCloud and the `.nosync` folders

This repo sits inside iCloud Drive, which would otherwise try to upload the
150 MB of libraries and the multi-gigabyte Rust build folder to the cloud. Slow,
pointless, and occasionally it corrupts a build.

iCloud ignores any folder whose name ends in `.nosync`. So:

- the real folders are `node_modules.nosync` and `src-tauri/target.nosync`
- the names the tools expect (`node_modules`, `src-tauri/target`) are shortcuts
  pointing at them

`npm install` rebuilds `node_modules` as a real folder every time and breaks the
shortcut, so it is repaired automatically afterwards. If it ever looks wrong, fix
it by hand with:

```bash
npm run nosync
```

There is one knock-on effect. `npm run tauri:dev` watches `src-tauri/` and
restarts the app whenever a source file changes. It knows to skip a folder called
`target`, but not one called `target.nosync` — so it would see its own build
output as a change and rebuild forever. `src-tauri/.taurignore` tells it to skip
that folder. Don't delete that file.

---

## Notes on a couple of things you may read elsewhere

**Fountain screenplays.** Older docs (including `docs/HANDOFF.md`) say to use
[nyousefi/Fountain](https://github.com/nyousefi/Fountain). That is a **Swift**
library — it belongs to the Swift app and cannot be used here. This codebase uses
the **`fountain-js` npm package** instead, which is already installed and wired
up. Don't go looking for the Swift one.

**"Two themes only."** The handoff says Parchment and Midnight and nothing else.
Stage 3 adds a third, AquariusOS, because the app is the OS's stock app and has to
look like the OS on first boot. That is a deliberate amendment, recorded in
`docs/NOTES.md`.

**Licensing.** Unlike Aquarius Cut (which is an AGPL fork of someone else's app),
every line here is Royce's own. There are no license obligations — this repo can
stay private and still ship preinstalled on the OS.
