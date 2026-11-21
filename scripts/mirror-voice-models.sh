#!/usr/bin/env bash
# puts the built-in voice's model files on madani.bot (https://madani.bot/voice/<sha256>/<name>, served by
# apps/site/release-mirror.js), so a first call never depends on Hugging Face or GitHub. the list, the pinned upstream
# addresses and the hashes come from server/local-voice/models.ts; the server fetches each file itself and keeps it
# only when its size and sha256 match. run on the Mac after the site with the /voice route is deployed:
#   scripts/mirror-voice-models.sh
# env: MIRROR_HOST (ssh host, default contabo), VOICE_MIRROR_ROOT (default /var/lib/madani-voice).
set -euo pipefail
cd "$(dirname "$0")/.."

manifest=$(node --experimental-strip-types --no-warnings --input-type=module -e '
  const { MODEL_FILES } = await import("./server/local-voice/models.ts");
  for (const f of MODEL_FILES) console.log([f.sha256, f.path.split("/").pop(), f.bytes, f.url].join(" "));
')
echo "$manifest" | awk '{ s += $3 } END { printf "%d files, %d MB\n", NR, s / 1048576 }'

ssh "${MIRROR_HOST:-contabo}" env ROOT="${VOICE_MIRROR_ROOT:-/var/lib/madani-voice}" MANIFEST="$(printf '%s' "$manifest" | base64 | tr -d '\n')" bash -s <<'REMOTE'
set -euo pipefail
mkdir -p "$ROOT"
incoming="$ROOT/.incoming"
rm -rf "$incoming"; mkdir -p "$incoming"
trap 'rm -rf "$incoming"' EXIT
echo "$MANIFEST" | base64 -d > "$incoming/manifest"
while read -r sha name bytes url; do
  [ -n "$sha" ] || continue
  [[ "$sha" =~ ^[0-9a-f]{64}$ && "$name" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || { echo "bad entry: $sha $name" >&2; exit 1; }
  if [ -f "$ROOT/$sha/$name" ] && [ "$(sha256sum "$ROOT/$sha/$name" | cut -d' ' -f1)" = "$sha" ]; then echo "have $name"; continue; fi
  curl -fsSL --retry 5 --retry-all-errors -o "$incoming/$name" "$url"
  got=$(sha256sum "$incoming/$name" | cut -d' ' -f1)
  size=$(stat -c %s "$incoming/$name")
  if [ "$got" != "$sha" ] || [ "$size" != "$bytes" ]; then echo "refused $name: sha256 $got, $size bytes" >&2; exit 1; fi
  mkdir -p "$ROOT/$sha"
  mv "$incoming/$name" "$ROOT/$sha/$name"
  chmod 755 "$ROOT/$sha"; chmod 644 "$ROOT/$sha/$name"
  echo "ok $name ($((size / 1048576)) MB)"
done < "$incoming/manifest"
du -sh "$ROOT"
REMOTE

echo "$manifest" | while read -r sha name bytes url; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -I "https://madani.bot/voice/$sha/$name")
  echo "https://madani.bot/voice/$sha/$name -> $code"
done
