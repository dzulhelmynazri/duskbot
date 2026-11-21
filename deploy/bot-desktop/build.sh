#!/bin/sh
# builds the bot desktop image for this machine's architecture, tagged the way the app looks for it.
#   deploy/bot-desktop/build.sh                 local build, tag from BOT_DESKTOP_IMAGE in shared/bot-desktop.ts
#   deploy/bot-desktop/build.sh --push          multi-arch (amd64 + arm64) build pushed to the registry (needs buildx)
#   IMAGE=ghcr.io/me/madani-desktop:v6 deploy/bot-desktop/build.sh
# runs anywhere this folder is: on a VPS copy deploy/bot-desktop/ over and run it there (only docker is needed).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
constants="$here/../../shared/bot-desktop.ts"
read_const() { sed -n "s/^export const $1 = \"\\(.*\\)\";.*/\\1/p" "$constants" 2>/dev/null | head -n 1; }

version="${BOT_DESKTOP_VERSION:-$(read_const BOT_DESKTOP_VERSION)}"
version="${version:-6}"
image="${IMAGE:-$(read_const BOT_DESKTOP_IMAGE)}"
image="${image:-ghcr.io/madanibotai/madani-desktop:v$version}"
resolution="${MADANI_RESOLUTION:-1280x800}"

start="$(date +%s)"
if [ "${1:-}" = "--push" ]; then
  docker buildx build --platform linux/amd64,linux/arm64 \
    --build-arg BOT_DESKTOP_VERSION="$version" --build-arg RESOLUTION="$resolution" \
    -t "$image" --push "$here"
else
  docker build --build-arg BOT_DESKTOP_VERSION="$version" --build-arg RESOLUTION="$resolution" -t "$image" "$here"
fi
echo "built $image in $(( $(date +%s) - start ))s"
