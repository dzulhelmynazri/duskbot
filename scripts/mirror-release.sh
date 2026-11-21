#!/usr/bin/env bash
# puts a published release's installers and mac update zips on madani.bot (https://madani.bot/releases/<version>/<name>,
# served by apps/site/release-mirror.js), so updates and downloads never depend on GitHub alone. run on the Mac after
# publish-downloads.sh; the server fetches each file from the public downloads release itself, keeps it only when its
# sha256 is in that release's SHA256SUMS (itself checked against the signed latest.json when it is the latest), names
# it as SHA256SUMS does, and keeps the newest MIRROR_KEEP versions. the mac browser parts are not in SHA256SUMS (the app
# pins their digest in parts.json and checks it itself), so each is kept only when its sha256 is GitHub's digest of it.
#   scripts/mirror-release.sh v0.2.15
# env: MIRROR_HOST (ssh host, default contabo), MIRROR_ROOT (default /var/lib/madani-releases), MIRROR_KEEP (default 3),
# MIRROR_SPARE_GB (free space left after the copy, default 10), MADANI_DOWNLOADS_REPO.
set -euo pipefail

TAG="${1:?usage: mirror-release.sh v<version>}"
VERSION="${TAG#v}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a release tag: $TAG" >&2; exit 2; }

ssh "${MIRROR_HOST:-contabo}" env VERSION="$VERSION" ROOT="${MIRROR_ROOT:-/var/lib/madani-releases}" KEEP="${MIRROR_KEEP:-3}" SPARE_GB="${MIRROR_SPARE_GB:-10}" \
  REPO="${MADANI_DOWNLOADS_REPO:-dzulhelmynazri/madani-bot-releases}" bash -s <<'REMOTE'
set -euo pipefail
mkdir -p "$ROOT"
incoming="$ROOT/.incoming-$VERSION"
rm -rf "$incoming"; mkdir -p "$incoming/files"
trap 'rm -rf "$incoming"' EXIT

curl -fsSL --retry 3 "https://madani.bot/releases/$VERSION/SHA256SUMS" -o "$incoming/SHA256SUMS"
curl -fsSL --retry 3 "https://madani.bot/releases/latest.json" -o "$incoming/latest.json"
python3 - "$incoming" "$VERSION" <<'PY'
import hashlib, json, sys
d, v = sys.argv[1], sys.argv[2]
m = json.load(open(f"{d}/latest.json"))
if m.get("version") == v and hashlib.sha256(open(f"{d}/SHA256SUMS", "rb").read()).hexdigest() != m.get("sha256sums"):
    sys.exit("SHA256SUMS does not match latest.json")
PY

curl -fsSL --retry 3 "https://api.github.com/repos/$REPO/releases/tags/v$VERSION" -o "$incoming/release.json"
python3 - "$incoming" > "$incoming/assets.tsv" <<'PY'
import json, sys
for a in json.load(open(f"{sys.argv[1]}/release.json"))["assets"]:
    n = a["name"]
    if n == "SHA256SUMS" or n == "latest.json": continue
    digest = a.get("digest") or ""
    if "-browser-" in n and not digest.startswith("sha256:"): continue
    print(f'{n}\t{a["size"]}\t{a["browser_download_url"]}\t{digest.removeprefix("sha256:") if "-browser-" in n else ""}')
PY

need=$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$incoming/assets.tsv")
free=$(df --output=avail -B1 "$ROOT" | tail -1)
spare=$((SPARE_GB * 1024 * 1024 * 1024))
if [ $((free - need)) -lt "$spare" ]; then
  echo "not enough disk: $((need / 1048576)) MB needed, $((free / 1048576)) MB free, $SPARE_GB GB must stay free" >&2; exit 1
fi
echo "mirroring $(wc -l < "$incoming/assets.tsv") files, $((need / 1048576)) MB, $((free / 1073741824)) GB free"

while IFS=$'\t' read -r name size url pinned; do
  curl -fsSL --retry 5 --retry-all-errors -o "$incoming/$name" "$url"
  sum=$(sha256sum "$incoming/$name" | cut -d' ' -f1)
  if [ -n "$pinned" ]; then real=$([ "$sum" = "$pinned" ] && echo "$name" || true)
  else real=$(awk -v s="$sum" '$1 == s { print $2; exit }' "$incoming/SHA256SUMS"); fi
  if [ -z "$real" ]; then echo "skip $name: its sha256 is not in SHA256SUMS" >&2; rm -f "$incoming/$name"; continue; fi
  mv "$incoming/$name" "$incoming/files/$real"
  echo "ok $real ($((size / 1048576)) MB)"
done < "$incoming/assets.tsv"

[ -n "$(ls "$incoming/files")" ] || { echo "nothing matched SHA256SUMS" >&2; exit 1; }
chmod 644 "$incoming/files"/*; chmod 755 "$incoming/files"
rm -rf "$ROOT/$VERSION.old"; [ -d "$ROOT/$VERSION" ] && mv "$ROOT/$VERSION" "$ROOT/$VERSION.old"
mv "$incoming/files" "$ROOT/$VERSION"; rm -rf "$ROOT/$VERSION.old"
ls "$ROOT" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | head -n -"$KEEP" | while read -r old; do echo "drop $old"; rm -rf "${ROOT:?}/$old"; done
echo "mirrored $VERSION: $(ls "$ROOT/$VERSION" | tr '\n' ' ')"
df -h "$ROOT" | tail -1
REMOTE

for name in $(ssh "${MIRROR_HOST:-contabo}" ls "${MIRROR_ROOT:-/var/lib/madani-releases}/$VERSION"); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -I "https://madani.bot/releases/$VERSION/$name")
  echo "https://madani.bot/releases/$VERSION/$name -> $code"
done
