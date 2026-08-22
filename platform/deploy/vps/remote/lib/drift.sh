#!/usr/bin/bash
# Deployment and release pointers read by the drift and rollback gates.
#
# Sourced by remote/common.sh; not an entry point. Functions here rely on
# the constants and siblings the loader defines before any of them runs.

latest_deployment() {
  find "$DEPLOYMENTS_DIR" -mindepth 1 -maxdepth 1 -type d -name '[0-9a-f]*' -print \
    | LC_ALL=C sort | tail -n 1
}

safe_release_pointer() {
  local pointer="$1"
  [[ -L "$pointer" ]] || return 1
  local resolved
  resolved="$(readlink -f "$pointer")"
  [[ "$resolved" == "$RELEASES_DIR/"* && -d "$resolved" ]] || return 1
  printf '%s\n' "$resolved"
}

# The first canonical cutover records the still-running legacy containers as
# its rollback target. Those containers retain their historical external
# network attachment even though no Ai Pin Revival service uses that network.
legacy_rollback_network_required() {
  local current_pointer="${1:-$REMOTE_ROOT/current}"
  if (($#)); then
    local explicit_releases resolved
    explicit_releases="$(dirname -- "$current_pointer")/releases"
    if [[ -L "$current_pointer" ]]; then
      resolved="$(readlink -f -- "$current_pointer")" || return 0
      if [[ "$resolved" == "$explicit_releases/"* && -d "$resolved" ]]; then
        return 1
      fi
    fi
  elif safe_release_pointer "$current_pointer" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

safe_deployment_pointer() {
  local pointer="$1" resolved
  [[ -L "$pointer" ]] || return 1
  resolved="$(readlink -f "$pointer")"
  [[ "$resolved" == "$DEPLOYMENTS_DIR/"* && -d "$resolved" ]] || return 1
  printf '%s\n' "$resolved"
}
