#!/usr/bin/env bash
# puts a (stapled) app into an electron-builder dmg in place of the one inside, keeping the dmg's layout and background,
# then signs the dmg again. used after notarizing and stapling the app, so the app people drag out of the dmg carries
# its own ticket and opens offline too.
#   scripts/mac-dmg-swap-app.sh <dmg> <app> <identity or -> [keychain]
set -euo pipefail
dmg="$1"; app="$2"; identity="$3"; keychain="${4:-}"
work="$(mktemp -d "${TMPDIR:-/tmp}/madani-dmg.XXXXXX")"
mnt="$work/mnt"
mounted=0
cleanup() { if [ "$mounted" = 1 ]; then hdiutil detach "$mnt" -force -quiet 2>/dev/null || true; fi; rm -rf "$work"; }
trap cleanup EXIT
# lzma (ULMO, macOS 10.15+) is about 30% smaller than electron-builder's zlib dmg; electron-builder 26 cannot write it
format="${MADANI_DMG_FORMAT:-ULMO}"
rw="$work/rw.dmg"
hdiutil convert "$dmg" -format UDRW -o "$rw" -quiet
# room for the ticket and any size drift: 20 MB more than the current size
sectors="$(hdiutil resize -limits "$rw" 2>/dev/null | awk 'NR==1{print $2}')"
hdiutil resize -sectors $((sectors + 40960)) "$rw" -quiet 2>/dev/null
mkdir -p "$mnt"
hdiutil attach "$rw" -nobrowse -noautoopen -noverify -mountpoint "$mnt" -quiet
mounted=1
name="$(basename "$app")"
[ -d "$mnt/$name" ] || { echo "error: $dmg has no $name to replace" >&2; exit 1; }
rm -rf "${mnt:?}/$name"
ditto "$app" "$mnt/$name"
hdiutil detach "$mnt" -quiet
mounted=0
rm -f "$dmg"
hdiutil convert "$rw" -format "$format" -o "$dmg" -quiet
if [ "$identity" = "-" ]; then
  codesign --force --sign - "$dmg"
else
  codesign --force --sign "$identity" ${keychain:+--keychain "$keychain"} --timestamp "$dmg"
fi
echo "repacked $(basename "$dmg") ($format) with $(basename "$app")"
