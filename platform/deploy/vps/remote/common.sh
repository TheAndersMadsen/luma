#!/usr/bin/env bash
# Common remote-side deployment primitives. The drivers concatenate this file
# with one reviewed entry point over SSH; do not print or `set -x` secret data.
set -euo pipefail
umask 077

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
HELPER_IMAGE="node:22.18.0-alpine3.22@sha256:1b2479dd35a99687d6638f5976fd235e26c5b37e8122f786fcd5fe231d63de5b"

STATE_VOLUME="humane-carry-clone_carry-state"
PG_VOLUME="humane-carry-clone_carry-pgdata"
PROMETHEUS_VOLUME="humane-carry-clone_prometheus-data"
GRAFANA_VOLUME="humane-carry-clone_grafana-data"
CENTER_DATA_DIR="/home/anders/carry-center-data"

RUNTIME_ENV="$PRIVATE_DIR/runtime.env"
COSMOS_ENV="$PRIVATE_DIR/cosmos.env"
CENTER_ENV="$PRIVATE_DIR/center.env"
PROVIDER_ENV="$PRIVATE_DIR/providers.env"
# Operator-provisioned, never written by any script here. See
# assert_wearer_canary_secret for the contract and docs/operations.md for the
# provisioning runbook.
WEARER_CANARY_SECRET="$PRIVATE_DIR/canary-wearer.secret"

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
# openTokens/refreshTokens/JWKS/CARRY_EDGE_TOKEN are intact on a live deployment.
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
  paths ingress release_transactions configuration compose backup database canary drift; do
  # shellcheck source=/dev/null
  source "$_revival_common_dir/lib/$_revival_common_lib.sh"
done
unset _revival_common_dir _revival_common_lib
