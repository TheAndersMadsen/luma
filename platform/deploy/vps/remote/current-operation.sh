#!/usr/bin/bash
set -euo pipefail
source "${REVIVAL_HELD_COMMON:?held common authority is required}"

operation=""
record=""
usage() {
  echo "usage: current-operation --operation canary.sh|drift.sh --record PATH [-- ARGS...]" >&2
  exit 64
}
while (($#)); do
  case "$1" in
    --operation) (($# >= 2)) || usage; operation="$2"; shift 2 ;;
    --record) (($# >= 2)) || usage; record="$2"; shift 2 ;;
    --) shift; break ;;
    *) usage ;;
  esac
done
case "$operation" in canary.sh|drift.sh) ;; *) usage ;; esac

release="${REVIVAL_HELD_RELEASE_LOGICAL_ROOT:-}"
release_id="${REVIVAL_HELD_RELEASE_ID:-}"
validate_release_id "$release_id"
[[ "$release" == "$RELEASES_DIR/$release_id" \
  && "$record" == "$DEPLOYMENTS_DIR/"* && -d "$record" && ! -L "$record" \
  && "$(tr -d '\r\n' <"$record/release-id")" == "$release_id" ]] \
  || fail "standalone current operation is outside the accepted release record"

# Standalone checks are not allowed to trust whatever tags/cache happen to be
# present. Reload the accepted deployment's exact retained bundle and generate
# the complete content-ID override before the target script is dispatched.
prefix="standalone-${operation%.sh}"
activate_retained_candidate_authority "$release" "$record" "$record" "$prefix"
[[ "${revival_candidate_authority_required:-0}" == 1 \
  && "${revival_candidate_authority_release:-}" == "$release" \
  && "${revival_candidate_override_path:-}" == "$record/$prefix-images.override.json" \
  && "${revival_candidate_override_sha256:-}" =~ ^[0-9a-f]{64}$ \
  && "${revival_candidate_compose_model_sha256:-}" =~ ^[0-9a-f]{64}$ \
  && "${revival_candidate_authority_receipt_name:-}" == "$prefix-compose-authority.json" \
  && "${revival_candidate_authority_receipt_sha256:-}" =~ ^[0-9a-f]{64}$ ]] \
  || fail "standalone current operation did not acquire exact candidate image authority"

run_held_release_program "$release" "platform/deploy/vps/remote/$operation" bash 0 "$@"
