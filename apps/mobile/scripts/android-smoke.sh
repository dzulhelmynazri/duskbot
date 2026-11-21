#!/usr/bin/env bash
# Smoke run of the phone app on a booted emulator (the android-smoke workflow): install, launch, tap the first screen,
# back, rotate, open madanibot:// links. Screenshots, ui dumps and logcat go to the out dir; summary.txt says what died.
#
#   apps/mobile/scripts/android-smoke.sh <apk> <out dir>
set -uo pipefail
apk="$1"
out="$2"
pkg=bot.madani.mobile
mkdir -p "$out"
summary="$out/summary.txt"
: > "$summary"

note() { echo "$*" | tee -a "$summary"; }
shot() { adb exec-out screencap -p > "$out/$1.png"; adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 && adb pull /sdcard/ui.xml "$out/$1.xml" > /dev/null 2>&1; }
alive() { if adb shell pidof "$pkg" > /dev/null 2>&1; then note "$1: running"; else note "$1: NOT RUNNING"; fi; }
top() { adb shell dumpsys window | grep -m1 -E "mCurrentFocus" | sed 's/^ *//'; }

note "device: $(adb shell getprop ro.build.version.release) (api $(adb shell getprop ro.build.version.sdk)), $(adb shell wm size | tail -1), $(adb shell wm density | tail -1)"
adb logcat -c
adb install -r "$apk" > "$out/install.txt" 2>&1 || { note "install failed: $(cat "$out/install.txt")"; exit 1; }

adb shell am start -W -n "$pkg/.MainActivity" > "$out/start.txt" 2>&1
sleep 20
shot 01-launch
alive "after launch"

# tap the first labelled clickable thing the web view exposes (the first screen's main action)
target=$(python3 - "$out/01-launch.xml" <<'PY'
import re, sys, xml.etree.ElementTree as ET
try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    sys.exit(0)
for node in root.iter("node"):
    if node.get("package") != "bot.madani.mobile" or node.get("clickable") != "true":
        continue
    label = (node.get("text") or node.get("content-desc") or "").strip()
    if not label:
        continue
    x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.get("bounds", "")))
    print(f"{(x1 + x2) // 2} {(y1 + y2) // 2} {label}")
    break
PY
)
if [ -n "$target" ]; then
  set -- $target
  note "tapping \"${*:3}\" at $1,$2"
  adb shell input tap "$1" "$2"
  sleep 6
  shot 02-after-tap
  alive "after tap"
  adb shell input keyevent KEYCODE_BACK
  sleep 3
  shot 03-after-first-back
  alive "after first back"
  note "focus: $(top)"
else
  # the web view shows no accessibility tree to uiautomator: tap where the pairing screen draws "Enter a code"
  read -r w h <<< "$(adb shell wm size | tail -1 | sed 's/.*: //; s/x/ /')"
  note "no labelled clickable node; tapping the pairing screen's \"Enter a code\" at $((w / 2)),$((h * 933 / 1000))"
  adb shell input tap "$((w / 2))" "$((h * 933 / 1000))"
  sleep 6
  shot 02-after-tap
  alive "after tap"
  adb shell input keyevent KEYCODE_BACK
  sleep 5
  shot 03-after-first-back
  alive "after first back"
  note "focus: $(top)"
fi

adb shell input keyevent KEYCODE_BACK
sleep 5
shot 04-after-back
alive "after back on first screen (should minimize, still running)"
note "focus: $(top)"

adb shell am start -W -n "$pkg/.MainActivity" > /dev/null 2>&1
sleep 5
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 1
sleep 6
# the manifest locks the activity to portrait, so this checks it stays upright and alive
shot 05-landscape
alive "after rotate to landscape"
adb shell settings put system user_rotation 0
sleep 5
shot 06-portrait-again
alive "after rotate back"

adb shell am start -W -a android.intent.action.VIEW -d "madanibot://cloud" "$pkg" > /dev/null 2>&1
sleep 6
shot 07-deeplink-cloud
alive "after madanibot://cloud"
adb shell am start -W -a android.intent.action.VIEW -d "madanibot://pair?m=bm90LWEtcGF5bG9hZA" "$pkg" > /dev/null 2>&1
sleep 6
shot 08-deeplink-bad-pair
alive "after madanibot://pair with a bad payload"

adb logcat -d -v threadtime > "$out/logcat-full.txt"
grep -E "FATAL EXCEPTION|AndroidRuntime|ANR in|Capacitor/Console|chromium|Capacitor|$pkg|DEBUG +: " "$out/logcat-full.txt" > "$out/logcat-app.txt" || true
fatal=$(grep -c "FATAL EXCEPTION" "$out/logcat-full.txt" || true)
anr=$(grep -c "ANR in $pkg" "$out/logcat-full.txt" || true)
console_errors=$(grep -E "Capacitor/Console" "$out/logcat-full.txt" | grep -ciE " E |error" || true)
note "fatal exceptions: $fatal, anr: $anr, console errors: $console_errors"
