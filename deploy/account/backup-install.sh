#!/usr/bin/env bash
# installs the backup scripts and units on the vps and turns on each set's timer (daily, or a set's timer.d drop-in). the env files, rclone.conf
# (remotes oracle-backup and r2-backup) and the age recipient are set up by hand once (backup.env.example).
#   deploy/account/backup-install.sh [ssh host] [sets...]    # default: contabo madani make
set -euo pipefail
host="${1:-contabo}"; [ $# -gt 0 ] && shift
if [ $# -gt 0 ]; then sets=("$@"); else sets=(madani make); fi
cd "$(dirname "$0")/../.."
ssh "$host" 'install -d -m 755 /opt/madani-backup && install -d -m 700 /etc/madani-backup'
scp -q deploy/account/backup.sh deploy/account/backup-alert.mjs deploy/monitor/uptime-check.mjs apps/dashboard/server/email/layout.ts "$host:/opt/madani-backup/"
scp -q deploy/account/madani-backup@.service deploy/account/madani-backup@.timer "$host:/etc/systemd/system/"
for d in deploy/account/madani-backup@*.timer.d; do
  [ -d "$d" ] || continue
  ssh "$host" "install -d -m 755 /etc/systemd/system/${d##*/}"
  scp -q "$d"/*.conf "$host:/etc/systemd/system/${d##*/}/"
done
ssh "$host" "chmod 755 /opt/madani-backup/backup.sh && systemctl daemon-reload && for s in ${sets[*]}; do
  [ -f /etc/madani-backup/\$s.env ] || { echo \"missing /etc/madani-backup/\$s.env\" >&2; exit 1; }
  systemctl enable madani-backup@\$s.timer && systemctl restart madani-backup@\$s.timer; done && systemctl list-timers --no-pager 'madani-backup@*'"
