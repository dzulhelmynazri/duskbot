#!/usr/bin/env bash
# puts a published release where people download it: the installers on the public downloads repo's release (stable
# /releases/latest/download/ links), and the signed latest.json and SHA256SUMS on madani.bot through the deployd landing
# site. run on the Mac after Release published v<version>.
#   scripts/publish-downloads.sh v0.1.142
# env: MADANI_DOWNLOADS_REPO (public, default dzulhelmynazri/madani-bot-releases), MADANI_SOURCE_REPO (private, the
# release's home), SITE_DIR (default apps/site in this repo), DRY_RUN=1 to stop before uploading.
set -euo pipefail

TAG="${1:?usage: publish-downloads.sh v<version>}"
VERSION="${TAG#v}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a release tag: $TAG" >&2; exit 2; }
SOURCE="${MADANI_SOURCE_REPO:-dzulhelmynazri/madani-bot}"
DOWNLOADS="${MADANI_DOWNLOADS_REPO:-dzulhelmynazri/madani-bot-releases}"
SITE="${SITE_DIR:-$(cd "$(dirname "$0")/.." && pwd)/apps/site}"
work=$(mktemp -d "${TMPDIR:-/tmp}/madani-publish.XXXXXX")
trap 'rm -rf "$work"' EXIT

[ "$(gh release view "$TAG" --repo "$SOURCE" --json isDraft --jq .isDraft)" = false ] || { echo "$TAG is still a draft in $SOURCE; publish it first" >&2; exit 1; }
gh release download "$TAG" --repo "$SOURCE" --dir "$work/assets"

# the release run that built this tag left the signed manifest as its madani-site artifact
sha=$(gh release view "$TAG" --repo "$SOURCE" --json targetCommitish --jq .targetCommitish)
sha=$(gh api "repos/$SOURCE/commits/$sha" --jq .sha)
run=$(gh run list --repo "$SOURCE" --workflow release.yml --json databaseId,headSha,conclusion --limit 50 \
  --jq "[.[] | select(.headSha == \"$sha\" and .conclusion == \"success\")][0].databaseId")
[ -n "$run" ] && [ "$run" != null ] || { echo "no successful Release run for $sha" >&2; exit 1; }
gh run download "$run" --repo "$SOURCE" --name madani-site --dir "$work/site"

# the manifest must vouch for exactly these installers
(cd "$work/assets" && shasum -a 256 -c "$work/site/SHA256SUMS")
node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (m.version!==process.argv[2]) { console.error(`latest.json is for ${m.version}`); process.exit(1); }' "$work/site/latest.json" "$VERSION"

if [ "${DRY_RUN:-}" = 1 ]; then echo "dry run: verified $TAG (run $run); nothing uploaded"; exit 0; fi

gh repo view "$DOWNLOADS" --json visibility --jq .visibility | grep -qx PUBLIC || { echo "$DOWNLOADS must exist and be public" >&2; exit 1; }
gh release view "$TAG" --repo "$DOWNLOADS" >/dev/null 2>&1 || gh release create "$TAG" --repo "$DOWNLOADS" --title "madani bot $VERSION" --notes "madani bot $VERSION. Download from https://madani.bot/download"
# only what people and the apps fetch: the stable installer names the download page links to, the mac update zips and
# browser parts the apps fetch by version, the checksums, and the signed latest.json (the apps' fallback when madani.bot
# does not answer, at /releases/latest/download/latest.json); the versioned copies of the installers stay on the source release
shopt -s nullglob
keep=("$work"/assets/MadaniBot{.dmg,-intel.dmg,-setup.exe,-amd64.deb,.AppImage} "$work"/assets/MadaniBot-"$VERSION"-{arm64,x64}.zip "$work"/assets/MadaniBot-"$VERSION"-browser-darwin-*.zip)
shopt -u nullglob
[ "${#keep[@]}" -ge 7 ] || { echo "missing installers in $TAG: ${keep[*]##*/}" >&2; exit 1; }
gh release upload "$TAG" --repo "$DOWNLOADS" --clobber "${keep[@]}" "$work/site/SHA256SUMS" "$work/site/latest.json"
gh release edit "$TAG" --repo "$DOWNLOADS" --latest

mkdir -p "$SITE/public/landing/releases/$VERSION"
cp "$work/site/latest.json" "$SITE/public/landing/releases/latest.json"
cp "$work/site/SHA256SUMS" "$SITE/public/landing/releases/$VERSION/SHA256SUMS"
(cd "$SITE" && ./deploy.sh landing)
curl -fsS "https://madani.bot/releases/latest.json" | grep -q "\"version\": \"$VERSION\"" && echo "madani.bot announces $VERSION"

# madani.bot keeps its own copy of the installers and update zips (the apps fall back to it when GitHub fails)
"$(dirname "$0")/mirror-release.sh" "$TAG"
