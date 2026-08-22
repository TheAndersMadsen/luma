#!/usr/bin/env -S /bin/bash -p
# Local side of the supported protected-configuration change.
#
# Streamed with run_remote_impl rather than dispatched through
# run_current_release_operation, and that is the whole point of the choice: this
# tool is needed exactly when a deploy will not complete, so it cannot depend on
# a release having already shipped it to the server. The reviewed local scripts
# go over stdin, run out of a temporary directory, and leave nothing installed.
#
# The argument list is closed. There is no pass-through, so no future caller can
# hand the remote entry point an option this file has not been read to allow.
set -euo pipefail
case "${BASH_SOURCE[0]}" in /*) SCRIPT_PATH="${BASH_SOURCE[0]}" ;; *) SCRIPT_PATH="$PWD/${BASH_SOURCE[0]}" ;; esac
SCRIPT_DIR="${SCRIPT_PATH%/*}"
builtin source "$SCRIPT_DIR/lib/local.sh"

baseline=all
confirm=0
reason=""
expect_plan=""
show_all=0
json=0
explain() {
  cat <<EOF
usage: ./revival adopt-config [--remote vps] [--baseline all|pending|current]
                              [--show-all] [--json]
                              [--confirm --reason TEXT [--expect-plan TOKEN]]

Teaches a deployment record that a protected configuration input legitimately
changed. Use it when a repair moved one of the inputs config-digests.tsv
fingerprints -- re-ticketing /etc/penumbra after the Pin regenerated its iroh
node identity is the case this was built for -- and the deploy now refuses with
"protected configuration or rendered Compose model drift".

WITHOUT --confirm this only PLANS: it recomputes the live evidence, prints every
row that differs from every relevant deployment record, names the files under a
changed protected directory, and changes nothing.
WITH --confirm it REWRITES exactly the rows it printed, in exactly the records it
printed, and records the reason in each one.

It is not a way around the drift gate. It changes what the recorded baseline
says; it never changes whether the comparison happens, it cannot run while a
deploy holds the deployment lock, and after adopting it re-proves each record
with the same verify_configuration_evidence every deploy gate calls.

Options
  --baseline all|pending|current  which deployment records to ADOPT INTO. Default
                                  \`all\`: a prepared transaction's record is what
                                  the resume path verifies FIRST, current-deployment
                                  is what preflight verifies. Both are reported.
                                  \`current\` refuses, rather than quietly succeeding,
                                  while a prepared transaction's record carries
                                  configuration evidence of its own.
  --confirm                       adopt; without it, plan only
  --reason TEXT                   required with --confirm; stored in the record
  --expect-plan TOKEN             refuse unless the plan still matches the token
                                  the dry run printed
  --show-all                      also list the rows that already match
  --json                          machine-readable plan or result
  --remote NAME                   SSH target (default: vps)
  --help                          show this message
EOF
}
usage() { explain >&2; exit 64; }
while (($#)); do
  case "$1" in
    --help|-h) explain; exit 0 ;;
    --remote) (($# >= 2)) || usage; DEPLOY_REMOTE="$2"; shift 2 ;;
    --baseline) (($# >= 2)) || usage; baseline="$2"; shift 2 ;;
    --confirm) confirm=1; shift ;;
    --reason) (($# >= 2)) || usage; reason="$2"; shift 2 ;;
    --expect-plan) (($# >= 2)) || usage; expect_plan="$2"; shift 2 ;;
    --show-all) show_all=1; shift ;;
    --json) json=1; shift ;;
    *) usage ;;
  esac
done
case "$baseline" in all|pending|current) ;; *) usage ;; esac
[[ -z "$expect_plan" || "$expect_plan" =~ ^[0-9a-f]{64}$ ]] \
  || usage_error "--expect-plan must be the 64-character plan token the dry run printed"
if ((confirm)); then
  # Refused here as well as remotely, so an operator who forgot it is told
  # before a connection is opened rather than after a privileged read.
  [[ -n "$reason" ]] || usage_error "--confirm requires --reason: adopting a protected configuration change without a stated reason is the hand-edit this command replaces"
else
  [[ -z "$reason" ]] || usage_error "--reason is only meaningful with --confirm"
fi
[[ "$reason" != *$'\n'* && "$reason" != *$'\r'* ]] || usage_error "--reason must be a single line"
((${#reason} <= 1000)) || usage_error "--reason must be at most 1000 characters"

need_local ssh
args=(--baseline "$baseline")
((show_all)) && args+=(--show-all)
((json)) && args+=(--json)
[[ -z "$expect_plan" ]] || args+=(--expect-plan "$expect_plan")
((confirm)) && args+=(--confirm --reason "$reason")
run_remote_impl adopt-config.sh "${args[@]}"
