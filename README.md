# Aquarius Writer

A local-first writing studio for **novels, notes, and screenplays**. Your writing
lives in a plain folder on your disk — real `.md` and `.fountain` files you can
copy to a thumb drive. No cloud account, no database, no lock-in.

This is the app that ships with **AquariusOS** as its stock writing/vault app —
the slot Obsidian would fill on someone else's system.

**It is free.** There are no tiers, no unlock screens and nothing held back —
every feature in the app is available to everyone who runs it.

**It has no AI of its own.** Instead it can hand the vault to whichever AI app
you already use — Claude Code, Claude Desktop — over MCP. Flip one switch in
Settings and they can read, write, re-order and file your work, using the same
operations you have in the window. See "Letting an AI app drive it" below.

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

### Way 3 — build a finished Mac app

```bash
export PATH="$HOME/.cargo/bin:$PATH"
npm run tauri:build
```

Leaves a real, double-clickable **`Aquarius Writer.app`** in
`src-tauri/target/release/bundle/macos/`. It is unsigned, so macOS will grumble
on any Mac but this one.

This can only ever build the *Mac* app. For the Linux one, see below.

---

## Where the app is right now

**The interface is built, and the desktop app now works on real folders.**

- The full UI exists — sidebar and vault tree, the prose editor, the note editor,
  the screenplay (Fountain) editor, manuscript outline and corkboard, PDF and
  image viewers, the command palette and settings.
- The **desktop app reads and writes actual files.** Point it at a folder and it
  becomes a vault: it writes `.aquarius/workflow.json`, walks the folder into the
  sidebar, saves your edits, keeps version history, moves deletions to a trash
  folder for 30 days, and notices edits you make outside the app.
- The **browser preview still runs on sample data** — it has no filesystem. That
  is the point of it: fast UI work with nothing real at risk.

- On **Linux** the app draws its own window buttons — minimise, maximise, close,
  in the top-right. It has to: the window is built without a system title bar,
  so nothing else would draw them. (An earlier version of this line said macOS
  floats its own traffic lights over ours. It does not — the Mac window has no
  buttons of its own either. `docs/NOTES.md` §15c.)

- The **MCP server** is in and switched off until you want it (Settings → MCP).
  On, an AI app on this machine can drive the vault.

It **has** now run on Linux, on AquariusOS. The first boot (2026-08-28) launched
cleanly and none of the welcome screen's three buttons worked, which is what
v0.1.1 fixes — `docs/NOTES.md` §14. The second (2026-08-29) opened workflows
fine but the window could not be dragged anywhere, which is what v0.1.2 fixes —
`docs/NOTES.md` §15. §10 is the rest of the checklist, most of which still
wants walking on a real bench.

### Starting a workflow

The welcome screen has three ways in.

**Open existing** opens a normal folder chooser. Any folder works — a folder of
markdown notes, a novel with a `Drafts/` folder, a folder of `.fountain`
scripts. Aquarius reads what is there and never rearranges it. The only thing it
adds is a hidden `.aquarius/` folder for its own bookkeeping:

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

**Create new** asks for a name and a shape — Novel, Screenplay, Worldbuilding or
Notes — then asks where to keep it, and makes the folder for you with the right
subfolders and one file to start writing in. Nothing is written to your disk
until you have chosen the location.

**Try the sample** writes a small finished-looking workflow to
`~/Documents/Aquarius/Lantern, Lantern` and opens it. It is ordinary files —
read them, edit them, or delete the folder when you are done. Pressing it again
just reopens the one you already have, and never overwrites anything you wrote
in it.

**If the folder chooser does not appear**, there is a link under the recent list
that lets you type a folder's path instead. It does exactly the same thing. It
is there because on some Linux desktops a native dialog can open behind the
window or not at all, and an app whose only way in is a dialog is unusable when
that happens.

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

`AQ_DEV_SMOKE=welcome` runs a different pass, and needs no `AQ_DEV_VAULT`: it
drives the welcome screen's own actions — the sample, all four "Create new"
shapes, the name guards, and opening a folder by path — against real folders,
and prints `ok` / `FAIL` per check (`src/lib/dev/welcome-smoke.ts`). It creates
folders under the OS temp directory and writes the sample to
`~/Documents/Aquarius/`.

### Seeing what the app is doing

The app's own window has a console that a terminal cannot see, which once made a
completely broken welcome screen produce a completely clean log. It no longer
does: anything that throws inside the interface is printed to standard error as
`[webview:error] …`, in shipped builds as well as development ones, and every
failure a button hits also appears on screen.

For more, set `AQ_WRITER_DEBUG=1` before launching. That mirrors the whole
interface console — `console.error` and `console.warn` — to the terminal too.
Two other prefixes are worth knowing when something will not open: `[dialog]`
lines bracket every folder chooser, and `[vault]` lines record every folder that
gets registered or created.

---

## Letting an AI app drive it

Aquarius Writer has no AI inside it, and that is on purpose. Instead it can open
a small door on your own machine that AI apps know how to knock on — a standard
called **MCP**. Turn it on and Claude Code (or Claude Desktop, or anything else
that speaks MCP) can read your chapters, rewrite them, re-order your manuscript,
set a chapter's status and put a draft in the trash — the same things you can do
in the window, done through the same code.

### Turning it on

1. Open **Settings** (⌘,) and click **MCP**.
2. Flick the switch to **On**. A green "listening" dot appears.
3. Copy the line it shows you and paste it into a terminal once:

   ```bash
   claude mcp add --transport http aquarius-writer http://127.0.0.1:1729/mcp
   ```

That is the whole setup. Claude Code remembers it from then on. **Aquarius
Writer has to be running** for the connection to work — the door is in the app,
so when the app is closed there is no door.

If you change the port in Settings, the URL changes with it and you would run
`claude mcp add` again with the new number.

### Is that safe?

The door only opens onto *this computer*. In network terms the app listens on
`127.0.0.1`, which is the address a machine uses to talk to itself — another
computer on your wifi cannot reach it, and neither can anything on the internet.
That is why there is no password: the only things that can knock are programs
already running as you, which could open your files directly anyway.

Two more things worth knowing:

- **Nothing can permanently delete your work through it.** The only delete an AI
  client has is the same one the app's Trash button uses: the file moves into
  `.aquarius/trash/` and can be restored for 30 days.
- **It is off unless you turn it on**, and it stays however you left it the next
  time you open the app.

### What it can do

Fifteen operations, and the rule going forward is that this list keeps pace with
the app: **if you can do it in the window, an AI client can do it too.**

| | |
|---|---|
| `list_workflows`, `get_workflow` | which vaults exist; one vault's manifest and file tree |
| `list_folder`, `search` | look around; find text across the vault |
| `read_document`, `write_document`, `create_document` | read a file, replace one, make a new one |
| `set_frontmatter_status` | mark a chapter final / drafting / rev / outline |
| `reorder_chapters` | rearrange the manuscript |
| `trash_document`, `list_trash`, `restore_document` | the reversible delete, and undoing it |
| `list_snapshots`, `read_snapshot` | read the version history (read-only) |
| `server_info` | a connectivity check |

### If something goes wrong

- **The switch turns itself back off, or shows an error.** Almost always the port
  is already taken by something else. Pick a different number in Settings.
- **Claude Code says it cannot connect.** Check the app is actually open and the
  dot in Settings says "listening".
- **You changed a file through Claude and the app is showing the old text.** The
  sidebar and the tree update immediately, but a document you had *open and
  half-edited* keeps your unsaved text, and your next save wins. Close the
  document (or save it) before handing it to an AI client.

---

## Building the Linux app

### Why your Mac can't do it

The Linux app is built against **WebKitGTK** and **GTK** — Linux system
libraries that simply do not exist on macOS. There is no flag that makes a Mac
produce a Linux app. A Linux machine has to do it.

You don't own one. GitHub rents you one for free.

### What CI will do the moment this repo is on GitHub

There is a finished instruction file waiting at
`.github/workflows/build.yml`. GitHub reads that file automatically. Every time
you push to `main` — and any time you press a button yourself — it starts two
computers:

| Machine | Builds | You get |
|---|---|---|
| Ubuntu 22.04 | the Linux app | **`Aquarius Writer_0.1.2_amd64.AppImage`** |
| macOS 14 | the Mac app | **`Aquarius Writer.app.zip`** |

An **AppImage** is the whole app in one file. You don't install it. You download
it onto the AquariusOS machine, mark it executable, and double-click it.

Each run takes roughly 10–20 minutes the first time and less afterwards.
Both files appear at the bottom of the run's page, under **Artifacts**, and are
kept for 14 days.

### What Royce has to do — the whole list

The repo has no `origin`. That is the only thing standing between you and an
AppImage. Six steps, once:

1. **Make an empty repo on GitHub.** github.com → **New repository** → name it
   `aquarius-writer`. **Private is completely fine** — there is no licence here
   forcing it open, unlike Aquarius Cut. Do **not** tick "add a README",
   "add .gitignore" or "choose a licence"; this repo already has all three and an
   empty one avoids a merge on the first push.

2. **Point this folder at it** and push. From inside this folder:

   ```bash
   git remote add origin git@github.com:<your-username>/aquarius-writer.git
   git push -u origin main
   ```

   (If GitHub asks for a password and refuses it, that is normal — GitHub
   stopped taking passwords years ago. Either set up an SSH key, or install the
   `gh` command and run `gh auth login` once, which handles it for you.)

3. **Watch it build.** Go to the repo on GitHub → the **Actions** tab. A run
   called *Build Aquarius Writer* will already be going, started by your push.

4. **Download the AppImage.** When the run finishes (green tick), scroll to the
   bottom of the run's page → **Artifacts** → `aquarius-writer-linux-appimage`.
   It downloads as a .zip; unzip it to get the `.AppImage` file.

5. **Run it on the AquariusOS machine** (the Xbox Ally or the 5090 build):

   ```bash
   chmod +x "Aquarius Writer_0.1.2_amd64.AppImage"
   ./"Aquarius Writer_0.1.2_amd64.AppImage"
   ```

6. **Tell me what broke.** This will be the first time a single line of this app
   has ever run on Linux. `docs/NOTES.md` §10 is a short list of the exact
   things worth looking at first.

To build again later without changing any code: **Actions** tab → *Build
Aquarius Writer* → **Run workflow**.

## Publishing a release

Everything above gets you a file that lives on a run's page for 14 days and
that only you can download. A **release** is the permanent, public version of
the same thing — and it is what AquariusOS actually installs from: the OS image
build downloads the AppImage from a release URL and checks it against the
release's `SHA256SUMS.txt` before baking it into the OS.

Publishing one is a tag push. Three commands:

```bash
# 1. Make sure the version is right. These three files must all agree,
#    and must match the tag you are about to push.
#      package.json            -> "version": "0.1.2"
#      src-tauri/tauri.conf.json -> "version": "0.1.2"
#      src-tauri/Cargo.toml    -> version = "0.1.2"
#
#    Four more places carry it and CI does not check any of them, so they
#    are the ones to miss: the footer in src/App.tsx, the About panel in
#    src/components/overlays/Settings.tsx, and the two lockfiles
#    (package-lock.json, src-tauri/Cargo.lock).
#
# 2. Write the release notes: add a "## v0.1.2 — <date>" section to
#    CHANGELOG.md. This becomes the release description word for word.
#    No section, no release — the workflow stops rather than publishing
#    something blank.

git push origin main
git tag v0.1.2
git push origin v0.1.2
```

That third command starts the same build as always, and then a second job takes
over. It:

1. **Checks the tag against the version in those three files** — before anything
   slow runs, so a mismatched tag fails in half a minute rather than twenty.
2. **Renames the files** to a flat, scriptable convention (tauri names the
   AppImage with a space in it, which is awkward for anything automated):

   | File | What it is |
   |---|---|
   | `AquariusWriter-0.1.2-x86_64.AppImage` | the Linux / AquariusOS build |
   | `AquariusWriter-0.1.2-arm64.zip` | the Mac build, Apple Silicon |
   | `SHA256SUMS.txt` | the fingerprints, to prove a download is intact |

3. **Publishes them as a public GitHub Release** on that tag, with your
   changelog section as the description.

It is written to be hard to get half-wrong. The release is created as a private
draft, the files are uploaded into it, and only then is it flipped public — so
nobody can ever catch it mid-upload. And it refuses to touch a release that
already exists: to genuinely redo one, delete it on GitHub first.

To check a download on the other end, put `SHA256SUMS.txt` next to the file and
run `sha256sum -c SHA256SUMS.txt`. `OK` means it is exactly what was built.

### What CI deliberately does *not* do

No code signing, no notarisation, no auto-updater. Those need your Apple
Developer account and a signing key, and they are distribution decisions, not
build ones. The TODO comments at the end of the build job spell out what each
would take.

Two consequences to expect: the **Mac** build is unsigned, so a Mac that isn't
yours will refuse to open it until you right-click → Open (the Linux AppImage
does not care), and there is no update check — a new version means downloading
a new release by hand.

---

## The plan, in stages

From `AquariusOS/docs/aquarius-writer-port-plan.md`:

| Stage | What it does | Status |
|---|---|---|
| **1** | Land the repo here, install the toolchain, prove both dev modes boot on the Mac | ✅ **done** |
| **2** | **The Rust vault backend.** Implement the 9 file operations for real: open a folder, walk the tree, read/write files with safe atomic saves, soft-delete to trash, watch for outside edits. Move version history / comments / trash off browser storage and onto disk in `.aquarius/`. | ✅ **done** |
| **3** | **The AquariusOS skin.** A third theme matching the OS design tokens, with the Sora / Inter / JetBrains Mono fonts bundled. Default on Linux; Parchment stays default on macOS. | ✅ **done** |
| **4** | **Linux identity + packaging.** Draw our own window buttons on Linux, app id `os.aquarius.writer`, desktop entry and icons, AppImage built by CI. | ✅ **done** (the AppImage waits on the GitHub repo — see below) |
| **5** | **MCP server, and no embedded AI.** Royce decided on 2026-08-25 that the app will not carry a model of its own and will not have paid tiers. So: the pricing plumbing and the Spark UI came out, and the app now speaks MCP on localhost so any AI app can drive it. | ✅ **done** |

---

## How the code is laid out

```
src/                     the interface (React + TypeScript)
  components/            every screen and panel
  components/window/     the app's own title bar + the Linux window buttons
  lib/platform.ts        "which OS am I on" — asked by the theme and the chrome
  lib/vault/             ← the important seam, see below
  lib/dev/               development-only checks (AQ_DEV_SMOKE)
  lib/logging.ts         forwards renderer errors to the terminal
  components/notices/    the on-screen failure surface
  theme/                 Parchment, Midnight + AquariusOS themes (CSS variables)
  fonts/                 the OS typefaces, bundled (Sora / Inter / JetBrains Mono)
  state/                 app state (zustand stores)
src-tauri/               the desktop shell (Rust)
  src/lib.rs             app setup + the list of commands the UI can call
  src/commands.rs        every invoke() the interface makes, in one file
  src/vault/             workflow registry, workflow.json, the folder walk
  src/vault/ops.rs       the operations the UI and the MCP server both use
  src/mcp/               the MCP server: the switch, and the 15 tools
  src/fs_ops/            saving, trash + retention, the file watcher
  src/aux_store.rs       version history / comments / searches in .aquarius/
  capabilities/          what the app is permitted to do (kept deliberately tiny)
  icons/                 the app icon, every size, from the Writer's 4K master
  linux/….desktop        the Linux application entry (menu name, icon, filetypes)
  tauri.conf.json        window size, app id, bundle targets, build commands
.github/workflows/       the GitHub build (see "Building the Linux app")
docs/HANDOFF.md          the product design contract — the law
docs/NOTES.md            where the code and the handoff disagree
docs/screenshots/        review shots, one folder per theme
scripts/nosync-link.sh   iCloud housekeeping (see below)
```

**Regenerating the icons.** Every icon comes from one 4096×4096 master, the
Swift app's own logo. If it ever changes, one command redoes the whole set:

```bash
npx tauri icon "/path/to/Branches/Apps/AquariusWriter/swift/Logo-Master-4K.png"
```

It is the Writer's own mark on purpose, not the AquariusOS logo — this is an app
in the Aquarius suite, not the operating system itself.

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
