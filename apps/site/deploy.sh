#!/usr/bin/env bash
# deploy the madani.bot site server with the deploy CLI. safe to rerun; a rerun is also how
# install.sh gets refreshed. madani.bot itself is the account service (deploy/account/deploy.sh production in the
# Madani Bot repo), which proxies every non-account path to this app on 127.0.0.1:3103; app., dev. and www. are its
# aliases and redirect. preview.madani.bot (deploy/account/deploy.sh preview) proxies to madani-preview the same way.
#   apps/site/deploy.sh landing    # madani-landing, reached through madani.bot
#   apps/site/deploy.sh preview    # madani-preview, reached through preview.madani.bot: the full site, never indexed
#   apps/site/deploy.sh [all]      # both
# launched 2026-11-16: landing deploys ship the full site; MADANI_WAITLIST_HOME=1 brings back the waitlist-only stage, which
# keeps only the waitlist at /, its files, the privacy, terms and cookies pages (sign-in links to them), help and
# account deletion (the app stores link to them), the download page (unlisted, handed to invited people), the license
# page (the LICENSE notice links to it) and the own server guide (the installer prints its address), and the server sends every other page to / (MADANI_HOME_ONLY). at launch deploy it with MADANI_WAITLIST_HOME=0 for the full site.
# MADANI_REPO is the Madani Bot checkout (pages read docs/legal there); INSTALLER overrides where install.sh comes from.
# the landing app's env (mongodb + brevo for the waitlist, names in .env.example) is built from the [landing] part of
# ~/.config/madanibot/madani.env by deploy/env.mjs in the Madani Bot repo; LANDING_ENV sends a ready env file instead. with
# neither, the env already on the server stays. the preview app keeps the env already on the server.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MADANI_REPO="${MADANI_REPO:-$(cd "$HERE/../.." && pwd)}"
INSTALLER="${INSTALLER:-$MADANI_REPO/apps/link-service/install.sh}"
LANDING_ENV="${LANDING_ENV:-}"
MADANI_ENV="${MADANI_ENV:-$HOME/.config/madanibot/madani.env}"
DEPLOY="${DEPLOY:-deploy}"
WHICH="${1:-all}"

WAITLIST="${MADANI_WAITLIST_HOME:-0}"

# which, app name, domain, waitlist home (1 = madani.bot before launch), env from madani.env
SITES=(
  "landing madani-landing madani-landing.apps.siddz.com $WAITLIST 1"
  "preview madani-preview madani-preview.apps.siddz.com 0 0"
)

stage=$(mktemp -d "${TMPDIR:-/tmp}/madani-sites.XXXXXX")
# the committed build stays the full site; it is put back once a waitlist build has been staged
trap 'rm -rf "$stage"; if [ "${RESTORE:-0}" = 1 ]; then node "$HERE/build-pages.mjs" "$MADANI_REPO" > /dev/null; fi' EXIT
[ -f "$INSTALLER" ] || { echo "error: installer not found at $INSTALLER" >&2; exit 1; }

ran=0
for row in "${SITES[@]}"; do
  read -r which name domain waitlist useenv <<<"$row"
  [ "$WHICH" = all ] || [ "$WHICH" = "$which" ] || continue
  # the pages and the legal drafts (docs/legal in the Madani Bot repo) become the site's html
  [ "$waitlist" = 1 ] && RESTORE=1
  MADANI_WAITLIST_HOME="$waitlist" node "$HERE/build-pages.mjs" "$MADANI_REPO"
  # no deploy with a link, picture or anchor that leads nowhere
  node "$HERE/check-links.mjs"
  dir="$stage/$name"
  mkdir -p "$dir/public"
  cp "$HERE/server.js" "$HERE/release-mirror.js" "$HERE/waitlist-store.js" "$HERE/waitlist-mongo.js" "$HERE/unsubscribe.js" "$HERE/package.json" "$HERE/package-lock.json" "$dir/"
  cp -R "$HERE/public/landing" "$dir/public/landing"
  cp "$INSTALLER" "$dir/public/landing/install.sh"
  cp "$HERE/install-mac.sh" "$dir/public/landing/install-mac.sh"
  (cd "$dir/public/landing" && shasum -a 256 install.sh > install.sh.sha256)
  echo "$name: install.sh from $INSTALLER ($(shasum -a 256 "$INSTALLER" | cut -c1-12))"
  vars=""
  if [ "$waitlist" = 1 ]; then
    # madani.bot is the waitlist only: every other page, the search index files and the redirect list go; the server
    # sends any page that is not here to /
    pub="$dir/public/landing"
    find "$pub" -name '*.html' ! -path "$pub/index.html" ! -path "$pub/privacy/index.html" ! -path "$pub/terms/index.html" ! -path "$pub/cookies/index.html" ! -path "$pub/license/index.html" ! -path "$pub/docs/your-own-server/index.html" ! -path "$pub/support/index.html" ! -path "$pub/delete-account/index.html" ! -path "$pub/download/index.html" -delete
    rm -rf "$pub/sitemaps" "$pub/docs/search.json" "$pub/_redirects.json" "$pub/_gone.json"
    find "$pub" -maxdepth 1 -regex '.*/[0-9a-f]\{32\}\.txt' -delete
    find "$pub" -type d -empty -delete
    printf 'User-agent: *\nAllow: /\n\nSitemap: https://madani.bot/sitemap.xml\n' > "$pub/robots.txt"
    { printf '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      for p in / /privacy /terms /cookies /license /support /delete-account; do printf '  <url><loc>https://madani.bot%s</loc></url>\n' "$p"; done
      printf '</urlset>\n'; } > "$pub/sitemap.xml"
    vars="MADANI_HOME_ONLY=1"
  fi
  # the preview is a staging copy: search engines only see madani.bot
  [ "$which" = preview ] && vars="MADANI_NO_INDEX=1"
  envargs=()
  if [ "$useenv" = 1 ]; then
    env="$LANDING_ENV"
    if [ -z "$env" ] && [ -f "$MADANI_ENV" ]; then
      env="$stage/landing.env"
      MADANI_ENV="$MADANI_ENV" node "$MADANI_REPO/deploy/env.mjs" landing "$env"
    fi
    [ -n "$env" ] && [ -f "$env" ] && envargs=(--env-file "$env")
  fi
  "$DEPLOY" "$dir" --name "$name" --domain "$domain" --install "npm install --omit=dev --no-audit --no-fund" ${envargs[@]+"${envargs[@]}"} \
    --cmd "set -a; [ -f ./.env ] && . ./.env; set +a; exec env $vars node server.js landing"
  ran=1
done
[ "$ran" = 1 ] || { echo "usage: $0 [all|landing|preview]" >&2; exit 2; }
