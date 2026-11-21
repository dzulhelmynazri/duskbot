#!/bin/sh
# installs the latest madani bot on a mac: curl -fsSL https://madani.bot/install-mac | sh
# downloads this mac's build of the newest release, checks it against the release's SHA256SUMS (which latest.json
# vouches for), puts Madani Bot.app in /Applications (or ~/Applications when that is not writable) and opens it.
# until the app is notarized this is the way in without the "open anyway" step: a file curl downloads carries no
# quarantine flag, so macos does not stop it. MADANI_SITE overrides where the release is read from.
set -eu

SITE="${MADANI_SITE:-https://madani.bot}"
DOWNLOADS="https://github.com/dzulhelmynazri/madani-bot-releases/releases/download"
APP="Madani Bot.app"

say() { printf '%s\n' "$*"; }
fail() { printf 'madani bot: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "this installer is for a mac. other systems: $SITE/download"
# an intel shell under rosetta still gets the apple silicon build on an m-series mac
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; else arch=x64; fi

work=$(mktemp -d "${TMPDIR:-/tmp}/madani-install.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

say "Checking the newest release"
curl -fsSL --proto '=https' "$SITE/releases/latest.json" -o "$work/latest.json" || fail "could not reach $SITE"
version=$(sed -n 's/.*"version": *"\([0-9][0-9.]*\)".*/\1/p' "$work/latest.json" | head -n 1)
want=$(sed -n 's/.*"sha256sums": *"\([0-9a-f]\{64\}\)".*/\1/p' "$work/latest.json" | head -n 1)
[ -n "$version" ] && [ -n "$want" ] || fail "the release notes from $SITE look wrong; try again later"
curl -fsSL --proto '=https' "$SITE/releases/$version/SHA256SUMS" -o "$work/SHA256SUMS" || fail "could not get the checksums"
[ "$(shasum -a 256 "$work/SHA256SUMS" | cut -d ' ' -f 1)" = "$want" ] || fail "the checksums do not match the release; nothing was installed"

file="MadaniBot-$version-$arch.zip"
sum=$(awk -v f="$file" '$2 == f { print $1 }' "$work/SHA256SUMS")
[ -n "$sum" ] || fail "release $version has no $file"

say "Downloading madani bot $version ($arch)"
curl -fL --proto '=https' --progress-bar "$DOWNLOADS/v$version/$file" -o "$work/$file" || fail "the download stopped; run the line again"
[ "$(shasum -a 256 "$work/$file" | cut -d ' ' -f 1)" = "$sum" ] || fail "the download does not match its checksum; nothing was installed"

ditto -x -k "$work/$file" "$work/app"
[ -d "$work/app/$APP" ] || fail "the download has no $APP"
codesign --verify --deep --strict "$work/app/$APP" 2>/dev/null || fail "the app's signature does not verify; nothing was installed"

dest=/Applications
[ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
if pgrep -xq "Madani Bot"; then
  say "Closing madani bot to update it"
  osascript -e 'quit app "Madani Bot"' >/dev/null 2>&1 || true
  i=0; while pgrep -xq "Madani Bot" && [ $i -lt 20 ]; do sleep 1; i=$((i + 1)); done
  pgrep -xq "Madani Bot" && fail "madani bot is still open; quit it and run the line again"
fi
rm -rf "$dest/$APP.old"
[ -e "$dest/$APP" ] && mv "$dest/$APP" "$dest/$APP.old"
if ! mv "$work/app/$APP" "$dest/$APP"; then
  [ -e "$dest/$APP.old" ] && mv "$dest/$APP.old" "$dest/$APP"
  fail "could not write to $dest"
fi
rm -rf "$dest/$APP.old"
xattr -dr com.apple.quarantine "$dest/$APP" 2>/dev/null || true

say "Installed madani bot $version in $dest. Opening it."
open "$dest/$APP"
