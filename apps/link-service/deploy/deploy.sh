#!/usr/bin/env bash
# ships the link service to its nodes, and restarts a node only when what it runs changed: a deploy restarts the
# process, and every app and agent on that node reconnects its relay stream, so a change to tests, the chaos lab or the
# readme alone is not worth one. from the repo root on the mac:
#   apps/link-service/deploy/deploy.sh            # contabo (the deploy cli, prozessor) and oracle-in (tar + systemd)
#   apps/link-service/deploy/deploy.sh --force    # ship even when nothing it runs changed
# needs `ssh contabo` and `ssh oracle`, and the deploy cli reaching contabo's deployd (DEPLOY_URL or its default).
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
src="$root/apps/link-service"
force="${1:-}"

# what a node runs: everything but tests, the chaos lab, docs and deploy scripts. a node is compared on these files
# only (the same names hashed there), so leftovers on a node do not count as a change
files() { (cd "$src" && find . -type f ! -path './test/*' ! -path './chaos/*' ! -path './deploy/*' ! -path './node_modules/*' ! -path './data/*' ! -name 'README.md' ! -name 'package-lock.json' ! -name '.env*' ! -name '._*' ! -name '.DS_Store' | LC_ALL=C sort); }
local_sum="$(cd "$src" && files | tr '\n' '\0' | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64)"
same() {
  [ "$force" = "--force" ] && return 1
  [ "$(files | ssh "$1" "cd '$2' && tr '\\n' '\\0' | xargs -0 sha256sum 2>&1" | shasum -a 256 | cut -c1-64)" = "$local_sum" ]
}

if same contabo /root/autorunner/projects/omb-link; then echo "contabo: nothing it runs changed, not restarted"
else
  (cd "$src" && deploy . --name omb-link --domain link 2>&1 | tail -1)
  echo "contabo: shipped"
fi

if same oracle /opt/madani-link-node; then echo "oracle-in: nothing it runs changed, not restarted"
else
  tgz="$(mktemp -t link-node).tgz"
  (cd "$src" && COPYFILE_DISABLE=1 tar --no-xattrs -czf "$tgz" --exclude=test --exclude=chaos --exclude=deploy --exclude=data --exclude=README.md --exclude=.env.example --exclude=node_modules .)
  scp -q "$tgz" oracle:/tmp/link-node.tgz && rm -f "$tgz"
  ssh oracle 'sudo tar -xzf /tmp/link-node.tgz -C /opt/madani-link-node && sudo systemctl restart madani-link-node && sleep 2 && echo "oracle-in: shipped, $(systemctl is-active madani-link-node)"'
fi
