#!/bin/sh
# The gate between origin/main and the owner's checkout (the folder the owner's dev app runs from). Run by the
# coordinator, batched, never by each agent after each push:
#
#   scripts/sync-owner-checkout.sh            smoke origin/main in a worktree; only if it passes, fast-forward the checkout
#   scripts/sync-owner-checkout.sh --check    the same smoke and version check, without moving the checkout
#
# The checkout only ever fast-forwards (no stash, no reset, no merge commit). It stops, changing nothing, when the
# checkout is not on main, has commits origin/main lacks, or has local edits in files the update touches.
# Env: MADANI_OWNER_CHECKOUT (default ~/Desktop/code/OpenMausBot), MADANI_SMOKE_HOME (default ~/.cache/madani-smoke),
# MADANI_SMOKE_SSH_HOST (owner's server, default oracle), MADANI_CLOUD_PACKAGE_HOST (preview host, default contabo).
set -eu
# smoke launches never report usage analytics (electron/product-events.mjs analyticsAllowed)
export MADANI_ANALYTICS=0
OWNER=${MADANI_OWNER_CHECKOUT:-$HOME/Desktop/code/OpenMausBot}
HOME_DIR=${MADANI_SMOKE_HOME:-$HOME/.cache/madani-smoke}
WT=$HOME_DIR/gate-worktree
SERVER_HOST=${MADANI_SMOKE_SSH_HOST:-oracle}
SERVER_USER=${MADANI_SMOKE_SERVER_USER:-maus}
PACKAGE_HOST=${MADANI_CLOUD_PACKAGE_HOST:-contabo}
PACKAGE_FILE=${MADANI_CLOUD_PACKAGE_FILE:-/var/lib/madani-account-preview/home/omb-home.tgz}
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1
say() { printf '%s\n' "$*"; }
stop() { say "STOP: $*"; exit 2; }
mkdir -p "$HOME_DIR/runs"

[ -d "$OWNER/.git" ] || stop "$OWNER is not a git checkout"
branch=$(git -C "$OWNER" symbolic-ref --short -q HEAD || true)
[ "$branch" = main ] || stop "the checkout is on '${branch:-a detached HEAD}', not main; nothing changed"
git -C "$OWNER" fetch -q origin main
target=$(git -C "$OWNER" rev-parse origin/main)
head=$(git -C "$OWNER" rev-parse HEAD)
short=$(git -C "$OWNER" rev-parse --short "$target")
if [ "$head" = "$target" ]; then say "the checkout is already at origin/main ($short)"; behind=0
else
  git -C "$OWNER" merge-base --is-ancestor "$head" "$target" || stop "the checkout has commits origin/main lacks; nothing changed (push or move them first)"
  behind=$(git -C "$OWNER" rev-list --count "$head..$target")
  say "origin/main $short is $behind commits ahead of the checkout"
fi

# local edits in files the update changes would block or be clobbered: refuse before any work
if [ "$behind" -gt 0 ]; then
  changed=$(git -C "$OWNER" diff --name-only "$head" "$target")
  dirty=$(git -C "$OWNER" status --porcelain --untracked-files=all | sed -E 's/^...//; s/.* -> //')
  printf '%s\n' "$changed" > "$HOME_DIR/changed.txt"
  clash=$(printf '%s\n' "$dirty" | grep -Fx -f "$HOME_DIR/changed.txt" || true)
  [ -z "$clash" ] || stop "local changes in files the update touches; nothing changed:
$clash"
fi

# the smoke runs origin/main in the gate's own worktree, never in the checkout
if [ -d "$WT" ]; then git -C "$OWNER" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf -- "$WT"; fi
git -C "$OWNER" worktree prune
git -C "$OWNER" worktree add -q --detach "$WT" "$target"
if git -C "$OWNER" diff --quiet "$head" "$target" -- pnpm-lock.yaml && [ -d "$OWNER/node_modules" ]; then
  ln -s "$OWNER/node_modules" "$WT/node_modules"
else
  say "the lockfile changed: installing the worktree's own node_modules"
  (cd "$WT" && corepack pnpm install --frozen-lockfile --ignore-scripts >/dev/null) || stop "pnpm install failed in the gate worktree"
fi
[ -f "$WT/scripts/smoke/real-setup.mjs" ] || stop "origin/main has no scripts/smoke/real-setup.mjs"

out="$HOME_DIR/runs/$(date +%Y%m%d-%H%M%S)-$short"
say "smoke: $out"
if node "$WT/scripts/smoke/real-setup.mjs" --root "$WT" --out "$out"; then smoke=pass; else smoke=fail; fi
say ""
sed -n '1,40p' "$out/report.md" 2>/dev/null || true
say ""

# what the owner runs against: the server package on the owner's server and the cloud package on preview
app_version=$(git -C "$OWNER" show "$target:package.json" | node -e 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>console.log(JSON.parse(t).version))')
server_version=$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$SERVER_HOST" "sudo -n -u $SERVER_USER sh -c 'cat ~/.local/lib/node_modules/madanibot/package.json'" 2>/dev/null | node -e 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>{try{console.log(JSON.parse(t).version)}catch{console.log("unknown")}})')
cloud_version=$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$PACKAGE_HOST" "tar -xzOf $PACKAGE_FILE ./dist-server/package.json" 2>/dev/null | node -e 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>{try{console.log(JSON.parse(t).version)}catch{console.log("unknown")}})')
say "versions: app $app_version, owner's server ($SERVER_HOST) $server_version, preview cloud package $cloud_version"
[ "$server_version" = "$app_version" ] || say "  roll: the owner's server runs $server_version; update its madanibot package to $app_version"
[ "$cloud_version" = "$app_version" ] || say "  roll: the preview cloud package is $cloud_version; rebuild omb-home.tgz at $short and redeploy preview (deploy/account/deploy.sh preview)"

git -C "$OWNER" worktree remove --force "$WT" >/dev/null 2>&1 || true
[ "$smoke" = pass ] || { say "FAIL: the smoke failed, so the checkout stays at $(git -C "$OWNER" rev-parse --short HEAD). Report: $out/report.md"; exit 1; }
[ "$behind" -gt 0 ] || { say "PASS: nothing to move"; exit 0; }
[ "$CHECK_ONLY" = 0 ] || { say "PASS (--check): the checkout was not moved"; exit 0; }

git -C "$OWNER" merge --ff-only -q "$target" || stop "git refused the fast-forward (see above); the checkout stays where it was"
say "PASS: the checkout fast-forwarded $behind commits to $short"
if ! git -C "$OWNER" diff --quiet "$head" "$target" -- pnpm-lock.yaml; then
  (cd "$OWNER" && corepack pnpm install --frozen-lockfile >/dev/null) && say "  dependencies installed (the lockfile changed)" || say "  WARN: pnpm install failed in the checkout; run it there"
fi
if ! git -C "$OWNER" diff --quiet "$head" "$target" -- electron/; then say "  restart the dev app: electron/ changed"; fi
