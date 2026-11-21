# sourced by the store build scripts: exports named keys from madani.env without echoing them or sourcing the whole file.
#   . "$(dirname "$0")/release-env.sh"; madani_env_load KEY [KEY...]
MADANI_ENV_FILE="${MADANI_ENV_FILE:-$HOME/.config/madanibot/madani.env}"

madani_env_load() {
  [ -r "$MADANI_ENV_FILE" ] || return 0
  for key in "$@"; do
    # a value already in the environment wins
    eval "current=\${$key:-}"
    [ -n "$current" ] && continue
    line=$(grep -m1 "^${key}=" "$MADANI_ENV_FILE" 2>/dev/null || true)
    [ -n "$line" ] || continue
    value=${line#*=}
    case "$value" in \"*\") value=${value#\"}; value=${value%\"} ;; \'*\') value=${value#\'}; value=${value%\'} ;; esac
    export "$key=$value"
  done
  unset current line value
}
