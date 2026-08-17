#!/usr/bin/env bash
# Provision the canary wearer identity. RUN THIS ON THE VPS, from a terminal.
#
#   scp platform/deploy/vps/provision-canary-wearer.sh vps:~/
#   ssh -t vps 'bash ~/provision-canary-wearer.sh'
#
# WHY THIS EXISTS. The deploy canary must sign in as a real wearer, or it cannot
# tell a healthy Center from one answering 200 to everything while every wearer
# sees an empty dashboard. Two 100%-wearer-facing outages passed every gate this
# project has, for exactly that reason. The canary now fails closed without a
# credential, so preflight refuses a deploy until this file exists.
#
# WHAT IT DOES NOT DO. It never prints the password, never passes it as a command
# argument, and never puts it in an environment variable — every credential moves
# through a mode-0600 temporary file that is shredded on exit. The password is
# generated here, on this host, so it exists in exactly two places when the script
# finishes: Keycloak, and the secret file.
#
# It is safe to re-run. An existing canary user is reused and its password reset;
# an existing secret file is replaced only after the new credential is proven to
# work against Keycloak.
set -euo pipefail

REVIVAL_ROOT="${REVIVAL_ROOT:-$HOME/ai-pin-revival}"
PRIVATE_DIR="$REVIVAL_ROOT/private"
SECRET_FILE="$PRIVATE_DIR/canary-wearer.secret"
KEYCLOAK="http://127.0.0.1:8088"
REALM=humane
CENTER_CLIENT=center

die() { printf '\nprovision-canary-wearer: %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

# One 0700 directory for every transient credential, removed on any exit path
# including a signal. Nothing below writes a secret anywhere else.
WORK="$(mktemp -d)"; chmod 700 "$WORK"
cleanup() {
  if [[ -d "$WORK" ]]; then
    find "$WORK" -type f -exec shred -u {} + 2>/dev/null || true
    rm -rf -- "$WORK"
  fi
}
trap cleanup EXIT HUP INT TERM

[[ -d "$REVIVAL_ROOT" ]] || die "this must run on the VPS: $REVIVAL_ROOT does not exist"
[[ -d "$PRIVATE_DIR" ]] || die "missing $PRIVATE_DIR"
for tool in curl python3 openssl install; do
  command -v "$tool" >/dev/null || die "missing required tool: $tool"
done

curl -fsS --max-time 8 "$KEYCLOAK/realms/$REALM" >/dev/null \
  || die "Keycloak is not answering on $KEYCLOAK — is the stack up?"

# ---------------------------------------------------------------------------
step "Keycloak administrator sign-in"
# TAKEN FROM private/runtime.env, NOT PROMPTED FOR AND NEVER PRINTED.
#
# This script already runs as the user that owns the 0700 private directory, so
# asking a human to fetch KEYCLOAK_ADMIN_PASSWORD out of that file and paste it
# back in adds no security and costs plenty: the value lands in terminal
# scrollback, in shell history if it is ever echoed, and in whatever is reading
# over the operator's shoulder. Reading it directly means the master-realm
# password is seen by nobody and typed nowhere.
#
# It is read with `sudo -n` — the same non-interactive privilege this script
# already uses for CARRY_OPERATOR_EMAILS — straight into a mode-600 file, and is
# shredded a few lines below. --admin-prompt is kept for a host where that read
# is not permitted.
umask 077
ADMIN_PROMPT=0
[[ "${1:-}" != "--admin-prompt" ]] || ADMIN_PROMPT=1

read_private_value() {
  local key="$1"
  sudo -n grep -h "^$key=" "$PRIVATE_DIR"/*.env 2>/dev/null | head -1 | cut -d= -f2-
}

if ((ADMIN_PROMPT == 0)); then
  read_private_value KEYCLOAK_ADMIN >"$WORK/admin-user"
  read_private_value KEYCLOAK_ADMIN_PASSWORD >"$WORK/admin-pass"
  if [[ ! -s "$WORK/admin-user" || ! -s "$WORK/admin-pass" ]]; then
    die "could not read KEYCLOAK_ADMIN/KEYCLOAK_ADMIN_PASSWORD from $PRIVATE_DIR.
  Re-run as the owner of that directory, or use --admin-prompt to type them."
  fi
  printf '  using KEYCLOAK_ADMIN from %s (value not shown)\n' "$PRIVATE_DIR"
else
  echo "This is the Keycloak MASTER-REALM admin (KEYCLOAK_ADMIN) — not your"
  echo "center.andersmadsen.dk sign-in. Never echoed, never a command argument."
  read -r -p "  Keycloak admin username [admin]: " ADMIN_USER
  printf '%s' "${ADMIN_USER:-admin}" >"$WORK/admin-user"
  read -r -s -p "  Keycloak admin password: " ADMIN_PASS; echo
  [[ -n "$ADMIN_PASS" ]] || die "admin password is required"
  printf '%s' "$ADMIN_PASS" >"$WORK/admin-pass"
  unset ADMIN_PASS
fi

# --data @file, never --data "$VAR": an argument list is world-readable in /proc.
# The same rule applies to the ENCODER: a value handed to `python3 -c ... "$PASS"`
# sits in that process's argv for its lifetime, so python reads the FILES.
python3 - "$WORK/admin-user" "$WORK/admin-pass" >"$WORK/admin-login" <<'ENCODE'
import sys, urllib.parse
def read(path):
    with open(path, encoding="utf-8") as handle:
        return urllib.parse.quote(handle.read().strip(), safe="")
sys.stdout.write("client_id=admin-cli&grant_type=password&username=%s&password=%s"
                 % (read(sys.argv[1]), read(sys.argv[2])))
ENCODE
shred -u "$WORK/admin-user" "$WORK/admin-pass" 2>/dev/null || rm -f "$WORK/admin-user" "$WORK/admin-pass"

curl -fsS --max-time 15 -o "$WORK/admin-token.json" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data "@$WORK/admin-login" \
  "$KEYCLOAK/realms/master/protocol/openid-connect/token" \
  || die "admin sign-in failed. KEYCLOAK_ADMIN/KEYCLOAK_ADMIN_PASSWORD in
  $PRIVATE_DIR did not authenticate against the master realm. If that pair was
  rotated in Keycloak without updating the file, re-run with --admin-prompt."
shred -u "$WORK/admin-login" 2>/dev/null || rm -f "$WORK/admin-login"

python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("access_token") else 1)' \
  "$WORK/admin-token.json" || die "Keycloak returned no admin access token"
ADMIN_TOKEN_FILE="$WORK/admin-token.header"
python3 -c 'import json,sys; print("authorization: Bearer "+json.load(open(sys.argv[1]))["access_token"])' \
  "$WORK/admin-token.json" >"$ADMIN_TOKEN_FILE"
echo "  admin sign-in ok"

admin_api() { curl -fsS --max-time 20 -H "@$ADMIN_TOKEN_FILE" "$@"; }

# ---------------------------------------------------------------------------
step "Choosing the canary identity"
# Read the operator allowlist so the script can refuse BEFORE creating anything.
# The canary asserts this again at runtime (it requires 403 from /api/admin/overview),
# so a lazily provisioned identity fails the deploy rather than quietly handing a
# gate the operator's own account.
OPERATORS="$(sudo -n grep -h '^CARRY_OPERATOR_EMAILS=' "$PRIVATE_DIR"/*.env 2>/dev/null | cut -d= -f2- | tr ',' '\n' | tr -d ' ' | grep -v '^$' | sort -u || true)"
PIN_OWNER_SUB="$(sudo -n grep -h '^REVIVAL_PIN_BRIDGE_OWNER_SUB=' "$PRIVATE_DIR"/*.env 2>/dev/null | cut -d= -f2- | tr -d ' ' | head -1 || true)"

echo "  This account is CREATED by this script; it does not need to exist yet."
echo "  It must not be your own login: the canary asserts it is NOT an operator."
read -r -p "  Canary username to create [canary@andersmadsen.dk]: " CANARY_USER
CANARY_USER="${CANARY_USER:-canary@andersmadsen.dk}"
printf '%s' "$CANARY_USER" >"$WORK/canary-user-name"

if [[ -n "$OPERATORS" ]] && grep -Fxq -- "$CANARY_USER" <<<"$OPERATORS"; then
  die "$CANARY_USER is an operator (CARRY_OPERATOR_EMAILS). The canary must be an ordinary wearer; pick another name."
fi

# ---------------------------------------------------------------------------
step "Creating or reusing the realm user"
lookup_user() {
  admin_api -G --data-urlencode "username=$CANARY_USER" --data-urlencode 'exact=true' \
    "$KEYCLOAK/admin/realms/$REALM/users" \
    | python3 -c 'import json,sys
users=json.load(sys.stdin)
print(users[0]["id"] if users else "")'
}

USER_ID="$(lookup_user)"
if [[ -z "$USER_ID" ]]; then
  # firstName/lastName are REQUIRED, not decoration. This realm uses Keycloak's
  # declarative user profile, which makes them mandatory attributes: a user
  # missing either is "not fully set up", and the password grant fails with
  # invalid_grant no matter how correct the password is. Center surfaces that as
  # "Those credentials were not accepted", which reads like a wrong password and
  # sends you hunting in the wrong place — it cost an hour here.
  python3 - "$CANARY_USER" >"$WORK/create-user.json" <<'CREATE'
import json, sys
name = sys.argv[1]
json.dump({
    "username": name,
    "email": name,
    "firstName": "Deploy",
    "lastName": "Canary",
    "enabled": True,
    "emailVerified": True,
    "requiredActions": [],
}, sys.stdout)
CREATE
  admin_api -X POST -H 'content-type: application/json' --data "@$WORK/create-user.json" \
    "$KEYCLOAK/admin/realms/$REALM/users" >/dev/null \
    || die "could not create $CANARY_USER"
  USER_ID="$(lookup_user)"
  [[ -n "$USER_ID" ]] || die "created $CANARY_USER but could not read it back"
  echo "  created $CANARY_USER"
else
  echo "  reusing existing $CANARY_USER"
  # A pre-existing user may carry a pending action that would block the password
  # grant; clear those two and nothing else.
  # Same repair on the reuse path: a user created before this fix has no
  # firstName/lastName and cannot complete a password grant until it does.
  admin_api -X PUT -H 'content-type: application/json' \
    --data '{"enabled":true,"emailVerified":true,"requiredActions":[],"firstName":"Deploy","lastName":"Canary"}' \
    "$KEYCLOAK/admin/realms/$REALM/users/$USER_ID" >/dev/null || true
fi

# ---------------------------------------------------------------------------
step "Refusing a privileged identity"
[[ "$USER_ID" != "$PIN_OWNER_SUB" ]] \
  || die "$CANARY_USER is the paired Pin owner ($PIN_OWNER_SUB). It must be a separate identity."

ROLES="$(admin_api "$KEYCLOAK/admin/realms/$REALM/users/$USER_ID/role-mappings" \
  | python3 -c 'import json,sys
m=json.load(sys.stdin)
names=[r["name"] for r in m.get("realmMappings",[])]
for c in (m.get("clientMappings") or {}).values():
    names += [r["name"] for r in c.get("mappings",[])]
print("\n".join(sorted(set(names))))')"
if grep -qi 'operator\|admin' <<<"$ROLES"; then
  die "$CANARY_USER holds privileged roles and must not: $(tr '\n' ' ' <<<"$ROLES")"
fi
echo "  subject $USER_ID, roles: $(tr '\n' ' ' <<<"${ROLES:-none}")"

# ---------------------------------------------------------------------------
step "Generating and setting the password"
# Generated here so it is never typed, never in scrollback, and never known to
# anyone who did not run this script. 48 base64url chars from the system CSPRNG.
openssl rand -base64 36 | tr -d '\n=' | tr '+/' '-_' >"$WORK/password"
[[ -s "$WORK/password" ]] || die "could not generate a password"

python3 -c 'import json,sys
print(json.dumps({"type":"password","temporary":False,"value":open(sys.argv[1]).read().strip()}))' \
  "$WORK/password" >"$WORK/credential.json"
admin_api -X PUT -H 'content-type: application/json' --data "@$WORK/credential.json" \
  "$KEYCLOAK/admin/realms/$REALM/users/$USER_ID/reset-password" >/dev/null \
  || die "could not set the canary password"
shred -u "$WORK/credential.json" 2>/dev/null || rm -f "$WORK/credential.json"
echo "  password set (not displayed)"

# ---------------------------------------------------------------------------
step "Proving the credential works before writing it"
# THROUGH CENTER'S OWN LOGIN ROUTE, which is exactly what the canary does.
#
# The first version of this check posted straight to Keycloak's token endpoint
# with only client_id, and got a 401: `center` is a CONFIDENTIAL client, so a
# direct grant needs KEYCLOAK_CLIENT_SECRET too. Rather than teach this script to
# handle that secret, it now exercises the real path — POST /api/auth/login on
# Center's loopback port, which supplies the client secret itself, seals the
# tokens and sets the chunked carry_tokens cookies. That proves the thing the
# canary actually depends on, not an adjacent thing that happens to share a
# password. Loopback only, so the credential never reaches nginx or Cloudflare.
CENTER_ORIGIN="http://127.0.0.1:${REVIVAL_CENTER_PORT:-14000}"

python3 - "$WORK/canary-user-name" "$WORK/password" >"$WORK/login-body.json" <<'ENCODE'
import json, sys
def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read().strip()
json.dump({"username": read(sys.argv[1]), "password": read(sys.argv[2])}, sys.stdout)
ENCODE

LOGIN_STATUS="$(curl -sS --max-time 20 -o "$WORK/login-response.json" -w '%{http_code}' \
  -H 'content-type: application/json' --data "@$WORK/login-body.json" \
  "$CENTER_ORIGIN/api/auth/login" || echo 000)"
shred -u "$WORK/login-body.json" 2>/dev/null || rm -f "$WORK/login-body.json"

if [[ "$LOGIN_STATUS" != 200 ]]; then
  printf '  Center answered %s\n' "$LOGIN_STATUS" >&2
  [[ ! -s "$WORK/login-response.json" ]] || {
    printf '  response: ' >&2
    head -c 300 "$WORK/login-response.json" >&2
    printf '\n' >&2
  }
  die "the canary credential could not sign in through Center.
  A 401 usually does NOT mean the password is wrong. Keycloak returns
  invalid_grant \"Account is not fully set up\" for a user missing a mandatory
  profile attribute, and Center reports that as a rejected credential. Check the
  realm's user profile requirements against the attributes this script sets.
  A 5xx means Center could not reach Keycloak; if Center is not on
  $CENTER_ORIGIN, set REVIVAL_CENTER_PORT and re-run."
fi
echo "  signed in through Center on $CENTER_ORIGIN"

step "Writing the secret"
# Exactly two keys: the validator refuses a third, which is what stops this file
# quietly becoming a copy of something larger. Written to a temp file in the same
# directory and moved into place, so a reader never sees a half-written file.
{
  printf 'REVIVAL_CANARY_WEARER_USERNAME=%s\n' "$CANARY_USER"
  # printf is a shell builtin, so this value never becomes a process argument.
  printf 'REVIVAL_CANARY_WEARER_PASSWORD=%s\n' "$(cat "$WORK/password")"
} >"$WORK/secret"
install -m 600 "$WORK/secret" "$SECRET_FILE"
shred -u "$WORK/secret" "$WORK/password" 2>/dev/null || rm -f "$WORK/secret" "$WORK/password"

[[ "$(stat -c '%a' "$SECRET_FILE")" == 600 ]] || die "wrote $SECRET_FILE with the wrong mode"
echo "  wrote $SECRET_FILE (mode 600, $(wc -l <"$SECRET_FILE") lines)"

# ---------------------------------------------------------------------------
step "Done"
cat <<'NEXT'
The canary wearer is provisioned. Nothing printed the password; it exists only in
Keycloak and in the secret file.

Next, from your laptop:

  ./revival canary --remote vps

That proves the sealed-bearer path end to end against the live system. Once it is
clean, a deploy will run its wearer-plane assertions on every canary.

To rotate later: re-run this script. It resets the password and rewrites the file,
and needs no deploy — the credential is deliberately not fingerprinted into
config-digests.tsv.
NEXT
