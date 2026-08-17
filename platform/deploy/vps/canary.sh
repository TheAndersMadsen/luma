#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/lib/local.sh"

release_id=""
baseline=""
cookie_file=""
require_remote_tts=0
wearer_plane_optional=0
from_tree=0
json=0
usage() {
  echo "usage: $0 [--remote vps] [--release-id SHA256] [--baseline DIR] [--require-remote-tts] [--wearer-plane-optional] [--from-tree] [--cookie-file REMOTE_PATH] [--json]" >&2
  exit 64
}
while (($#)); do
  case "$1" in
    --remote) (($# >= 2)) || usage; DEPLOY_REMOTE="$2"; shift 2 ;;
    --release-id) (($# >= 2)) || usage; release_id="$2"; shift 2 ;;
    --baseline) (($# >= 2)) || usage; baseline="$2"; shift 2 ;;
    --require-remote-tts) require_remote_tts=1; shift ;;
    # Reachable from here on purpose: the escape hatch is for an operator at a
    # terminal, and one that only exists on the far side of an ssh invocation
    # gets replaced by someone editing the deploy path instead.
    --wearer-plane-optional) wearer_plane_optional=1; shift ;;
    # Run the WORKING TREE's canary instead of the deployed release's copy. The
    # default path can only ever run the gate a release was already accepted
    # under, which means a changed canary first executes inside a deploy, with
    # ingress quiesced — a bug there lands in an outage window instead of in a
    # terminal. This is how a canary change gets proven against production
    # BEFORE a deploy stakes anything on it. Operator-only, for the same reason
    # --wearer-plane-optional is: see run_working_tree_canary in lib/local.sh.
    --from-tree) from_tree=1; shift ;;
    --cookie-file) (($# >= 2)) || usage; cookie_file="$2"; shift 2 ;;
    --json) json=1; shift ;;
    *) usage ;;
  esac
done
need_local ssh
args=()
[[ -n "$release_id" ]] && args+=(--release-id "$release_id")
[[ -n "$baseline" ]] && args+=(--baseline "$baseline")
((require_remote_tts)) && args+=(--require-remote-tts)
((wearer_plane_optional)) && args+=(--wearer-plane-optional)
[[ -n "$cookie_file" ]] && args+=(--cookie-file "$cookie_file")
((json)) && args+=(--json)
if ((from_tree)); then
  # Said on stderr so it survives --json: the result below did not come from the
  # gate the running deployment was accepted under.
  echo "warning: running the working tree's platform/deploy/vps/remote/canary.sh against $DEPLOY_REMOTE, not the deployed release's copy" >&2
  run_working_tree_canary "${args[@]}"
else
  run_current_release_operation canary.sh "${args[@]}"
fi
