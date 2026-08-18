#!/usr/bin/env bash
# Public Center domain transaction. This library is sourced after common.sh.

DOMAIN_CANONICAL_ORIGIN=https://center.andersmadsen.dk
DOMAIN_LEGACY_ORIGIN=https://cosmos.andersmadsen.dk
DOMAIN_HELPER="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/domain.py"
DOMAIN_CLOUDFLARED_CONFIG=/home/anders/.cloudflared/config.yml
DOMAIN_CLOUDFLARED_BIN=/usr/local/bin/cloudflared

domain_sudo() { sudo -n "$@"; }
domain_error() { echo "domain transaction: $*" >&2; return 1; }

# SHA-256 of the empty input.
#
# Every certificate-vs-private-key gate in this deployment used to be written as
#   digest="$(openssl … 2>/dev/null | sha256sum | awk '{print $1}')"
# and that construction cannot fail. `2>/dev/null` hides openssl's message, and
# a command substitution reports the status of the LAST command in the pipeline —
# awk, which exits 0 whatever it was handed. A broken, unreadable or wrong-format
# input therefore yields the digest of nothing rather than an error, and because
# BOTH sides of the comparison are built the same way, two failed openssl runs
# produce two identical non-empty digests and the pair "matches". `[[ -n
# "$digest" ]]` does not help: the sentinel is 64 characters long.
#
# That is the house failure mode aimed at the one gate that stands between a
# mismatched edge pair and a Pin that cannot complete a TLS handshake: Envoy
# rejects the client certificate, no workload logs anything, and every
# HTTP-level probe stays green. A gate that passes when its own tool errors is
# worse than no gate, because it is also an assurance.
#
# The same constant appears in common.sh for the backup path's key-material
# digests. Deliberately duplicated rather than shared: this library must keep
# working for anything that sources it, and the value cannot drift — it is fixed
# by SHA-256 itself, not by a decision either file gets to make.
DOMAIN_EMPTY_INPUT_SHA256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

# SHA-256 of the DER public key a certificate carries, or that a private key
# derives — status-checked at every stage, and never the sentinel above.
#
# kind:       certificate | private-key
# path:       PEM file
# privileged: 1 to read through `sudo -n` (protected PKI), 0 for a plain read
#
# Private key material never leaves its protected directory: the privileged
# arms keep sudo on openssl itself and only the DERIVED public key crosses the
# boundary, matching the promise preflight.sh's anchor comparison makes for
# certificates. The DER goes to a file rather than a variable because command
# substitution strips NUL bytes, which would silently change what is hashed.
public_key_digest() {
  local kind="$1" path="$2" privileged="${3:-0}" work digest status=0
  work="$(mktemp)" || return 1
  chmod 600 "$work"
  case "$kind:$privileged" in
    certificate:0) openssl x509 -in "$path" -pubkey -noout 2>/dev/null \
      | openssl pkey -pubin -outform DER >"$work" 2>/dev/null || status=1 ;;
    certificate:1) sudo -n openssl x509 -in "$path" -pubkey -noout 2>/dev/null \
      | openssl pkey -pubin -outform DER >"$work" 2>/dev/null || status=1 ;;
    private-key:0) openssl pkey -in "$path" -pubout -outform DER >"$work" 2>/dev/null || status=1 ;;
    private-key:1) sudo -n openssl pkey -in "$path" -pubout -outform DER >"$work" 2>/dev/null || status=1 ;;
    *) status=1 ;;
  esac
  if ((status != 0)) || [[ ! -s "$work" ]]; then rm -f -- "$work"; return 1; fi
  digest="$(sha256sum <"$work" | awk '{print $1}')"
  rm -f -- "$work"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$digest" != "$DOMAIN_EMPTY_INPUT_SHA256" ]] || return 1
  printf '%s\n' "$digest"
}

domain_require_helper() {
  [[ -f "$DOMAIN_HELPER" && ! -L "$DOMAIN_HELPER" ]] \
    || domain_error "domain transaction helper is missing or unsafe"
}

domain_evidence_owner() {
  local record="$1" subtree="$2" owner path
  case "$subtree" in nginx|keycloak|cloudflared) ;; *) domain_error "invalid domain evidence subtree"; return 1 ;; esac
  [[ -d "$record" && ! -L "$record" ]] || { domain_error "deployment record is unsafe"; return 1; }
  owner="$(stat -c '%u:%g' "$record")" || return 1
  path="$record/domain-cutover/$subtree"
  domain_sudo test -d "$path" && ! domain_sudo test -L "$path" \
    || { domain_error "domain evidence subtree is unsafe"; return 1; }
  domain_sudo chown -R -h -- "$owner" "$path"
}

domain_discover_public_edge() {
  local output="$1" expanded
  domain_require_helper || return 1
  [[ -n "$output" && ! -e "$output" && ! -L "$output" ]] \
    || domain_error "public edge discovery output already exists"
  expanded="$(mktemp)"
  chmod 600 "$expanded"
  if ! domain_sudo nginx -T >"$expanded" 2>/dev/null; then
    rm -f -- "$expanded"
    domain_error "could not expand the active Nginx configuration"
    return 1
  fi
  python3 "$DOMAIN_HELPER" discover-nginx --input "$expanded" --output "$output" \
    || { rm -f -- "$expanded"; return 1; }
  rm -f -- "$expanded"
  chmod 600 "$output"
}

domain_discovery_value() {
  local discovery="$1" key="$2"
  python3 - "$discovery" "$key" <<'PY'
import json,sys
body=json.load(open(sys.argv[1],encoding="utf-8")); value=body.get(sys.argv[2])
assert isinstance(value,str) and value
print(value)
PY
}

domain_assert_public_tls() {
  local discovery="$1" certificate private_key certificate_public key_public san key_mode
  domain_require_helper || return 1
  python3 "$DOMAIN_HELPER" check-discovery --input "$discovery" || return 1
  certificate="$(domain_discovery_value "$discovery" certificatePath)" || return 1
  private_key="$(domain_discovery_value "$discovery" privateKeyPath)" || return 1
  domain_sudo test -f "$certificate" && domain_sudo test -r "$certificate" \
    && domain_sudo test -f "$private_key" && domain_sudo test -r "$private_key" \
    || { domain_error "public TLS certificate pair is missing or unreadable"; return 1; }
  domain_sudo openssl x509 -in "$certificate" -noout >/dev/null \
    && domain_sudo openssl x509 -checkend 604800 -in "$certificate" -noout >/dev/null \
    && domain_sudo openssl x509 -checkhost center.andersmadsen.dk -in "$certificate" -noout >/dev/null \
    && domain_sudo openssl x509 -checkhost cosmos.andersmadsen.dk -in "$certificate" -noout >/dev/null \
    || { domain_error "public TLS certificate is invalid, expires soon, or does not cover Center and Cosmos"; return 1; }
  san="$(domain_sudo openssl x509 -in "$certificate" -noout -ext subjectAltName)" || return 1
  grep -Eq 'DNS:[*]\.andersmadsen\.dk([,[:space:]]|$)' <<<"$san" \
    || { domain_error "public TLS certificate is not the reviewed andersmadsen.dk wildcard"; return 1; }
  # Both digests come from public_key_digest, which refuses to answer when
  # openssl fails. The previous inline pipelines answered sha256("") on both
  # sides of this comparison whenever openssl errored — an unreadable key, a
  # certificate in the wrong format, a missing sudo grant — so the wildcard pair
  # serving center.andersmadsen.dk was declared matching without either half
  # ever being read. The trailing `|| return 1` was inert for the same reason:
  # awk's exit status is what the substitution reported.
  certificate_public="$(public_key_digest certificate "$certificate" 1)" \
    || { domain_error "public TLS certificate public key could not be read"; return 1; }
  key_public="$(public_key_digest private-key "$private_key" 1)" \
    || { domain_error "public TLS private key public half could not be derived"; return 1; }
  [[ "$certificate_public" == "$key_public" ]] \
    || { domain_error "public TLS certificate and private key do not match"; return 1; }
  key_mode="$(domain_sudo stat -c '%a' "$private_key")" || return 1
  (( (8#$key_mode & 8#007) == 0 )) \
    || { domain_error "public TLS private key is readable by other users"; return 1; }
}

domain_assert_dns_ready() {
  local host="${1:-center.andersmadsen.dk}" command_name resolved status
  [[ "$host" == center.andersmadsen.dk ]] \
    || { domain_error "unreviewed public Center DNS hostname"; return 1; }
  for command_name in getent python3 curl; do
    command -v "$command_name" >/dev/null 2>&1 \
      || { domain_error "required DNS readiness command is unavailable: $command_name"; return 1; }
  done
  resolved="$(getent ahosts "$host" 2>/dev/null)" \
    || { domain_error "$host does not resolve through the configured system resolver"; return 1; }
  [[ -n "$resolved" && ${#resolved} -le 65536 ]] \
    || { domain_error "$host returned no bounded system resolver answer"; return 1; }
  python3 - "$resolved" <<'PY' \
    || { domain_error "Center DNS contains no exclusively public address set"; return 1; }
import ipaddress
import sys

addresses = []
for raw in sys.argv[1].splitlines():
    fields = raw.split()
    if not fields:
        continue
    try:
        addresses.append(ipaddress.ip_address(fields[0]))
    except ValueError as error:
        raise SystemExit(f"invalid resolver address: {fields[0]}") from error
if not addresses or any(not address.is_global for address in addresses):
    raise SystemExit("resolver answer is empty or contains a non-public address")
PY
  status="$(curl --disable --silent --show-error --connect-timeout 5 --max-time 20 \
    --noproxy '*' --proto '=https' --tlsv1.2 --max-redirs 0 --head --output /dev/null \
    --write-out '%{http_code}' "https://$host/")" \
    || { domain_error "$host is not reachable with a certificate-valid HTTPS handshake"; return 1; }
  [[ "$status" =~ ^[1-5][0-9][0-9]$ ]] \
    || { domain_error "$host HTTPS readiness returned no valid HTTP response"; return 1; }
}

domain_cloudflared_require() {
  local command_name
  domain_require_helper || return 1
  for command_name in python3 timeout stat; do
    command -v "$command_name" >/dev/null 2>&1 \
      || { domain_error "required Cloudflared transaction command is unavailable: $command_name"; return 1; }
  done
  [[ "$DOMAIN_CLOUDFLARED_CONFIG" == /home/anders/.cloudflared/config.yml \
    && -f "$DOMAIN_CLOUDFLARED_CONFIG" && ! -L "$DOMAIN_CLOUDFLARED_CONFIG" \
    && -r "$DOMAIN_CLOUDFLARED_CONFIG" ]] \
    || { domain_error "exact Cloudflared configuration is missing, unreadable, or unsafe"; return 1; }
  [[ "$DOMAIN_CLOUDFLARED_BIN" == /usr/local/bin/cloudflared \
    && -f "$DOMAIN_CLOUDFLARED_BIN" && ! -L "$DOMAIN_CLOUDFLARED_BIN" \
    && -x "$DOMAIN_CLOUDFLARED_BIN" ]] \
    || { domain_error "exact Cloudflared executable is missing or unsafe"; return 1; }
}

domain_cloudflared_bounded() {
  local output="$1"
  shift
  (ulimit -f 128; timeout 20 "$DOMAIN_CLOUDFLARED_BIN" tunnel \
    --config "$DOMAIN_CLOUDFLARED_CONFIG" ingress "$@") >"$output" 2>&1 \
    || { domain_error "bounded Cloudflared ingress command failed: $*"; return 1; }
  [[ -f "$output" && ! -L "$output" && $(stat -c '%s' "$output") -le 65536 ]] \
    || { domain_error "Cloudflared ingress command returned unsafe output"; return 1; }
}

domain_cloudflared_validate() {
  local output
  output="$(mktemp)" || return 1
  chmod 600 "$output"
  domain_cloudflared_bounded "$output" validate \
    || { rm -f -- "$output"; return 1; }
  rm -f -- "$output"
}

domain_cloudflared_rule() {
  local url="$1" expected_host="$2" expected_service="$3" output
  output="$(mktemp)" || return 1
  chmod 600 "$output"
  domain_cloudflared_bounded "$output" rule "$url" \
    || { rm -f -- "$output"; return 1; }
  python3 - "$output" "$expected_host" "$expected_service" <<'PY' \
    || { rm -f -- "$output"; domain_error "Cloudflared ingress rule selected an unexpected route"; return 1; }
import re
import sys

text = open(sys.argv[1], encoding="utf-8").read()
matches = re.findall(r"(?m)^\s*Matched rule #(\d+)\s*$", text)
services = re.findall(r"(?m)^\s*service:\s*(\S+)\s*$", text)
hosts = re.findall(r"(?m)^\s*hostname:\s*(\S+)\s*$", text)
assert len(matches) == 1 and len(services) == 1
assert services == [sys.argv[3]]
if sys.argv[2] == "-":
    assert not hosts
else:
    assert hosts == [sys.argv[2]]
PY
  rm -f -- "$output"
}

domain_cloudflared_validate_state() {
  local state="$1"
  domain_cloudflared_validate || return 1
  case "$state" in
    desired)
      domain_cloudflared_rule https://center.andersmadsen.dk/ \
        center.andersmadsen.dk http://localhost:80 || return 1
      domain_cloudflared_rule https://cloudflared-canary.invalid/ - http_status:404
      ;;
    before)
      domain_cloudflared_rule https://center.andersmadsen.dk/ - http_status:404
      ;;
    *) domain_error "invalid Cloudflared validation state"; return 1 ;;
  esac
}

domain_cloudflared_assert_ready() {
  local route
  domain_cloudflared_require || return 1
  route="$(domain_sudo python3 "$DOMAIN_HELPER" cloudflared-inspect)" || return 1
  case "$route" in
    center) domain_cloudflared_validate_state desired ;;
    catchall) domain_cloudflared_validate_state before ;;
    *) domain_error "Cloudflared preflight returned an invalid Center route"; return 1 ;;
  esac
}

domain_cloudflared_prepare() {
  local record="$1"
  domain_cloudflared_assert_ready || return 1
  domain_sudo python3 "$DOMAIN_HELPER" cloudflared-prepare --record "$record" || return 1
  domain_evidence_owner "$record" cloudflared
}

domain_cloudflared_before_validation_state() {
  local record="$1" route
  route="$(domain_sudo python3 "$DOMAIN_HELPER" cloudflared-before-route --record "$record")" || return 1
  case "$route" in
    center) printf '%s\n' desired ;;
    catchall) printf '%s\n' before ;;
    *) domain_error "Cloudflared journal contains an invalid preimage route"; return 1 ;;
  esac
}

domain_cloudflared_install() {
  local record="$1"
  domain_cloudflared_require || return 1
  domain_sudo python3 "$DOMAIN_HELPER" cloudflared-install --record "$record" || return 1
  domain_cloudflared_validate_state desired || return 1
  domain_sudo python3 "$DOMAIN_HELPER" cloudflared-mark --record "$record" --state desired || return 1
  domain_evidence_owner "$record" cloudflared || return 1
  domain_sudo python3 "$DOMAIN_HELPER" cloudflared-verify --record "$record" \
    --state desired --require-marker
}

domain_cloudflared_restore() {
  local record="$1" validation_state
  domain_cloudflared_require || return 1
  domain_sudo python3 "$DOMAIN_HELPER" cloudflared-restore --record "$record" || return 1
  validation_state="$(domain_cloudflared_before_validation_state "$record")" || return 1
  domain_cloudflared_validate_state "$validation_state" || return 1
  domain_sudo python3 "$DOMAIN_HELPER" cloudflared-mark --record "$record" --state before || return 1
  domain_evidence_owner "$record" cloudflared || return 1
  domain_sudo python3 "$DOMAIN_HELPER" cloudflared-verify --record "$record" \
    --state before --require-marker
}

domain_cloudflared_verify_desired() {
  local record="$1"
  domain_cloudflared_require \
    && domain_sudo python3 "$DOMAIN_HELPER" cloudflared-verify --record "$record" \
      --state desired --require-marker \
    && domain_cloudflared_validate_state desired
}

domain_cloudflared_verify_before() {
  local record="$1" validation_state
  domain_cloudflared_require || return 1
  validation_state="$(domain_cloudflared_before_validation_state "$record")" || return 1
  domain_sudo python3 "$DOMAIN_HELPER" cloudflared-verify --record "$record" \
      --state before --require-marker \
    && domain_cloudflared_validate_state "$validation_state"
}

domain_nginx_test() { domain_sudo nginx -t >/dev/null; }
domain_nginx_reload() { domain_sudo systemctl reload nginx; }

# The device edge stream template lives beside the Center vhost template in the
# same release tree, so it is derived rather than threaded through every caller.
domain_nginx_stream_template() {
  local template="$1" stream
  stream="${template%/*}/ai-pin-revival-device-edge.stream.conf.template"
  [[ -f "$stream" && ! -L "$stream" ]] \
    || { domain_error "device edge stream template is missing or unsafe: $stream"; return 1; }
  printf '%s\n' "$stream"
}

# `nginx -t` answers "syntax is ok" for a configuration whose http and stream
# contexts both bind 0.0.0.0:443; the master only fails when it tries to bind, at
# which point every vhost on this host is gone. That is how the previous attempt
# at this port took the site down. `nginx -T` expands the on-disk configuration
# without applying it, so this runs after every nginx -t and before any reload:
# a violation costs a failed deploy step, not the site.
domain_nginx_assert_443_owner() {
  local expanded status
  domain_require_helper || return 1
  expanded="$(mktemp)" || return 1
  chmod 600 "$expanded"
  if ! domain_sudo nginx -T >"$expanded" 2>/dev/null; then
    rm -f -- "$expanded"
    domain_error "could not expand the Nginx configuration to check the public :443 owner"
    return 1
  fi
  python3 "$DOMAIN_HELPER" nginx-assert-443-owner --input "$expanded"
  status=$?
  rm -f -- "$expanded"
  ((status == 0)) || domain_error "public :443 ownership check failed"
  return "$status"
}

domain_nginx_install() {
  local record="$1" template="$2" discovery="$3" center_port="$4" keycloak_port="$5" reload_mode="${6:-validate-only}" stream_template
  domain_require_helper || return 1
  stream_template="$(domain_nginx_stream_template "$template")" || return 1
  domain_assert_public_tls "$discovery" || return 1
  domain_sudo python3 "$DOMAIN_HELPER" nginx-snapshot --record "$record" --discovery "$discovery" || return 1
  domain_evidence_owner "$record" nginx || return 1
  domain_sudo python3 "$DOMAIN_HELPER" nginx-render --record "$record" --template "$template" \
    --stream-template "$stream_template" \
    --discovery "$discovery" --center-port "$center_port" --keycloak-port "$keycloak_port" || return 1
  domain_evidence_owner "$record" nginx || return 1
  domain_sudo python3 "$DOMAIN_HELPER" nginx-install-files --record "$record" || return 1
  domain_nginx_test || return 1
  domain_nginx_assert_443_owner || return 1
  domain_sudo python3 "$DOMAIN_HELPER" nginx-mark-installed --record "$record" || return 1
  domain_evidence_owner "$record" nginx || return 1
  domain_sudo python3 "$DOMAIN_HELPER" nginx-verify-desired --record "$record" --require-marker || return 1
  case "$reload_mode" in
    reload) domain_nginx_reload ;;
    validate-only) ;;
    *) domain_error "invalid Nginx activation mode"; return 1 ;;
  esac
}

domain_nginx_reapply() {
  local record="$1" reload_mode="${2:-validate-only}"
  domain_require_helper || return 1
  domain_sudo python3 "$DOMAIN_HELPER" nginx-install-files --record "$record" || return 1
  domain_nginx_test || return 1
  domain_nginx_assert_443_owner || return 1
  domain_sudo python3 "$DOMAIN_HELPER" nginx-mark-installed --record "$record" || return 1
  domain_evidence_owner "$record" nginx || return 1
  domain_sudo python3 "$DOMAIN_HELPER" nginx-verify-desired --record "$record" --require-marker || return 1
  [[ "$reload_mode" == validate-only ]] || { [[ "$reload_mode" == reload ]] && domain_nginx_reload; }
}

domain_nginx_restore() {
  local record="$1" reload_mode="${2:-validate-only}"
  domain_require_helper || return 1
  domain_sudo python3 "$DOMAIN_HELPER" nginx-restore-files --record "$record" || return 1
  domain_nginx_test || return 1
  domain_nginx_assert_443_owner || return 1
  domain_sudo python3 "$DOMAIN_HELPER" nginx-verify-before --record "$record" || return 1
  [[ "$reload_mode" == validate-only ]] || { [[ "$reload_mode" == reload ]] && domain_nginx_reload; }
}

domain_nginx_verify_desired() {
  local record="$1"
  domain_sudo python3 "$DOMAIN_HELPER" nginx-verify-desired --record "$record" --require-marker \
    && domain_nginx_test \
    && domain_nginx_assert_443_owner
}

domain_nginx_verify_before() {
  local record="$1"
  domain_sudo python3 "$DOMAIN_HELPER" nginx-verify-before --record "$record" \
    && domain_nginx_test \
    && domain_nginx_assert_443_owner
}

domain_env_value() {
  local file="$1" key="$2"
  if declare -F read_env_value >/dev/null; then
    read_env_value "$file" "$key"
  else
    python3 - "$file" "$key" <<'PY'
import sys
value=""
for raw in open(sys.argv[1],encoding="utf-8"):
    name,separator,candidate=raw.rstrip("\n").partition("=")
    if separator and name.strip()==sys.argv[2]: value=candidate.strip().strip('"')
if not value: raise SystemExit(1)
print(value)
PY
  fi
}

domain_keycloak_host() {
  case "$1" in
    center.andersmadsen.dk|cosmos.andersmadsen.dk) printf '%s\n' "$1" ;;
    *) domain_error "unreviewed Keycloak request host"; return 1 ;;
  esac
}

domain_keycloak_wait() {
  local port="$1" request_host="$2" attempt
  request_host="$(domain_keycloak_host "$request_host")" || return 1
  for attempt in $(seq 1 90); do
    if curl --silent --show-error --fail --connect-timeout 2 --max-time 5 \
        -H "Host: $request_host" -H 'X-Forwarded-Proto: https' \
        "http://127.0.0.1:$port/realms/humane/.well-known/openid-configuration" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  domain_error "Keycloak did not become ready for $request_host"
}

domain_keycloak_headers() {
  local runtime="$1" port="$2" work="$3" request_host="$4" username password_file password
  request_host="$(domain_keycloak_host "$request_host")" || return 1
  username="$(domain_env_value "$runtime" KEYCLOAK_ADMIN)" \
    || { domain_error "Keycloak administrator name is unavailable"; return 1; }
  password_file="$work/admin-password"
  password="$(domain_env_value "$runtime" KEYCLOAK_ADMIN_PASSWORD)" \
    || { domain_error "Keycloak administrator password is unavailable"; return 1; }
  printf '%s' "$password" >"$password_file"
  chmod 600 "$password_file"
  curl --silent --show-error --fail --connect-timeout 3 --max-time 20 \
    -H "Host: $request_host" -H 'X-Forwarded-Proto: https' \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode client_id=admin-cli --data-urlencode grant_type=password \
    --data-urlencode "username=$username" --data-urlencode "password@$password_file" \
    "http://127.0.0.1:$port/realms/master/protocol/openid-connect/token" >"$work/token.json" \
    || { rm -f -- "$password_file"; domain_error "Keycloak administrator authentication failed"; return 1; }
  rm -f -- "$password_file"
  python3 - "$work/token.json" "$work/admin.headers" "$work/admin-refresh-token" <<'PY'
import json,os,sys
body=json.load(open(sys.argv[1],encoding="utf-8")); token=body.get("access_token"); refresh=body.get("refresh_token")
assert isinstance(token,str) and 32 <= len(token) <= 16384 and "\n" not in token and "\r" not in token
assert isinstance(refresh,str) and 32 <= len(refresh) <= 16384 and "\n" not in refresh and "\r" not in refresh
with open(sys.argv[2],"w",encoding="utf-8") as target: target.write(f"authorization: Bearer {token}\n")
with open(sys.argv[3],"w",encoding="utf-8") as target: target.write(refresh)
os.chmod(sys.argv[2],0o600); os.chmod(sys.argv[3],0o600)
PY
  rm -f -- "$work/token.json"
}

domain_keycloak_logout() {
  local port="$1" work="$2" request_host="$3"
  request_host="$(domain_keycloak_host "$request_host")" || return 1
  [[ -f "$work/admin-refresh-token" ]] || return 0
  curl --silent --show-error --fail --connect-timeout 3 --max-time 20 \
    -H "Host: $request_host" -H 'X-Forwarded-Proto: https' \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode client_id=admin-cli --data-urlencode "refresh_token@$work/admin-refresh-token" \
    "http://127.0.0.1:$port/realms/master/protocol/openid-connect/logout" >/dev/null \
    || { domain_error "Keycloak administrator session cleanup failed"; return 1; }
  rm -f -- "$work/admin-refresh-token" "$work/admin.headers"
}

domain_keycloak_fetch_client() {
  local runtime="$1" port="$2" output="$3" request_host="${4:-center.andersmadsen.dk}" work list uuid
  request_host="$(domain_keycloak_host "$request_host")" || return 1
  work="$(mktemp -d)"; chmod 700 "$work"
  domain_keycloak_headers "$runtime" "$port" "$work" "$request_host" || { rm -rf -- "$work"; return 1; }
  list="$work/clients.json"
  curl --silent --show-error --fail --connect-timeout 3 --max-time 20 --max-filesize 2097152 \
    -H "Host: $request_host" -H 'X-Forwarded-Proto: https' -H @"$work/admin.headers" \
    "http://127.0.0.1:$port/admin/realms/humane/clients?clientId=center" >"$list" \
    || { domain_keycloak_logout "$port" "$work" "$request_host" || true; rm -rf -- "$work"; domain_error "Keycloak center client lookup failed"; return 1; }
  uuid="$(python3 - "$list" <<'PY'
import json,re,sys
body=json.load(open(sys.argv[1],encoding="utf-8")); matches=[item for item in body if item.get("clientId")=="center"]
assert len(matches)==1 and isinstance(matches[0].get("id"),str) and re.fullmatch(r"[A-Za-z0-9._:-]{8,128}",matches[0]["id"])
print(matches[0]["id"])
PY
)" || { rm -rf -- "$work"; domain_error "Keycloak center client identity is ambiguous"; return 1; }
  curl --silent --show-error --fail --connect-timeout 3 --max-time 20 --max-filesize 2097152 \
    -H "Host: $request_host" -H 'X-Forwarded-Proto: https' -H @"$work/admin.headers" \
    "http://127.0.0.1:$port/admin/realms/humane/clients/$uuid" >"$work/client.raw.json" \
    || { domain_keycloak_logout "$port" "$work" "$request_host" || true; rm -rf -- "$work"; domain_error "Keycloak center client export failed"; return 1; }
  python3 "$DOMAIN_HELPER" client-sanitize --input "$work/client.raw.json" --output "$output" \
    || { domain_keycloak_logout "$port" "$work" "$request_host" || true; rm -rf -- "$work"; return 1; }
  chmod 600 "$output"
  domain_keycloak_logout "$port" "$work" "$request_host" || { rm -rf -- "$work"; return 1; }
  rm -rf -- "$work"
}

domain_keycloak_snapshot_before() {
  local record="$1" runtime="$2" port="$3" request_host="${4:-center.andersmadsen.dk}" directory output temporary
  directory="$record/domain-cutover"
  output="$directory/keycloak-before.json"
  if [[ -e "$directory" ]]; then
    local owner path_mode
    owner="$(stat -c '%u:%g' "$record")" \
      || domain_error "deployment record ownership is unreadable" || return 1
    path_mode="$(stat -c '%a' "$directory")" \
      || domain_error "domain-cutover mode is unreadable" || return 1
    if [[ "$path_mode" != "700" ]]; then
      domain_sudo chown -R -h -- "$owner" "$directory"
      domain_sudo chmod 700 "$directory"
    else
      domain_sudo chown -R -h -- "$owner" "$directory"
    fi
  else
    domain_sudo mkdir -p "$directory"
    domain_sudo chmod 700 "$directory"
  fi
  temporary="$(mktemp "$directory/.keycloak-before.XXXXXX")"
  domain_keycloak_fetch_client "$runtime" "$port" "$temporary" "$request_host" \
    || { rm -f -- "$temporary"; return 1; }
  if [[ -f "$output" ]]; then
    cmp -s "$output" "$temporary" \
      || { rm -f -- "$temporary"; domain_error "Keycloak client changed after its pre-backup snapshot"; return 1; }
    rm -f -- "$temporary"
  else
    chmod 600 "$temporary"
    mv "$temporary" "$output"
  fi
}

domain_keycloak_bind_backup() {
  local record="$1" backup="$2" before
  domain_require_helper || return 1
  [[ -f "$backup/BACKUP_MANIFEST.json" && ! -L "$backup/BACKUP_MANIFEST.json" ]] \
    || { domain_error "restore-tested backup manifest is unavailable for Keycloak migration"; return 1; }
  before="$record/domain-cutover/keycloak-before.json"
  [[ -f "$before" && ! -L "$before" ]] \
    || { domain_error "pre-backup Keycloak client snapshot is unavailable"; return 1; }
  domain_sudo python3 "$DOMAIN_HELPER" client-prepare --before "$before" --record "$record" \
    --backup-manifest "$backup/BACKUP_MANIFEST.json" || return 1
  domain_evidence_owner "$record" keycloak
}

domain_keycloak_prepare() {
  local record="$1" backup="$2" runtime="$3" port="$4" request_host="${5:-center.andersmadsen.dk}"
  domain_keycloak_snapshot_before "$record" "$runtime" "$port" "$request_host" || return 1
  domain_keycloak_bind_backup "$record" "$backup"
}

domain_keycloak_put_desired() {
  local record="$1" runtime="$2" port="$3" which="$4" request_host="${5:-center.andersmadsen.dk}" work uuid body status
  request_host="$(domain_keycloak_host "$request_host")" || return 1
  work="$(mktemp -d)"; chmod 700 "$work"
  domain_keycloak_headers "$runtime" "$port" "$work" "$request_host" || { rm -rf -- "$work"; return 1; }
  uuid="$(domain_sudo python3 - "$record/domain-cutover/keycloak/JOURNAL.json" <<'PY'
import json,sys
body=json.load(open(sys.argv[1],encoding="utf-8")); print(body["clientUuid"])
PY
)" || { rm -rf -- "$work"; return 1; }
  body="$record/domain-cutover/keycloak/$which.json"
  status="$(domain_sudo curl --silent --show-error --connect-timeout 3 --max-time 20 \
    -o "$work/put-response" -w '%{http_code}' -X PUT \
    -H "Host: $request_host" -H 'X-Forwarded-Proto: https' \
    -H 'content-type: application/json' -H @"$work/admin.headers" --data-binary @"$body" \
    "http://127.0.0.1:$port/admin/realms/humane/clients/$uuid")" \
    || { domain_keycloak_logout "$port" "$work" "$request_host" || true; domain_sudo rm -rf -- "$work"; domain_error "Keycloak center client update failed"; return 1; }
  domain_keycloak_logout "$port" "$work" "$request_host" || { domain_sudo rm -rf -- "$work"; return 1; }
  domain_sudo rm -rf -- "$work"
  [[ "$status" == 204 ]] || { domain_error "Keycloak center client update returned HTTP $status"; return 1; }
}

domain_keycloak_verify_state() {
  local record="$1" runtime="$2" port="$3" which="$4" request_host="${5:-center.andersmadsen.dk}" work
  work="$(mktemp -d)"; chmod 700 "$work"
  domain_keycloak_fetch_client "$runtime" "$port" "$work/actual.json" "$request_host" \
    || { rm -rf -- "$work"; return 1; }
  domain_sudo python3 "$DOMAIN_HELPER" client-verify --record "$record" --which "$which" \
    --actual "$work/actual.json"
  local status=$?
  rm -rf -- "$work"
  return "$status"
}

domain_keycloak_apply() {
  local record="$1" runtime="$2" port="$3" request_host="${4:-center.andersmadsen.dk}"
  if ! domain_keycloak_verify_state "$record" "$runtime" "$port" desired "$request_host" 2>/dev/null; then
    domain_keycloak_verify_state "$record" "$runtime" "$port" before "$request_host" \
      || { domain_error "live Keycloak client matches neither migration state"; return 1; }
    domain_keycloak_put_desired "$record" "$runtime" "$port" desired "$request_host" || return 1
  fi
  domain_keycloak_verify_state "$record" "$runtime" "$port" desired "$request_host" || return 1
  domain_sudo python3 "$DOMAIN_HELPER" client-mark --record "$record" --state applied || return 1
  domain_evidence_owner "$record" keycloak
}

domain_keycloak_restore() {
  local record="$1" runtime="$2" port="$3" request_host="${4:-center.andersmadsen.dk}"
  if ! domain_keycloak_verify_state "$record" "$runtime" "$port" before "$request_host" 2>/dev/null; then
    domain_keycloak_verify_state "$record" "$runtime" "$port" desired "$request_host" \
      || { domain_error "live Keycloak client matches neither migration state"; return 1; }
    domain_keycloak_put_desired "$record" "$runtime" "$port" before "$request_host" || return 1
  fi
  domain_keycloak_verify_state "$record" "$runtime" "$port" before "$request_host" || return 1
  domain_sudo python3 "$DOMAIN_HELPER" client-mark --record "$record" --state restored || return 1
  domain_evidence_owner "$record" keycloak
}

domain_keycloak_verify_desired() {
  local record="$1" runtime="$2" port="$3" request_host="${4:-center.andersmadsen.dk}"
  domain_keycloak_verify_state "$record" "$runtime" "$port" desired "$request_host" \
    && domain_sudo python3 "$DOMAIN_HELPER" client-check-marker --record "$record" --state applied
}

domain_keycloak_verify_before() {
  local record="$1" runtime="$2" port="$3" request_host="${4:-cosmos.andersmadsen.dk}"
  domain_keycloak_verify_state "$record" "$runtime" "$port" before "$request_host" \
    && domain_sudo python3 "$DOMAIN_HELPER" client-check-marker --record "$record" --state restored
}
