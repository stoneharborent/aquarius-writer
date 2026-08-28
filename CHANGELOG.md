# Aquarius Writer changelog

The workflow in `.github/workflows/build.yml` reads this file. When a tag like
`v0.1.0` is pushed, it copies the matching section below into the GitHub Release
description word for word. So write these entries for the person downloading the
app, not for the person who wrote the code — and keep the heading shape exactly
as it is (`## v0.1.0 — 2026-08-28`), because that is what the workflow matches on.

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
