#!/usr/bin/env bash
# Builds the sideload APK (arm64-v8a + armeabi-v7a in one file), signed with the release key, and verifies it.
#
#   apps/mobile/scripts/build-android-apk.sh                     (versionName 1.2, versionCode 1)
#   MADANI_ANDROID_VERSION_CODE=2 MADANI_ANDROID_VERSION_NAME=1.2.1 apps/mobile/scripts/build-android-apk.sh
#   MADANI_ANDROID_APK_OUT=~/Desktop/madani-android apps/mobile/scripts/build-android-apk.sh
#
# The key is ~/.config/madanibot/android/release.keystore (MADANI_ANDROID_KEYSTORE overrides), its passwords
# MADANI_ANDROID_KEYSTORE_PASSWORD / MADANI_ANDROID_KEY_ALIAS / MADANI_ANDROID_KEY_PASSWORD from the environment or madani.env.
# Values are never printed. This key is not the Play upload key (build-android-release.sh): see docs/store-launch.md.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mobile=$(cd "$here/.." && pwd)
repo=$(cd "$mobile/../.." && pwd)
. "$here/release-env.sh"
madani_env_load MADANI_ANDROID_KEYSTORE_PASSWORD MADANI_ANDROID_KEY_ALIAS MADANI_ANDROID_KEY_PASSWORD

keystore="${MADANI_ANDROID_KEYSTORE:-$HOME/.config/madanibot/android/release.keystore}"
for key in MADANI_ANDROID_KEYSTORE_PASSWORD MADANI_ANDROID_KEY_ALIAS MADANI_ANDROID_KEY_PASSWORD; do
  [ -n "${!key:-}" ] || { echo "error: $key is not set (environment or madani.env)" >&2; exit 1; }
done
[ -f "$keystore" ] || { echo "error: no release keystore at $keystore" >&2; exit 1; }

if [ -z "${ANDROID_HOME:-}" ]; then
  if [ -n "${ANDROID_SDK_ROOT:-}" ]; then export ANDROID_HOME="$ANDROID_SDK_ROOT"
  elif [ -d "$HOME/Library/Android/sdk" ]; then export ANDROID_HOME="$HOME/Library/Android/sdk"
  elif [ -d "$HOME/android-sdk" ]; then export ANDROID_HOME="$HOME/android-sdk"
  else echo "error: no Android SDK (set ANDROID_HOME)" >&2; exit 1; fi
fi
build_tools=$(ls -d "$ANDROID_HOME"/build-tools/*/ 2>/dev/null | sort -V | tail -1)
[ -x "${build_tools}apksigner" ] || { echo "error: no apksigner under $ANDROID_HOME/build-tools" >&2; exit 1; }

export MADANI_ANDROID_VERSION_NAME="${MADANI_ANDROID_VERSION_NAME:-1.2}"
export MADANI_ANDROID_VERSION_CODE="${MADANI_ANDROID_VERSION_CODE:-1}"
export MADANI_ANDROID_ABIS="${MADANI_ANDROID_ABIS:-arm64-v8a,armeabi-v7a}"
out_dir="${MADANI_ANDROID_APK_OUT:-$HOME/Desktop/madani-android}"

cd "$repo"
echo "== web bundle"
pnpm --filter @madanibot/mobile build
echo "== release gate"
node apps/mobile/scripts/release-gate.mjs
echo "== cap sync android"
(cd "$mobile" && npx cap sync android)
echo "== gradle assembleRelease ($MADANI_ANDROID_VERSION_NAME, code $MADANI_ANDROID_VERSION_CODE, $MADANI_ANDROID_ABIS)"
# the upload key must not sign this one: apksigner signs it with the release key below
# kept light: two workers and a 2 GB heap, so the build never starves the machine it runs on
(cd "$mobile/android" && env -u ANDROID_UPLOAD_KEYSTORE_PATH ./gradlew --no-daemon --max-workers=2 -Dorg.gradle.jvmargs=-Xmx2g \
  -q assembleRelease -PANDROID_UPLOAD_KEYSTORE_PATH=)

built_dir="$mobile/android/app/build/outputs/apk/release"
built=""
for candidate in "$built_dir/app-release-unsigned.apk" "$built_dir/app-release.apk"; do
  if [ -f "$candidate" ]; then built="$candidate"; break; fi
done
[ -n "$built" ] || { echo "error: gradle finished but no apk in $built_dir" >&2; exit 1; }

mkdir -p "$out_dir"
apk="$out_dir/madani-bot-$MADANI_ANDROID_VERSION_NAME.apk"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
aligned="$work/aligned.apk"
"${build_tools}zipalign" -f -p 4 "$built" "$aligned"
"${build_tools}apksigner" sign --ks "$keystore" --ks-key-alias "$MADANI_ANDROID_KEY_ALIAS" \
  --ks-pass env:MADANI_ANDROID_KEYSTORE_PASSWORD --key-pass env:MADANI_ANDROID_KEY_PASSWORD --out "$apk" "$aligned"
"${build_tools}apksigner" verify --verbose "$apk" | grep -E "^Verifies|v[0-9].*scheme"
echo "sha256: $(shasum -a 256 "$apk" | cut -d' ' -f1)"
echo "$apk"
