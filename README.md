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

**The interface is built, and the desktop app now works on real folders.**

- The full UI exists — sidebar and vault tree, the prose editor, the note editor,
  the screenplay (Fountain) editor, manuscript outline and corkboard, PDF and
  image viewers, the Spark panel, command palette, settings, pricing dialogs.
- The **desktop app reads and writes actual files.** Point it at a folder and it
  becomes a vault: it writes `.aquarius/workflow.json`, walks the folder into the
  sidebar, saves your edits, keeps version history, moves deletions to a trash
  folder for 30 days, and notices edits you make outside the app.
- The **browser preview still runs on sample data** — it has no filesystem. That
  is the point of it: fast UI work with nothing real at risk.

What is *not* done yet: the AquariusOS look (Stage 3), Linux window buttons and
packaging (Stage 4), and Spark (Stage 5).

### Opening a folder

In the desktop app, "add a workflow" opens a normal macOS folder picker. Any
folder works — a folder of markdown notes, a novel with a `Drafts/` folder, a
folder of `.fountain` scripts. Aquarius reads what is there and never rearranges
it. The only thing it adds is a hidden `.aquarius/` folder for its own
bookkeeping:

```
Your Folder/
  .aquarius/
    workflow.json          what this vault is, and its chapter order
    snapshots/…            version history, as plain readable markdown
    comments.json          margin comments
    trash/                 deleted files, kept 30 days, then swept
  Drafts/Ch_01.md          ← your writing, untouched
```

Delete `.aquarius/` and you lose the history, not the writing.

**A save never rewrites a file that didn't change.** If you open a note with no
frontmatter, it will still have no frontmatter afterwards — right down to the
file's timestamp being untouched.

### Opening a folder without the picker (for development)

The folder dialog needs a human to click it, which makes automated checks
awkward. So the app can also be pointed at a folder from the command line:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
AQ_DEV_VAULT="/path/to/some/folder" npm run tauri:dev
```

It opens that folder on launch. Add `AQ_DEV_SMOKE=1` and it also runs a scripted
pass over every backend operation (`src/lib/dev/smoke.ts`) and prints the results
in the terminal — useful for proving the backend still works after a change.
**That pass edits and deletes files in the folder it is given, so point it at a
scratch copy, never at real writing.** Both are development-only.

---

## The plan, in stages

From `AquariusOS/docs/aquarius-writer-port-plan.md`:

| Stage | What it does | Status |
|---|---|---|
| **1** | Land the repo here, install the toolchain, prove both dev modes boot on the Mac | ✅ **done** |
| **2** | **The Rust vault backend.** Implement the 9 file operations for real: open a folder, walk the tree, read/write files with safe atomic saves, soft-delete to trash, watch for outside edits. Move version history / comments / trash off browser storage and onto disk in `.aquarius/`. | ✅ **done** |
| **3** | **The AquariusOS skin.** A third theme matching the OS design tokens, with the Sora / Inter / JetBrains Mono fonts bundled. Default on Linux; Parchment stays default on macOS. | ✅ **done** |
| **4** | **Linux identity + packaging.** Draw our own window buttons on Linux, app id `os.aquarius.writer`, desktop entry and icons, AppImage built by CI. | next |
| **5** | **Spark on Linux.** Local model lifecycle (Ollama is Linux-native), provider routing, and the rule that every feature is drivable by Spark. | last |

---

## How the code is laid out

```
src/                     the interface (React + TypeScript)
  components/            every screen and panel
  lib/vault/             ← the important seam, see below
  lib/dev/smoke.ts       development-only backend check (AQ_DEV_SMOKE)
  theme/                 Parchment, Midnight + AquariusOS themes (CSS variables)
  fonts/                 the OS typefaces, bundled (Sora / Inter / JetBrains Mono)
  state/                 app state (zustand stores)
src-tauri/               the desktop shell (Rust)
  src/lib.rs             app setup + the list of commands the UI can call
  src/commands.rs        every invoke() the interface makes, in one file
  src/vault/             workflow registry, workflow.json, the folder walk
  src/fs_ops/            saving, trash + retention, the file watcher
  src/aux_store.rs       version history / comments / searches in .aquarius/
  capabilities/          what the app is permitted to do (kept deliberately tiny)
  tauri.conf.json        window size, app id, build commands
docs/HANDOFF.md          the product design contract — the law
docs/NOTES.md            where the code and the handoff disagree
scripts/nosync-link.sh   iCloud housekeeping (see below)
```

**The seam that matters:** `src/lib/vault/service.ts` defines nine methods.
`browser-service.ts` implements them with fake data (the browser preview).
`tauri-service.ts` implements them by calling into Rust (the desktop app).
`index.ts` picks whichever one fits where the app is running. Nothing else in the
app knows or cares which is in use — that's the whole design. Version history,
comments and trash follow the same pattern in `aux-store.ts`.

**Testing the Rust side:**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test
```

Everything that could quietly lose a writer's work — the folder walk, saves,
trash and its 30-day sweep, `workflow.json` — is covered there and runs in about
a second, with no app window involved.

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
Stage 3 added a third, AquariusOS, because the app is the OS's stock app and has to
look like the OS on first boot. It is the default on Linux; Parchment is still the
default everywhere else, and all three are selectable anywhere. Parchment and
Midnight are untouched. That is a deliberate amendment, recorded in
`docs/NOTES.md` §2 — which also explains why the writing page inside the dark
chrome is deliberately not pure black, the decision Royce is asked to sign off on
from `docs/screenshots/`.

**Licensing.** Unlike Aquarius Cut (which is an AGPL fork of someone else's app),
every line of code here is Royce's own — this repo can stay private and still ship
preinstalled on the OS. The one obligation comes from the three bundled typefaces
in `src/fonts/`: Sora, Inter and JetBrains Mono are all SIL Open Font License 1.1,
which means their licence files travel with the app (they are in that folder) and
the font files themselves can't be sold on their own. Nothing about OFL touches
the app's own code or price.
