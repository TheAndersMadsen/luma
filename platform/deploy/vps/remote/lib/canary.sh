#!/usr/bin/bash
# Semantic evidence and the canary wearer credential machinery.
#
# Sourced by remote/common.sh; not an entry point. Functions here rely on
# the constants and siblings the loader defines before any of them runs.

write_application_semantic_evidence() {
  local output="$1" mode="$2" work login_status status_digest connectivity_url center_url
  work="$(mktemp -d)" || return 1
  case "$mode" in
    public)
      connectivity_url=http://127.0.0.1/
      center_url=https://cosmos.andersmadsen.dk/login
      ;;
    quiesced)
      connectivity_url=http://127.0.0.1:18085/
      center_url=http://127.0.0.1:14000/login
      ;;
    *) rm -rf -- "$work"; return 1 ;;
  esac
  {
    printf 'connectivity.ready\t%s\n' "$(http_status http://127.0.0.1:18085/readyz 2>/dev/null || true)"
    printf 'aibus.ready\t%s\n' "$(http_status http://127.0.0.1:18086/readyz 2>/dev/null || true)"
    printf 'connectivity.authority\t%s\n' "$(http_status -H 'Host: connectivity-check.cosmos.humane.cloud' "$connectivity_url" 2>/dev/null || true)"
    printf 'oidc.discovery\t%s\n' "$(http_status http://127.0.0.1:8088/realms/humane/.well-known/openid-configuration 2>/dev/null || true)"
    if [[ "$mode" == quiesced ]]; then
      login_status="$(http_status -H 'Host: cosmos.andersmadsen.dk' "$center_url" 2>/dev/null || true)"
    else
      login_status="$(http_status "$center_url" 2>/dev/null || true)"
    fi
    printf 'center.login\t%s\n' "$login_status"
  } >"$work/statuses.tsv"
  curl --silent --show-error --fail --max-time 20 \
    http://127.0.0.1:18086/demo-api/status >"$work/aibus-status.json" \
    || { rm -rf -- "$work"; return 1; }
  status_digest="$(python3 - "$work/aibus-status.json" <<'PY'
import hashlib,json,sys
body=json.load(open(sys.argv[1],encoding="utf-8")); mesh=body.get("mesh") or {}
summary={
  "assistant":body.get("assistant"), "speech":body.get("speech"),
  "reachable":mesh.get("reachable"), "total":mesh.get("total"),
  "services":mesh.get("services"), "methods":mesh.get("methods"),
}
assert summary["assistant"] is True and summary["speech"] is True
assert summary["reachable"] == summary["total"] == 7
encoded=json.dumps(summary,sort_keys=True,separators=(",",":")).encode()
print(hashlib.sha256(encoded).hexdigest())
PY
)" || { rm -rf -- "$work"; return 1; }
  for key in connectivity.ready aibus.ready connectivity.authority; do
    [[ "$(awk -F '\t' -v wanted="$key" '$1==wanted{print $2}' "$work/statuses.tsv")" == 204 ]] \
      || { rm -rf -- "$work"; return 1; }
  done
  [[ "$(awk -F '\t' '$1=="oidc.discovery"{print $2}' "$work/statuses.tsv")" == 200 ]] \
    || { rm -rf -- "$work"; return 1; }
  [[ "$login_status" == 200 || "$login_status" == 302 || "$login_status" == 307 ]] \
    || { rm -rf -- "$work"; return 1; }
  printf 'aibus.status.sha256\t%s\n' "$status_digest" >>"$work/statuses.tsv"
  LC_ALL=C sort -o "$work/statuses.tsv" "$work/statuses.tsv"
  install -m 600 "$work/statuses.tsv" "$output"
  rm -rf -- "$work"
}

write_legacy_semantic_evidence() { write_application_semantic_evidence "$1" public; }

# Used only when the deployment owner has deliberately stopped public ingress.
write_quiesced_semantic_evidence() { write_application_semantic_evidence "$1" quiesced; }

# First-cutover rollback has no canonical release from which to run a canary.
# Compare only the exact healthy surfaces captured before cutover; legacy did
# not expose the later n.cosmos, Center version, or Spotify-adapter contracts.
verify_legacy_application() {
  local snapshot="$1" baseline="${2:-}" current
  verify_recorded_application_identity "$snapshot" || return 1
  [[ -f "$snapshot/semantic-baseline.tsv" ]] || return 1
  systemctl is-active --quiet penumbra-center-bridge.service || return 1
  timeout 3 bash -c '</dev/tcp/127.0.0.1/18080' 2>/dev/null || return 1
  current="$(mktemp)" || return 1
  write_legacy_semantic_evidence "$current" || { rm -f -- "$current"; return 1; }
  cmp -s "$snapshot/semantic-baseline.tsv" "$current" || { rm -f -- "$current"; return 1; }
  rm -f -- "$current"
  if [[ -n "$baseline" ]]; then
    (verify_invariants "$baseline/invariants.tsv") || return 1
  fi
}

verify_quiesced_application() {
  local snapshot="$1" baseline="${2:-}" current
  verify_recorded_application_identity "$snapshot" || return 1
  [[ -f "$snapshot/semantic-baseline.tsv" ]] || return 1
  systemctl is-active --quiet penumbra-center-bridge.service || return 1
  timeout 3 bash -c '</dev/tcp/127.0.0.1/18080' 2>/dev/null || return 1
  current="$(mktemp)" || return 1
  write_quiesced_semantic_evidence "$current" || { rm -f -- "$current"; return 1; }
  cmp -s "$snapshot/semantic-baseline.tsv" "$current" || { rm -f -- "$current"; return 1; }
  rm -f -- "$current"
  if [[ -n "$baseline" ]]; then (verify_invariants "$baseline/invariants.tsv") || return 1; fi
}

# A deployment-minted Center SESSION for the paired owner — and nothing else.
#
# Read what this does and does not contain before treating a canary that consumes
# it as proof of the wearer data plane. The jar holds exactly one cookie name,
# `cosmos_session`: the HS256 session Center signs with AUTH_SESSION_SECRET. It
# does NOT hold the separate `cosmos_tokens` manifest and chunk cookies that
# Center reassembles into the wearer's Keycloak bearer (TOKENS_COOKIE and its
# `cosmos_tokens.N` chunks, center/src/server/auth.ts), so `requestBearer()`
# returns null for every request made with it, and with COSMOS_PRINCIPAL unset
# (which is every production deployment, deliberately) every outbound gRPC call
# carries no wearer identity and the workload refuses it. Center logs
# "cosmos: outbound gRPC carries no wearer identity" on each one.
#
# That is on purpose: a deploy gate must not hold a wearer credential, and there
# is no service identity here that could stand in for one without either sealing
# a real wearer's token into $PRIVATE_DIR or minting a deployment-wide principal.
# So the contract this jar supports is the HONEST-DEGRADED one — routes that
# need a bearer must answer 200 with `x-data-state: degraded`, never 500 and
# never a silently "live" fixture — and canary.sh's --require-wearer-plane
# asserts exactly that, plus the REST plane which resolves without a bearer.
#
# Closing the remaining gap needs a real sealed bearer (a `center-canary`
# confidential Keycloak client with service accounts, or a synthetic realm user),
# and until that exists the canary says so out loud rather than implying
# coverage it does not have.
write_owner_canary_cookie() {
  local release="$1" output="$2" owner_sub center_container
  load_compose_command "$release"
  owner_sub="$(read_env_value "$CENTER_ENV" REVIVAL_PIN_BRIDGE_OWNER_SUB)"
  center_container="$("${COMPOSE[@]}" ps -q center)"
  [[ -n "$owner_sub" && -n "$center_container" ]] || return 1
  docker exec -i -e "REVIVAL_CANARY_SUB=$owner_sub" "$center_container" node >"$output" <<'NODE'
const { createHmac } = require("node:crypto");
const secret = process.env.AUTH_SESSION_SECRET || "";
const sub = process.env.REVIVAL_CANARY_SUB || "";
if (secret.length < 32 || !sub || /[\r\n]/u.test(sub)) process.exit(1);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = `${encode({ alg: "HS256" })}.${encode({ sub, email: "", name: "deployment canary", operator: false, iat: now, exp: now + 3600 })}`;
const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
// curl matches a cookie against the request's effective Host header, so the jar
// must name every host a canary dials: the loopback origin and both public
// dashboard hosts (the quiesced canary reaches Center on 127.0.0.1 while
// sending Host: <dashboard>). None may be secure-only, because that same
// quiesced path speaks plain HTTP and curl withholds secure cookies there.
// This jar is ephemeral canary material: one hour, mode 0600, removed after.
const token = `${unsigned}.${signature}`;
const expiry = now + 3600;
process.stdout.write(
  `# Netscape HTTP Cookie File\n` +
    `127.0.0.1\tFALSE\t/\tFALSE\t${expiry}\tcosmos_session\t${token}\n` +
    `#HttpOnly_center.andersmadsen.dk\tFALSE\t/\tFALSE\t${expiry}\tcosmos_session\t${token}\n` +
    `#HttpOnly_cosmos.andersmadsen.dk\tFALSE\t/\tFALSE\t${expiry}\tcosmos_session\t${token}\n`,
);
NODE
  unset owner_sub
  chmod 600 "$output"
  python3 - "$output" <<'PY'
import os,re,sys
data=open(sys.argv[1],encoding="ascii").read()
assert os.stat(sys.argv[1]).st_mode & 0o777 == 0o600
assert len(data) <= 4096
assert re.fullmatch(
    r"# Netscape HTTP Cookie File\n"
    r"127\.0\.0\.1\tFALSE\t/\tFALSE\t[0-9]+\tcosmos_session\t(?P<token>[A-Za-z0-9_.-]+)\n"
    r"#HttpOnly_center\.andersmadsen\.dk\tFALSE\t/\tFALSE\t[0-9]+\tcosmos_session\t(?P=token)\n"
    r"#HttpOnly_cosmos\.andersmadsen\.dk\tFALSE\t/\tFALSE\t[0-9]+\tcosmos_session\t(?P=token)\n",
    data,
)
PY
}

# Fail CLOSED and say exactly which property is wrong. Never prints a value —
# not a length, not a prefix — because this is the one file on the host whose
# contents are a live wearer credential.
assert_wearer_canary_secret() {
  local path="${1:-$WEARER_CANARY_SECRET}"
  python3 - "$path" <<'PY'
import os,stat,sys

path=sys.argv[1]
try:
    metadata=os.lstat(path)
except FileNotFoundError:
    raise SystemExit("the canary wearer credential file does not exist")
if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
    raise SystemExit("the canary wearer credential must be a regular file, not a link")
if stat.S_IMODE(metadata.st_mode) not in (0o600,0o400):
    raise SystemExit("the canary wearer credential must be mode 0600 or 0400")
if metadata.st_uid != os.geteuid():
    raise SystemExit("the canary wearer credential is not owned by the deploying user")
directory=os.stat(os.path.dirname(os.path.abspath(path)))
if stat.S_IMODE(directory.st_mode) & 0o077:
    raise SystemExit("the directory holding the canary wearer credential is group- or world-accessible")
if not 0 < metadata.st_size <= 4096:
    raise SystemExit("the canary wearer credential file has an implausible size")

required={"REVIVAL_CANARY_WEARER_USERNAME","REVIVAL_CANARY_WEARER_PASSWORD"}
values={}
for line in open(path,encoding="utf-8"):
    line=line.rstrip("\n")
    if not line.strip() or line.lstrip().startswith("#"): continue
    key,separator,value=line.partition("=")
    if not separator:
        raise SystemExit("the canary wearer credential file has a line that is not KEY=VALUE")
    key=key.strip()
    # An extra key means this file is a copy of something larger — a whole
    # center.env, say — and the blast radius of the one file that must stay
    # single-purpose has quietly grown.
    if key not in required:
        raise SystemExit("the canary wearer credential file carries a key that is not part of its contract")
    if key in values:
        raise SystemExit("the canary wearer credential file defines a key twice")
    values[key]=value.strip()
missing=sorted(required-set(values))
if missing:
    raise SystemExit("the canary wearer credential file is missing a required key")
username=values["REVIVAL_CANARY_WEARER_USERNAME"]
password=values["REVIVAL_CANARY_WEARER_PASSWORD"]
for value in (username,password):
    if not value:
        raise SystemExit("the canary wearer credential file has an empty value")
    if any(character < " " or character == "\x7f" for character in value):
        raise SystemExit("the canary wearer credential file has a control character in a value")
if not 1 <= len(username) <= 320:
    raise SystemExit("the canary wearer username is implausible")
# Short enough to be a placeholder is short enough to be guessable, and a
# password equal to the username is the shape a hurried provisioning takes.
if len(password) < 16 or password == username:
    raise SystemExit("the canary wearer password is too weak to be a provisioned credential")
PY
}

wearer_canary_secret_present() {
  [[ -f "$WEARER_CANARY_SECRET" && ! -L "$WEARER_CANARY_SECRET" ]]
}

# The credential's only appearance outside its own file: a mode-0600 JSON body
# that curl reads by path. Kept separate from the request so it is testable
# without a running Center.
write_wearer_canary_login_body() {
  local secret="$1" output="$2"
  python3 - "$secret" "$output" <<'PY'
import json,os,sys,tempfile
secret,output=sys.argv[1:]
values={}
for line in open(secret,encoding="utf-8"):
    key,separator,value=line.rstrip("\n").partition("=")
    if separator: values[key.strip()]=value.strip()
body=json.dumps(
    {"username":values["REVIVAL_CANARY_WEARER_USERNAME"],
     "password":values["REVIVAL_CANARY_WEARER_PASSWORD"]},
    separators=(",",":"),
)
directory=os.path.dirname(os.path.abspath(output))
descriptor,temporary=tempfile.mkstemp(prefix=".canary-login.",dir=directory)
try:
    os.fchmod(descriptor,0o600)
    with os.fdopen(descriptor,"w",encoding="utf-8") as handle: handle.write(body)
    os.replace(temporary,output)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
}

# Turn Center's login response headers into the raw jar the normalizer consumes.
#
# WHY NOT curl's own --cookie-jar, which is what this did until it was run.
# curl REFUSES TO STORE a `Secure` cookie that arrived over a plain-http URL, and
# Center sets every auth cookie Secure whenever NODE_ENV=production — which
# production is. The login is loopback-only by design (a wearer credential must
# not traverse the public edge, and the quiesced window has no public edge at
# all), so the response ALWAYS arrives over http and curl ALWAYS dropped the
# entire set. The jar came back empty and the run failed with "Center's login set
# no session cookie", which reads as a broken Center and was in fact a broken
# canary. Observed against production, curl 8.5.0, for both http://127.0.0.1 and
# http://localhost: four Set-Cookie headers received, zero cookies stored.
#
# Reading Set-Cookie directly is what canary.sh's OIDC block already does with
# these very headers, so this is the existing pattern rather than a new one, and
# it does not depend on a cookie-engine heuristic that varies by curl version.
#
# Values are carried VERBATIM. Next.js percent-encodes cookie values on the way
# out, and what goes back on the wire has to be the same bytes a browser would
# send; decoding here would quietly rewrite the credential material.
write_login_cookie_jar() {
  local headers="$1" output="$2"
  python3 - "$headers" "$output" <<'PY'
import os,re,sys,tempfile,time

headers,output=sys.argv[1:]
expiry=int(time.time())+3600
rows=[]
for line in open(headers,encoding="latin1"):
    key,separator,value=line.partition(":")
    if not separator or key.strip().lower()!="set-cookie": continue
    attributes=[part.strip() for part in value.strip().split(";")]
    name,assignment,raw=attributes[0].partition("=")
    if not assignment: continue
    # A cleared cookie is not a credential. Center deletes with Max-Age=0, and
    # storing one would make an emptied session look like a complete jar.
    if any(re.fullmatch(r"max-age\s*=\s*0",attribute,re.I) for attribute in attributes[1:]): continue
    rows.append((name.strip(),raw))
if not rows:
    raise SystemExit("Center's login answered 200 and set no cookie at all")
data="# Netscape HTTP Cookie File\n"+"".join(
    f"127.0.0.1\tFALSE\t/\tFALSE\t{expiry}\t{name}\t{value}\n" for name,value in rows
)
directory=os.path.dirname(os.path.abspath(output))
descriptor,temporary=tempfile.mkstemp(prefix=".canary-raw.",dir=directory)
try:
    os.fchmod(descriptor,0o600)
    with os.fdopen(descriptor,"w",encoding="utf-8") as handle: handle.write(data)
    os.replace(temporary,output)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
}

# Rewrite the login's cookies into the canonical multi-host form the canary
# dials, and refuse anything that is not a complete sealed token set.
#
# The refusal is the gate: Center answers a successful login with 200 and a
# session cookie whether or not sealTokens produced anything usable, so "the
# login worked" is not evidence that the bearer plane exists. A jar with a
# session and no `cosmos_tokens` manifest is exactly the credential-free jar
# write_owner_canary_cookie mints, and accepting it here would silently
# reinstate the blind spot this whole path exists to close.
#
# The Secure attribute is dropped on purpose, in both directions. Center sets
# these cookies Secure in production, and the canary reaches Center over plain
# HTTP on 127.0.0.1 to sign in — always, and necessarily so in the quiesced
# window, where every public ingress is stopped. curl neither STORES such a
# cookie (see write_login_cookie_jar) nor SENDS one back over loopback, so a jar
# that kept the attribute would be silently empty on the one run that brackets
# the cutover. The values are unchanged and the file is 0600 on a 0700 directory
# — the attribute governs what curl does on loopback, not what Center sets on a
# browser.
normalize_wearer_canary_jar() {
  local raw="$1" output="$2"
  python3 - "$raw" "$output" <<'PY'
import os,re,sys,tempfile,time,urllib.parse

raw,output=sys.argv[1:]
cookies={}
for line in open(raw,encoding="utf-8"):
    line=line.rstrip("\n")
    if not line or (line.startswith("#") and not line.startswith("#HttpOnly_")): continue
    fields=line.split("\t")
    if len(fields)!=7: continue
    name,value=fields[5],fields[6]
    if name in cookies and cookies[name]!=value:
        raise SystemExit("Center's login returned two different values for one cookie")
    cookies[name]=value

session=cookies.get("cosmos_session")
manifest=cookies.get("cosmos_tokens")
if not session:
    raise SystemExit("Center's login set no session cookie")
if not manifest:
    raise SystemExit("Center's login set no sealed token cookie, so this jar carries no wearer bearer")
# Center writes `v1:N`, and Next.js percent-encodes every cookie value on the way
# out, so the byte sequence that actually arrives is `v1%3AN`. The DECODED form is
# what gets checked, because that is what Center meant; the ENCODED form is what
# stays in the jar, because that is what a browser sends back.
found=re.fullmatch(r"v1:([1-4])",urllib.parse.unquote(manifest))
if not found:
    raise SystemExit("the sealed token manifest is not the chunk format Center writes")
ordered=[("cosmos_session",session),("cosmos_tokens",manifest)]
for index in range(int(found.group(1))):
    name=f"cosmos_tokens.{index}"
    value=cookies.get(name)
    if not value:
        raise SystemExit("the sealed token set is missing a chunk its own manifest declares")
    ordered.append((name,value))
for name,value in ordered:
    # base64url for the session JWT and every JWE chunk, plus the one colon in
    # the `v1:N` manifest — percent-escaped or not, since Next.js escapes it and
    # base64url itself has nothing left to escape. Anything else means a hop
    # rewrote the cookie, and a rewritten sealed token is a silent `degraded`
    # three checks later.
    if not re.fullmatch(r"[A-Za-z0-9_.:%~-]{1,16384}",value):
        raise SystemExit("a canary cookie value is not the shape Center emits")

expiry=int(time.time())+3600
lines=["# Netscape HTTP Cookie File\n"]
for host in ("127.0.0.1","#HttpOnly_center.andersmadsen.dk","#HttpOnly_cosmos.andersmadsen.dk"):
    for name,value in ordered:
        lines.append(f"{host}\tFALSE\t/\tFALSE\t{expiry}\t{name}\t{value}\n")
data="".join(lines)
if len(data) > 262144:
    raise SystemExit("the canary cookie jar is larger than the supported cookie budget")
directory=os.path.dirname(os.path.abspath(output))
descriptor,temporary=tempfile.mkstemp(prefix=".canary-jar.",dir=directory)
try:
    os.fchmod(descriptor,0o600)
    with os.fdopen(descriptor,"w",encoding="ascii") as handle: handle.write(data)
    os.replace(temporary,output)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
}

# Sign the canary wearer in through Center's own login route and leave a jar
# holding the real sealed bearer. Diagnostics name the failing stage and never
# the credential.
write_wearer_canary_jar() {
  local output="$1" work status
  assert_wearer_canary_secret "$WEARER_CANARY_SECRET" || return 1
  work="$(mktemp -d)" || return 1
  if ! write_wearer_canary_login_body "$WEARER_CANARY_SECRET" "$work/login.json"; then
    rm -rf -- "$work"
    return 1
  fi
  # Loopback only: the credential must not traverse the public edge, and this is
  # also the one Center origin that is reachable inside the quiesced window.
  status="$(curl --silent --show-error --connect-timeout 4 --max-time 25 --max-redirs 0 \
    -o /dev/null -w '%{http_code}' \
    -H 'content-type: application/json' -H 'Host: center.andersmadsen.dk' \
    -H 'X-Forwarded-Proto: https' -H 'Origin: https://center.andersmadsen.dk' \
    --data @"$work/login.json" -D "$work/login.headers" \
    http://127.0.0.1:14000/api/auth/login || true)"
  rm -f -- "$work/login.json"
  if [[ "$status" != 200 ]]; then
    # 401 is a rejected credential; 503 is a Center with no KEYCLOAK_BASE_URL;
    # 000 is a Center that did not answer at all. All three are deploy-blocking
    # and none of them is the operator's password being echoed anywhere.
    warn "the canary wearer could not sign in to Center (HTTP $status)"
    rm -rf -- "$work"
    return 1
  fi
  if ! write_login_cookie_jar "$work/login.headers" "$work/raw.cookies"; then
    rm -rf -- "$work"
    return 1
  fi
  if ! normalize_wearer_canary_jar "$work/raw.cookies" "$output"; then
    rm -rf -- "$work"
    return 1
  fi
  rm -rf -- "$work"
}

# The subject Center signed into the session half of the jar. Read from our own
# cookie without verifying it — the signature is Center's to check, and this is
# only used to prove the canary is NOT the paired wearer.
wearer_canary_jar_subject() {
  local jar="$1"
  python3 - "$jar" <<'PY'
import base64,json,re,sys
value=None
for line in open(sys.argv[1],encoding="ascii"):
    fields=line.rstrip("\n").split("\t")
    if len(fields)==7 and fields[5]=="cosmos_session": value=fields[6]; break
if not value: raise SystemExit("the canary jar has no session cookie")
parts=value.split(".")
if len(parts)!=3: raise SystemExit("the canary session cookie is not a compact JWT")
payload=parts[1]
claims=json.loads(base64.urlsafe_b64decode(payload+"="*(-len(payload)%4)))
subject=str(claims.get("sub") or "")
if not re.fullmatch(r"[A-Za-z0-9_.:@-]{1,320}",subject):
    raise SystemExit("the canary session cookie carries no usable subject")
print(subject)
PY
}
