#!/usr/bin/env python3
"""
Ask a browser engine to paint colour emoji, and see whether it survives.

This exists because of the bug in docs/NOTES.md §29: the Linux download used to
quit the moment it was asked to draw a colour emoji, and there was no way to
drive the app's own window from a script to prove it (§29c). So this drives the
*engine* instead — a bare WebKitGTK window, one page of emoji, and a handler
that says out loud when the engine's rendering process dies.

It prints exactly one of:

    PROBE: survived paint              — good
    PROBE: WEB PROCESS TERMINATED …    — the engine died painting emoji

Run it against the engine on this machine:

    GDK_BACKEND=x11 python3 scripts/emoji-probe.py

Run it against the engine inside a downloaded AppImage — the whole point —
by staging that copy's libraries and launching from a directory that has the
engine's helper processes underneath it, because the path to those is baked in
as a *relative* one (§29c):

    stage=/tmp/wklib   root=/tmp/wkroot
    mkdir -p "$stage" "$root/lib/x86_64-linux-gnu/webkit2gtk-4.1"
    app=~/.local/share/aquarius/aquarius-writer/versions/<version>
    cp -a "$app"/usr/lib/lib{webkit2gtk-4.1,javascriptcoregtk-4.1}.so.0 \
          "$app"/usr/lib/libicu*.so.* "$app"/usr/lib/libwoff2*.so.* "$stage"/
    cp -a "$app"/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/. \
          "$root/lib/x86_64-linux-gnu/webkit2gtk-4.1/"
    cd "$root" && LD_LIBRARY_PATH="$stage" GDK_BACKEND=x11 \
      python3 <path to>/emoji-probe.py

Two knobs, both optional:

    PROBE_FONT   the font to name outright. Defaults to "Noto Color Emoji",
                 which is the COLRv1 one AquariusOS has and the one that used
                 to crash. Naming it matters: left to its own devices the
                 engine may fall back to a different emoji font and paint
                 happily, which is a false all-clear (§29c, dead end two).
    PROBE_CHARS  the characters to paint. Defaults to a sweep of the emoji
                 Royce's vault documents actually use.
    PROBE_SECS   how long to leave the window up before calling it survived.

Needs python3-gi and the WebKit2 4.1 typelib, both already present on the
Linux dev box (docs/NOTES.md §28b).
"""

import os

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402  (must follow require_version)

FONT = os.environ.get("PROBE_FONT", "Noto Color Emoji")
CHARS = os.environ.get(
    "PROBE_CHARS", "🧠🏗️🧭💾⚡🎯👤🎬🚀✅☑️🔥💡📊🐛😀"
)
SECONDS = int(os.environ.get("PROBE_SECS", "8"))

rows = "".join(
    f"<p style='font-family:\"{FONT}\";font-size:40px'>{c} U+{ord(c[0]):04X}</p>"
    for c in CHARS
)
HTML = (
    f"<html><body style='background:#fff'>"
    f"<h1 style='font:24px sans-serif'>{FONT}</h1>{rows}</body></html>"
)

window = Gtk.Window(title="emoji-probe")
window.set_default_size(900, 700)
view = WebKit2.WebView()
window.add(view)
window.show_all()
view.load_html(HTML, "file:///")


def survived():
    print("PROBE: survived paint", flush=True)
    Gtk.main_quit()
    return False


def terminated(_view, reason):
    print(f"PROBE: WEB PROCESS TERMINATED ({reason})", flush=True)
    Gtk.main_quit()


view.connect("web-process-terminated", terminated)
GLib.timeout_add_seconds(SECONDS, survived)
Gtk.main()
