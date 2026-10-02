#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

env_file="${LUMA_ENV_FILE:?LUMA_ENV_FILE is required}"
operator_compose="${LUMA_CONFIG_DIR:?LUMA_CONFIG_DIR is required}/production/operator.compose.yaml"
application="${LUMA_COMPOSE_APPLICATION:?LUMA_COMPOSE_APPLICATION is required}"
project_name="${COMPOSE_PROJECT_NAME:-luma}"

usage() {
  echo "usage: $0 [--env-file FILE] [--project-name NAME]" >&2
  exit 64
}

while (($#)); do
  case "$1" in
    --env-file) (($# >= 2)) || usage; env_file="$2"; shift 2 ;;
    --project-name) (($# >= 2)) || usage; project_name="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[[ "$env_file" = /* ]] || env_file="$PWD/$env_file"
for file in "$env_file" "$operator_compose"; do
  [[ -f "$file" && ! -L "$file" && -r "$file" ]] || {
    echo "production input is not a readable regular file: $file" >&2
    exit 1
  }
done
[[ "$project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || {
  echo "invalid Compose project name: $project_name" >&2
  exit 1
}
[[ "$application" =~ ^oci://ghcr\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]] || {
  echo "production application must be an immutable oci://ghcr.io/...@sha256 reference" >&2
  exit 1
}
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
compose_version="$(docker compose version --short)" || {
  echo "Docker Compose 2.34.0 or newer is required" >&2
  exit 1
}
if [[ ! "$compose_version" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)([-+].*)?$ ]] ||
   (( 10#${BASH_REMATCH[1]:-0} < 2 )) ||
   (( 10#${BASH_REMATCH[1]:-0} == 2 && 10#${BASH_REMATCH[2]:-0} < 34 )); then
  echo "Docker Compose 2.34.0 or newer is required; observed ${compose_version:-unknown}" >&2
  exit 1
fi

compose=(
  --project-directory "$ROOT"
  --project-name "$project_name"
  --env-file "$env_file"
  -f "$application"
  -f "$operator_compose"
)

# While it resolves the OCI application, Compose logs failed ghcr.io fetch
# attempts ("fetch failed after status: 404") even when resolution then
# succeeds, so its messages are shown only when the model cannot be read.
if ! compose_errors="$(docker compose "${compose[@]}" config --quiet 2>&1 >/dev/null)"; then
  printf '%s\n' "$compose_errors" >&2
  if [[ "$compose_errors" == *ghcr.io* ]]; then
    echo "Docker could not read this release's application from ghcr.io. Luma's images are public, so check your network and that the application digest is correct; a private fork needs ./luma registry login --username GITHUB_USER with a classic token that has read:packages. Then rerun ./luma doctor production." >&2
  fi
  exit 1
fi

# Traefik joins the owner's existing external networks. A missing one would
# stop the edge, and with it every route, at `up`. Traefik reaches Luma's own
# services by these names (platform/edge/traefik/dynamic.yaml.tpl), and Docker's
# DNS answers from a non-internal network before cosmos-internal, so a container
# on an extra network that answers to one of them would receive Luma's traffic.
luma_upstreams=(center keycloak ai-bus connectivity edge)
if [[ -n "${LUMA_TRAEFIK_EXTRA_NETWORKS:-}" ]]; then
  IFS=',' read -r -a extra_networks <<< "$LUMA_TRAEFIK_EXTRA_NETWORKS"
  for network in "${extra_networks[@]}"; do
    docker network inspect "$network" >/dev/null 2>&1 || {
      echo "LUMA_TRAEFIK_EXTRA_NETWORKS names Docker network $network, which does not exist on this host." >&2
      echo "Start the stack that owns it, or correct the list with ./luma config set LUMA_TRAEFIK_EXTRA_NETWORKS, then rerun ./luma doctor production." >&2
      exit 1
    }
    containers="$(docker network inspect "$network" --format '{{range $id, $container := .Containers}}{{$id}} {{end}}')"
    for container in $containers; do
      names="$(docker inspect "$container" --format "{{.Name}} {{with index .NetworkSettings.Networks \"$network\"}}{{range .Aliases}}{{.}} {{end}}{{range .DNSNames}}{{.}} {{end}}{{end}}")"
      for name in $names; do
        for upstream in "${luma_upstreams[@]}"; do
          [[ "${name#/}" != "$upstream" ]] || {
            echo "Docker network $network has a container that answers to $upstream, the name Luma's Traefik uses for its own $upstream service; Traefik would send Luma's traffic to it." >&2
            echo "Rename that container or alias, or remove $network from LUMA_TRAEFIK_EXTRA_NETWORKS, then rerun ./luma doctor production." >&2
            exit 1
          }
        done
      done
    done
  done
fi

# Compose derives volume names from the project name. When this stack's data
# volumes already exist under a different project and none exist under the
# target project, `up` would silently start an empty stack beside the
# operator's data. Fail closed with the exact fix instead.
declared_volumes="$(docker compose "${compose[@]}" config --volumes 2>/dev/null)" || {
  docker compose "${compose[@]}" config --volumes >/dev/null
  exit 1
}
all_volumes="$(docker volume ls --format '{{.Name}}')" || exit 1
blocking_volumes=()
while IFS= read -r volume_key; do
  [[ -n "$volume_key" ]] || continue
  target_volume="${project_name}_${volume_key}"
  # Once this project owns the volume, same-named volumes of other Compose
  # projects are unrelated to this deployment and are not reported.
  grep -qxF -- "$target_volume" <<< "$all_volumes" && continue
  while IFS= read -r existing; do
    [[ -n "$existing" ]] || continue
    [[ "$existing" == *"_${volume_key}" ]] || continue
    # Only another Luma stack, one holding Cosmos's own state or database,
    # holds this stack's data. Unrelated stacks also name volumes grafana-data.
    other_project="${existing%_"${volume_key}"}"
    grep -qxF -e "${other_project}_cosmos-state" -e "${other_project}_cosmos-pgdata" <<< "$all_volumes" ||
      continue
    blocking_volumes+=("${volume_key} ${existing}")
  done <<< "$all_volumes"
done <<< "$declared_volumes"
if ((${#blocking_volumes[@]})); then
  echo "this stack's data volumes exist under another Compose project name:" >&2
  for entry in "${blocking_volumes[@]}"; do
    read -r volume_key existing <<< "$entry"
    target_volume="${project_name}_${volume_key}"
    echo "  $existing holds volume ${volume_key}" >&2
    echo "  carry it over, with both stacks stopped:" >&2
    echo "    docker volume create --label com.docker.compose.project=${project_name} --label com.docker.compose.volume=${volume_key} ${target_volume}" >&2
    echo "    docker run --rm -v ${existing}:/from:ro -v ${target_volume}:/to alpine cp -a /from/. /to/" >&2
  done
  echo "Docker cannot rename volumes. Redeploy under the existing project with --project-name, copy the volumes as printed, or back up and remove the other stack's volumes first. Luma will not move or delete volumes automatically." >&2
  exit 1
fi

# Compose labels each volume it creates with the hash of its definition. When a
# release defines an existing volume differently, `up` offers to delete it and
# create it empty, and deploy's `up --yes`, which the remote application needs,
# would accept. So compute the hash Compose will expect (its VolumeHash: Go's
# JSON of the volume with the driver defaulted to "local") and refuse any
# volume that would be recreated. The config is piped, never written or printed.
volume_hashes='
let input = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => { input += chunk; }).on("end", () => {
  let model;
  try { model = JSON.parse(input); } catch { console.error("docker compose config did not return JSON"); process.exit(1); }
  const sorted = (map) => (map && Object.keys(map).length
    ? Object.fromEntries(Object.keys(map).sort().map((key) => [key, map[key]])) : undefined);
  for (const volume of Object.values(model.volumes ?? {})) {
    if (volume.external) continue;
    const definition = JSON.stringify({
      name: volume.name,
      driver: volume.driver || "local",
      driver_opts: sorted(volume.driver_opts),
      labels: sorted(volume.labels),
    }).replace(/[<>&\p{Zl}\p{Zp}]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const hash = require("node:crypto").createHash("sha256").update(definition).digest("hex");
    process.stdout.write(`${volume.name}\t${hash}\n`);
  }
});
'
expected_hashes="$(docker compose "${compose[@]}" config --format json 2>/dev/null | bun --no-env-file -e "$volume_hashes")" || exit 1
diverged_volumes=()
while IFS=$'\t' read -r volume_name expected_hash; do
  [[ -n "$volume_name" ]] || continue
  grep -qxF -- "$volume_name" <<< "$all_volumes" || continue
  recorded_hash="$(docker volume inspect "$volume_name" --format '{{index .Labels "com.docker.compose.config-hash"}}')" || exit 1
  case "$recorded_hash" in
    ""|"<no value>"|"$expected_hash") ;;
    *) diverged_volumes+=("$volume_name") ;;
  esac
done <<< "$expected_hashes"
if ((${#diverged_volumes[@]})); then
  echo "this release defines these data volumes differently from the ones on this server:" >&2
  printf '  %s\n' "${diverged_volumes[@]}" >&2
  echo "Docker Compose would delete them and create them empty, so Luma stops here; nothing was changed." >&2
  echo "Keep running your current release, take a backup with ./luma backup production, and report the release that changed a data volume's definition. Luma never recreates a data volume." >&2
  exit 1
fi

public_host="${LUMA_PUBLIC_ORIGIN#https://}"
public_host="${public_host%%/*}"
if command -v getent >/dev/null 2>&1 && ! getent ahosts "$public_host" >/dev/null 2>&1; then
  echo "public DNS name $public_host does not resolve from this server" >&2
  echo "Create or correct its A or AAAA record, wait for DNS propagation, then rerun ./luma doctor production." >&2
  exit 1
fi

# A running Traefik container in this project already owns the ports during a
# normal update. Otherwise, fail before Compose reaches a vague bind error.
if ! docker compose "${compose[@]}" ps --status running --services traefik 2>/dev/null |
    grep -qx traefik; then
  listeners=""
  if command -v ss >/dev/null; then
    listeners="$(ss -H -ltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/')"
  else
    listeners="$(awk '
      NR > 1 && $4 == "0A" {
        split($2, address, ":")
        if (address[2] == "0050" || address[2] == "01BB") print FILENAME ":" $0
      }
    ' /proc/net/tcp /proc/net/tcp6 2>/dev/null || true)"
  fi
  if [[ -n "$listeners" ]]; then
    echo "host ports 80 or 443 are already in use:" >&2
    echo "$listeners" >&2
    echo "Stop or reconfigure the owning service (commonly Nginx, Apache, Caddy, or another Compose stack), then rerun. Luma will not stop it automatically." >&2
    exit 1
  fi
fi
printf 'Production configuration is complete for %s (%s).\n' "$project_name" "$LUMA_RELEASE_ID"
