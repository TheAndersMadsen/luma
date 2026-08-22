#!/usr/bin/env bash
set -euo pipefail

if (( $# < 3 )); then
  printf 'debug-set-publisher: usage: publish-debug-set.sh ROOT APPEND_ONLY_SET ROLE [ROLE ...]\n' >&2
  exit 2
fi

# Publication appends a watched selection record for an already verified set;
# it never reopens helper code by a mutable source path.
readonly held_tool="${REVIVAL_HELD_DEBUG_STORE_TOOL:-}"
if [[ ! "${held_tool}" =~ ^/proc/(self|[1-9][0-9]*)/fd/[0-9]+$ ]]; then
  printf 'debug-set-publisher: REVIVAL_HELD_DEBUG_STORE_TOOL must be a held /proc fd\n' >&2
  exit 1
fi
exec /usr/bin/python3 -B "${held_tool}" publish "$@"
