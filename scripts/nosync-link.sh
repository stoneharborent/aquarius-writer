#!/usr/bin/env bash
#
# iCloud hygiene for this repo.
#
# This folder lives inside iCloud Drive. iCloud will happily try to upload a
# 150 MB node_modules folder or a multi-gigabyte Rust build folder, which is
# slow, wasteful, and occasionally corrupts builds.
#
# iCloud skips anything whose name ends in ".nosync". So the real folders are
# named "node_modules.nosync" and "src-tauri/target.nosync", and the names the
# tools expect ("node_modules", "src-tauri/target") are symlinks pointing at
# them.
#
# npm rebuilds "node_modules" as a real folder every time it installs, which
# breaks the symlink. This script puts it back. It runs automatically after
# "npm install" (see the "postinstall" script in package.json), and you can run
# it by hand any time with:
#
#     npm run nosync
#
set -euo pipefail

cd "$(dirname "$0")/.."

relink() {
  link="$1"
  real="$1.nosync"

  if [ -L "$link" ]; then
    # Already a symlink. Just make sure it points somewhere real.
    mkdir -p "$real"
    return
  fi

  if [ -d "$link" ]; then
    # A real folder is sitting where the symlink should be (npm just made it).
    # The real folder is the fresh one, so it wins: drop any stale .nosync copy
    # and move this one into its place.
    rm -rf "$real"
    mv "$link" "$real"
  else
    mkdir -p "$real"
  fi

  ln -s "$(basename "$real")" "$link"
  echo "nosync: $link -> $(basename "$real")"
}

relink "node_modules"
relink "src-tauri/target"
