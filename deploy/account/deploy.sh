#!/usr/bin/env bash
# Deploys the account service (apps/dashboard/server with the managed cloud) from this checkout with the deploy CLI
# (deployd on the VPS). Always pass the install and run commands: without them the CLI picks npm and package.json's main.
#   deploy/account/deploy.sh preview      # preview.madani.bot (staging): the full site at /, the page at /dashboard, the admin at /admin, the API at /v1 and /api
#   deploy/account/deploy.sh production   # madani.bot: the same paths, with the waitlist site (madani-landing) at /
# the app's env is built from ~/.config/madanibot/madani.env (deploy/env.mjs) into a temp file that is removed after the
# deploy; ENV_FILE sends a ready env file instead (0600, names in production.env.example).
set -euo pipefail
target="${1:-}"
case "$target" in
  preview) name=madani-account; domain=preview.madani.bot; site=https://preview.madani.bot ;;
  production) name=madani-account-prod; domain=madani.bot; site=https://madani.bot ;;
  *) echo "usage: $0 preview|production" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/../.."
if [ -n "${ENV_FILE:-}" ]; then
  env_file="$ENV_FILE"
  [ -f "$env_file" ] || { echo "missing $env_file" >&2; exit 1; }
  [ "$(stat -f %Lp "$env_file" 2>/dev/null || stat -c %a "$env_file")" = 600 ] || { echo "$env_file must be mode 600" >&2; exit 1; }
else
  env_file=$(mktemp "${TMPDIR:-/tmp}/madani-account-env.XXXXXX")
  trap 'rm -f "$env_file"' EXIT
  node deploy/env.mjs "$target" "$env_file"
fi
# a home package whose file, signature and sha256 disagree keeps the service from starting: refuse before shipping
node deploy/account/check-home-package.mjs "$env_file"
# the account service runs TypeScript directly on Node 24 (/opt/node24 on the VPS; the system node is older)
"${DEPLOY:-deploy}" . --name "$name" --domain "$domain" --env-file "$env_file" \
  --install "export PATH=/opt/node24/bin:\$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1; corepack pnpm install --frozen-lockfile --ignore-scripts && MADANI_DASHBOARD_BASE=/dashboard/ MADANI_SITE_URL=$site corepack pnpm build:dashboard" \
  --cmd 'set -a; . ./.env; set +a; mkdir -p "$MADANI_DASHBOARD_DATA"; MADANI_DASHBOARD_PORT=$PORT exec /opt/node24/bin/node apps/dashboard/server/main.ts'
