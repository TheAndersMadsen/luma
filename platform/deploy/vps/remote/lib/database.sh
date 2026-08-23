#!/usr/bin/bash
# Database checks: postgres data/schema/security capture, the additive
# schema allowance, and relation column projections.
#
# Sourced by remote/common.sh; not an entry point. Functions here rely on
# the constants and siblings the loader defines before any of them runs.

# Hash every dumpable, non-system relation without retaining row bodies.  Both
# backup creation and the domain cutover use this one canonical producer, so a
# rollback comparison cannot silently drift to a second manifest format.
#
# ONE psql SESSION PER DATABASE, NOT ONE `docker exec` PER STATEMENT.
#
# This used to spend three to four `docker exec` calls per relation — a count, a
# column lookup and a digest — across ~110 relations in two databases, roughly
# 330 container round trips. On the production host a `docker exec` costs about
# 65ms of namespace and process setup before psql has said a word, and the two
# databases together are 25MB, so the capture was almost entirely process
# spawning: 20.2s measured per call, nine calls inside the quiesced public
# ingress window, ~180s of a 420s budget during which the wearer sees a
# Cloudflare 530 and the Pin's device plane is unreachable.
#
# WHAT THIS DELIBERATELY DOES NOT CHANGE, because the whole value of the
# manifest is that two captures of an unchanged cluster are byte-identical:
#
#   * Every statement is still issued SEPARATELY, one at a time, in the same
#     order, with the same text. A batch is a single psql SESSION, never a
#     single TRANSACTION — psql stays in autocommit, so each statement still
#     takes its own snapshot exactly as a separate `docker exec` did. Wrapping
#     the relations in one transaction would arguably be *more* consistent and
#     is exactly why it is not done: it would change what the digest means.
#   * Every statement keeps the environment it had. The counts and the COPYs
#     still run with PGOPTIONS statement_timeout/lock_timeout; the catalog list,
#     the column lookups and the large-object count still run without them.
#     That is why the column lookups get their own session rather than riding
#     along with the digests.
#   * The digest is still sha256 of THE BYTES PSQL WROTE, computed here on the
#     host. Moving it into SQL (sha256(convert_to(string_agg(...)))) would mean
#     re-implementing COPY's text escaping in SQL — a second implementation of
#     the manifest format, which is precisely the defect class this file has
#     already been bitten by twice (see data-mutation-gates.test.mjs).
#
# HOW THE STREAM IS SPLIT. psql writes every statement's output to one stdout,
# so `\echo <marker>` is emitted before each statement and split_postgres_segments
# cuts the stream on that exact line, hashing each segment independently. The
# marker is a per-run random nonce wrapped in '#'. It cannot be forged by data:
# COPY renders every row of this manifest as either a jsonb object ('{'…) or a
# large-object page (a digit…), JSON escapes every control character inside
# strings, and COPY escapes every newline, so no data line can begin with '#'.
# A segment miscount is fatal rather than silently shifting one relation's
# digest onto the next.
#
# THE ONE ORDERING THAT DID MOVE: the column lookups now all run before the
# first digest instead of interleaved one relation at a time. They are pure
# pg_attribute reads whose answer is regex-validated before it can reach a
# digest, and a column that disappeared between the lookup and its COPY fails
# the COPY loudly. On the quiesced cluster every caller captures from, no DDL
# can run at all.
#
# The scratch workspace holds only generated SQL, the per-statement plan and the
# resulting digests — the COPY stream itself is piped and never lands on disk,
# so no wearer row body is written anywhere.
postgres_segment_batch() {
  local container="$1" database_user="$2" database="$3" timeouts="$4" \
    marker="$5" script="$6" plan="$7" results="$8"
  local -a command=(docker exec -i)
  [[ "$timeouts" != timeouts ]] \
    || command+=(-e 'PGOPTIONS=-c statement_timeout=120000 -c lock_timeout=5000')
  command+=("$container" psql -X -qAt -v ON_ERROR_STOP=1 -U "$database_user" -d "$database" -f -)
  "${command[@]}" <"$script" | split_postgres_segments "$marker" "$plan" >"$results" \
    || fail "batched PostgreSQL capture failed for database $database"
}

# Cut one psql stdout stream on its marker lines and reduce each segment to the
# value the caller asked for: `digest` for a COPY (sha256 of the exact bytes,
# identical to the old `docker exec … | sha256sum` per statement) and `text` for
# a scalar select. `3<&0` hands the piped stream to python on fd 3 so stdin can
# still contain the program, the way every other inline python here is written.
split_postgres_segments() {
  python3 - "$1" "$2" 3<&0 <<'PY'
import hashlib,os,sys
marker=(sys.argv[1]+"\n").encode()
with open(sys.argv[2],encoding="ascii") as source:
    plan=[line.strip() for line in source if line.strip()]
if not plan: raise SystemExit("psql batch plan is empty")
index=-1; digest=None; text=bytearray(); values=[]
def close_segment():
    if index<0: return
    values.append(text.decode("utf-8").strip() if plan[index]=="text" else digest.hexdigest())
for raw in os.fdopen(3,"rb"):
    if raw==marker:
        close_segment(); index+=1
        if index>=len(plan): raise SystemExit("psql batch produced more segments than its plan")
        digest=hashlib.sha256(); text=bytearray()
        continue
    if index<0: raise SystemExit("psql batch wrote output before its first segment marker")
    digest.update(raw)
    if plan[index]=="text": text+=raw
close_segment()
if index+1!=len(plan): raise SystemExit("psql batch segment count differs from its plan")
sys.stdout.write("".join(value+"\n" for value in values))
PY
}

# The recorded half of the column projection: the list this relation's digest was
# taken over when the BEFORE snapshot was taken, or empty when there is no
# sidecar or no entry for this relation. Kept per-relation because it is a local
# awk over a file and costs nothing; the LIVE half is what had to be batched.
relation_recorded_columns() {
  local key="$1" columns_source="$2" columns=""
  if [[ -n "$columns_source" && -f "$columns_source" ]]; then
    columns="$(awk -F'\t' -v want="$key" '$1 == want { print $2 }' "$columns_source")"
  fi
  printf '%s' "$columns"
}

# The column list a relation digest is taken over. With no recorded source this
# is simply "every column, in attnum order"; with one, it is the list that
# relation had when the BEFORE snapshot was taken, so an added column cannot
# change the digest and a removed one cannot hide inside it.
relation_column_projection() {
  local key="$1" recorded="$2" live="$3" columns
  columns="$recorded"
  [[ -n "$columns" ]] || columns="$live"
  [[ -n "$columns" ]] || fail "relation $key has no readable columns"
  [[ "$columns" =~ ^[A-Za-z0-9_\",]+$ ]] || fail "unsafe column list for relation $key"
  printf '%s' "$columns"
}

# `columns_source` (optional 4th argument) makes a comparison insensitive to an
# ADDITIVE schema change while staying strict about values. `to_jsonb(t)` encodes
# the schema as well as the data, so a migration adding a nullable column
# rewrites every row's JSON without moving a single byte of anyone's data — and
# this project's migration policy explicitly permits exactly that
# (`ADD COLUMN IF NOT EXISTS`, asserted additive and non-destructive by
# store_postgres.rs). Without this the two invariants contradict each other and
# no schema change is deployable. Pass the sidecar written by the BEFORE capture
# to project the AFTER capture onto the columns that existed then: a new column
# is invisible, a changed value or a vanished row is not, and a DROPPED column
# fails loudly because the projection no longer resolves.
capture_postgres_data() {
  local container="$1" database_user="$2" output="$3" columns_source="${4:-}"
  local database schema relation kind qualified count digest lo_count lo_digest relations columns
  local work marker index consumed
  local -a rel_schema rel_name rel_kind rel_columns pending values
  need python3
  work="$(mktemp -d)"
  # SELF-CLEARING, and that is not tidiness. A RETURN trap set inside a function
  # is NOT removed when that function returns: it stays installed and fires again
  # when the CALLER returns, evaluated in the caller's scope. Both this function
  # and its caller capture_resume_candidate_evidence have a local named `work`, so
  # the second firing expanded to the CALLER's directory and deleted it — the
  # resume's evidence directory, wiped between being written and being read, which
  # surfaced as "install: cannot create regular file ... No such file or directory"
  # and refused a deploy with public ingress already quiesced.
  #
  # `trap - RETURN` inside the body removes it after the first firing. Verified on
  # bash 5.2.21 (the host) and 5.3.15: without it the caller's directory is deleted,
  # with it neither the caller's nor the outer scope's is touched.
  trap 'rm -rf -- "${work:-}"; trap - RETURN' RETURN
  chmod 700 "$work"
  marker="#$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')#"
  [[ "$marker" =~ ^#[0-9a-f]{32}#$ ]] || fail "segment marker nonce is unavailable"
  : >"$output"
  : >"$output.columns"
  for database in "$LEGACY_DATABASE_NAME" keycloak; do
    relations="$(docker exec "$container" psql -X -qAt -F $'\t' -v ON_ERROR_STOP=1 \
      -U "$database_user" -d "$database" -c \
      "select n.nspname,c.relname,c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and c.relkind in ('r','p','m','S') order by n.nspname,c.relname,c.relkind")"
    [[ -n "$relations" ]] || fail "database relation catalog is empty"
    rel_schema=(); rel_name=(); rel_kind=(); rel_columns=(); pending=()
    : >"$work/columns.sql"
    : >"$work/columns.plan"
    while IFS=$'\t' read -r schema relation kind; do
      [[ "$schema" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && "$relation" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
        || fail "database contains an unsafe relation identifier"
      qualified="\"$schema\".\"$relation\""
      rel_schema+=("$schema"); rel_name+=("$relation"); rel_kind+=("$kind"); rel_columns+=("")
      case "$kind" in
        r|p)
          rel_columns[-1]="$(relation_recorded_columns "$database.$schema.$relation" "$columns_source")"
          # Only the relations the sidecar does not already answer for cost a
          # query, and they are all asked in one session below.
          if [[ -z "${rel_columns[-1]}" ]]; then
            pending+=("$(( ${#rel_kind[@]} - 1 ))")
            cat >>"$work/columns.sql" <<SQL
\echo $marker
select string_agg(quote_ident(attname), ',' order by attnum)
  from pg_attribute
 where attrelid = '$qualified'::regclass and attnum > 0 and not attisdropped;
SQL
            printf 'text\n' >>"$work/columns.plan"
          fi
          ;;
        m|S) ;;
        *) fail "unsupported durable relation kind in database manifest" ;;
      esac
    done <<<"$relations"
    if (( ${#pending[@]} > 0 )); then
      postgres_segment_batch "$container" "$database_user" "$database" plain \
        "$marker" "$work/columns.sql" "$work/columns.plan" "$work/columns.out"
      mapfile -t values <"$work/columns.out"
      (( ${#values[@]} == ${#pending[@]} )) || fail "database relation column batch is incomplete"
      for index in "${!pending[@]}"; do
        rel_columns[${pending[index]}]="${values[index]}"
      done
    fi
    : >"$work/data.sql"
    : >"$work/data.plan"
    for index in "${!rel_kind[@]}"; do
      schema="${rel_schema[index]}"; relation="${rel_name[index]}"; kind="${rel_kind[index]}"
      qualified="\"$schema\".\"$relation\""
      case "$kind" in
        r|p)
          columns="$(relation_column_projection "$database.$schema.$relation" \
            "${rel_columns[index]}" "")"
          printf '%s.%s.%s\t%s\n' "$database" "$schema" "$relation" "$columns" >>"$output.columns"
          cat >>"$work/data.sql" <<SQL
\echo $marker
select count(*) from only $qualified;
\echo $marker
copy (select to_jsonb(x)::text from (select $columns from only $qualified) x order by 1) to stdout;
SQL
          printf 'text\ndigest\n' >>"$work/data.plan"
          ;;
        m)
          cat >>"$work/data.sql" <<SQL
\echo $marker
select count(*) from $qualified;
\echo $marker
copy (select to_jsonb(t)::text from $qualified t order by to_jsonb(t)::text) to stdout;
SQL
          printf 'text\ndigest\n' >>"$work/data.plan"
          ;;
        S)
          # A sequence has exactly one row by construction, so its count was
          # never queried and still is not.
          cat >>"$work/data.sql" <<SQL
\echo $marker
copy (select jsonb_build_object('last_value',last_value,'is_called',is_called)::text from $qualified) to stdout;
SQL
          printf 'digest\n' >>"$work/data.plan"
          ;;
        *) fail "unsupported durable relation kind in database manifest" ;;
      esac
    done
    postgres_segment_batch "$container" "$database_user" "$database" timeouts \
      "$marker" "$work/data.sql" "$work/data.plan" "$work/data.out"
    mapfile -t values <"$work/data.out"
    consumed=0
    for index in "${!rel_kind[@]}"; do
      schema="${rel_schema[index]}"; relation="${rel_name[index]}"; kind="${rel_kind[index]}"
      case "$kind" in
        r|p|m) count="${values[consumed]:-}"; digest="${values[consumed + 1]:-}"; consumed=$((consumed + 2)) ;;
        S) count=1; digest="${values[consumed]:-}"; consumed=$((consumed + 1)) ;;
        *) fail "unsupported durable relation kind in database manifest" ;;
      esac
      [[ "$count" =~ ^[0-9]+$ && "$digest" =~ ^[0-9a-f]{64}$ ]] \
        || fail "database relation manifest failed"
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$database" "$schema" "$relation" "$kind" "$count" "$digest" >>"$output"
    done
    (( consumed == ${#values[@]} )) || fail "database relation manifest is incomplete"
    lo_count="$(docker exec "$container" psql -X -qAt -v ON_ERROR_STOP=1 \
      -U "$database_user" -d "$database" -c 'select count(*) from pg_largeobject_metadata' | tr -d '[:space:]')"
    lo_digest="$(docker exec -e 'PGOPTIONS=-c statement_timeout=120000 -c lock_timeout=5000' \
      "$container" psql -X -qAt -v ON_ERROR_STOP=1 -U "$database_user" -d "$database" \
      -c "copy (select loid::text || ':' || pageno::text || ':' || encode(data,'hex') from pg_largeobject order by loid,pageno) to stdout" \
      | sha256sum | awk '{print $1}')"
    [[ "$lo_count" =~ ^[0-9]+$ && "$lo_digest" =~ ^[0-9a-f]{64}$ ]] \
      || fail "large-object manifest failed"
    printf '%s\tpg_catalog\tpg_largeobject\tL\t%s\t%s\n' "$database" "$lo_count" "$lo_digest" >>"$output"
  done
  LC_ALL=C sort -o "$output" "$output"
  chmod 600 "$output" "$output.columns"
}

# Canonical security metadata for a complete logical PostgreSQL restore. Role
# password verifiers are one-way hashed again before they enter the inventory;
# the globals dump itself remains the protected source of truth.
#
# One producer on purpose, like capture_postgres_data above: backup.sh writes
# postgres-security.json and staging-smoke.sh compares its own captures against
# that file byte-for-byte, so a second body here is a second interpretation of
# the same format that only agrees until one of them is edited.
#
# `work_parent` (optional 4th argument) is where the scratch capture workspace
# is created. backup.sh omits it (system tmp); staging-smoke.sh passes its 0700
# projection workspace so a failure mid-capture is swept by the smoke's own
# cleanup trap. Either way the workdir is appended to `security_work_dirs`,
# the failure-cleanup ledger backup.sh's EXIT trap consumes — appending is
# harmless for callers that never read it.
capture_postgres_security() {
  local container="$1" database_user="$2" output="$3" work_parent="${4:-}" work database
  if [[ -n "$work_parent" ]]; then
    work="$(mktemp -d "$work_parent/pg-security.XXXXXX")"
  else
    work="$(mktemp -d)"
  fi
  security_work_dirs+=("$work")
  chmod 700 "$work"
  docker exec -i "$container" psql -X -qAt -v ON_ERROR_STOP=1 -U "$database_user" -d postgres \
    >"$work/roles.jsonl" <<'SQL'
select jsonb_build_object(
  'name',a.rolname,'superuser',a.rolsuper,'inherit',a.rolinherit,
  'create_role',a.rolcreaterole,'create_db',a.rolcreatedb,'can_login',a.rolcanlogin,
  'replication',a.rolreplication,'connection_limit',a.rolconnlimit,
  'bypass_rls',a.rolbypassrls,'valid_until',coalesce(a.rolvaliduntil::text,''),
  'config',coalesce(to_jsonb(s.setconfig),'[]'::jsonb),
  'password',coalesce(a.rolpassword,'')
)::text
from pg_authid a
left join pg_db_role_setting s on s.setrole = a.oid and s.setdatabase = 0
where a.rolname !~ '^pg_' and a.rolname <> 'revival_restore_bootstrap'
order by a.rolname;
SQL
  docker exec -i "$container" psql -X -qAt -v ON_ERROR_STOP=1 -U "$database_user" -d postgres \
    >"$work/memberships.jsonl" <<'SQL'
select jsonb_build_object(
  'role',pg_get_userbyid(roleid),'member',pg_get_userbyid(member),
  'grantor',pg_get_userbyid(grantor),'admin_option',admin_option,
  'inherit_option',inherit_option,'set_option',set_option
)::text
from pg_auth_members
where pg_get_userbyid(roleid) !~ '^pg_' or pg_get_userbyid(member) !~ '^pg_'
order by 1;
SQL
  docker exec -i "$container" psql -X -qAt -v ON_ERROR_STOP=1 -U "$database_user" -d postgres \
    -v "legacy_database=$LEGACY_DATABASE_NAME" \
    >"$work/globals.jsonl" <<'SQL'
select jsonb_build_object(
  'kind','database','name',datname,'owner',pg_get_userbyid(datdba),
  'encoding',pg_encoding_to_char(encoding),'collate',datcollate,'ctype',datctype,
  'allow_connections',datallowconn,'connection_limit',datconnlimit,
  'tablespace',coalesce(t.spcname,''),
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(d.datacl) x),'[]'::jsonb)
)::text
from pg_database d left join pg_tablespace t on t.oid=d.dattablespace
where datname in (:'legacy_database','keycloak') order by datname;
select jsonb_build_object(
  'kind','tablespace','name',spcname,'owner',pg_get_userbyid(spcowner),
  'options',coalesce(to_jsonb(spcoptions),'[]'::jsonb),
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(spcacl) x),'[]'::jsonb)
)::text
from pg_tablespace where spcname !~ '^pg_' order by spcname;
select jsonb_build_object(
  'kind','database_role_setting','database',coalesce(d.datname,''),
  'role',coalesce(r.rolname,''),'settings',coalesce(to_jsonb(s.setconfig),'[]'::jsonb)
)::text
from pg_db_role_setting s
left join pg_database d on d.oid=s.setdatabase
left join pg_roles r on r.oid=s.setrole
where d.datname in (:'legacy_database','keycloak') or s.setdatabase=0
order by 1;
SQL
  for database in "$LEGACY_DATABASE_NAME" keycloak; do
    docker exec -i "$container" psql -X -qAt -v ON_ERROR_STOP=1 -U "$database_user" -d "$database" \
      >"$work/$database.jsonl" <<'SQL'
select jsonb_build_object(
  'kind','schema','name',nspname,'owner',pg_get_userbyid(nspowner),
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(nspacl) x),'[]'::jsonb)
)::text
from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by nspname;
select jsonb_build_object(
  'kind','relation','schema',n.nspname,'name',c.relname,'relation_kind',c.relkind,
  'persistence',c.relpersistence,'owner',pg_get_userbyid(c.relowner),
  'row_security',c.relrowsecurity,'force_row_security',c.relforcerowsecurity,
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(c.relacl) x),'[]'::jsonb)
)::text
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
  and c.relkind in ('r','p','v','m','S','f')
order by n.nspname,c.relname,c.relkind;
select jsonb_build_object(
  'kind','column_acl','schema',n.nspname,'relation',c.relname,'column',a.attname,
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(a.attacl) x),'[]'::jsonb)
)::text
from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
  and a.attnum>0 and not a.attisdropped and a.attacl is not null
order by n.nspname,c.relname,a.attnum;
select jsonb_build_object(
  'kind','routine','schema',n.nspname,'name',p.proname,
  'identity_arguments',pg_get_function_identity_arguments(p.oid),
  'routine_kind',p.prokind,'owner',pg_get_userbyid(p.proowner),
  'security_definer',p.prosecdef,
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(p.proacl) x),'[]'::jsonb)
)::text
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid);
select jsonb_build_object(
  'kind','type','schema',n.nspname,'name',t.typname,'type_kind',t.typtype,
  'owner',pg_get_userbyid(t.typowner),
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(t.typacl) x),'[]'::jsonb)
)::text
from pg_type t join pg_namespace n on n.oid=t.typnamespace
where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
  and t.typisdefined and t.typname !~ '^_'
order by n.nspname,t.typname;
select jsonb_build_object(
  'kind','default_acl','role',pg_get_userbyid(d.defaclrole),
  'schema',coalesce(n.nspname,''),'object_type',d.defaclobjtype,
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(d.defaclacl) x),'[]'::jsonb)
)::text
from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
order by 1;
select jsonb_build_object(
  'kind','policy','schema',n.nspname,'relation',c.relname,'name',p.polname,
  'permissive',p.polpermissive,'command',p.polcmd,
  'roles',coalesce((select jsonb_agg(pg_get_userbyid(x) order by pg_get_userbyid(x)) from unnest(p.polroles) x),'[]'::jsonb),
  'using',coalesce(pg_get_expr(p.polqual,p.polrelid),''),
  'check',coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')
)::text
from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
order by n.nspname,c.relname,p.polname;
select jsonb_build_object(
  'kind','extension','name',e.extname,'owner',pg_get_userbyid(e.extowner),
  'schema',n.nspname,'version',e.extversion
)::text
from pg_extension e join pg_namespace n on n.oid=e.extnamespace
where e.extname <> 'plpgsql'
order by e.extname;
select jsonb_build_object(
  'kind','large_object','oid',m.oid,'owner',pg_get_userbyid(m.lomowner),
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(m.lomacl) x),'[]'::jsonb)
)::text
from pg_largeobject_metadata m order by m.oid;
SQL
  done
  python3 - "$work" "$output" "$LEGACY_DATABASE_NAME" <<'PY'
import hashlib,json,os,sys
work,output,legacy_database=sys.argv[1:]
def read(name):
    path=os.path.join(work,name)
    return [json.loads(line) for line in open(path,encoding="utf-8") if line.strip()]
roles=read("roles.jsonl")
for role in roles:
    password=role.pop("password","")
    role["password_sha256"]=hashlib.sha256(password.encode()).hexdigest() if password else None
document={
    "roles":roles,
    "memberships":read("memberships.jsonl"),
    "globals":read("globals.jsonl"),
    "databases":{legacy_database:read(legacy_database+".jsonl"),"keycloak":read("keycloak.jsonl")},
}
with open(output,"w",encoding="utf-8") as target:
    json.dump(document,target,sort_keys=True,separators=(",",":"))
PY
  chmod 600 "$output"
  rm -rf -- "$work"
}

# pg_dump's schema-only stream covers definitions that row/catalog summaries do
# not: columns/defaults/generated identities, constraints, indexes, triggers,
# views, and routine bodies. Normalize only pg_dump's random psql restriction
# token; retain owners, ACLs, comments, and all other emitted semantics.
#
# Also one producer on purpose: staging-smoke.sh compares backup.sh's
# postgres-schema.tsv against its own captures line-for-line, and the two
# previously separate bodies had already diverged while still emitting a
# matching line — the format agreement was luck, not structure.
#
# `retain-sql` (optional 4th argument, exactly that literal): additionally keep
# the canonical pg_dump text beside each digest line, as
# "$output.<database>.sql". The digest is unchanged and is still the whole of
# the equality check; the retained text exists only so that a FAILED equality
# check can be classified (classify_schema_delta below) and reported as something
# other than "two hashes differ". The classifier re-hashes what it reads and
# refuses unless it reproduces the digest recorded here, so retaining the text
# cannot become a way to have the gate judge bytes it did not hash.
#
# The BACKUP producer retains too, and must. deploy.sh compares the pre-candidate
# backup's schema manifest against the post-candidate one, and the pre-candidate
# dump cannot be re-taken once the candidate has migrated — so if it is not kept
# at capture time there is nothing to classify a legitimate additive delta
# against, and the gate can only refuse. The two sidecars are enumerated as
# OPTIONAL artifacts (backup_optional_artifacts) so a backup taken before they
# existed still verifies; classification against such a backup refuses, which is
# the safe direction.
capture_postgres_schema() {
  local container="$1" database_user="$2" output="$3" retain_sql="${4:-}" database record canonical_path
  [[ -z "$retain_sql" || "$retain_sql" == retain-sql ]] \
    || fail "unknown capture_postgres_schema retention mode: $retain_sql"
  : >"$output"
  for database in "$LEGACY_DATABASE_NAME" keycloak; do
    canonical_path=""
    [[ "$retain_sql" != retain-sql ]] || canonical_path="$output.$database.sql"
    record="$(docker exec -e 'PGOPTIONS=-c statement_timeout=120000 -c lock_timeout=5000' \
      "$container" pg_dump --schema-only --quote-all-identifiers \
      -U "$database_user" -d "$database" | python3 -c '
import hashlib,os,sys
database,canonical_path=sys.argv[1:3]; limit=32*1024*1024
body=sys.stdin.buffer.read(limit+1)
if len(body)>limit: raise SystemExit("pg_dump schema stream exceeds limit")
lines=body.splitlines(keepends=True)
restrict=next((index for index,line in enumerate(lines) if line.startswith(b"\\restrict ")),None)
if restrict is not None:
    parts=lines[restrict].rstrip(b"\r\n").split(maxsplit=1)
    if len(parts)!=2 or not parts[1]: raise SystemExit("invalid pg_dump restriction token")
    token=parts[1]
    unrestrict=next((index for index in range(len(lines)-1,restrict,-1)
        if lines[index].rstrip(b"\r\n")==b"\\unrestrict "+token),None)
    if unrestrict is None: raise SystemExit("mismatched pg_dump restriction token")
    lines[restrict]=b"\\restrict <normalized>\n"; lines[unrestrict]=b"\\unrestrict <normalized>\n"
canonical=b"".join(lines)
if len(canonical)<64 or len(lines)<3: raise SystemExit("incomplete pg_dump schema stream")
if canonical_path:
    with os.fdopen(os.open(canonical_path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600),"wb") as retained:
        retained.write(canonical)
print(f"{database}\t{len(canonical)}\t{len(lines)}\t{hashlib.sha256(canonical).hexdigest()}")
' "$database" "$canonical_path")"
    [[ "$record" =~ ^$database$'\t'[0-9]+$'\t'[0-9]+$'\t'[0-9a-f]{64}$ ]] \
      || fail "database schema manifest failed"
    printf '%s\n' "$record" >>"$output"
    [[ -z "$canonical_path" ]] || chmod 600 "$canonical_path"
  done
  LC_ALL=C sort -o "$output" "$output"
  chmod 600 "$output"
}

# THE ADDITIVE-SCHEMA ALLOWANCE, shared by every gate that compares a schema
# manifest captured BEFORE a candidate started against one captured AFTER.
#
# It lives here rather than beside any one of them because it has three consumers:
# staging-smoke.sh's candidate-mutation gate, deploy.sh's pre-commit comparison of
# the pre- and post-candidate backups, and rollback.sh's legacy-eligibility check.
# All three go through compare_schema_manifests below. Copying it instead of
# hoisting it is the defect that cost four deploy cycles the last time.
#
# A gate compares two sha256 digests over pg_dump --schema-only, so it can prove
# the schema moved and cannot say how. A pending additive migration — today
# cosmos/migrations/0004_listing.sql, `ADD COLUMN IF NOT EXISTS
# carry_memory.thumbnail_count` plus three `CREATE INDEX IF NOT EXISTS` — moves it
# legitimately, and thirteen deploys have stopped there.
#
# This is NOT a loosened comparison. The digest equality check stays exactly where
# it was; it is still the only thing that decides whether anything changed. This
# classifier runs only after that check has already failed, and its job is to
# PROVE a specific delta is non-destructive or refuse it by name. Its default
# answer is refusal: every statement is compared for exact equality, and only a
# short, explicit list of arrivals is permitted.
#
#   PERMITTED  a column appended to an existing table, leaving every pre-existing
#              column's definition byte-identical and in place; an entirely new
#              table (and the OWNER/CONSTRAINT/DEFAULT/SEQUENCE decoration
#              pg_dump emits for THAT table); a new non-UNIQUE index.
#   REFUSED    everything else, by name — a dropped or renamed table or column, a
#              retyped column, a changed nullability or default, a reordered
#              column list, a dropped or redefined index or constraint, changed
#              ownership or grants, any function, trigger, view or type change,
#              a UNIQUE index over rows that already exist, a change to the
#              CREATE TABLE heading or table options of a table that already
#              existed (UNLOGGED, PARTITION BY, storage options), and ANY delta
#              at all in the keycloak database.
#
# THE SUBTLETY THAT MAKES A NAIVE LINE DIFF WRONG: pg_dump prints CREATE TABLE
# with the full column list, so adding a column does not appear as an "ADD COLUMN"
# line — it REWRITES the whole CREATE TABLE block, which a line diff reads as one
# line removed and one line added. So this reasons about the COLUMN SET and not
# the text: the BEFORE column list must be an exact, byte-identical PREFIX of the
# AFTER column list. `ALTER TABLE ... ADD COLUMN` always appends in attnum order,
# so a genuine addition satisfies that; a drop, a rename, a retype, or a reorder
# breaks the prefix at a named position and is refused there.
#
# The corollary, which is easy to miss: a CREATE TABLE block is more than its
# column list. Its HEADING and its trailing TABLE OPTIONS are compared verbatim
# too, and a rewritten block that yields no attributable difference at all is
# refused rather than passed over. Otherwise a table quietly converted to
# UNLOGGED — losing every existing row on the next crash — would produce no note
# of its own and ride along under the legitimate `+column` note beside it.
#
# It cannot be fooled by handing it different text than the gate compared: it
# re-hashes the retained pg_dump bytes and refuses unless they reproduce the exact
# digest, byte count, and line count in the manifest the gate used. And if the
# digests differ while no statement-level delta explains it — a comment-only or
# whitespace-only difference — that is refused too, rather than waved through as
# "nothing found".
classify_schema_delta() {
  local before="$1" after="$2"
  [[ -f "$before" && ! -L "$before" && -f "$after" && ! -L "$after" ]] \
    || fail "schema delta classifier needs both schema manifests"
  python3 - "$before" "$after" "$LEGACY_DATABASE_NAME" <<'PY'
import collections,hashlib,os,re,sys
before_manifest,after_manifest,legacy_database=sys.argv[1:4]
class Refusal(Exception): pass
def refuse(message): raise Refusal(message)
QUOTED=r'"(?:[^"]|"")*"'
NAME=r'(?:'+QUOTED+r'|[A-Za-z_][A-Za-z0-9_$]*)'
QUALIFIED=NAME+r'(?:\.'+NAME+r')*'
DOLLAR=re.compile(r'\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$')
CREATE_TABLE=re.compile(r'^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?('+QUALIFIED+r')\s*$',re.I)
CREATE_INDEX=re.compile(r'^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?('+QUALIFIED+r')\s+ON\s+('+QUALIFIED+r')(?=[\s(])',re.I)
TABLE_OWNER=re.compile(r'^ALTER\s+TABLE\s+(?:ONLY\s+)?('+QUALIFIED+r')\s+OWNER\s+TO\s',re.I)
TABLE_CONSTRAINT=re.compile(r'^ALTER\s+TABLE\s+(?:ONLY\s+)?('+QUALIFIED+r')\s+ADD\s+CONSTRAINT\s+('+QUALIFIED+r')(?=[\s(])',re.I)
TABLE_DEFAULT=re.compile(r'^ALTER\s+TABLE\s+(?:ONLY\s+)?('+QUALIFIED+r')\s+ALTER\s+COLUMN\s+('+QUALIFIED+r')\s+SET\s+DEFAULT\s',re.I)
CREATE_SEQUENCE=re.compile(r'^CREATE\s+(?:UNLOGGED\s+)?SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?('+QUALIFIED+r')(?=[\s(]|$)',re.I)
SEQUENCE_OWNED=re.compile(r'^ALTER\s+SEQUENCE\s+('+QUALIFIED+r')\s+OWNED\s+BY\s+('+QUALIFIED+r')\.('+NAME+r')\s*$',re.I)
SEQUENCE_OWNER=re.compile(r'^ALTER\s+SEQUENCE\s+('+QUALIFIED+r')\s+OWNER\s+TO\s',re.I)

def chunks(text):
    """Yield (is_literal, chunk) over SQL: comments dropped, quoted spans opaque."""
    index=0; start=0; size=len(text)
    while index<size:
        char=text[index]
        if char=="-" and text.startswith("--",index):
            if start<index: yield (False,text[start:index])
            stop=text.find("\n",index); index=size if stop<0 else stop+1; start=index; continue
        if char=="'" or char=='"':
            if start<index: yield (False,text[start:index])
            cursor=index+1
            while True:
                stop=text.find(char,cursor)
                if stop<0: refuse("pg_dump output has an unterminated quoted span")
                if text.startswith(char*2,stop): cursor=stop+2; continue
                break
            yield (True,text[index:stop+1]); index=stop+1; start=index; continue
        if char=="$":
            match=DOLLAR.match(text,index)
            if match:
                if start<index: yield (False,text[start:index])
                tag=match.group(0); stop=text.find(tag,match.end())
                if stop<0: refuse("pg_dump output has an unterminated dollar-quoted body")
                yield (True,text[index:stop+len(tag)]); index=stop+len(tag); start=index; continue
        index+=1
    if start<size: yield (False,text[start:size])

def masked(text):
    """(flat text, literal mask) so scanning can ignore delimiters inside literals."""
    body=[]; mask=[]
    for literal,chunk in chunks(text):
        body.append(chunk); mask.extend([literal]*len(chunk))
    return "".join(body),mask

def normalize(statement):
    return "".join(chunk if literal else re.sub(r"\s+"," ",chunk)
                   for literal,chunk in chunks(statement)).strip()

def parse(text):
    """(psql meta lines, normalized statements) for one pg_dump --schema-only stream."""
    meta=[line for line in text.splitlines() if line.startswith("\\")]
    body="\n".join(line for line in text.splitlines() if not line.startswith("\\"))
    out=[]; current=[]
    for literal,chunk in chunks(body):
        if literal: current.append(chunk); continue
        while True:
            stop=chunk.find(";")
            if stop<0: current.append(chunk); break
            current.append(chunk[:stop]); out.append("".join(current)); current=[]; chunk=chunk[stop+1:]
    if "".join(current).strip(): refuse("pg_dump output ends with an unterminated statement")
    return meta,[statement for statement in (normalize(item) for item in out) if statement]

def entries(text,mask):
    """Top-level comma-separated entries of a parenthesised body."""
    out=[]; start=0; depth=0
    for index,char in enumerate(text):
        if mask[index]: continue
        if char=="(": depth+=1
        elif char==")": depth-=1
        elif char=="," and depth==0: out.append(text[start:index]); start=index+1
    out.append(text[start:])
    return [item.strip() for item in out if item.strip()]

class Table:
    def __init__(self,name,heading,columns,others,trailing,statement):
        self.name=name; self.heading=heading; self.columns=columns; self.others=others
        self.trailing=trailing; self.statement=statement

def parse_table(statement):
    """A CREATE TABLE as (name, ordered columns, other entries, trailing options).

    None for anything this does not model exactly -- a partition, a typed table, a
    CREATE TABLE ... AS. Those fall through to the exact-equality path, where any
    change to them is refused."""
    text,mask=masked(statement)
    open_index=next((index for index,char in enumerate(text) if char=="(" and not mask[index]),None)
    if open_index is None: return None
    header=CREATE_TABLE.match(text[:open_index])
    if not header: return None
    depth=0; close_index=None
    for index in range(open_index,len(text)):
        if mask[index]: continue
        if text[index]=="(": depth+=1
        elif text[index]==")":
            depth-=1
            if depth==0: close_index=index; break
    if close_index is None: refuse("CREATE TABLE body is unbalanced: "+describe(statement))
    body=text[open_index+1:close_index]; body_mask=mask[open_index+1:close_index]
    columns=[]; others=[]
    for entry in entries(body,body_mask):
        # --quote-all-identifiers means every real column starts with its quoted
        # name; an entry that does not is a table constraint (CONSTRAINT/PRIMARY
        # KEY/CHECK/...), which is compared as an unordered set below.
        if entry.startswith('"'): columns.append((re.match(QUOTED,entry).group(0),entry))
        else: others.append(entry)
    # The heading is retained verbatim, not just the name the regex captured out of
    # it. CREATE TABLE and CREATE UNLOGGED TABLE name the same table, so comparing
    # only names would let `ALTER TABLE ... SET UNLOGGED` -- which throws away every
    # existing row on the next crash -- ride along inside a delta whose columns are
    # genuinely additive.
    return Table(header.group(1),text[:open_index].strip(),columns,tuple(sorted(others)),
                 text[close_index+1:].strip(),statement)

def readable(name):
    return ".".join(part[1:-1].replace('""','"') if part.startswith('"') else part
                    for part in re.findall(NAME,name))

def describe(statement,limit=180):
    text=re.sub(r"\s+"," ",statement).strip()
    return text if len(text)<=limit else text[:limit]+" ..."

def kind(statement):
    """The leading keyword phrase only -- never an identifier, which keeps its case."""
    words=[]
    for word in re.sub(r"\s+"," ",statement).strip().split(" ")[:4]:
        if not word.isalpha(): break
        words.append(word.upper())
    return " ".join(words) or "statement"

def identity(statement):
    """An already-readable key for the object a statement defines, so a statement
    leaving BEFORE and one arriving in AFTER for the same object read as one
    redefinition instead of as two unrelated events."""
    match=CREATE_INDEX.match(statement)
    if match: return f"index {readable(match.group(1))}"
    match=TABLE_OWNER.match(statement)
    if match: return f"ownership of table {readable(match.group(1))}"
    match=TABLE_CONSTRAINT.match(statement)
    if match: return f"constraint {readable(match.group(2))} on table {readable(match.group(1))}"
    match=TABLE_DEFAULT.match(statement)
    if match: return f"default of column {readable(match.group(1))}.{readable(match.group(2))}"
    match=CREATE_SEQUENCE.match(statement)
    if match: return f"sequence {readable(match.group(1))}"
    match=SEQUENCE_OWNED.match(statement)
    if match: return f"owning column of sequence {readable(match.group(1))}"
    match=SEQUENCE_OWNER.match(statement)
    if match: return f"ownership of sequence {readable(match.group(1))}"
    return None

def read_manifest(path):
    rows={}
    for number,raw in enumerate(open(path,encoding="utf-8"),1):
        line=raw.rstrip("\n")
        if not line: continue
        parts=line.split("\t")
        if len(parts)!=4: refuse(f"{path}: malformed schema manifest row at line {number}")
        database,size,lines,digest=parts
        if database in rows: refuse(f"{path}: duplicate schema manifest row for {database}")
        if not re.fullmatch(r"[0-9a-f]{64}",digest) or not size.isdigit() or not lines.isdigit():
            refuse(f"{path}: malformed schema manifest row at line {number}")
        rows[database]=(int(size),int(lines),digest)
    if not rows: refuse(f"{path}: schema manifest is empty")
    return rows

def read_dump(manifest_path,database,record):
    """The retained pg_dump text, proved to be the exact bytes the gate hashed."""
    size,lines,digest=record
    path=f"{manifest_path}.{database}.sql"
    if not os.path.isfile(path) or os.path.islink(path):
        refuse(f"{database}: retained pg_dump text is missing beside the manifest ({path})")
    body=open(path,"rb").read()
    if len(body)!=size or hashlib.sha256(body).hexdigest()!=digest:
        refuse(f"{database}: retained pg_dump text does not reproduce the digest the gate "
               f"compared ({path}); refusing to classify text the gate did not hash")
    if len(body.splitlines(keepends=True))!=lines:
        refuse(f"{database}: retained pg_dump text line count does not match the manifest ({path})")
    try: return body.decode("utf-8")
    except UnicodeDecodeError: refuse(f"{database}: retained pg_dump text is not valid UTF-8 ({path})")

def compare_table(database,before,after):
    """Notes for a provably additive table delta; refuses, by name, otherwise."""
    name=readable(before.name)
    if before.heading!=after.heading:
        refuse(f"{database}: table {name} changed its CREATE TABLE heading, which is a property of "
               f"the table itself and not of its columns (UNLOGGED, for one, discards every row "
               f"that already exists on the next crash): before <{before.heading}> after "
               f"<{after.heading}>")
    if before.trailing!=after.trailing:
        refuse(f"{database}: table {name} changed its table-level options: "
               f"before <{before.trailing}> after <{after.trailing}>")
    if before.others!=after.others:
        gone=[item for item in before.others if item not in after.others]
        arrived=[item for item in after.others if item not in before.others]
        if gone: refuse(f"{database}: table {name} lost an inline table constraint: {describe(gone[0])}")
        refuse(f"{database}: table {name} gained an inline table constraint, which can reject or "
               f"reinterpret rows that already exist: {describe(arrived[0])}")
    before_names=[column for column,_ in before.columns]
    after_names=[column for column,_ in after.columns]
    if len(after.columns)<len(before.columns):
        lost=[readable(column) for column in before_names if column not in after_names]
        refuse(f"{database}: table {name} lost column(s) "
               f"{', '.join(lost) or '(the column list was reordered)'}: a column may not disappear")
    for index,(before_column,after_column) in enumerate(zip(before.columns,after.columns)):
        if before_column==after_column: continue
        if before_column[0]!=after_column[0]:
            if before_column[0] not in after_names:
                refuse(f"{database}: table {name} column {readable(before_column[0])} was dropped or "
                       f"renamed; position {index+1} now holds {readable(after_column[0])}")
            refuse(f"{database}: table {name} reordered its pre-existing columns; position "
                   f"{index+1} held {readable(before_column[0])} and now holds "
                   f"{readable(after_column[0])}")
        refuse(f"{database}: table {name} changed the definition of pre-existing column "
               f"{readable(before_column[0])}: before <{before_column[1]}> after <{after_column[1]}>")
    added=after.columns[len(before.columns):]
    for column,definition in added:
        if column in before_names:
            refuse(f"{database}: table {name} lists column {readable(column)} twice after the delta")
    return [f"+column {name}.{readable(column)}" for column,_ in added]

def classify(database,before_text,after_text):
    before_meta,before_statements=parse(before_text)
    after_meta,after_statements=parse(after_text)
    if before_meta!=after_meta:
        refuse(f"{database}: the psql meta-commands around the dump changed")
    before_tables={}; after_tables={}
    before_other=collections.Counter(); after_other=collections.Counter()
    for statements,tables,other in ((before_statements,before_tables,before_other),
                                    (after_statements,after_tables,after_other)):
        for statement in statements:
            table=parse_table(statement)
            if table is None: other[statement]+=1; continue
            if table.name in tables: refuse(f"{database}: table {readable(table.name)} is created twice")
            tables[table.name]=table
    # Every object name the BEFORE schema already knew. "New" below means "absent
    # from this set", so an object that is merely being redefined can never be
    # mistaken for one this delta created.
    before_objects=set(before_tables)
    for statement in before_other:
        for pattern in (CREATE_INDEX,CREATE_SEQUENCE):
            match=pattern.match(statement)
            if match: before_objects.add(match.group(1))
    removed=before_other-after_other
    added=after_other-before_other
    arrivals={}
    for statement in added.elements():
        key=identity(statement)
        if key is not None: arrivals.setdefault(key,statement)

    # 1. Departures first, and tables before the statements that decorate them, so
    #    a dropped table is reported as a dropped table and not as its own vanished
    #    OWNER TO line.
    for name in sorted(before_tables):
        if name not in after_tables:
            refuse(f"{database}: table {readable(name)} was dropped or renamed")
    for statement in sorted(removed.elements()):
        key=identity(statement)
        if key is not None and key in arrivals:
            refuse(f"{database}: {key} was redefined: before <{describe(statement)}> "
                   f"after <{describe(arrivals[key])}>")
        refuse(f"{database}: {kind(statement)} disappeared from the schema"
               + (f" ({key})" if key else "") + f": {describe(statement)}")

    # 2. Tables. A new table is additive; a table both dumps have is additive only
    #    if every column it already had survives byte-identically, in place.
    notes=[]; new_tables=set()
    for name in sorted(after_tables):
        if name not in before_tables:
            new_tables.add(name); notes.append(f"+table {readable(name)}")
    for name in sorted(before_tables):
        if after_tables[name].statement!=before_tables[name].statement:
            found=compare_table(database,before_tables[name],after_tables[name])
            # A rewritten CREATE TABLE that compare_table can neither refuse nor
            # attribute to an appended column is a part of the statement this
            # classifier does not model. Silence there would let it ride along
            # under some OTHER table's legitimate note, so it refuses instead.
            if not found:
                refuse(f"{database}: the CREATE TABLE for {readable(name)} was rewritten, but no "
                       "column, inline constraint, table option or heading difference explains it; "
                       "refusing a table redefinition this classifier cannot attribute")
            notes.extend(found)

    # 3. Arrivals. Only a new non-UNIQUE index, or the decoration pg_dump emits for
    #    a table THIS delta created, may arrive.
    for statement in sorted(added.elements()):
        match=CREATE_INDEX.match(statement)
        if match:
            index,target=match.group(1),match.group(2)
            if index in before_objects:
                refuse(f"{database}: index {readable(index)} is created twice after the delta")
            if target not in after_tables:
                refuse(f"{database}: index {readable(index)} targets {readable(target)}, "
                       "which is not a table this dump creates")
            if re.match(r"^CREATE\s+UNIQUE\s",statement,re.I) and target not in new_tables:
                refuse(f"{database}: index {readable(index)} adds a UNIQUE constraint to "
                       f"pre-existing table {readable(target)}; a uniqueness rule over rows that "
                       "already exist is a constraint change, not an additive index")
            notes.append(f"+index {readable(index)} on {readable(target)}")
            continue
        for pattern,label in ((TABLE_OWNER,"ownership"),(TABLE_CONSTRAINT,"constraint"),
                              (TABLE_DEFAULT,"column default")):
            match=pattern.match(statement)
            if match and match.group(1) in new_tables:
                notes.append(f"+{label} on new table {readable(match.group(1))}"); break
        else:
            match=CREATE_SEQUENCE.match(statement) or SEQUENCE_OWNER.match(statement)
            if match and match.group(1) not in before_objects:
                notes.append(f"+sequence {readable(match.group(1))}"); continue
            match=SEQUENCE_OWNED.match(statement)
            if match and match.group(1) not in before_objects and match.group(2) in new_tables:
                notes.append(f"+sequence {readable(match.group(1))} owned by new table "
                             f"{readable(match.group(2))}"); continue
            key=identity(statement)
            refuse(f"{database}: {kind(statement)} is not a provably additive change"
                   + (f" ({key})" if key else "") + f": {describe(statement)}")
    return notes

try:
    before_rows=read_manifest(before_manifest); after_rows=read_manifest(after_manifest)
    if set(before_rows)!=set(after_rows):
        refuse(f"the set of databases changed: before {sorted(before_rows)} after {sorted(after_rows)}")
    accepted=[]
    for database in sorted(before_rows):
        if before_rows[database][2]==after_rows[database][2]: continue
        notes=classify(database,
                       read_dump(before_manifest,database,before_rows[database]),
                       read_dump(after_manifest,database,after_rows[database]))
        if database!=legacy_database:
            refuse(f"{database}: only the deployed legacy database may contain a pending migration; the "
                   f"{database} schema must not change at all, additively or otherwise"
                   + (f"; observed {'; '.join(notes)}" if notes else
                      "; the change is not even a classifiable statement delta"))
        if not notes:
            refuse(f"{database}: the schema text changed but no statement-level delta explains it "
                   "(a comment-only or whitespace-only difference); refusing an unexplained change")
        accepted.append(f"{database}: "+"; ".join(notes))
    if not accepted:
        refuse("the schema manifests differ in a field no digest explains (byte or line count); "
               "refusing a manifest that disagrees with itself")
    print("additive schema delta accepted -- "+" | ".join(accepted))
except Refusal as refusal:
    raise SystemExit("schema delta refused: "+str(refusal))
PY
}

# The one call every pre-vs-post schema gate makes. Byte equality still decides
# whether anything changed at all; the classifier runs ONLY after that has already
# failed and must then PROVE the delta non-destructive or refuse it by name. It is
# an addition to the equality check, never a replacement for it.
compare_schema_manifests() {
  local before="$1" after="$2" context="$3" allowance
  if cmp -s "$before" "$after"; then return 0; fi
  allowance="$(classify_schema_delta "$before" "$after")" \
    || fail "$context: the schema delta is NOT provably additive; the classifier's refusal above names the object it refused and why"
  log "$context: $allowance"
}

# A relation-column sidecar is the "$output.columns" file capture_postgres_data
# writes beside every data manifest: one row per relation, `db.schema.relation`
# TAB the exact comma-separated quoted column list that relation's digest was
# taken over. Validate it before a LATER capture is projected onto it, so a
# truncated, duplicated or hand-edited file fails loudly here instead of silently
# narrowing what a digest covers.
validate_relation_column_sidecar() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" && -s "$path" ]] \
    || fail "relation column sidecar is missing or unsafe: $path"
  python3 - "$path" <<'PY'
import re,sys
path=sys.argv[1]
seen=set()
for number,raw in enumerate(open(path,encoding="utf-8"),1):
    line=raw.rstrip("\n")
    if not line: continue
    parts=line.split("\t")
    if len(parts)!=2: raise SystemExit(f"{path}: malformed relation column row at line {number}")
    key,columns=parts
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){2}",key):
        raise SystemExit(f"{path}: unsafe relation key at line {number}")
    if key in seen: raise SystemExit(f"{path}: duplicate relation key {key}")
    seen.add(key)
    if not re.fullmatch(r'[A-Za-z0-9_",]+',columns):
        raise SystemExit(f"{path}: unsafe column list for {key}")
if not seen: raise SystemExit(f"{path}: relation column sidecar is empty")
PY
}

verify_keycloak_post_migration_evidence() {
  local record="$1"
  python3 - "$record/keycloak-post-migration-data.tsv" "$record/keycloak-post-migration-data.sha256" <<'PY'
import hashlib
import os
import re
import stat
import sys

data_path, digest_path = sys.argv[1:]
for path in (data_path, digest_path):
    metadata = os.lstat(path)
    assert stat.S_ISREG(metadata.st_mode), f"not a regular migration-evidence file: {path}"

with open(digest_path, encoding="ascii") as source:
    line = source.read()
match = re.fullmatch(
    r"([0-9a-f]{64})[ \t]+\*?(?:.*/)?keycloak-post-migration-data\.tsv\n?",
    line,
)
assert match, "invalid Keycloak post-migration digest record"

actual = hashlib.sha256()
with open(data_path, "rb") as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        actual.update(chunk)
assert actual.hexdigest() == match.group(1), "Keycloak post-migration evidence digest drift"
PY
}
