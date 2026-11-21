#!/bin/sh
# the host side of a free bot box: boxes on the omb-desk0 bridge reach the public internet and nothing else. not this
# host (any of its addresses, any port but the link agent's egress proxy, which only relays to the person's own
# computer), not other boxes or containers, not the LAN or VPC, not cloud metadata.
# rules live in the host's netfilter, out of reach of root inside a box, and apply to runc and gVisor boxes alike.
#   sudo deploy/bot-desktop/host-fence.sh            apply (idempotent; run at boot after docker, see README.md)
#   sudo deploy/bot-desktop/host-fence.sh --check    exit 0 when the fence is in place
#   sudo deploy/bot-desktop/host-fence.sh --remove   take it away again
set -eu
BRIDGE=omb-desk0
MARK="omb-box-fence v1"
# apps/link-service/agent.mjs EGRESS_PORT
EGRESS_PORT="${MADANI_EGRESS_PORT:-3129}"
BLOCKED4="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24
192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4"

IPT="${IPT:-iptables}"
ipt() { "$IPT" -w 10 "$@"; }
ip6t() { ip6tables -w 10 "$@" 2>/dev/null || true; }

check() {
  ipt -S OMB-BOX-IN 2>/dev/null | grep -q -- "$MARK" &&
    ipt -S OMB-BOX-FWD 2>/dev/null | grep -q -- "$MARK" &&
    ipt -S INPUT | grep -q -- "-i $BRIDGE -j OMB-BOX-IN" &&
    ipt -S DOCKER-USER 2>/dev/null | grep -q -- "-i $BRIDGE -j OMB-BOX-FWD"
}

remove() {
  while ipt -D INPUT -i "$BRIDGE" -j OMB-BOX-IN 2>/dev/null; do :; done
  while ipt -D DOCKER-USER -i "$BRIDGE" -j OMB-BOX-FWD 2>/dev/null; do :; done
  while ip6tables -w 10 -D INPUT -i "$BRIDGE" -j DROP 2>/dev/null; do :; done
  while ip6tables -w 10 -D FORWARD -i "$BRIDGE" -j DROP 2>/dev/null; do :; done
  for chain in OMB-BOX-IN OMB-BOX-FWD; do ipt -F "$chain" 2>/dev/null || true; ipt -X "$chain" 2>/dev/null || true; done
}

case "${1:-}" in
  # the checker may run in a container whose iptables defaults to nft on a host still on legacy tables
  --check) check || { command -v iptables-legacy >/dev/null 2>&1 && IPT=iptables-legacy check; }; exit $? ;;
  --remove) remove; exit 0 ;;
esac

[ "$(id -u)" = 0 ] || { echo "host-fence: run as root" >&2; exit 1; }
# docker makes DOCKER-USER when it starts; making it first is harmless and docker keeps what is in it
ipt -N DOCKER-USER 2>/dev/null || true
ipt -C FORWARD -j DOCKER-USER 2>/dev/null || ipt -I FORWARD 1 -j DOCKER-USER
for chain in OMB-BOX-IN OMB-BOX-FWD; do ipt -N "$chain" 2>/dev/null || ipt -F "$chain"; done

# to this host: only replies to connections the host opened (the viewer tunnel), so no host service is reachable
ipt -A OMB-BOX-IN -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "$MARK" -j ACCEPT
ipt -A OMB-BOX-IN -p tcp --dport "$EGRESS_PORT" -m comment --comment "omb-box-egress" -j ACCEPT
ipt -A OMB-BOX-IN -j DROP

# through this host: replies, then never another box or any private, local or metadata range, then the internet
ipt -A OMB-BOX-FWD -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "$MARK" -j RETURN
ipt -A OMB-BOX-FWD -o "$BRIDGE" -j DROP
for net in $BLOCKED4; do ipt -A OMB-BOX-FWD -d "$net" -j DROP; done
ipt -A OMB-BOX-FWD -j RETURN

ipt -C INPUT -i "$BRIDGE" -j OMB-BOX-IN 2>/dev/null || ipt -I INPUT 1 -i "$BRIDGE" -j OMB-BOX-IN
ipt -C DOCKER-USER -i "$BRIDGE" -j OMB-BOX-FWD 2>/dev/null || ipt -I DOCKER-USER 1 -i "$BRIDGE" -j OMB-BOX-FWD
# boxes get no IPv6 at all
ip6tables -w 10 -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null || ip6t -I INPUT 1 -i "$BRIDGE" -j DROP
ip6tables -w 10 -C FORWARD -i "$BRIDGE" -j DROP 2>/dev/null || ip6t -I FORWARD 1 -i "$BRIDGE" -j DROP
check && echo "host-fence: boxes on $BRIDGE are fenced"
