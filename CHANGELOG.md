# Aquarius Writer changelog

The workflow in `.github/workflows/build.yml` reads this file. When a tag like
`v0.1.0` is pushed, it copies the matching section below into the GitHub Release
description word for word. So write these entries for the person downloading the
app, not for the person who wrote the code — and keep the heading shape exactly
as it is (`## v0.1.0 — 2026-08-28`), because that is what the workflow matches on.

## v0.2.0 — 2026-08-29

Aquarius Writer can update itself on AquariusOS.

### Updates, in Settings → About

- **There is an Updates section now.** Open Settings (⌘, or the gear at the
  bottom right), go to **About**, and it tells you whether you have the newest
  version. If you don't, one button downloads it and one button restarts into
  it. That is the whole feature.
- **It looks for a new version once, quietly, when the app starts.** It never
  downloads anything on its own and it never restarts you — a download is one
  deliberate press, and the new version waits until *you* pick a good moment to
  restart. If the machine is offline the check says nothing at all rather than
  greeting you with a complaint. **Check for updates** is always there when you
  want to ask.
- **A download is proved genuine before it is used.** Every release publishes a
  checksum file — a fingerprint of each file in it — and the app compares the
  download against it. A file that doesn't match is deleted and never run.
- **A failed update leaves you exactly where you were.** The copy of Aquarius
  Writer that came with AquariusOS is never touched. Everything happens in a
  scratch folder off to one side, and the switch to the new version is the very
  last step. Lose your connection halfway through and you simply carry on with
  the version you already have; press the button again whenever you like.
- **Old downloads are cleaned up.** Only the version you are running and the one
  you just installed are kept, so this cannot slowly fill a handheld's disk.

### Only on AquariusOS

- **On a Mac, or on a Linux PC where you ran the AppImage yourself, none of this
  appears** — the Updates section is simply not drawn. Those copies are updated
  the way you installed them: download the newest release and replace the file.
  Nothing about them changed in this release.

### An honest note about upgrading to this version

**A copy of Aquarius Writer older than v0.2.0 cannot update itself**, because
the feature you are reading about did not exist in it yet. There is nothing to
press. Those installs get v0.2.0 the way they got v0.1.2 — through an AquariusOS
system update, which brings a fresh copy of the app with it. **That is a
one-time thing:** once v0.2.0 is what is running, every version after it can be
installed from inside the app.

### Smaller things

- **The version number shown in the app is now the real one.** The status bar
  and the About panel each had "v0.1.2" typed into them by hand, which is the
  sort of thing that quietly goes stale. Both now read the number the app was
  actually built with.

## v0.1.2 — 2026-08-29

The window moves now.

### You can drag the window again

- **Dragging the title bar moves the window.** On the AquariusOS bench the
  window was stuck wherever it opened: press the title bar, pull, and nothing
  happened. Aquarius draws its own title bar rather than letting the desktop
  draw one, and the part of the app that turns a pull on that bar into a moved
  window had never been switched on. It is on.
- **The three window buttons work.** Minimise, maximise and close — the small
  controls at the top right on Linux — were refused in exactly the same way and
  by exactly the same cause. Nobody had reported them yet; they would have been
  the next thing to go wrong.
- **Double-clicking the title bar still maximises**, as it always did. That one
  happened to be allowed, which is the clue that found the rest: the same bar
  answered a double click and ignored a drag.
- **macOS gets the fix too.** The window there could not be dragged either, for
  the same reason — it was simply never the thing being tested. Note for the
  Mac: that build still has no close or minimise button of its own. ⌘Q and ⌘M
  work, and giving it real buttons is a change to how the Mac app looks, so it
  is a decision rather than a hotfix. It is written up in `docs/NOTES.md` §15c.

Nothing else changed. No file, editor, vault or MCP behaviour is touched by this
release — it is four lines of window permission and the notes that explain them.

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
