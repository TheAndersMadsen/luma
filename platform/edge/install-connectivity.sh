#!/usr/bin/env bash
set -euo pipefail

source_file=""
nginx_stopped=0

usage() {
  echo "usage: $0 --source FILE [--nginx-stopped]" >&2
  exit 64
}

while (($#)); do
  case "$1" in
    --source) (($# >= 2)) || usage; source_file="$2"; shift 2 ;;
    --nginx-stopped) nginx_stopped=1; shift ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[[ -f "$source_file" && ! -L "$source_file" ]] || usage
command -v nginx >/dev/null || { echo "nginx is required" >&2; exit 1; }
command -v sudo >/dev/null || { echo "sudo is required" >&2; exit 1; }

available=/etc/nginx/sites-available/ai-pin-revival-connectivity
enabled=/etc/nginx/sites-enabled/ai-pin-revival-connectivity

sudo -n install -o root -g root -m 644 -- "$source_file" "$available"
sudo -n ln -sfn -- "$available" "$enabled"
sudo -n nginx -t

if ((nginx_stopped)); then
  sudo -n systemctl start nginx
else
  sudo -n systemctl reload nginx
fi

for host in connectivity-check.cosmos.humane.cloud n.cosmos.humane.cloud; do
  curl --fail --silent --output /dev/null --resolve "$host:80:127.0.0.1" "http://$host/"
done

echo "installed Cosmos connectivity edge"
