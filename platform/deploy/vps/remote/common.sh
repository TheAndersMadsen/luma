#!/usr/bin/bash
# Common remote-side deployment primitives. The drivers concatenate this file
# with one reviewed entry point over SSH; do not print or `set -x` secret data.
set -euo pipefail
builtin umask 077

# A held or streamed production entry starts with no caller-selected command
# authority. Remove every imported function before any utility is dispatched,
# then install one fixed host runtime and a minimal process environment. The
# held executor authenticates these root-owned paths; streamed entry points are
# launched under the same positive environment by lib/local.sh.
_revival_imported_functions=()
builtin mapfile -t _revival_imported_functions < <(builtin declare -F)
for _revival_function_record in "${_revival_imported_functions[@]}"; do
  builtin unset -f -- "${_revival_function_record##* }"
done
builtin unset _revival_imported_functions _revival_function_record
builtin unset BASH_ENV ENV CDPATH GLOBIGNORE LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG
builtin unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_REPL_HISTORY NODE_TLS_REJECT_UNAUTHORIZED
builtin unset PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONINSPECT PYTHONWARNINGS PYTHONUSERBASE
builtin unset PYTHONBREAKPOINT PYTHONHASHSEED PYTHONIOENCODING PYTHONCASEOK PYTHONSAFEPATH
builtin unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
builtin unset GIT_CONFIG GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_DIR GIT_WORK_TREE GIT_EXEC_PATH
builtin unset CURL_HOME OPENSSL_CONF SSL_CERT_FILE SSL_CERT_DIR TMPDIR XDG_CONFIG_HOME
PATH=/usr/bin:/usr/sbin
HOME=/nonexistent
LANG=C.UTF-8
LC_ALL=C.UTF-8
TZ=UTC
export PATH HOME LANG LC_ALL TZ

# The only PATH entries are fixed system directories.  Validate their ownership
# and mutability before any name-resolved noncritical utility is allowed to run;
# authority-critical runtimes below still use absolute paths.
for _revival_system_directory in /usr/bin /usr/sbin; do
  [[ -d "$_revival_system_directory" && ! -L "$_revival_system_directory" ]] \
    || { echo 'trusted system command directory is missing or aliased' >&2; exit 1; }
  _revival_system_metadata="$(/usr/bin/stat -Lc '%u:%g:%a' -- "$_revival_system_directory")"
  IFS=: read -r _revival_system_uid _revival_system_gid _revival_system_mode <<<"$_revival_system_metadata"
  [[ "$_revival_system_uid:$_revival_system_gid" == 0:0 ]] \
    && (( (8#${_revival_system_mode} & 8#22) == 0 )) \
    || { echo 'trusted system command directory is writable or unowned' >&2; exit 1; }
done
unset _revival_system_directory _revival_system_metadata _revival_system_uid _revival_system_gid _revival_system_mode
readonly PATH HOME

REVIVAL_HOST_BASH=/usr/bin/bash
REVIVAL_HOST_DOCKER=/usr/bin/docker
REVIVAL_HOST_NODE=/usr/bin/node
REVIVAL_HOST_PYTHON=/usr/bin/python3
REVIVAL_HOST_SUDO=/usr/bin/sudo
readonly REVIVAL_HOST_BASH REVIVAL_HOST_DOCKER REVIVAL_HOST_NODE REVIVAL_HOST_PYTHON REVIVAL_HOST_SUDO

for _revival_host_program in \
  "$REVIVAL_HOST_BASH" "$REVIVAL_HOST_DOCKER" "$REVIVAL_HOST_NODE" \
  "$REVIVAL_HOST_PYTHON" "$REVIVAL_HOST_SUDO" /usr/bin/env; do
  _revival_program_name="$(/usr/bin/stat -c '%u:%g' -- "$_revival_host_program")"
  _revival_program_target="$(/usr/bin/readlink -f -- "$_revival_host_program")"
  [[ "$_revival_program_name" == 0:0 && "$_revival_program_target" == /usr/bin/* ]] \
    || { echo 'trusted host runtime name is outside root-owned /usr/bin' >&2; exit 1; }
  _revival_program_metadata="$(/usr/bin/stat -Lc '%F:%u:%g:%a' -- "$_revival_host_program")"
  IFS=: read -r _revival_program_type _revival_program_uid _revival_program_gid _revival_program_mode \
    <<<"$_revival_program_metadata"
  [[ "$_revival_program_type" == 'regular file' \
    && "$_revival_program_uid:$_revival_program_gid" == 0:0 ]] \
    && (( (8#${_revival_program_mode} & 8#22) == 0 \
      && (8#${_revival_program_mode} & 8#111) != 0 )) \
    || { echo 'trusted host runtime is writable, unowned, or non-executable' >&2; exit 1; }
done
unset _revival_host_program _revival_program_name _revival_program_target
unset _revival_program_metadata _revival_program_type _revival_program_uid _revival_program_gid _revival_program_mode

REMOTE_ROOT="/home/anders/ai-pin-revival"
PRIVATE_DIR="$REMOTE_ROOT/private"
DATA_DIR="$REMOTE_ROOT/data"
PIN_RELEASE_DIR="$DATA_DIR/pin-releases"
BACKUP_ROOT="$REMOTE_ROOT/backups"
DEPLOYMENTS_DIR="$REMOTE_ROOT/deployments"
PACKAGES_DIR="$REMOTE_ROOT/packages"
MANIFESTS_DIR="$REMOTE_ROOT/manifests"
RELEASES_DIR="$REMOTE_ROOT/releases"
LOCK_FILE="$REMOTE_ROOT/deploy.lock"
DOCKER_HOST=unix:///var/run/docker.sock
DOCKER_CONFIG="$REMOTE_ROOT/private/docker-cli-empty"
export DOCKER_HOST DOCKER_CONFIG

BACKUP_CONTRACT_KIND="dk.andersmadsen.ai-pin-revival.backup"
BACKUP_CONTRACT_VERSION=1
BACKUP_INVARIANT_KIND="dk.andersmadsen.ai-pin-revival.backup-invariants"
BACKUP_INVARIANT_VERSION=1
BACKUP_ARCHIVE_INVENTORY_VERSION=1

EXPECTED_HOST="anders-server"
EXPECTED_USER="anders"
EXPECTED_ARCH="aarch64"
PROJECT="ai-pin-revival"
LEGACY_PROJECT="humane-carry-clone"
CANDIDATE_HELPER_REFERENCE="node:22.18.0-alpine3.22@sha256:1b2479dd35a99687d6638f5976fd235e26c5b37e8122f786fcd5fe231d63de5b"
HELPER_IMAGE="${HELPER_IMAGE:-$CANDIDATE_HELPER_REFERENCE}"
[[ "$HELPER_IMAGE" == "$CANDIDATE_HELPER_REFERENCE" || "$HELPER_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || { echo 'invalid inherited backup helper image authority' >&2; exit 1; }
export HELPER_IMAGE

# Authority-critical programs never resolve through PATH. These wrappers also
# centralize old aliases in the large release shell surface without changing
# container-internal `node`/`sh` arguments passed to Docker.
python3() { "$REVIVAL_HOST_PYTHON" -I -B "$@"; }
node() { "$REVIVAL_HOST_NODE" "$@"; }
bash() { "$REVIVAL_HOST_BASH" --noprofile --norc "$@"; }
sudo() {
  local -a _revival_sudo_options=() _revival_sudo_environment=() _revival_sudo_prefix=()
  local _revival_sudo_command="" _revival_sudo_path="" _revival_sudo_target="" _revival_sudo_value=""
  local _revival_sudo_metadata="" _revival_sudo_type="" _revival_sudo_uid="" _revival_sudo_gid="" _revival_sudo_mode=""
  while (($#)); do
    case "$1" in
      -n) _revival_sudo_options+=("$1"); shift ;;
      -u)
        (($# >= 2)) || { echo 'sudo user selection is incomplete' >&2; return 1; }
        _revival_sudo_options+=("$1" "$2"); shift 2 ;;
      XDG_RUNTIME_DIR=*)
        _revival_sudo_value="${1#*=}"
        [[ "$_revival_sudo_value" =~ ^/run/user/[0-9]+$ ]] \
          || { echo 'sudo runtime-directory selection is invalid' >&2; return 1; }
        _revival_sudo_environment+=("$1"); shift ;;
      DBUS_SESSION_BUS_ADDRESS=*)
        _revival_sudo_value="${1#*=}"
        [[ "$_revival_sudo_value" =~ ^unix:path=/run/user/[0-9]+/bus$ ]] \
          || { echo 'sudo session-bus selection is invalid' >&2; return 1; }
        _revival_sudo_environment+=("$1"); shift ;;
      -*|*=*) echo 'sudo option or environment selection is not allowlisted' >&2; return 1 ;;
      *) _revival_sudo_command="$1"; shift; break ;;
    esac
  done
  case "$_revival_sudo_command" in
    python3) _revival_sudo_path="$REVIVAL_HOST_PYTHON"; _revival_sudo_prefix=(-I -B) ;;
    nginx) _revival_sudo_path=/usr/sbin/nginx ;;
    cat|chmod|chown|cp|curl|gzip|install|mkdir|mv|openssl|readlink|rm|sha256sum|stat|systemctl|tar|test|true)
      _revival_sudo_path="/usr/bin/$_revival_sudo_command" ;;
    *) echo 'sudo command is not allowlisted' >&2; return 1 ;;
  esac
  _revival_sudo_target="$(/usr/bin/readlink -f -- "$_revival_sudo_path")"
  [[ "$_revival_sudo_target" == /usr/bin/* || "$_revival_sudo_target" == /usr/sbin/* ]] \
    || { echo 'sudo command target is outside the trusted system directories' >&2; return 1; }
  _revival_sudo_metadata="$(/usr/bin/stat -Lc '%F:%u:%g:%a' -- "$_revival_sudo_path")"
  IFS=: read -r _revival_sudo_type _revival_sudo_uid _revival_sudo_gid _revival_sudo_mode \
    <<<"$_revival_sudo_metadata"
  [[ "$_revival_sudo_type" == 'regular file' && "$_revival_sudo_uid:$_revival_sudo_gid" == 0:0 ]] \
    && (( (8#${_revival_sudo_mode} & 8#22) == 0 && (8#${_revival_sudo_mode} & 8#111) != 0 )) \
    || { echo 'sudo command is writable, unowned, or non-executable' >&2; return 1; }
  "$REVIVAL_HOST_SUDO" "${_revival_sudo_options[@]}" /usr/bin/env -i \
    HOME=/nonexistent LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/bin:/usr/sbin TZ=UTC \
    "${_revival_sudo_environment[@]}" "$_revival_sudo_path" "${_revival_sudo_prefix[@]}" "$@"
}
docker() {
  /usr/bin/env -i \
    DOCKER_CONFIG="$DOCKER_CONFIG" DOCKER_HOST="$DOCKER_HOST" \
    HOME=/nonexistent LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/bin:/usr/sbin TZ=UTC \
    "$REVIVAL_HOST_DOCKER" "$@"
}

STATE_VOLUME="humane-carry-clone_carry-state"
PG_VOLUME="humane-carry-clone_carry-pgdata"
PROMETHEUS_VOLUME="humane-carry-clone_prometheus-data"
GRAFANA_VOLUME="humane-carry-clone_grafana-data"
CENTER_DATA_DIR="/home/anders/carry-center-data"
LOCAL_MODEL_NETWORK="humane-carry-clone_carry-local"
LEGACY_RUNTIME_ENV="/home/anders/humane-carry-clone/.env"
LEGACY_BACKENDS_ENV="/home/anders/carry-backends.env"
LEGACY_CENTER_ENV="/home/anders/carry-center.env"
LEGACY_EDGE_DIR="/home/anders/carry-edge"
LEGACY_ATTEST_DIR="/home/anders/carry-attest"
LEGACY_DUC_DIR="/home/anders/carry-duc"
LEGACY_DATABASE_USER="carry"
LEGACY_DATABASE_NAME="carry"

# These are deployed physical identities, not migration inputs.  The canonical
# Cosmos-named workloads deliberately continue to consume the exact Carry
# certificate/key inodes for the whole rollback window.  No deployment path is
# allowed to copy, rename, chown, chmod, relabel, create, or otherwise replace
# them.  Only the generated Envoy configuration is release-private.
PRODUCTION_EDGE_CONFIG="$PRIVATE_DIR/edge/envoy.yaml"
PRODUCTION_EDGE_CERT_DIR="$LEGACY_EDGE_DIR/certs"
PRODUCTION_ATTEST_DIR="$LEGACY_ATTEST_DIR"
PRODUCTION_DUC_DIR="$LEGACY_DUC_DIR"
PRODUCTION_KEYCLOAK_THEME_DIR="/home/anders/keycloak-themes/humane"

RUNTIME_ENV="$PRIVATE_DIR/runtime.env"
COSMOS_ENV="$PRIVATE_DIR/cosmos.env"
CENTER_ENV="$PRIVATE_DIR/center.env"
PROVIDER_ENV="$PRIVATE_DIR/providers.env"
# Operator-provisioned, never written by any script here. See
# assert_wearer_canary_secret for the contract and docs/operations.md for the
# provisioning runbook.
WEARER_CANARY_SECRET="$PRIVATE_DIR/canary-wearer.secret"

# A manifest-held release executor deliberately presents executable bytes as
# sealed anonymous memfds under /proc/<holder>/fd/<number>. Those names are
# symlinks by kernel design, so a blanket `! -L` check would reject the safer
# mode. A merely-open ordinary inode is not enough: its owner can still rewrite
# it while bash/Python is consuming it. Require the kernel write/grow/shrink/seal
# locks on every inherited execution dependency.
release_material_file_is_safe() {
  local candidate="$1"
  if [[ "$candidate" =~ ^/proc/self/fd/[1-9][0-9]*$ ]]; then
    "$REVIVAL_HOST_PYTHON" -I -B - "$candidate" <<'PY'
import fcntl,os,stat,sys
path=sys.argv[1]
required=(getattr(fcntl,"F_SEAL_SEAL",0x0001)|getattr(fcntl,"F_SEAL_SHRINK",0x0002)|
          getattr(fcntl,"F_SEAL_GROW",0x0004)|getattr(fcntl,"F_SEAL_WRITE",0x0008))
descriptor=os.open(path,os.O_RDONLY)
try:
    metadata=os.fstat(descriptor)
    assert stat.S_ISREG(metadata.st_mode) and metadata.st_nlink==0
    assert (metadata.st_uid,metadata.st_gid)==(os.getuid(),os.getgid())
    assert stat.S_IMODE(metadata.st_mode) in (0o600,0o644,0o755)
    assert fcntl.fcntl(descriptor,fcntl.F_GET_SEALS)&required==required
finally: os.close(descriptor)
PY
  else
    [[ -f "$candidate" && ! -L "$candidate" ]]
  fi
}

# The only supported way a release-bound shell invokes the candidate verifier.
# held-release-exec.py supplies all three descriptors with FD_CLOEXEC cleared in
# its child, so they remain live through Bash -> Node.  No logical release path,
# cwd, parent-PID proc path, or ambient ROOT variable participates in authority.
run_held_candidate_verifier() {
  [[ "${REVIVAL_HELD_CANDIDATE_VERIFIER:-}" =~ ^/proc/self/fd/[1-9][0-9]*$ \
    && "${REVIVAL_HELD_RELEASE_ROOT_FD:-}" =~ ^[1-9][0-9]*$ \
    && "${REVIVAL_HELD_RELEASE_MANIFEST_FD:-}" =~ ^[1-9][0-9]*$ \
    && "${REVIVAL_HELD_RELEASE_ROOT:-}" == "/proc/self/fd/${REVIVAL_HELD_RELEASE_ROOT_FD:-}" \
    && "${REVIVAL_HELD_RELEASE_ID:-}" =~ ^[0-9a-f]{64}$ ]] \
    || fail "held candidate verifier/root/manifest authority is unavailable"
  release_material_file_is_safe "$REVIVAL_HELD_CANDIDATE_VERIFIER" \
    || fail "held candidate verifier is not a fully sealed regular memfd"
  "$REVIVAL_HOST_NODE" --preserve-symlinks --preserve-symlinks-main "$REVIVAL_HELD_CANDIDATE_VERIFIER" \
    --held-release-root-fd "$REVIVAL_HELD_RELEASE_ROOT_FD" \
    --held-release-manifest-fd "$REVIVAL_HELD_RELEASE_MANIFEST_FD" \
    --held-release-id "$REVIVAL_HELD_RELEASE_ID" "$@"
}

MANAGED_CLOUDFLARED_CONFIG="/home/anders/.cloudflared/config.yml"
MANAGED_CLOUDFLARED_BINARY="/usr/local/bin/cloudflared"
MANAGED_CLOUDFLARED_COMMAND="$MANAGED_CLOUDFLARED_BINARY tunnel --config $MANAGED_CLOUDFLARED_CONFIG run"
MANAGED_CLOUDFLARED_SYSTEM_UNIT="cloudflared-tunnel.service"
MANAGED_CLOUDFLARED_USER_UNIT="cloudflared-hermes.service"

# ── The canary wearer credential ─────────────────────────────────────────────
#
# write_owner_canary_cookie above mints a SESSION and deliberately no bearer, and
# says so at length. What follows is the other half: a real sealed Keycloak
# bearer for a DEDICATED canary identity, which is the only thing that can prove
# openTokens/refreshTokens/JWKS/COSMOS_EDGE_TOKEN are intact on a live deployment.
# Two 100%-degraded wearer planes shipped green because nothing did.
#
# WHY A SEPARATE REALM USER AND NOT A SERVICE ACCOUNT. Center mints the wearer
# bearer in exactly one place — POST /api/auth/login, which calls keycloakLogin
# (Resource Owner Password against client `center`), seals the result with
# sealTokens and writes it as the chunked `carry_tokens` cookie set. A
# client-credentials service account would return a token this deployment's own
# login path never produces, and it returns no refresh token at all, so the gate
# would be exercising a code path production does not have. The canary therefore
# signs in the way a wearer signs in, through Center's own route, and the jar it
# gets back is byte-for-byte the jar a browser gets.
#
# WHAT THE OPERATOR PROVISIONS. One Keycloak realm user in `humane` that is:
#   * NOT in the operator allowlist and holds no `carry-operator` role, so the
#     admin plane refuses it — canary.sh proves this at runtime rather than
#     trusting the provisioning;
#   * NOT the paired Pin owner, so it addresses its own empty `U:<sub>`
#     partition — canary.sh proves that too, against
#     REVIVAL_PIN_BRIDGE_OWNER_SUB;
#   * paired to no device, so it cannot drive the bridge.
# Everything that identity can reach is therefore an empty account. A stolen jar
# buys an attacker a view of nothing, which is the point: this credential must
# not widen what reading a log or an evidence file is worth.
#
# WHERE THE SECRET LIVES. $WEARER_CANARY_SECRET, inside the 0700 $PRIVATE_DIR,
# mode 0600, owned by the deploying user — the same posture as every other
# secret file on this host. It is NOT an entry in any .env file: those are
# interpolated into Compose and land in container environments, and this
# credential must never be readable from inside a workload. It is deliberately
# NOT fingerprinted into config-digests.tsv either, because rotating it would
# then trip the protected-configuration gate and deadlock a deploy on a
# credential rotation — the exact class of deadlock adopt-config exists to undo.
#
# HOW IT REACHES A REQUEST. It does not reach canary.sh as a value at all. The
# password goes from the file into a mode-0600 JSON body in a private temp
# directory, curl reads that body with `--data @path` (the PATH is the argument;
# the value never appears in argv, in the environment, or in any log), and what
# comes back is a short-lived cookie jar. The exchange happens on the loopback
# Center origin only, so the credential never traverses nginx, Cloudflare or any
# public hop. The jar is removed when the canary exits.

# ---------------------------------------------------------------------------
# The implementation lives in cohesive libraries beside this file. This loader
# holds the shared constants above and sources every library, so `source
# common.sh` keeps meaning what it always has — one file, the whole surface.
# The streamed operations (lib/local.sh run_remote_impl) write these files
# into the same staging directory before the entry point runs.
_revival_common_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
for _revival_common_lib in \
  paths ingress release_transactions configuration compose backup database canary carry-baseline drift; do
  _revival_common_key="REVIVAL_HELD_COMMON_LIB_${_revival_common_lib^^}"
  _revival_common_key="${_revival_common_key//-/_}"
  _revival_common_path="${!_revival_common_key:-$_revival_common_dir/lib/$_revival_common_lib.sh}"
  # shellcheck source=/dev/null
  source "$_revival_common_path"
done
unset _revival_common_dir _revival_common_lib _revival_common_key _revival_common_path
