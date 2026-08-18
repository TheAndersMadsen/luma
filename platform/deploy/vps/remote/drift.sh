#!/usr/bin/env bash
set -euo pipefail
remote_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$remote_dir/common.sh"
source "$remote_dir/domain.sh"

json=0
usage() { echo "usage: drift [--json]" >&2; exit 64; }
while (($#)); do
  case "$1" in
    --json) json=1; shift ;;
    *) usage ;;
  esac
done

assert_target
assert_remote_root
for command in docker python3 systemctl curl sha256sum readlink; do need "$command"; done
current="$(safe_release_pointer "$REMOTE_ROOT/current")" || fail "canonical current pointer is missing or unsafe"
release_id="$(basename "$current")"
validate_release_id "$release_id"
manifest="$MANIFESTS_DIR/$release_id.json"
release_verifier="$current/platform/deploy/vps/verify-release.py"
[[ -f "$release_verifier" && ! -L "$release_verifier" && -f "$manifest" ]] || fail "release verifier or manifest is missing"
verification="$(python3 "$release_verifier" --tree "$current" --manifest "$manifest" --json)"
python3 - "$verification" "$release_id" <<'PY'
import json,sys
body=json.loads(sys.argv[1]); assert body.get("ok") is True and body.get("profile")=="vps" and body.get("releaseId")==sys.argv[2]
PY

load_compose_command "$current"
"${COMPOSE[@]}" config --quiet
assert_compose_ports

legacy_running="$(docker ps -q --filter "label=com.docker.compose.project=$LEGACY_PROJECT" | head -n 1)"
[[ -z "$legacy_running" ]] || fail "legacy Compose project is still running alongside canonical production"

for service in connectivity ai-bus account contacts feature-flags notable-events provisioning postgres keycloak edge center spotify-adapter searxng prometheus grafana; do
  container="$("${COMPOSE[@]}" ps -q "$service")"
  [[ -n "$container" ]] || fail "canonical service is missing: $service"
  [[ "$(docker inspect --format '{{index .Config.Labels "dk.andersmadsen.ai-pin-revival.release"}}' "$container")" == "$release_id" ]] \
    || fail "release label drift: $service"
done

assert_durable_inputs
for volume in "$STATE_VOLUME" "$PG_VOLUME" "$PROMETHEUS_VOLUME" "$GRAFANA_VOLUME"; do
  [[ "$(docker volume inspect --format '{{.Name}}' "$volume")" == "$volume" ]] || fail "volume identity drift: $volume"
done

for file in "$RUNTIME_ENV" "$COSMOS_ENV" "$CENTER_ENV" "$PROVIDER_ENV"; do
  [[ -f "$file" && "$(stat -c '%a' "$file")" == 600 ]] || fail "protected environment mode drift"
done
spotify_token_file="$PRIVATE_DIR/spotify-adapter/token"
[[ -f "$spotify_token_file" ]] || fail "Spotify adapter token is missing"
[[ "$(stat -c '%u:%g' "$spotify_token_file")" == 1000:1001 ]] || fail "Spotify adapter token owner drift"
spotify_mode="$(stat -c '%a' "$spotify_token_file")"
[[ "$spotify_mode" == 400 || "$spotify_mode" == 440 ]] || fail "Spotify adapter token mode drift"

python3 - "$RUNTIME_ENV" "$COSMOS_ENV" "$CENTER_ENV" "$PROVIDER_ENV" "$PRIVATE_DIR/edge/envoy.yaml" "$spotify_token_file" <<'PY'
import re,sys
def value(path,key):
    result=""
    for line in open(path,encoding="utf-8"):
        name,sep,candidate=line.rstrip("\n").partition("=")
        if sep and name.strip()==key: result=candidate.strip().strip('"')
    return result
tokens=[value(path,"COSMOS_EDGE_TOKEN") for path in sys.argv[1:5]]
assert tokens[0] and len(set(tokens))==1
rendered=open(sys.argv[5],encoding="utf-8").read()
assert rendered.count(tokens[0])==2 and "@@EDGE_TOKEN@@" not in rendered
spotify=open(sys.argv[6],encoding="utf-8").read().strip()
assert len(spotify)>=32 and spotify != tokens[0]
PY

postgres="$("${COMPOSE[@]}" ps -q postgres)"
paired_identity="$(derive_paired_identity "$postgres")"
IFS=$'\t' read -r paired_device paired_owner <<<"$paired_identity"
configured_device="$(read_env_value "$CENTER_ENV" REVIVAL_PIN_BRIDGE_DEVICE_ID)"
configured_owner="$(read_env_value "$CENTER_ENV" REVIVAL_PIN_BRIDGE_OWNER_SUB)"
[[ "$paired_device" == "$configured_device" && "$paired_owner" == "$configured_owner" ]] \
  || fail "protected Pin pairing identity drift"
unset paired_identity paired_device paired_owner configured_device configured_owner

systemctl is-active --quiet penumbra-center-bridge.service || fail "Pin bridge systemd unit is not active"
timeout 3 bash -c '</dev/tcp/127.0.0.1/18080' 2>/dev/null || fail "Pin bridge loopback listener is unavailable"
sudo -n nginx -t >/dev/null

# The authoritative deployment pointer, not a same-release directory scan, is
# the only accepted attestation lineage. Multiple deployments may share a
# release digest while having different protected inputs and image identities.
accepted_record="$(safe_deployment_pointer "$REMOTE_ROOT/current-deployment")" \
  || fail "canonical current-deployment pointer is missing or unsafe"
[[ -f "$accepted_record/SUCCEEDED" && ! -f "$accepted_record/MANUAL_ROLLBACK" \
  && -f "$accepted_record/INGRESS_ACTIVATED" && -f "$accepted_record/POINTER_TRANSACTION_COMMITTED" \
  && -f "$accepted_record/release-id" && -f "$accepted_record/running-images.tsv" \
  && -f "$accepted_record/config-digests.tsv" ]] \
  || fail "authoritative deployment record is incomplete or no longer current"
[[ "$(tr -d '\r\n' <"$accepted_record/release-id")" == "$release_id" ]] \
  || fail "current release and authoritative deployment record disagree"
verify_keycloak_post_migration_evidence "$accepted_record" \
  || fail "authoritative deployment record has invalid Keycloak post-migration evidence"
domain_nginx_verify_desired "$accepted_record" \
  || fail "authoritative deployment has public Center Nginx drift"
verify_image_evidence "$accepted_record/running-images.tsv" "$current"
verify_configuration_evidence "$accepted_record/config-digests.tsv" "$current"
bash "$current/platform/deploy/vps/remote/canary.sh" --release-id "$release_id" --image-evidence "$accepted_record/running-images.tsv" --require-remote-tts >/dev/null
domain_keycloak_verify_desired "$accepted_record" "$RUNTIME_ENV" 8088 \
  || fail "authoritative deployment has Center Keycloak client drift"

latest_backup="$(find "$BACKUP_ROOT" -mindepth 2 -maxdepth 2 -type f -name SHA256SUMS \
  -printf '%T@\t%h\n' | LC_ALL=C sort -n | tail -n 1 | cut -f2-)"
[[ -n "$latest_backup" && -f "$latest_backup/SHA256SUMS" ]] || fail "no verified backup exists"
(cd "$latest_backup" && sha256sum -c SHA256SUMS >/dev/null)
backup_age=$(( $(date +%s) - $(stat -c '%Y' "$latest_backup/SHA256SUMS") ))
((backup_age <= 129600)) || fail "latest verified backup is older than 36 hours"

if ((json)); then
  python3 - "$release_id" "$backup_age" <<'PY'
import json,sys
print(json.dumps({"ok":True,"releaseId":sys.argv[1],"backupAgeSeconds":int(sys.argv[2])},separators=(",",":")))
PY
else
  log "no deployment drift detected for release $release_id"
fi
