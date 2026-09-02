#!/usr/bin/env bash
#
# One-time setup for building and running Aquarius Writer on the Linux box.
#
# WHAT THIS IS FOR. Until now the app could only be built on the Mac or in CI.
# §27l measured typing in a bare WebKitGTK window because there was no Rust
# toolchain here and the prebuilt binaries under "src-tauri/target.nosync" are
# Mach-O arm64 — Mac binaries, which a Linux machine cannot run. This script
# installs the missing half so "npm run tauri:dev" opens the real window.
#
# WHERE THIS RUNS. The Ubuntu 24.04 container named "aquarius" that the coding
# agent gets a shell in. This is NOT the AquariusOS desktop itself — AquariusOS
# is the Fedora/Bazzite system underneath, and it is immutable, so you would
# never apt-get anything there. The container is a throwaway: it shares the
# home directory and the desktop's screen, but everything installed here is
# gone when it is rebuilt, which is why this is a script and not a memory.
#
# HOW TO RUN IT:
#
#     bash scripts/linux-dev-env.sh
#
# It is safe to run twice. apt skips packages that are already installed and
# rustup skips a toolchain it already has.
#
set -euo pipefail

echo "==> 1/3  System libraries Tauri needs to compile against"

# Tauri v2 on Linux draws its window with GTK3 and renders the page with
# WebKitGTK — the same engine §27l measured. These are the "-dev" packages,
# meaning the header files a compiler needs; the runtime halves are already on
# any desktop. build-essential is the C compiler and linker, which Rust needs
# to link the final binary. patchelf and file are used by "tauri build" when it
# assembles an AppImage.
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  pkg-config \
  build-essential \
  patchelf \
  file \
  curl

echo "==> 2/3  The Rust toolchain"

# rustup installs into ~/.cargo, entirely inside the home directory — nothing
# system-wide, no root. "--no-modify-path" stops it editing shell profiles;
# this script prints the one line to add instead, so nothing changes behind
# your back.
if [ -x "$HOME/.cargo/bin/cargo" ]; then
  echo "    rustup is already installed — skipping"
else
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh
  sh /tmp/rustup-init.sh -y --default-toolchain stable --profile default --no-modify-path
fi
export PATH="$HOME/.cargo/bin:$PATH"
cargo --version

echo "==> 3/3  A build folder that is not the Mac's"

# "src-tauri/target" is a symlink to "target.nosync" (see nosync-link.sh), and
# on the Mac that folder holds Mach-O arm64 build output. Pointing Linux builds
# at the same folder would mix two architectures in one cache and confuse
# cargo. CARGO_TARGET_DIR sends Linux output somewhere else entirely. It also
# keeps a multi-gigabyte build folder off the synced drive the repo lives on,
# which is the same reason target.nosync exists in the first place.
mkdir -p "$HOME/.cache/aquarius-writer-target"

cat <<'EOF'

==> Done.

Add these two lines to ~/.bashrc so every new shell can build:

    export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
    export CARGO_TARGET_DIR="$HOME/.cache/aquarius-writer-target"

Then, once per checkout, install the JavaScript packages natively — the ones
in the repo were installed on the Mac and are the wrong architecture:

    npm ci

Check it worked:

    cd src-tauri && cargo test     # 268 tests, all green
    npm run build                  # the frontend bundle

And to open the real app window:

    npm run tauri:dev

See docs/NOTES.md §28 for the full story, including the one mistake that is
easy to make with the typing bench.
EOF
