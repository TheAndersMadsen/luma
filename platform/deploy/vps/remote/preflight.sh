#!/usr/bin/bash
set -euo pipefail
source "${REVIVAL_HELD_COMMON:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh}"
source "${REVIVAL_HELD_DOMAIN:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/domain.sh}"

min_free_gb=8
cleanup=0
json=0
archive_bytes=0
candidate_id=""
candidate_release_id=""
deployment_authority_sha256=""
first_cutover=0
usage() {
  echo "usage: preflight --min-free-gb N [--archive-bytes N] [--cleanup-project-images] [--json]" >&2
  exit 64
}
while (($#)); do
  case "$1" in
    --min-free-gb) (($# >= 2)) || usage; min_free_gb="$2"; shift 2 ;;
    --archive-bytes) (($# >= 2)) || usage; archive_bytes="$2"; shift 2 ;;
    --candidate-id) (($# >= 2)) || usage; candidate_id="$2"; shift 2 ;;
    --candidate-release-id) (($# >= 2)) || usage; candidate_release_id="$2"; shift 2 ;;
    --deployment-authority-sha256) (($# >= 2)) || usage; deployment_authority_sha256="$2"; shift 2 ;;
    --cleanup-project-images) cleanup=1; shift ;;
    --json) json=1; shift ;;
    *) usage ;;
  esac
done
[[ "$min_free_gb" =~ ^[0-9]+$ && "$archive_bytes" =~ ^[0-9]+$ ]] || usage
if [[ -n "$candidate_id$candidate_release_id$deployment_authority_sha256" ]]; then
  [[ "$candidate_id" =~ ^[0-9a-f]{64}$ && "$candidate_release_id" =~ ^[0-9a-f]{64}$ \
    && "$deployment_authority_sha256" =~ ^[0-9a-f]{64}$ ]] || usage
fi

assert_target
assert_remote_root
for command in bash docker curl getent openssl python3 flock sha256sum tar gzip awk sed stat find ip systemctl pgrep readlink; do need "$command"; done
docker compose version >/dev/null
compose_version="$(docker compose version --short | sed 's/^v//')"
python3 - "$compose_version" <<'PY'
import re,sys
match=re.match(r"^(\d+)\.(\d+)\.(\d+)",sys.argv[1])
if not match or tuple(map(int,match.groups())) < (2,33,1):
    raise SystemExit("Docker Compose 2.33.1 or newer is required for gw_priority")
PY
docker info >/dev/null
domain_cloudflared_assert_ready \
  || fail "the exact Cloudflare tunnel command and fixed configuration are not ready"
assert_managed_cloudflared_topology \
  || fail "the active Cloudflare tunnel processes are not the exact allowlisted system and user units"

transaction_driver="${REVIVAL_HELD_TRANSACTION:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/transaction.py}"
release_material_file_is_safe "$transaction_driver" \
  || fail "global authority transaction helper is missing or unsafe"

if [[ ! -e "$REMOTE_ROOT" ]]; then
  global_pending=()
elif [[ -L "$REMOTE_ROOT" || ! -d "$REMOTE_ROOT" ]]; then
  fail "canonical deployment root is unsafe"
else
  first_cutover=1
  inventory_json="$(python3 "$transaction_driver" --root "$REMOTE_ROOT" --inventory)" \
    || fail "global authority transaction inventory is invalid"
  mapfile -t global_pending < <(python3 - "$inventory_json" <<'PY'
import json,sys
body=json.loads(sys.argv[1])
assert body.get("schemaVersion")==1 and isinstance(body.get("active"),list) and len(body["active"])<=1
for item in body["active"]:
  assert set(item)=={"namespace","record"}
  print(f'{item["namespace"]}\t{item["record"]}')
PY
  )
fi

# A durably prepared deployment operation is the one deliberate exception to
# ordinary topology and ingress readiness. Preflight never mutates it: it binds
# the pending record to its immutable release and lets that release's verified
# deploy driver either prove predecessor recovery or resume accepted activation.
pending_transactions=()
pending_activation=0
if ((${#global_pending[@]} == 1)); then
  IFS=$'\t' read -r pending_namespace pending_record <<<"${global_pending[0]}"
  [[ "$pending_namespace" == deploy ]] \
    || fail "a rollback authority transaction is pending and must be resumed before deployment"
  pending_transactions=("$pending_record")
fi
if ((${#pending_transactions[@]} == 1)); then
  pending_record="${pending_transactions[0]}"
  [[ -f "$pending_record/release-id" && ! -L "$pending_record/release-id" \
    && -f "$pending_record/ingress-active.tsv" && ! -L "$pending_record/ingress-active.tsv" ]] \
    || fail "pending deployment operation lacks durable identity or ingress evidence"
  pending_release_id="$(tr -d '\r\n' <"$pending_record/release-id")"
  validate_release_id "$pending_release_id"
  pending_release="$RELEASES_DIR/$pending_release_id"
  pending_manifest="$MANIFESTS_DIR/$pending_release_id.json"
  pending_verifier="$pending_release/platform/deploy/vps/verify-release.py"
  pending_transaction_driver="$pending_release/platform/deploy/vps/remote/transaction.py"
  [[ -d "$pending_release" && ! -L "$pending_release" && -f "$pending_manifest" \
    && ! -L "$pending_manifest" && -f "$pending_verifier" && ! -L "$pending_verifier" \
    && -f "$pending_transaction_driver" && ! -L "$pending_transaction_driver" ]] \
    || fail "pending deployment release material is unsafe"
  verify_release_verifier_entry "$pending_manifest" "$pending_verifier" "$pending_release_id" \
    || fail "pending deployment verifier is not manifest-bound"
  # CROSS-RELEASE INVOCATION: verify-release.py out of $pending_release, which is a
  # POSSIBLY-OLDER release than this one. Its interface must not be assumed; only
  # options from the frozen release-boundary baseline may be passed. See
  # cross_release_baseline_options in common.sh.
  assert_cross_release_options verify-release.py --tree --manifest --expect-release-id --json
  run_held_release_program "$pending_release" platform/deploy/vps/verify-release.py python 0 \
    --tree "$pending_release" --manifest "$pending_manifest" \
    --expect-release-id "$pending_release_id" --json >/dev/null
  pending_operation=0
  if [[ -f "$pending_record/OPERATION_TRANSACTION_PREPARED" \
      && ! -f "$pending_record/OPERATION_TRANSACTION_COMPLETED" \
      && ! -f "$pending_record/OPERATION_TRANSACTION_ABORTED" ]]; then
    # CROSS-RELEASE INVOCATION: transaction.py out of $pending_release. Baseline
    # options only; see cross_release_baseline_options in common.sh.
    assert_cross_release_options transaction.py --root --record --namespace --operation-action
    run_held_release_program "$pending_release" platform/deploy/vps/remote/transaction.py python 0 \
      --root "$REMOTE_ROOT" --record "$pending_record" --namespace deploy --operation-action verify
    pending_operation=1
  fi
  if ((pending_operation)) && [[ ! -f "$pending_record/CANDIDATE_ACTIVATION_ARMED" ]]; then
    [[ ! -f "$pending_record/INGRESS_ACTIVATED" \
      && ! -f "$pending_record/POINTER_TRANSACTION_COMMITTED" \
      && ! -f "$pending_record/SUCCEEDED" ]] \
      || fail "pre-activation operation contains accepted or committed authority"
    if [[ -f "$pending_record/POINTER_TRANSACTION_PREPARED" ]]; then
      [[ -f "$pending_record/POINTER_TRANSACTION.json" \
        && ! -L "$pending_record/POINTER_TRANSACTION.json" ]] \
        || fail "prepared pre-activation pointer transaction lacks its journal"
      # CROSS-RELEASE INVOCATION: transaction.py out of $pending_release.
      assert_cross_release_options transaction.py --root --record --namespace --reconcile --prepare-only
      run_held_release_program "$pending_release" platform/deploy/vps/remote/transaction.py python 0 \
        --root "$REMOTE_ROOT" --record "$pending_record" --namespace deploy --reconcile --prepare-only
    fi
    pending_activation=1
  else
    [[ -f "$pending_record/POINTER_TRANSACTION.json" \
      && ! -L "$pending_record/POINTER_TRANSACTION.json" \
      && -f "$pending_record/config-digests.tsv" && ! -L "$pending_record/config-digests.tsv" \
      && -f "$pending_record/resolved-images.tsv" && ! -L "$pending_record/resolved-images.tsv" ]] \
      || fail "incomplete pointer transaction lacks durable activation evidence"
    verify_configuration_evidence "$pending_record/config-digests.tsv" "$pending_release"
    if [[ -f "$pending_record/INGRESS_ACTIVATED" ]]; then
    [[ -f "$pending_record/running-images.tsv" ]] \
      || fail "accepted pointer transaction lacks running image evidence"
    verify_image_evidence "$pending_record/running-images.tsv" "$pending_release"
    domain_cloudflared_verify_desired "$pending_record" \
      || fail "accepted pending deployment has Cloudflare route or configuration drift"
    assert_ingress_matches_recorded "$pending_record/ingress-active.tsv" \
      || fail "incomplete pointer transaction ingress no longer matches accepted state"
    [[ -z "$(docker ps -q --filter "label=com.docker.compose.project=$LEGACY_PROJECT")" \
      && -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")" ]] \
      || fail "incomplete pointer transaction production topology is ambiguous"
    canonical_current="$pending_release"
    canonical_record="$pending_record"
    else
      python3 - "$pending_record/POINTER_TRANSACTION.json" "$pending_record" "$pending_release" \
        "$REMOTE_ROOT" <<'PY'
import json,os,sys
path,record,release,root=sys.argv[1:]; body=json.load(open(path,encoding="utf-8"))
assert body.get("schemaVersion")==1 and body.get("namespace")=="deploy" and body.get("record")==record
assert body.get("desiredCurrent")==release and body.get("desiredCurrentDeployment")==record
assert body.get("desiredPrevious")==body.get("oldCurrent")
def pointer(name):
    path=os.path.join(root,name)
    if not os.path.lexists(path): return ""
    assert os.path.islink(path); return os.path.realpath(path)
assert pointer("current")==body.get("oldCurrent")
assert pointer("previous")==body.get("oldPrevious")
assert pointer("current-deployment")==body.get("oldCurrentDeployment")
PY
      pending_activation=1
    fi
  fi
else
# Establish one unambiguous production topology before any backup or config
# capture. A canonical current release is paired with its exact deployment
# record and may not run alongside legacy. A first cutover/retry may not retain
# any stopped or running canonical candidate containers.
if canonical_current="$(safe_release_pointer "$REMOTE_ROOT/current" 2>/dev/null)"; then
  first_cutover=0
  canonical_record="$(safe_deployment_pointer "$REMOTE_ROOT/current-deployment" 2>/dev/null)" \
    || fail "canonical current release lacks authoritative deployment lineage"
  [[ -f "$canonical_record/SUCCEEDED" && -f "$canonical_record/INGRESS_ACTIVATED" \
    && -f "$canonical_record/POINTER_TRANSACTION_COMMITTED" && -f "$canonical_record/release-id" \
    && -f "$canonical_record/running-images.tsv" && -f "$canonical_record/config-digests.tsv" \
    && "$(tr -d '\r\n' <"$canonical_record/release-id")" == "$(basename "$canonical_current")" ]] \
    || fail "canonical current release and deployment lineage disagree"
  [[ -z "$(docker ps -q --filter "label=com.docker.compose.project=$LEGACY_PROJECT")" ]] \
    || fail "legacy and canonical projects are running simultaneously"
  [[ -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")" ]] \
    || fail "canonical current pointer exists but no canonical services are running"
  verify_image_evidence "$canonical_record/running-images.tsv" "$canonical_current"
  verify_configuration_evidence "$canonical_record/config-digests.tsv" "$canonical_current"
  domain_cloudflared_verify_desired "$canonical_record" \
    || fail "canonical deployment Cloudflare route or configuration drifted"
else
  first_cutover=1
  [[ ! -e "$REMOTE_ROOT/current" && ! -L "$REMOTE_ROOT/current" ]] \
    || fail "canonical current pointer exists but is unsafe"
  [[ ! -e "$REMOTE_ROOT/current-deployment" && ! -L "$REMOTE_ROOT/current-deployment" ]] \
    || fail "deployment lineage exists without a canonical current release"
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ]] \
    || fail "stale canonical candidate containers must be reconciled before first cutover"
  [[ -n "$(docker ps -q --filter "label=com.docker.compose.project=$LEGACY_PROJECT")" ]] \
    || fail "first cutover requires one active legacy production project"
fi
fi

if ((pending_activation)); then
  # The selected deploy driver will resume the manifest-bound candidate before
  # considering a new release. Ordinary production readiness checks cannot run
  # while that deliberately quiesced activation is incomplete.
  if ((json)); then printf '{"ok":true,"pendingActivation":true}\n'; else log "pending candidate activation is safe to resume"; fi
  exit 0
fi

# Exact durable-resource and active-mount authority is proved before the first
# cleanup or other remote mutation. A missing/wrong legacy volume, network,
# Center directory, or project-specific mount therefore cannot be papered over
# by Docker auto-creation or leave even an image-removal side effect.
assert_durable_inputs
assert_active_durable_mounts
if [[ -n "${canonical_record:-}" ]]; then
  verify_exact_legacy_security_identity "$canonical_record/carry-security-identity.json"
else
  # The predecessor authority below binds this same complete identity to the hosted
  # registrar.  This first pass is intentionally before cleanup/capacity work.
  write_exact_legacy_security_identity >/dev/null \
    || fail "deployed legacy PKI/certificate paths are unsafe"
fi

# A pre-workflow legacy runtime is not a hosted release and is never described
# as one.  Its sole first-cutover authority is the deterministic observation
# registered by held code from this exact candidate.  Reprove it before any
# cleanup, image removal, staging write, or writer quiesce.
if ((first_cutover)); then
  legacy_predecessor_id="$(active_legacy_predecessor_id)" \
    || fail "first cutover requires the one-time adopted-live-carry-v1 registration"
  verify_legacy_predecessor "$legacy_predecessor_id" active \
    "$candidate_id" "$candidate_release_id" "$deployment_authority_sha256" \
    || fail "live legacy predecessor differs from its sealed one-time authority"
fi

# Legacy rollback compatibility only. Canonical Center and Keycloak are not
# attached to carry-net; after a valid canonical current release exists, the
# next rollback target is canonical and this historical network is irrelevant.
if legacy_rollback_network_required; then
  docker network inspect carry-net >/dev/null 2>&1 \
    || fail "legacy rollback network carry-net is missing before first canonical cutover"
fi

stale_smoke_containers="$(docker ps -aq --filter 'label=dk.andersmadsen.ai-pin-revival.temporary=staging-smoke' | head -n 1)"
stale_smoke_volumes="$(docker volume ls -q --filter 'label=dk.andersmadsen.ai-pin-revival.temporary=staging-smoke' | head -n 1)"
stale_smoke_networks="$(docker network ls -q --filter 'label=dk.andersmadsen.ai-pin-revival.temporary=staging-smoke' | head -n 1)"
[[ -z "$stale_smoke_containers$stale_smoke_volumes$stale_smoke_networks" ]] \
  || fail "stale isolated staging-smoke objects require reviewed cleanup before deployment"
sudo -n true >/dev/null
sudo -n nginx -t >/dev/null
systemctl is-active --quiet penumbra-center-bridge.service || fail "penumbra-center-bridge.service is not active"
timeout 3 bash -c '</dev/tcp/127.0.0.1/18080' 2>/dev/null || fail "the existing Pin bridge is not listening on 127.0.0.1:18080"

# Reject overlap before Compose creates the fixed private Spotify control link.
# A previously deployed ai-pin-revival spotify-control network is the only
# accepted owner of the exact subnet.
routes_json="$(mktemp)"
networks_json="$(mktemp)"
domain_discovery="$(mktemp)"
rm -f -- "$domain_discovery"
tts_work=""
cleanup_preflight() {
  rm -f -- "$routes_json" "$networks_json" "$domain_discovery"
  if [[ -n "$tts_work" && -d "$tts_work" ]]; then rm -rf -- "$tts_work"; fi
}
trap cleanup_preflight EXIT
previous_domain_discovery=""
if [[ -n "${canonical_record:-}" ]]; then
  previous_domain_discovery="$canonical_record/public-edge-discovery.json"
fi
domain_select_public_edge "$domain_discovery" "$previous_domain_discovery" \
  || fail "the active or recorded dashboard edge cannot seed the Center deployment"
domain_assert_public_tls "$domain_discovery" \
  || fail "the active wildcard TLS pair cannot serve center.andersmadsen.dk"
domain_assert_dns_ready center.andersmadsen.dk \
  || fail "center.andersmadsen.dk DNS and public TLS are not ready before cutover"
ip -j route show >"$routes_json"
network_ids="$(docker network ls -q | tr '\n' ' ')"
if [[ -n "$network_ids" ]]; then
  # shellcheck disable=SC2086 -- IDs are Docker-generated hex values.
  docker network inspect $network_ids >"$networks_json"
else
  printf '[]\n' >"$networks_json"
fi
python3 - "$routes_json" "$networks_json" <<'PY'
import ipaddress,json,sys
target=ipaddress.ip_network("10.0.7.0/24")
routes=json.load(open(sys.argv[1],encoding="utf-8")); networks=json.load(open(sys.argv[2],encoding="utf-8"))
allowed_ifaces=set()
for network in networks:
    labels=network.get("Labels") or {}; name=network.get("Name","")
    for config in (network.get("IPAM",{}).get("Config") or []):
        value=config.get("Subnet")
        if not value: continue
        subnet=ipaddress.ip_network(value,strict=False)
        if not subnet.overlaps(target): continue
        allowed=labels.get("com.docker.compose.project")=="ai-pin-revival" and name.endswith("_spotify-control") and subnet==target
        if not allowed: raise SystemExit(f"Spotify control subnet overlaps Docker network {name}")
        allowed_ifaces.add(network.get("Options",{}).get("com.docker.network.bridge.name", ""))
for route in routes:
    value=route.get("dst")
    if not value or value=="default": continue
    try: subnet=ipaddress.ip_network(value,strict=False)
    except ValueError: continue
    if not subnet.overlaps(target): continue
    dev=route.get("dev","")
    # Docker may choose an anonymous br- interface even when no explicit bridge
    # name was requested; only accept it when the exact allowed network exists.
    if subnet==target and (dev in allowed_ifaces or (dev.startswith("br-") and allowed_ifaces)):
        continue
    raise SystemExit(f"Spotify control subnet overlaps host route {value} on {dev or 'unknown'}")
PY

available_kb="$(df -Pk /home/anders | awk 'NR==2 {print $4}')"
required_kb=$((min_free_gb * 1024 * 1024 + (archive_bytes * 6 / 1024)))
((available_kb >= required_kb)) || fail "insufficient project build capacity: need ${required_kb} KiB, have ${available_kb} KiB"

if [[ ! -f "$RUNTIME_ENV" ]]; then
  [[ -f "$LEGACY_RUNTIME_ENV" ]] || fail "neither canonical nor legacy runtime configuration exists"
fi
runtime_source="$RUNTIME_ENV"; [[ -f "$runtime_source" ]] || runtime_source="$LEGACY_RUNTIME_ENV"
domain_env_value "$runtime_source" KEYCLOAK_ADMIN >/dev/null \
  && domain_env_value "$runtime_source" KEYCLOAK_ADMIN_PASSWORD >/dev/null \
  || fail "protected Keycloak administrator credentials are required for the reversible Center client migration"
if [[ ! -f "$PRIVATE_DIR/imported/cosmos-backends.env" ]]; then
  [[ -f "$LEGACY_BACKENDS_ENV" ]] || fail "legacy provider configuration is unavailable for first cutover"
fi
if [[ ! -f "$CENTER_ENV" ]]; then
  [[ -f "$LEGACY_CENTER_ENV" ]] || fail "legacy Center configuration is unavailable for first cutover"
fi

edge_dir="$LEGACY_EDGE_DIR"
attest_dir="$(active_attestation_root)"
duc_dir="$(active_device_user_root)"
theme_dir="$PRODUCTION_KEYCLOAK_THEME_DIR"
[[ -d "$edge_dir" ]] || fail "edge PKI/configuration is missing"
[[ -d "$attest_dir" ]] || fail "attestation PKI is missing"
[[ -d "$duc_dir" ]] || fail "DeviceUser PKI is missing"
[[ -d "$theme_dir" && -n "$(find "$theme_dir" -type f -print -quit)" ]] || fail "Keycloak theme is missing or empty"

if [[ -n "${canonical_current:-}" ]]; then edge_config="$PRODUCTION_EDGE_CONFIG"; else edge_config="$LEGACY_EDGE_DIR/envoy.yaml"; fi
edge_certs="$PRODUCTION_EDGE_CERT_DIR"
for file in "$edge_config" "$edge_certs/server.crt" "$edge_certs/server.key" \
  "$edge_certs/api-client-ca.crt" "$edge_certs/onboarding-client-ca.crt" \
  "$attest_dir/ca.crt" "$attest_dir/ca.key" "$duc_dir/duc-ca.crt" "$duc_dir/duc-ca.key" \
  /etc/penumbra/center-bridge.env /var/lib/penumbra-center/bridge_secret.key; do
  sudo -n test -f "$file" && sudo -n test -r "$file" || fail "required protected asset is missing or unreadable: $file"
done
for certificate in "$edge_certs/server.crt" "$edge_certs/api-client-ca.crt" \
  "$edge_certs/onboarding-client-ca.crt" "$attest_dir/ca.crt" "$duc_dir/duc-ca.crt"; do
  sudo -n openssl x509 -in "$certificate" -noout >/dev/null
  sudo -n openssl x509 -checkend 604800 -in "$certificate" -noout >/dev/null \
    || fail "certificate expires within seven days: $certificate"
done

# The edge's client trust anchors must BE the CAs that issue device certificates.
#
# Everything above proves those five files exist, parse, and are not about to
# expire. None of it proves the one relationship that decides whether a Pin can
# open a connection at all: platform/edge/envoy/envoy.yaml.tpl points
# `require_client_certificate` at onboarding-client-ca.crt and
# api-client-ca.crt, while the certificates those anchors have to accept are
# minted elsewhere — attestation leaves from $attest_dir (COSMOS_ATTEST_CA_*, via
# provision::mint) and DeviceUser leaves from $duc_dir (the enrollment ceremony).
# A rotated or mis-mounted anchor makes Envoy reject the Pin's client
# certificate during the TLS handshake: the request never reaches a workload,
# cosmos logs nothing, and preflight, doctor and canary all pass, because every
# one of them exercises the HTTP frontend rather than the device mTLS listeners.
# Same shape as the nginx proxy_buffer_size outage, one layer down.
certificate_identity() {
  # Subject DN plus the SHA-256 of the DER public key — the pair that decides
  # whether a chain built by an issuer validates against an anchor. The subject
  # alone would accept a re-issued CA holding a different key; the key alone
  # would accept a differently named authority.
  #
  # The public-key half goes through public_key_digest (domain.sh) rather than
  # an inline `openssl … | sha256sum | awk` pipeline. That pipeline could not
  # fail: awk's exit status is what the substitution reported, so a failed
  # openssl returned sha256("") — 64 characters, so `[[ -n "$public" ]]` passed
  # it — and every anchor candidate whose parse failed compared EQUAL to an
  # issuer whose parse also failed. That defeats precisely the "re-issued CA
  # with a different key" case this pairing exists to catch.
  local certificate="$1" subject public
  subject="$(openssl x509 -in "$certificate" -noout -subject -nameopt RFC2253)" || return 1
  public="$(public_key_digest certificate "$certificate" 0)" || return 1
  printf '%s\t%s\n' "${subject#subject=}" "$public"
}
anchor_accepts_issuer() {
  # An anchor file is allowed to be a bundle, so enumerate every certificate in
  # it rather than reading only the first the way `openssl x509` would.
  local issuer="$1" anchor="$2" anchor_work identity candidate found=1
  anchor_work="$(mktemp -d)" || return 1
  chmod 700 "$anchor_work"
  # Public certificates only; no private key ever leaves its protected directory.
  sudo -n cat "$issuer" >"$anchor_work/issuer.pem" || { rm -rf -- "$anchor_work"; return 1; }
  sudo -n cat "$anchor" >"$anchor_work/anchor.pem" || { rm -rf -- "$anchor_work"; return 1; }
  identity="$(certificate_identity "$anchor_work/issuer.pem")" \
    || { rm -rf -- "$anchor_work"; return 1; }
  awk -v directory="$anchor_work" '
    /-----BEGIN CERTIFICATE-----/ { count += 1 }
    count > 0 { print > (directory "/anchor-" count ".pem") }
  ' "$anchor_work/anchor.pem"
  for candidate in "$anchor_work"/anchor-*.pem; do
    [[ -f "$candidate" ]] || continue
    [[ "$(certificate_identity "$candidate" 2>/dev/null || true)" == "$identity" ]] || continue
    found=0
    break
  done
  rm -rf -- "$anchor_work"
  return "$found"
}
anchor_accepts_issuer "$attest_dir/ca.crt" "$edge_certs/onboarding-client-ca.crt" \
  || fail "the edge onboarding anchor ($edge_certs/onboarding-client-ca.crt) is not the attestation CA that mints onboarding client certificates ($attest_dir/ca.crt); every Pin onboarding handshake will be rejected at the edge"
anchor_accepts_issuer "$duc_dir/duc-ca.crt" "$edge_certs/api-client-ca.crt" \
  || fail "the edge API anchor ($edge_certs/api-client-ca.crt) is not the DeviceUser CA that mints device client certificates ($duc_dir/duc-ca.crt); every enrolled Pin will be rejected at the edge"

# Complete the other half of the device TLS contract before quiescing one
# writer. activate.mjs is in the VPS release and pins the same immutable legacy
# root as both installed device paths.  held-release-exec exposes that exact
# reviewed file as a sealed descriptor: reopening a mutable release pathname
# here would let a swapped root bless the wrong live certificate.
verify_pinned_legacy_edge_certificate() (
  set -euo pipefail
  local activate_source="${REVIVAL_HELD_PIN_ACTIVATE:-}" work root_file source_sha subject fingerprint authority
  [[ "$activate_source" =~ ^/proc/self/fd/[1-9][0-9]*$ ]] || return 1
  release_material_file_is_safe "$activate_source" || return 1
  work="$(mktemp -d)" || return 1
  chmod 700 "$work"
  trap 'rm -rf -- "$work"' EXIT
  root_file="$work/carry-clone-root.pem"
  "$REVIVAL_HOST_PYTHON" -I -B - "$activate_source" "$root_file" <<'PY'
import os,re,stat,sys
source_path,destination=sys.argv[1:]
descriptor=os.open(source_path,os.O_RDONLY)
try:
    metadata=os.fstat(descriptor)
    assert stat.S_ISREG(metadata.st_mode) and 0<metadata.st_size<=1024*1024
    source=b""
    while len(source)<metadata.st_size:
        block=os.read(descriptor,min(1024*1024,metadata.st_size-len(source)))
        assert block
        source+=block
    assert os.fstat(descriptor)==metadata
finally:
    os.close(descriptor)
text=source.decode("utf-8")
pattern=re.compile(r"export const CLONE_ROOT_PEM = `(-----BEGIN CERTIFICATE-----\n"
                   r"(?:[A-Za-z0-9+/=]+\n)+-----END CERTIFICATE-----)`;")
matches=pattern.findall(text)
assert len(matches)==1 and text.count("CLONE_ROOT_PEM = `")==1
pem=matches[0].encode("ascii")
assert len(pem)==687 and not pem.endswith(b"\n")
output=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
try:
    os.write(output,pem+b"\n")
    os.fchmod(output,0o600)
    os.fsync(output)
finally:
    os.close(output)
PY
  source_sha="$(sha256sum "$root_file" | awk '{print $1}')"
  [[ "$source_sha" == 1b947b4e4dae58dc5f8aac1863723eb0eaa313da993e2b8ec7abed38727e22ed ]] \
    || return 1
  subject="$(openssl x509 -in "$root_file" -noout -subject -nameopt RFC2253)" || return 1
  [[ "$subject" == "subject=CN=Carry Clone Root EC 1,O=humane-carry-clone" ]] || return 1
  fingerprint="$(openssl x509 -in "$root_file" -noout -fingerprint -sha256 \
    | tr '[:upper:]' '[:lower:]' | tr -d ':')" || return 1
  [[ "$fingerprint" == "sha256 fingerprint=7f82fbf94a370379ed238fb0c9d2e2d13316d67197faba2948c0e3d92ac3458b" ]] \
    || return 1
  sudo -n openssl verify -purpose sslserver -CAfile "$root_file" "$edge_certs/server.crt" >/dev/null \
    || return 1
  for authority in \
    onboarding.carry.humane.cloud onboarding.clone.invalid carry-edge \
    api.carry.humane.cloud api.clone.invalid eastus.carry.humane.cloud eastus-1.carry.humane.cloud; do
    sudo -n openssl x509 -in "$edge_certs/server.crt" -noout -checkhost "$authority" >/dev/null \
      || return 1
  done
)
verify_pinned_legacy_edge_certificate \
  || fail "edge server certificate does not chain to the exact pinned legacy root or cover every device SNI authority"

# The edge server pair. A mismatch here means Envoy presents a certificate it
# cannot prove it owns and every device TLS handshake dies before a request line
# exists, so this gate has to fail when it cannot measure, not when it measures a
# difference. Both digests therefore come from public_key_digest, which returns
# non-zero rather than the digest of an empty openssl failure — the previous form
# compared sha256("") to sha256("") and passed having read neither file.
server_public="$(public_key_digest certificate "$edge_certs/server.crt" 1)" \
  || fail "edge server certificate public key could not be read: $edge_certs/server.crt"
key_public="$(public_key_digest private-key "$edge_certs/server.key" 1)" \
  || fail "edge server private key public half could not be derived: $edge_certs/server.key"
[[ "$server_public" == "$key_public" ]] || fail "edge server certificate and private key do not match"
for key in "$edge_certs/server.key" "$attest_dir/ca.key" "$duc_dir/duc-ca.key" /var/lib/penumbra-center/bridge_secret.key; do
  key_mode="$(sudo -n stat -c '%a' "$key")"
  (( (8#$key_mode & 8#007) == 0 )) || fail "protected key is readable by other users: $key"
done
for path in "$edge_dir" "$edge_certs" "$edge_certs/server.crt" "$edge_certs/server.key" \
  "$edge_certs/api-client-ca.crt" "$edge_certs/onboarding-client-ca.crt"; do
  [[ "$(sudo -n stat -c '%u:%g' "$path")" == 1000:1001 ]] || fail "edge asset owner must match container uid 1000:1001: $path"
done
[[ "$(sudo -n stat -c '%a' "$edge_certs/server.key")" == 600 ]] || fail "edge server key must be mode 0600"
sudo -n -u '#1000' test -r "$edge_certs/server.crt" && sudo -n -u '#1000' test -r "$edge_certs/server.key" \
  || fail "edge container uid cannot traverse/read its PKI"
for directory in "$attest_dir" "$duc_dir"; do
  [[ "$(sudo -n stat -c '%u:%g' "$directory")" == 65532:65532 ]] || fail "Cosmos PKI directory owner drift: $directory"
done
for path in "$attest_dir/ca.crt" "$attest_dir/ca.key" "$duc_dir/duc-ca.crt" "$duc_dir/duc-ca.key"; do
  [[ "$(sudo -n stat -c '%u:%g' "$path")" == 65532:65532 ]] || fail "Cosmos PKI file owner drift: $path"
done
[[ "$(sudo -n stat -c '%a' "$attest_dir/ca.key")" == 600 ]] || fail "attestation key must be mode 0600"
[[ "$(sudo -n stat -c '%a' "$duc_dir/duc-ca.key")" == 600 ]] || fail "DeviceUser key must be mode 0600"
if [[ -n "${canonical_record:-}" ]]; then
  verify_exact_legacy_security_identity "$canonical_record/carry-security-identity.json"
else
  write_exact_legacy_security_identity >/dev/null \
    || fail "deployed legacy PKI/certificate identity changed during preflight"
fi

# This is the first allowed mutation in preflight. Every fixed legacy volume,
# network, mount, source path, owner, link topology, inode and certificate
# relationship has been re-proved above.
if ((cleanup)); then
  [[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" ]] || fail "canonical deployment lock is unavailable for image cleanup"
  exec 8>>"$LOCK_FILE"
  flock -n 8 || fail "another Ai Pin Revival operation holds the deployment lock"
  cleanup_project_images
  flock -u 8
fi
# Do not emulate container access through the host path: /home/anders is not
# traversable by the unregistered container uid, while Docker resolves the
# bind mount before entering that user context. The isolated staging run starts
# the real candidate as 65532:65532 and proves both mounted CA paths instead.
if [[ -f "$PRIVATE_DIR/spotify-adapter/token" ]]; then
  [[ "$(stat -c '%u:%g' "$PRIVATE_DIR/spotify-adapter/token")" == 1000:1001 ]] || fail "Spotify adapter token ownership is invalid"
  spotify_mode="$(stat -c '%a' "$PRIVATE_DIR/spotify-adapter/token")"
  [[ "$spotify_mode" == 400 || "$spotify_mode" == 440 ]] || fail "Spotify adapter token mode is invalid"
fi

# The canary wearer credential, checked HERE and not only where it is spent.
#
# canary.sh refuses to pass without it, which is the safe default and also the
# worst possible place to discover it is missing: the canaries that matter run
# inside the quiesced cutover window, so an unprovisioned credential would stop a
# deploy with public ingress already down and the live mutation already begun.
# Preflight is the last point at which the answer costs nothing. Only the
# credential's SHAPE is proven here — no sign-in is attempted, because preflight
# must not spend a credential against the release it is about to replace.
assert_wearer_canary_secret "$WEARER_CANARY_SECRET" \
  || fail "the canary wearer credential is missing or unsafe ($WEARER_CANARY_SECRET); the deploy canary cannot prove the wearer plane without it — see docs/operations.md, 'The canary wearer credential'"

# This is the provider proof used to authorize enabling remote speech flags in
# the staged candidate. It exercises the currently serving Azure path without
# changing feature flags or production configuration.
tts_work="$(mktemp -d)"
curl --silent --show-error --fail --connect-timeout 5 --max-time 40 \
  -D "$tts_work/headers" -o "$tts_work/audio" -H 'content-type: application/json' \
  --data '{"text":"Ai Pin Revival preflight."}' http://127.0.0.1:18086/demo-api/speech
python3 - "$tts_work/headers" "$tts_work/audio" <<'PY'
import sys
headers=open(sys.argv[1],encoding="latin1").read().lower(); audio=open(sys.argv[2],"rb").read()
assert "content-type: audio/mpeg" in headers
assert 1024 <= len(audio) <= 2_000_000
assert audio.startswith(b"ID3") or (len(audio)>2 and audio[0]==0xff and audio[1]&0xe0==0xe0)
PY
rm -rf -- "$tts_work"
tts_work=""

if ((json)); then
  python3 - "$available_kb" "$required_kb" <<'PY'
import json, sys
print(json.dumps({"ok": True, "host": "anders-server", "arch": "aarch64", "availableKiB": int(sys.argv[1]), "requiredKiB": int(sys.argv[2])}, separators=(",", ":")))
PY
else
  log "preflight passed on anders-server (${available_kb} KiB available)"
fi
rm -f "$routes_json" "$networks_json" "$domain_discovery"
trap - EXIT
