# Aquarius Writer changelog

The workflow in `.github/workflows/build.yml` reads this file. When a tag like
`v0.1.0` is pushed, it copies the matching section below into the GitHub Release
description word for word. So write these entries for the person downloading the
app, not for the person who wrote the code — and keep the heading shape exactly
as it is (`## v0.1.0 — 2026-08-28`), because that is what the workflow matches on.

## v0.1.1 — 2026-08-28

The first-Linux-boot fix round. v0.1.0 started up cleanly on AquariusOS and then
could not actually be used: the three buttons on the welcome screen — **Open
existing**, **Create new** and **Try the sample** — did nothing at all, and said
nothing about why. All three now work, and the app has learned how to tell you
when something goes wrong.

### The three dead buttons

- **Open existing** now opens the folder chooser. It never did: the button had
  no action attached to it. The folder chooser itself, and everything behind it,
  was already written and working.
- **Create new** now exists. Give the workflow a name, pick a shape — Novel,
  Screenplay, Worldbuilding or Notes — and choose where to keep it, and Aquarius
  makes the folder with the right subfolders and a first file to open. Nothing is
  written until you have chosen the location.
- **Try the sample** now writes a real sample workflow to
  `~/Documents/Aquarius/Lantern, Lantern` and opens it. Four chapters, a few
  character and worldbuilding notes, and a screenplay scene — all ordinary files
  you can read, edit or delete outside the app. Pressing it again just reopens
  the one you already have; it never overwrites anything you wrote in it.

### Failures are visible now

- **A message appears when something fails.** Every one of these actions used to
  fail silently — the app knew the reason and had nowhere to say it. Failures now
  appear in the bottom-right corner with the actual reason, and are written to
  the terminal as well, so a log taken on the day tells you what happened.
- **Uncaught errors reach the log.** Anything that goes wrong inside the app's
  own window is printed to standard error, which is where the OS keeps it. Run
  with `AQ_WRITER_DEBUG=1` to get the app's whole internal console there too.
- **The folder chooser leaves a trail.** Opening and closing it is logged, so
  "the dialog never appeared" can be told apart from "I closed it".
- **If the folder chooser doesn't appear**, there is now another way in: a link
  on the welcome screen lets you type the path to a folder instead. It is offered
  automatically if a chooser has been open for a suspiciously long time.

### Also

- A popped-out document window opens the workflow you actually have open, rather
  than looking for a demo workflow that only exists in the browser preview.
- The welcome screen says something useful when you have no workflows yet.

Everything above is verified on macOS. What still needs a Linux bench is whether
the **folder chooser itself** behaves inside an extracted AppImage — that one
step needs a real desktop, and it is the first thing to try. The rest of
`docs/NOTES.md` §10 is unchanged and still wants walking.

## v0.1.0 — 2026-08-28

The first public build of Aquarius Writer, and the first one that ships as a
finished file you can download and run. It is the stock writing app of
AquariusOS.

This is a pre-1.0 release. It is genuinely usable for writing — and there are
real gaps, listed below. Nothing here is hidden.

### What it is

A local-first writing studio for novels, notes and screenplays. You point it at
a folder on your disk and that folder *is* the document: plain Markdown and
Fountain files you can open in any other app, back up yourself, or put in git.
There is no account, no cloud, and nothing phones home.

### What works

- **Open a folder and write.** The app reads the folder, works out whether it is
  a novel, a screenplay or a pile of notes, and lays itself out to match.
- **Markdown and Fountain**, with screenplay formatting applied as you type.
- **Autosave, plus a version trail** — every save keeps the previous text, so a
  bad afternoon is recoverable.
- **A word-count and status view** over the whole manuscript.
- **Three themes**, including the AquariusOS skin the OS ships with.
- **An MCP server, off by default.** Turn it on in Settings and any MCP-capable
  AI app — Claude Code among them — can read and edit the vault through fifteen
  tools. It listens on `127.0.0.1` only, so nothing outside your own machine can
  reach it. See the README's "Letting an AI app drive it".

### What does not work yet

These are known and tracked in `docs/NOTES.md`. They are product gaps, not
crashes:

- **You cannot create or rename a file from inside the app.** Nine vault
  operations exist and none of them create or rename, and the interface has no
  button for it either. Make and rename files in your file manager for now.
  (`docs/NOTES.md` §8)
- **Conflicting edits are not caught.** If you edit a document in Aquarius
  Writer and something else changes the same file at the same time, the app's
  copy wins on the next save. The previous text is kept in the version trail, so
  nothing is lost — but the dialog that should stop and ask you is built and not
  yet wired up. (`docs/NOTES.md` §8)
- **Daily writing history is not recorded.** Nothing writes the per-day word
  counts the Today panel is meant to show. (`docs/NOTES.md` §8)
- **Chapter reordering does not stick** when you drag it in the sidebar. Doing it
  over MCP does. (`docs/NOTES.md` §13h, §13j)
- **An AI's edit is not snapshotted.** Writes the app makes itself keep a
  version; writes an MCP client makes replace the file without recording what
  was there first. (`docs/NOTES.md` §13j)

### About the Linux build specifically

**This is the first time this app has ever run on Linux.** Every line of it was
written and tested on a Mac; the AppImage is built on GitHub's Ubuntu machines
and has been compiled, not used. `docs/NOTES.md` §10 is a seven-item checklist of
exactly what is most likely to be wrong — window resizing, the sidebar blur, how
images load — and what to look at when it is. Please walk it and report back.

The AppImage is not signed, and neither is the Mac build. On a Mac that is not
Royce's, macOS will refuse to open it until you right-click → Open. Linux does
not care.

There is no auto-updater. New versions arrive as new releases here.
