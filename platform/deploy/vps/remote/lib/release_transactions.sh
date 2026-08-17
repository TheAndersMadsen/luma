#!/usr/bin/env bash
# Release identity, cross-release invocation rules, the deploy lock, and
# the nginx transaction snapshot.
#
# Sourced by remote/common.sh; not an entry point. Functions here rely on
# the constants and siblings the loader defines before any of them runs.

validate_release_id() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]] || fail "invalid release id"
}

# ---------------------------------------------------------------------------
# CROSS-RELEASE INVOCATION: running a script that belongs to a DIFFERENT release
# tree than the one whose code is doing the running.
#
# There is exactly one situation that needs it, and it is not optional. When
# deploy.sh reconciles a transaction that a PREVIOUS release armed, the partial
# effects on disk belong to that release, so the scripts that finish or unwind
# them must be that release's — the pending tree, not the selected one. The
# invocation therefore crosses a release boundary, and the invoked script's
# INTERFACE IS WHATEVER IT WAS WHEN THAT RELEASE WAS CUT. Not what this release's
# copy of the same file accepts.
#
# ASSUMING OTHERWISE IS A PRODUCTION DEADLOCK, not a failed deploy. Deploy 14:
# the new deploy.sh passed --data-columns-source to the pending release's
# backup.sh, which had never heard of the option, so backup.sh exited 64 on its
# own usage line. The transaction was already CANDIDATE_ACTIVATION_ARMED, which
# by design has no abort path — live mutation has begun and only a resume may
# finish it — so the single code path capable of completing it was the one that
# could not run. Every future option added to any invoked script re-creates that
# for every transaction armed before the option existed.
#
# THE RULE. Across a release boundary, pass ONLY options from the frozen baseline
# below. Anything the new code needs beyond that baseline, the NEW CODE MUST
# PRODUCE ITSELF with its own helpers — see deploy.sh's precommit-resume path,
# which captures its own projected data manifest and its own retained-text schema
# manifest instead of asking an older backup.sh to produce them.
#
# ADDING AN OPTION TO A LIST HERE IS A PROMISE that every release still capable of
# being pending accepts it. It is not a record of what the current release
# happens to support; the current release's own scripts are invoked from
# "$release_dir" and are not subject to any of this.
cross_release_baseline_options() {
  case "$1" in
    backup.sh)
      printf '%s\n' --backup-id --leave-quiesced --already-locked --public-ingress-quiesced \
        --cloudflared-record --cloudflared-state --ingress-evidence --json ;;
    canary.sh)
      printf '%s\n' --release-id --baseline --image-evidence --require-remote-tts \
        --require-owner-spotify --require-wearer-plane --quiesced-loopback \
        --expect-bridge-ready --legacy-dashboard-origin --cookie-file --json ;;
    transaction.py)
      printf '%s\n' --root --record --namespace --inventory --operation-action \
        --operation-ingress-evidence --channel-key-action --channel-key-path \
        --channel-key-contract --trust-root-action --staged-attest --staged-duc \
        --live-attest --live-duc --reconcile --prepare-only ;;
    verify-release.py)
      printf '%s\n' --archive --tree --manifest --extract --expect-release-id --json ;;
    *) return 1 ;;
  esac
}

# Refuse, before anything is executed, an argument list that assumes an interface
# newer than the boundary baseline. The failure is a loud message here instead of
# an exit 64 from a script three releases old in the middle of an armed cutover.
assert_cross_release_options() {
  local program="$1" baseline argument
  shift
  baseline="$(cross_release_baseline_options "$program")" \
    || fail "no cross-release interface baseline is declared for $program"
  for argument in "$@"; do
    [[ "$argument" == --* ]] || continue
    grep -qxF -- "$argument" <<<"$baseline" \
      || fail "cross-release invocation of $program passes $argument, which is newer than the release-boundary baseline: the invoked script belongs to a possibly-older release and its interface must not be assumed"
  done
}

# The one way deploy.sh runs a shell script out of another release's tree.
run_cross_release_script() {
  local release="$1" script="$2" entry
  shift 2
  entry="$release/platform/deploy/vps/remote/$script"
  [[ -f "$entry" && ! -L "$entry" ]] || fail "cross-release script is missing or unsafe: $script"
  assert_cross_release_options "$script" "$@"
  bash "$entry" "$@"
}

# Authenticate the verifier entry without executing that verifier. This breaks
# the otherwise circular trust relationship where a modified verifier could
# approve the release tree containing itself.
verify_release_verifier_entry() {
  local manifest="$1" verifier="$2" expected_release_id="$3"
  python3 - "$manifest" "$verifier" "$expected_release_id" <<'PY'
import hashlib,json,os,stat,sys
manifest_path,verifier_path,expected=sys.argv[1:]
for path in (manifest_path,verifier_path):
    metadata=os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit("release bootstrap input is not a regular file")
with open(manifest_path,"r",encoding="utf-8") as stream:
    manifest=json.load(stream)
if set(manifest) != {"schemaVersion","profile","releaseId","entries"}:
    raise SystemExit("release bootstrap manifest schema mismatch")
payload={"schemaVersion":manifest.get("schemaVersion"),"profile":manifest.get("profile"),"entries":manifest.get("entries")}
calculated=hashlib.sha256(json.dumps(payload,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
if manifest.get("schemaVersion") != 1 or manifest.get("profile") != "vps" or manifest.get("releaseId") != expected or calculated != expected:
    raise SystemExit("release bootstrap manifest identity mismatch")
entries=[entry for entry in manifest.get("entries",[]) if isinstance(entry,dict) and entry.get("path")=="platform/deploy/vps/verify-release.py"]
if len(entries) != 1 or set(entries[0]) != {"path","sha256","size","mode"}:
    raise SystemExit("release bootstrap verifier entry mismatch")
entry=entries[0]; before=os.lstat(verifier_path)
if entry.get("mode") not in {"0644","0755"} or entry.get("size") != before.st_size or entry.get("mode") != f"{stat.S_IMODE(before.st_mode):04o}":
    raise SystemExit("release bootstrap verifier metadata mismatch")
descriptor=os.open(verifier_path,os.O_RDONLY|os.O_NOFOLLOW)
try:
    opened=os.fstat(descriptor)
    if (opened.st_dev,opened.st_ino,opened.st_size) != (before.st_dev,before.st_ino,before.st_size):
        raise SystemExit("release bootstrap verifier changed before open")
    digest=hashlib.file_digest(os.fdopen(descriptor,"rb",closefd=False),"sha256").hexdigest()
finally:
    os.close(descriptor)
after=os.lstat(verifier_path)
if (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) != (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns):
    raise SystemExit("release bootstrap verifier changed while hashing")
if not isinstance(entry.get("sha256"),str) or digest != entry["sha256"]:
    raise SystemExit("release bootstrap verifier digest mismatch")
PY
}

# `--already-locked` is used only when a parent deploy/rollback operation has
# inherited descriptor 9 into backup.sh.  Prove that descriptor 9 names the
# canonical lock inode and holds (or can acquire) the exclusive flock before
# trusting the option.  A caller cannot bypass serialization merely by passing
# the flag with a closed or unrelated descriptor.
assert_inherited_deploy_lock() {
  python3 - "$LOCK_FILE" <<'PY'
import fcntl,os,stat,sys
path=sys.argv[1]
try:
    descriptor=os.fstat(9)
    target=os.stat(path,follow_symlinks=False)
except OSError as error:
    raise SystemExit(f"inherited deployment lock descriptor is unavailable: {error}")
if not stat.S_ISREG(target.st_mode):
    raise SystemExit("canonical deployment lock is not a regular file")
if (descriptor.st_dev,descriptor.st_ino)!=(target.st_dev,target.st_ino):
    raise SystemExit("inherited descriptor does not name the canonical deployment lock")
try:
    fcntl.flock(9,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit("inherited descriptor does not own the deployment lock")
PY
}

nginx_snapshot_manifest_value() {
  local manifest="$1" key="$2"
  awk -F '\t' -v wanted="$key" '
    $1 == wanted { if (found) exit 2; value=$2; found=1 }
    END { if (!found) exit 3; print value }
  ' "$manifest"
}

nginx_snapshot_object_type() {
  local path="$1"
  if sudo -n test -L "$path"; then printf 'symlink\n'
  elif sudo -n test -f "$path"; then printf 'regular\n'
  elif ! sudo -n test -e "$path" && ! sudo -n test -L "$path"; then printf 'absent\n'
  else return 1
  fi
}

nginx_snapshot_object_identity() {
  local path="$1" type="$2"
  case "$type" in
    regular)
      {
        printf 'regular\0'
        sudo -n stat --printf='%f\0%u\0%g\0%s\0%Y\0' -- "$path"
        sudo -n sha256sum -- "$path" | awk '{printf "%s%c", $1, 0}'
      } | sha256sum | awk '{print $1}'
      ;;
    symlink)
      {
        printf 'symlink\0'
        sudo -n stat --printf='%f\0%u\0%g\0%s\0%Y\0' -- "$path"
        sudo -n readlink -z -- "$path"
      } | sha256sum | awk '{print $1}'
      ;;
    *) return 1 ;;
  esac
}

validate_nginx_transaction_snapshot() {
  local evidence="$1" require_install="${2:-0}"
  local snapshot="$evidence/nginx-install/snapshot"
  local manifest="$snapshot/PRESENCE.COMPLETE"
  local label target expected_snapshot present type name identity actual_type actual_identity
  [[ -d "$snapshot" && ! -L "$snapshot" && -f "$manifest" && ! -L "$manifest" ]] || return 1
  [[ "$(wc -l <"$manifest" | tr -d '[:space:]')" == 12 ]] || return 1
  [[ "$(nginx_snapshot_manifest_value "$manifest" schema)" == ai-pin-revival-nginx-presence-v1 ]] || return 1
  [[ "$(nginx_snapshot_manifest_value "$manifest" complete)" == 1 ]] || return 1
  if [[ "$require_install" == 1 ]]; then
    local marker="$evidence/nginx-install/INSTALL.COMPLETE"
    [[ -f "$marker" && ! -L "$marker" ]] || return 1
    [[ "$(nginx_snapshot_manifest_value "$marker" schema)" == ai-pin-revival-nginx-install-v1 ]] || return 1
    [[ "$(nginx_snapshot_manifest_value "$marker" complete)" == 1 ]] || return 1
    [[ "$(nginx_snapshot_manifest_value "$marker" presence_manifest)" == snapshot/PRESENCE.COMPLETE ]] || return 1
  fi
  while IFS=$'\t' read -r label target expected_snapshot; do
    [[ "$(nginx_snapshot_manifest_value "$manifest" "$label.target")" == "$target" ]] || return 1
    present="$(nginx_snapshot_manifest_value "$manifest" "$label.present")" || return 1
    type="$(nginx_snapshot_manifest_value "$manifest" "$label.type")" || return 1
    name="$(nginx_snapshot_manifest_value "$manifest" "$label.snapshot")" || return 1
    identity="$(nginx_snapshot_manifest_value "$manifest" "$label.identity_sha256")" || return 1
    case "$present:$type:$name" in
      0:absent:-)
        [[ "$identity" == - && ! -e "$snapshot/$expected_snapshot" && ! -L "$snapshot/$expected_snapshot" ]] || return 1
        ;;
      1:regular:"$expected_snapshot"|1:symlink:"$expected_snapshot")
        [[ "$identity" =~ ^[0-9a-f]{64}$ ]] || return 1
        actual_type="$(nginx_snapshot_object_type "$snapshot/$expected_snapshot")" || return 1
        [[ "$actual_type" == "$type" ]] || return 1
        actual_identity="$(nginx_snapshot_object_identity "$snapshot/$expected_snapshot" "$type")" || return 1
        [[ "$actual_identity" == "$identity" ]] || return 1
        ;;
      *) return 1 ;;
    esac
  done <<'EOF'
available	/etc/nginx/sites-available/ai-pin-revival-connectivity	available.before
enabled	/etc/nginx/sites-enabled/ai-pin-revival-connectivity	enabled.before
EOF
}

restore_nginx_transaction_snapshot() {
  local evidence="$1" require_install="${2:-0}" reload_mode="${3:-reload}"
  local snapshot="$evidence/nginx-install/snapshot"
  local manifest="$snapshot/PRESENCE.COMPLETE"
  local label target expected_snapshot present type identity temporary actual_type actual_identity
  validate_nginx_transaction_snapshot "$evidence" "$require_install" || return 1
  while IFS=$'\t' read -r label target expected_snapshot; do
    present="$(nginx_snapshot_manifest_value "$manifest" "$label.present")" || return 1
    type="$(nginx_snapshot_manifest_value "$manifest" "$label.type")" || return 1
    identity="$(nginx_snapshot_manifest_value "$manifest" "$label.identity_sha256")" || return 1
    temporary="${target}.ai-pin-revival-outer-restore.$$"
    sudo -n rm -f -- "$temporary" || return 1
    if [[ "$present" == 0 ]]; then
      sudo -n rm -f -- "$target" || return 1
      [[ "$(nginx_snapshot_object_type "$target")" == absent ]] || return 1
      continue
    fi
    sudo -n cp -a -- "$snapshot/$expected_snapshot" "$temporary" || return 1
    actual_type="$(nginx_snapshot_object_type "$temporary")" || return 1
    [[ "$actual_type" == "$type" ]] || return 1
    actual_identity="$(nginx_snapshot_object_identity "$temporary" "$type")" || return 1
    [[ "$actual_identity" == "$identity" ]] || return 1
    sudo -n mv -Tf -- "$temporary" "$target" || return 1
  done <<'EOF'
available	/etc/nginx/sites-available/ai-pin-revival-connectivity	available.before
enabled	/etc/nginx/sites-enabled/ai-pin-revival-connectivity	enabled.before
EOF
  sudo -n nginx -t >/dev/null || return 1
  if [[ "$reload_mode" == reload ]]; then
    sudo -n systemctl reload nginx || return 1
  elif [[ "$reload_mode" != validate-only ]]; then
    return 1
  fi
}

cleanup_project_images() {
  # Exact repository scope only. Never run a builder/system prune and never
  # remove volumes or images referenced by any container.
  local image_id references
  while IFS= read -r image_id; do
    [[ -n "$image_id" ]] || continue
    references="$(docker ps -aq --filter "ancestor=$image_id" | head -n 1)"
    [[ -z "$references" ]] || continue
    docker image rm "$image_id" >/dev/null || true
  done < <(docker images --filter reference='ai-pin-revival/*' --filter dangling=true --quiet | LC_ALL=C sort -u)
}
