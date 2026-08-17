# Operations

The `revival` command is the supported entry point. It keeps local runtime,
release work, production operations, and physical-device work at separate
safety boundaries.

## Local stack

```sh
./revival init
./revival doctor
./revival build
./revival up
./revival status
```

Center opens at <http://127.0.0.1:4000>. Use `./revival logs` to inspect the
stack and `./revival down` to stop it without deleting volumes.

`init` creates protected external directories and a runtime file from
`.env.example`. Add provider credentials only to that protected runtime file.
Do not place them in source, Compose, command arguments, or documentation.

## Validation and releases

```sh
./revival test
./revival test --source
./revival release build --profile vps
```

- `implemented`: `test` checks source policy, packaging, Center, Cosmos, and the
  private Spotify adapter.
- `implemented`: `test --source` adds Pin toolchain and QA tests, Rust metadata,
  and the Gradle project graph. The browser installer is part of Center, so
  plain `test` covers it.
- `unknown`: neither gate proves that a signed bundle installs or works on a
  physical Pin.

Release archives are allowlisted, content-addressed, and verified after
extraction. Runtime state and secrets are not release contents.

## Production

Production commands target an existing reviewed installation; they are not a
clean-server bootstrap workflow.

```sh
./revival doctor production
./revival deploy production --dry-run
./revival backup
./revival backup --fetch          # the only copy that is not on the server
./revival canary
./revival drift
./revival adopt-config            # plans only; changes nothing without --confirm
```

`implemented`: the command surface verifies target identity, preserves explicit
state mappings, and packages one Center/Cosmos release.

`./revival backup` writes to the server. Every backup this project has ever
taken therefore lives on the same disk as the thing it protects, and two of the
things it protects — the attestation and DeviceUser CA private keys — cannot be
regenerated once that disk is gone, because the attestation root is pinned
inside the APKs already installed on the Pin. `--fetch` is the other direction:
it takes the same verified backup, pulls it to this machine, re-verifies it
here, proves the four key files are really inside `protected.tar.gz`, and adds
the half that exists only here — the Pin signing keystores, which appear in no
server backup at all. It is the difference between a recoverable loss and an
unrecoverable one, and it is the one production command with no schedule behind
it. Run it after any deploy that changed PKI, and otherwise on a rhythm you
choose: `./revival drift` fails when the newest *server-side* backup is older
than 36 hours (`platform/deploy/vps/remote/drift.sh:115`) and says nothing at
all about whether an off-host copy exists.

`--fetch` quiesces the host exactly as a plain `./revival backup` does, so it
stops the wearer's Pin bridge and every application writer for minutes. Its
destination is therefore checked twice — once before the host is touched at all,
and again at the copy — and it must be an absolute path, outside the source tree
(private keys must never land where the next release package would carry them),
and free of an existing bundle for that id
(`platform/deploy/vps/backup.sh:39-48`, `:280-295`). An unusable `--fetch-dir`
costs nothing rather than wasting the whole quiesced window. What the bundle
contains, and how to rebuild a server from one:
[docs/recovery.md](recovery.md#making-an-off-host-copy).

`unknown`: production cutover safety until the deployment transaction and its
rollback/acceptance fixtures pass final review. A dry run, backup, health check,
or HTTP 200 does not authorize `./revival deploy production`.

Rollback moves the release pointer back. It never touches a database:

```sh
./revival rollback --deployment <deployment-id>
```

**There is no database-restore command, and rollback has no flag that adds
one.** `rollback.sh` takes a fresh verified backup, returns the app to the
previous release, and prints `databases were not restored` on success — writes
made after the cutover are still there afterwards. Earlier revisions of this
page advertised `--confirm-database-restore`; no script has ever parsed it, so
the documented safe path failed with a usage error at the moment it was needed.
Both surfaces that can be handed the argument now refuse it by name and point at
the real procedure — the CLI (`revival:1160-1168`) and the local wrapper
(`platform/deploy/vps/rollback.sh:18-22`) — rather than reading as an operator
typo. Do not re-document the flag here without a script that parses it.

Restoring a database is a deliberate, manual, destructive operation with its own
written procedure, including which writers must be stopped first and what is
lost: [docs/recovery.md](recovery.md#restoring-a-database).

### The canary wearer credential

**Provision this before the next deploy. Without it `./revival preflight` and
every canary refuse, by design.**

Two 100%-wearer-facing outages passed every gate this project has. Both looked
identical from outside: Center answered 200 to everything while every wearer saw
an empty dashboard. Nothing in the canary held a credential capable of telling
the difference, and the canary said so in a warning and passed anyway. The fix is
one dedicated Keycloak identity the canary signs in as, so the deploy gate
exercises the same sealed-bearer path a wearer does.

**What to create, in Keycloak (`https://center.andersmadsen.dk`, realm
`humane`).** One ordinary realm user, and it must be *ordinary*:

- **not** in `CARRY_OPERATOR_EMAILS` and holding no `carry-operator` role, on
  the realm or on the `center` client;
- **not** the paired Pin owner (`REVIVAL_PIN_BRIDGE_OWNER_SUB`);
- paired to no device, so it has its own empty `U:<sub>` partition.

The canary checks the first two on every run and refuses the deploy if either is
wrong, so a lazily provisioned identity fails loudly rather than quietly handing
a deploy gate the wearer's account. Give it a long random password from your
password manager. Email verification and a first-login password reset must be
off, or the password grant will not complete.

**Where the secret goes, on the server.** One file,
`/home/anders/ai-pin-revival/private/canary-wearer.secret`, mode `0600`, owned by
`anders`, in the `0700` private directory beside `center.env`. Exactly two keys
and nothing else:

```
REVIVAL_CANARY_WEARER_USERNAME=<the Keycloak username>
REVIVAL_CANARY_WEARER_PASSWORD=<the password>
```

Write it with a redacted shell (`umask 077`, and `set +o history` or a leading
space so the value is not left in `~/.bash_history`). It is deliberately **not**
an entry in any `.env` file: those are interpolated into Compose and end up in
container environments, where a workload could read it. It is also deliberately
**not** fingerprinted into `config-digests.tsv`, so rotating it never trips the
protected-configuration gate — rotate by changing the password in Keycloak and
rewriting this one file, in either order, with no deploy involved.

**What the canary does with it.** It signs in through Center's own
`POST /api/auth/login` on `127.0.0.1:14000` — loopback only, so the credential
never reaches nginx, Cloudflare or any access log — and keeps the resulting
cookie jar for the length of the run. That jar carries a real sealed Keycloak
bearer, which is the only thing that exercises `openTokens`, the JWKS
verification at the workload, and `CARRY_EDGE_TOKEN`. It then requires
`/api/health`, `/api/capture/notes`, `/api/capture/memories`,
`/api/settings/wifi` and `/api/settings/features` to answer **live** with a body
of the right shape — a 200 carrying an error or an unavailable read fails the
deploy. The password appears in no argument list, no environment variable, no log
line and no evidence file; the jar is mode `0600` and is deleted when the canary
exits.

**What it still does not prove.** The token *refresh* path. `requestBearer` only
calls `refreshTokens` inside the last 60 seconds of an access token's life and
this jar is seconds old, so a grant Keycloak would refuse to rotate still passes.
The canary warns about it on every run.

**If it is missing.** `./revival preflight` fails before anything is touched,
which is the cheap place to find out. A canary that reaches the credential check
with nothing provisioned refuses too. The one override is
`./revival canary --wearer-plane-optional`, which exists for an operator at a
terminal during an incident and is passed by no deploy or rollback path; a run
that uses it prints `RUNNING WITHOUT WEARER-PLANE COVERAGE` and reports
`"wearerPlane":"unproven"` in `--json`. Do not wire it into the deploy path —
that is the warn-and-pass default this replaced, wearing a longer name.

**After you change `canary.sh`, run it before a deploy does.** `./revival canary`
runs the DEPLOYED release's copy of the canary, so an edited gate does not
execute until a deploy is already underway with public ingress quiesced — where a
mistake in it lengthens an outage instead of failing a check. `./revival canary
--from-tree` streams the working tree's `canary.sh` to the host and runs it
there, read-only, holding `deploy.lock` for the whole run so it cannot race a
deploy. It skips release verification, because there is no release yet: that is
the point, and it is why no deploy or rollback path may ever pass it. A passing
run prints `sealed-bearer wearer plane proven` and reports
`"wearerPlane":"sealed-bearer"`.

### Changing a setting from the dashboard

The operator console's **Configuration** pane lists every setting this
deployment reads, what its absence costs, and whether it is set — never a value,
for any setting, secret or not. A handful of them are editable there, and saving
one records a *pending value* in Center's own `/data` volume. Nothing about the
running system changes at that moment. The next `./revival deploy` applies it
(`apply_configuration_proposals`, called from `deploy.sh` while it stages the
private configuration), so the new value and the new digests land in the same
deployment record as the release — which is the whole reason a config change
costs a deploy. A dashboard that wrote `private/*.env` directly would leave
`rollback.sh` recomputing digests that no longer match its own record, and you
would discover that during the rollback that refuses.

Two things the pane will tell you and are worth knowing in advance:

- **Most settings are not editable, and the pane says where each one lives
  instead.** Secrets and key material never get a dashboard writer — the writer
  for the credentials that protect Center must not live inside Center. Neither
  do the values `drift.sh` requires to agree across files, nor the identity and
  release-identity settings. Set those in the named file on the VPS and deploy.
- **"Editable" is not "deliverable", and three settings differ.**
  `REVIVAL_PIN_SETUP_ORIGIN` and `CARRY_FEATURE_FLAGS_METRICS_URL` are Compose
  *literals*, and `CARRY_DEADLINE_MS` is absent from the Center service's
  explicit environment allowlist, so no env file reaches it. Each says so in its
  own row rather than accepting a value that would deploy and do nothing.

Removing a pending value stops Center re-asserting it on future deploys; it does
not restore the previous value. And a pending entry naming something this build
no longer accepts is shown in red, because `apply_configuration_proposals`
refuses the whole file rather than guessing — remove it or the deploy will not
start.

### When a protected configuration input legitimately changed

Every deployment record fingerprints its protected inputs into
`config-digests.tsv`, and `verify_configuration_evidence` refuses the deploy if
one row moved. That is correct. It also has no opinion about *why* a row moved,
and some moves are the repair rather than the damage: the Pin's server package
was reinstalled during boot-loop recovery, its iroh node identity was
regenerated, and the ticket in `/etc/penumbra` then addressed a node that no
longer existed — every request hung at "connecting to Pin via iroh" and the
Spotify adapter reported `{"adapter":"ready","upstream":"unavailable"}`. The old
ticket fails the canary. The new ticket fails the drift gate with `protected
configuration or rendered Compose model drift`, before the deploy quiesces. Four
attempts, a long outage window, and it ended in a hand-edited digest row.

```sh
./revival adopt-config                                    # show what differs
./revival adopt-config --confirm --reason "…" --expect-plan <token>
```

Without `--confirm` it recomputes the live evidence, prints every differing row
with its recorded digest and its live digest, names the files under a changed
protected directory, and writes nothing — the same plan-then-confirm shape as
`./revival pin install`. `--confirm` requires `--reason`, which is written into
the deployment record next to the before/after digests
(`CONFIG_ADOPTION_JOURNAL.jsonl`, plus a `PROTECTED_CONFIGURATION_ADOPTED`
marker). It rewrites only the rows it displayed, refuses if the evidence file
moved between the plan and the confirmation, and then re-proves each record it
touched with `verify_configuration_evidence` itself.

**Read the baseline line before you read anything else.** There are two drift
comparisons and they use different baselines. If a deploy transaction is
prepared, the resume path verifies *that record's* `config-digests.tsv`
(`platform/deploy/vps/remote/deploy.sh:722`, `:810`) and fails before the
comparison against `current-deployment`
(`platform/deploy/vps/remote/deploy.sh:1384`) is ever reached. `adopt-config`
resolves both, reports the pending one first, and says which gate reads which —
because adopting into `current-deployment` while a transaction is pending
changes a file the failing gate does not read, which is an hour lost.

Selecting one baseline does not hide the other. `--baseline current` still
resolves the transaction inventory, and **refuses** rather than reporting a
clean adoption if a prepared transaction's record carries configuration
evidence; it names that record and tells you to re-run with `--baseline all`.
The flag narrows what is adopted, never what is looked at.

This command cannot run during a deploy: it takes the same deployment lock
`deploy.sh` takes and refuses outright if a deployment driver is anywhere in its
process ancestry. "A deployment driver" means an ancestor process that is
*executing* one — the interpreter and the script it was handed — not any process
whose command line happens to mention one, so the operator shell you are sitting
in when a deploy has just failed is not itself a reason to refuse. It has no flag that skips, relaxes, or disables a comparison,
and nothing in the deploy path can reach it.

### What a deploy will not do to the wearer's rows

Shipping a release must not change data as a side effect. Two things that a
Cosmos workload could otherwise do at startup are therefore held back on every
ordinary deploy, and both are behind the same switch:

| Held back | What it is | Where |
| --- | --- | --- |
| Reviewed data removals | Any migration statement whose normalized text contains `DELETE`, `TRUNCATE` or `DROP`. Today that is exactly one, pinned verbatim: the `carry_account_blob` device-status cleanup in `0005_device_status_namespacing.sql`. | `cosmos/crates/cosmos/src/store_postgres.rs:118-122`, `:225-236` |
| Thumbnail backfill | `UPDATE carry_memory SET thumbnail_count = …` for captures written before the column existed. | `cosmos/crates/cosmos/src/store_postgres.rs:166-171`, `:256-262` |

`CARRY_ALLOW_DATA_REMOVALS=1` (or `true`) in a Cosmos workload's environment is
how you ask for them, and nothing else turns them on
(`store_postgres.rs:128-133`). Unset, the migration logs at `info` which
statement it skipped and names the variable, so a held-back removal is visible in
the container log rather than silent — but it is a log line, not a failure, and
`./revival deploy production` reports success either way.

Neither is a correctness gap while it waits. The removal is a retention cleanup;
the backfill is an optimisation, because the listing read path recomputes the
same count from the stored frame array whenever the scalar column is NULL
(`store_postgres.rs:358-362`, `:854`). It converges after one successful pass.

The reason is the deploy's own gate, not caution for its own sake: the isolated
staging smoke fingerprints every relation in both databases *before* and *after*
the candidate release starts and refuses the candidate if a single count or row
digest moved, naming the relations
(`platform/deploy/vps/remote/staging-smoke.sh:2177-2244`). A cleanup riding along
inside a release is therefore either blocked by that gate, or — if the gate were
ever relaxed — deletes a wearer's rows as an invisible side effect of shipping a
web change. So the removal is legitimate and reviewed; it just has to be
something an operator does on purpose.

**no command yet** — no `revival` subcommand sets it, and no Compose file in
this repository passes `CARRY_ALLOW_DATA_REMOVALS` into a container, so putting
it in the protected production env file does nothing. Running it means starting
a Cosmos workload with the variable in its own environment, once, deliberately,
after a `./revival backup --fetch`. Read
[docs/recovery.md](recovery.md#restoring-a-database) first: this discards rows,
and the backup you take before it is the only way back.

When the staging smoke *does* fail this way, the evidence survives the run.
`~/ai-pin-revival/deployments/<deployment-id>/staging-smoke-evidence/` holds the
before/after relation manifests and one `<database>.<schema>.<relation>.rowdiff.tsv`
per changed relation, counting the rows that appeared, vanished, or were
rewritten (`platform/deploy/vps/remote/deploy.sh:1447`). Read those before
concluding the gate is wrong.

### Why an added column does not read as changed data

A relation digest is taken over `to_jsonb(t)`, which encodes the *schema* as well
as the data — so `ADD COLUMN IF NOT EXISTS` rewrites every row's JSON without a
single wearer byte moving, and a comparison that spans a migration would refuse a
release for adding a column. Every gate that compares state captured *before* a
candidate started against state captured *after* therefore digests the later
capture over the **columns the earlier one used**, recorded beside each manifest
as `postgres-data.tsv.columns`. A changed value, an appearing or vanishing row and
a *dropped* column all still fail: the projection only hides columns that did not
exist before, and a column that vanished breaks it and fails the capture outright.
`backup.sh` takes that source with `--data-columns-source`, and only ever another
backup's own sidecar.

Fidelity checks are deliberately **not** projected that way. "Did the clean
snapshot, the physical restore and the blank-cluster restore preserve this
cluster?" has both sides at the same schema and the same instant, so there is
nothing additive to project away and narrowing would make it blind to exactly the
new column — a mangled `thumbnail_count` would round-trip unnoticed. A backup
whose authoritative manifest is projected therefore keeps an unprojected
`postgres-data.unprojected.tsv` beside it, and `backup_fidelity_data_manifest`
(in `common.sh`) is what every fidelity comparison resolves through. For a backup
taken outside a deploy the two are the same file and nothing changes.

### What a deploy may do to the schema

The schema has its own gate beside the relation-data one: the same smoke digests
`pg_dump --schema-only` for both databases before and after the candidate starts.
Two digests can prove the schema moved and cannot say how, so a delta that the
comparison rejects is then handed to an **additive-schema allowance**
(`classify_schema_delta`, in `platform/deploy/vps/remote/common.sh`). The equality
check is unchanged and still decides whether anything moved; the allowance only
decides whether a delta that already failed it is provably non-destructive.

The same shape occurs three times, and all three go through
`compare_schema_manifests`, which wraps the equality check and the allowance
together: the staging smoke's candidate-mutation gate, `deploy.sh`'s pre-commit
comparison of the pre- and post-candidate backups, and `rollback.sh`'s
legacy-eligibility check. Because the pre-candidate `pg_dump` text cannot be
re-taken once the candidate has migrated, `backup.sh` retains it beside the digest
as `postgres-schema.tsv.<database>.sql`; a backup taken before that existed can
only be refused, never waved through.

It permits four things, and names each one it allowed in the deploy log: a column
appended to an existing table with every pre-existing column's definition
byte-identical and still in place, an entirely new table with the ownership,
constraint, default and sequence statements `pg_dump` emits for that same new
table, and a new non-`UNIQUE` index. Everything else is refused, by name — a
dropped or renamed table or column, a retyped column, a changed nullability or
default, a reordered column list, a dropped or redefined index or constraint,
changed ownership or grants, any function, trigger, view or type, a `UNIQUE`
index over rows that already exist, a change to an existing table's `CREATE
TABLE` heading or table options (`UNLOGGED`, `PARTITION BY`, storage options), a
change in the `keycloak` database, and a digest delta with no statement-level
explanation at all.

`pg_dump` prints `CREATE TABLE` with the full column list, so an added column
rewrites the whole block rather than appearing as an `ADD COLUMN` line. The
allowance therefore compares the *column set*: the before column list must be an
exact byte-identical prefix of the after list. A `CREATE TABLE` block is more
than its columns, though, so the heading and the trailing table options are
compared verbatim too, and a rewritten block that yields no attributable
difference is refused rather than passed over — otherwise a table converted to
`UNLOGGED`, which discards every existing row on the next crash, would produce
no note of its own and ride along under the legitimate `+column` note beside it.
This is what lets
`cosmos/migrations/0004_listing.sql` — `carry_memory.thumbnail_count` plus three
indexes — reach production, and what stops a dropped or renamed column from
riding in beside it. Evidence survives a refusal the same way the relation-data
gate's does: `postgres-schema.before.tsv`, `postgres-schema.after.tsv` and the
retained `pg_dump` text for each database land in the same
`staging-smoke-evidence/` directory, so the delta can be read without re-running
the deploy.

## Pin host checks

```sh
./revival pin doctor
./revival pin check
./revival pin release --help
```

These commands inspect host readiness, source, and immutable APK metadata. They
do not mutate a device.

## Physical Pin

The root CLI contains no ADB, reset, flash, install, Wi-Fi, or provisioning
command. Before any device write, verify the exact serial, hardware and firmware
compatibility, signer, battery and transport state, current installed state,
immutable bundle, and a tested recovery path. Authorization is required at the
write step, even when host checks pass.

If a command fails, stop. Preserve the error and current state; do not turn a
failed installation or deployment into an improvised recovery attempt.

## Onboarding a Pin

Going from a stock Ai Pin to a device that talks to your own stack is a fixed
ceremony, written here in order so it does not have to be reconstructed from
memory. Every claim below cites the code that enforces it.

Steps marked **no command yet** have no `revival` subcommand and no console.
They are done by hand today. They are marked so a newcomer knows the gap is real
rather than something they failed to find; the boundary in
[Physical Pin](#physical-pin) still applies to every one of them.

### 0. What you need before you start

| Need | Where it lives | Enforced by |
| --- | --- | --- |
| Docker Compose 2.33.1+, Node 22.14.0+, Rust 1.91.1+ | host | `./revival doctor`, against `platform/containers/pin-builder/toolchain.json` |
| JDK 17, Android SDK 34, NDK r28c | host, for Pin builds only | `./revival pin doctor` |
| Pin signing keystore and its four `PIN_SIGNING_*` values | `${REVIVAL_SECRETS_DIR}/pin/signing.env` | `platform/deploy/pin/build.mjs:43-46` |
| Two pinned native build inputs, matched by exact SHA-256 | `${REVIVAL_CONFIG_DIR}/pin-assets/` | `platform/deploy/pin/build.mjs:78-87` |
| A browser with WebUSB, on HTTPS or `localhost` | operator workstation | `center/src/lib/pin-device/adb/browserSupport.ts:10-30` |
| DeviceUser CA certificate and PKCS#8 key | `${REVIVAL_SECRETS_DIR}/pki/duc-ca.crt`, `duc-ca.key` | `./revival doctor`, `cosmos/crates/cosmos/src/enrollment.rs:163-165` |
| Attestation CA certificate and PKCS#8 key | Cosmos `CARRY_ATTEST_CA_CERT` / `CARRY_ATTEST_CA_KEY` | `cosmos/crates/cosmos/src/provision.rs:27-31` |

Both CAs are **operator-supplied configuration and are never generated**. A CA
minted at startup is trusted by one process for one lifetime, so every restart
silently invalidates every certificate it ever issued
(`cosmos/crates/cosmos/src/enrollment.rs:95-104`). Mount the same material in
every provisioning replica and in the edge's trust bundles.

The attestation CA is additionally constrained by the device: the Pin verifies
that the bundle's issuer chains to a root pinned *inside the shipped APKs*
(`pin/runtime/android/.../CarryIdentityProvider.kt:534-540`, byte-identical to
`pin/hook/payload/.../CarryRemoteTransport.kt:75`) —
`O=humane-carry-clone, CN=Carry Clone Root EC 1`. An attestation CA that does
not chain to that exact root is rejected on the device, no matter how correct it
looks on the server. Changing the root means rebuilding and reinstalling the Pin
release.

### 1. `./revival init` — and what it deliberately leaves undone

`init` writes:

- the five external roots listed under **Source, secrets, and state** in
  [architecture](architecture.md#source-secrets-and-state);
- `${REVIVAL_SECRETS_DIR}/runtime.env` from `.env.example`, independently
  generating nine blank local secrets (`revival:322-350`) plus
  `REVIVAL_RELEASE_ID=local`;
- a sanitized local identity realm with no wearer accounts and no fixed
  passwords, at `${REVIVAL_SECRETS_DIR}/identity/realm.json`.

`init` leaves for you:

- `${REVIVAL_SECRETS_DIR}/pki/duc-ca.crt` and `duc-ca.key`, created as **empty**
  0600 placeholders (`revival:476-490`). **no command yet** — there is no
  `revival pki init`; supply the CA yourself.
- `REVIVAL_ENROLLMENT_PINCODE` (exactly four digits) and
  `REVIVAL_ENROLLMENT_USER_ID`, which must be set together, plus the
  `REVIVAL_OPAQUE_SEED` that `init` already generated.
- provider credentials, Spotify pairing, and wearer identity.
- `${REVIVAL_SECRETS_DIR}/pin/` and `${REVIVAL_CONFIG_DIR}/pin-assets/` —
  created as empty owner-only directories, never populated.

An empty DeviceUser CA is not a harmless default. Enrollment answers
`UNIMPLEMENTED` without it (`cosmos/crates/cosmos/src/enrollment.rs:101-104`,
`:1473-1482`), so a Pin can attest and connect and still never obtain a
DeviceUser certificate. `./revival init` names both files and says so on every
run.

### 2. Server PKI and enrollment configuration

Production preflight requires five PKI artifacts to exist, parse, and not expire
within seven days (`platform/deploy/vps/remote/preflight.sh:309-320`):
`edge/certs/server.crt`, `edge/certs/api-client-ca.crt`,
`edge/certs/onboarding-client-ca.crt`, the attestation CA `ca.crt`, and the
DeviceUser CA `duc-ca.crt`. It then separately checks the relationship those
files do not prove on their own — that the edge's `require_client_certificate`
trust anchors really are the CAs that issue device certificates
(`preflight.sh:322-381`): `onboarding-client-ca.crt` must be the attestation CA,
and `api-client-ca.crt` must be the DeviceUser CA. Getting either wrong rejects
every Pin at the edge.

`unknown`: one half of that relationship is never checked. The edge **server**
certificate must chain to the same pinned clone root the hook carries, and the
`vps` release profile deliberately excludes `pin/`, so the pinned literal is not
on the deploy host. Preflight warns and moves on rather than assuming it
(`preflight.sh:382-388`). If a Pin fails TLS against a server whose PKI passed
every gate, check this first.

Enrollment turns on only when the pincode and user id are both set;
`./revival doctor` additionally requires a 32-byte base64 OPAQUE seed and the
reviewed `/run/secrets/duc_ca_cert` and `/run/secrets/duc_ca_key` paths
(`revival:794-809`).

### 3. Build a Pin release

```sh
./revival pin release build --version YYYY-MM-DD.N --version-code INTEGER
```

This builds and compatibility-signs the five APK roles in the pinned container
and publishes them atomically to the **local** release store —
`REVIVAL_PIN_RELEASE_OUTPUT_DIR`, default `${REVIVAL_DATA_DIR}/pin-releases`
(`platform/deploy/pin/build.mjs:268`). It never runs ADB and never touches a
device. The store's layout is:

```text
pin-releases/
  current.json
  history.json
  releases/<releaseId>/manifest.json
  releases/<releaseId>/{installer,bootstrap,hook,server,hook-injector}.apk
```

### 4. Ship the release to the server

`pin release build` publishes to the store on *your machine*. Production Center
reads a different filesystem: `REVIVAL_PIN_RELEASE_DIR` is
`/var/lib/ai-pin-revival/pin-releases` (`platform/compose/production.yaml:177`),
a read-only bind of `$REMOTE_ROOT/data/pin-releases` on the VPS
(`platform/deploy/vps/remote/common.sh:10`). The deploy only *creates* that
directory (`common.sh:492-498`); it never puts a release in it. This step does,
and it is deliberately **not** part of a deploy:

```sh
./revival pin release ship                 # reads both stores, prints the plan
./revival pin release ship --confirm       # uploads and publishes
```

Without `--confirm` it inspects the far side, verifies it, prints what it would
upload, and changes nothing — the same shape as `pin install`. Options:
`--remote NAME` (default `$REVIVAL_DEPLOY_REMOTE`, else `vps`), `--remote-root
PATH` (default `/home/anders/ai-pin-revival/data/pin-releases`), `--release-root
DIR`, `--local` when the served store is mounted on this machine, and `--json`.

What it guarantees (`platform/deploy/pin/ship.mjs`):

- **One verifier.** Both stores — yours and the server's — go through the same
  `platform/deploy/pin/release.mjs` parsers `pin release build` publishes with:
  canonical manifest bytes, the release-identity digest, per-artifact size and
  SHA-256, a strictly monotonic `history.json`, and each history entry's
  `manifestSha256` against the manifest it names.
- **No rollback and no fork.** Every release the server already accepted must
  appear, entry for entry, at the front of your history, or the ship refuses.
- **An immutable release is never rewritten.** A `releases/<releaseId>/` that
  already exists is proven byte-identical and left alone.
- **Atomic swap.** Artifacts land in a hidden incoming directory, are re-hashed
  on the far side against the plan, and are `rename(2)`d into place;
  `history.json` and `current.json` are then replaced only if their current
  bytes still hash to what the inspection saw.
- **Nothing is buffered.** Hashing streams on both ends and the transfer is
  `scp`, so the >200 MiB `server.apk` never becomes a buffer anywhere.

If it is ever done by hand instead, copy the store whole, not artifact by
artifact. `current.json` must byte-match `releases/<releaseId>/manifest.json` or
Center answers 503 (`center/src/server/pin-releases.ts:846`), and every artifact
is SHA-256'd against the manifest before any of it is served
(`center/src/server/pin-releases.ts:768-786`).

That hash sweep is verified once per published release, not once per request:
the verdict is cached against each file's exact `(dev, ino, size, mtimeMs,
ctimeMs)` and re-run the moment any of them moves
(`pin-releases.ts:624-700`). So a partial or mid-flight copy is caught — but
copy into place with an atomic rename rather than writing over a live store,
or the first request to arrive mid-copy is the one that answers 503.

The signature of a server with no release, so it is not misread as a Center
fault: `GET /api/pin/releases/current` answers **404 "Pin release not found."**
when `current.json` is absent (`center/src/server/pin-releases.ts:540`, the
`not-found` policy) and the install pane simply offers nothing. Both the canary
and the staging smoke accept that 404, by design — they prove the route is
bounded and same-origin, not that a release exists.

### 5. Install the five roles

Open `/settings/pin/install` in Center, connect the Pin over WebUSB, and run the
pipeline: connect → inspect → resolve and lock a release target →
download/verify → remove conflicts → bootstrap → install the five roles →
configure → verify readiness
(`center/src/app/settings/pin/install/useInstallController.ts:6-9`). The pane
resolves its target from `/api/pin/releases/current`
(`center/src/lib/pin-install/releases/manifest.ts:4`) and verifies package,
version, size, and SHA-256 before any device mutation.

Center's only outbound call for this is signing the device's ADB AUTH
challenge, proxied server-side by `/api/pin/adb/sign` so `connect-src 'self'`
never has to be widened.

#### What the next release changes on the wire, and what to check

Two corrections to the device's copy of the stock protocol are **in the source
and not on the device**. They are the ones that could not be made silently:
every other correction in `contracts/wire-divergence.json` provably could not
change a byte the runtime emits, and these two change what the Pin puts on the
loopback wire the moment a release carrying them is installed. The record, with
the evidence behind each, is `stagedForRelease` in that file;
`platform/deploy/acceptance/wire-equivalence.test.mjs` holds it to the tree and
to this section, so neither can drift from the other.

**`delete-memory-status-4` — a failed delete stops reporting as a refusal.**
`humane.capture.DeleteMemoryStatus` value 3 is `NOT_AUTHORIZED` in the stock
client and `FAILURE` is 4; the device's copy had `FAILURE` at 3 and no fourth
value, so the store-error arm of `Capture.DeleteMemory` has been answering 3 —
which a stock client reads as *refused for authorization*. Cosmos already
answers 4 for the identical outcome, so the two servers on that RPC path
disagree until this lands. After installing, make a delete fail and read the
status: expect **4**. A delete of something that does not exist must still
answer 2, and a successful delete must still answer 1 — if either moved, the
enum was renumbered rather than corrected. Reverting is the same two-line enum
edit in the other direction plus a rebuild.

**`verify-hmc-association-field-order` — the pairing request starts decoding.**
`humane.provisioning.VerifyHmcAssociationRequest` carries `hmc_id` at 1 and the
verification signature at 2; the device's copy had them swapped. Both are
length-delimited, so the framing survived and the failure landed one layer in:
prost rejects a serialized signature as non-UTF-8 where it wants a string, and
cannot parse an `hmc_id` string as a message, so the call died before the
handler with `InvalidArgument` and the blame on the caller. After installing,
run pairing and watch for the existing `>>> Provisioning.VerifyHmcAssociation`
log line — prost decodes the request *before* the handler runs, so reaching that
line at all is proof the framing was accepted. Its absence during a pairing
attempt, or an `InvalidArgument` on that method, is the same evidence with the
opposite sign. The answer itself does not move: the handler ignores its request
and returns SUCCESS unconditionally, before and after.

Neither check is a canary or a deploy gate, and neither can be run from the
server: they are things to look at on the device once the five roles are
installed. Until they have been, the honest reading of the wire inventory is
that the trees agree and the device is one release behind them.

### 6. Mint a device-attestation credential

Sign in as an operator, open `/admin`, and use the Provisioning card. It posts
to `/api/admin/provision` (operator-gated, same-origin, admin token injected
server-side: `center/src/app/api/admin/provision/route.ts:10-20`), which proxies
`/demo-api/admin/provision` in Cosmos (`cosmos/.../http.rs:1350-1389`).

The response is shown once and contains `device_id`, `subject`,
`certificate_pem`, `private_key_pem`, `ca_certificate_pem`, and the enrollment
`pincode`. The private key is issued once and never stored. Treat it as
credential material: it is the device's identity.

If provisioning reports it is unavailable, the deployment has no attestation CA
(`ProvisionError::NotConfigured` → 503).

### 7. Point the Pin at your server — **no command yet**

The injector does not rewrite hostnames and does not need root or a reflash.
Stock keeps calling `api.carry.humane.cloud` and
`onboarding.carry.humane.cloud`; the hook pins those exact names to your edge's
IPv4 address, read from `Settings.Global` at
`penumbra_carry_edge_ipv4`, by overriding gRPC's DNS resolver
(`pin/hook/payload/.../CarryRemoteTransport.kt:151-172`, `:263-271`) and
`Network.getAllByName` for the two cleartext connectivity hosts
(`:175-196`). TLS trust is replaced with the pinned clone root and fails closed —
it never falls back to Humane trust (`:237-272`).

Three `Settings.Global` keys carry the whole repoint
(`pin/runtime/android/.../CosmosActivationTransaction.kt:15-17`):

| Key | Meaning |
| --- | --- |
| `penumbra_carry_remote_mode` | `1` enables clone mode; every hook is inert otherwise |
| `penumbra_carry_edge_ipv4` | the IPv4 the pinned stock hostnames resolve to |
| `penumbra_carry_attestation_bundle_b64` | one-shot staging slot, read and cleared by the hook in the provisioning process (`CarryRemoteTransport.kt:412-421`) |

Do not write them by hand. Activation is one journalled transaction inside the
Pin's own runtime. It validates trust, subject, key/certificate match, and
validity before the journal or `Settings.Global` is touched
(`pin/runtime/android/.../CarryIdentityProvider.kt:227-285`), then imports the
identity into AndroidKeyStore, writes `penumbra_carry_edge_ipv4`, clears the
staging slot, and writes `penumbra_carry_remote_mode=1` **last**, as the commit
gate — so stock traffic can never be redirected to a half-configured edge
(`CosmosActivationTransaction.kt:292-301`). Any failure rolls back
(`:312-319`). It also refuses to run while the staging slot is non-empty
(`PENDING_ATTESTATION_CONFLICT`, `:234-244`) or while an existing active
configuration disagrees with the one you asked for.

Reach it through its content provider from an ADB shell. The shell uid is
trusted and holds `DUMP`, so no root is involved
(`CarryIdentityProvider.kt:37-43`, `:420-429`):

```sh
adb shell content write \
  --uri content://com.penumbraos.server.carryidentity/attestation.json \
  < activation.json
adb shell content call \
  --uri content://com.penumbraos.server.carryidentity --method ACTIVATE
```

`activation.json` is the minted bundle plus three endpoint fields
(`CarryIdentityProvider.kt:584-601`, `:563-580`):

```json
{
  "api_endpoint": "https://api.carry.humane.cloud",
  "onboarding_endpoint": "https://onboarding.carry.humane.cloud",
  "edge_ipv4": "<your edge IPv4>",
  "device_id": "<from /admin>",
  "certificate_pem": "<from /admin>",
  "private_key_pem": "<from /admin>",
  "ca_certificate_pem": "<from /admin>"
}
```

The two endpoints are fixed: the transaction rejects any host that is not the
allowlisted stock name, any scheme but HTTPS, any port but 443, and any path,
query, or credentials (`CosmosActivationTransaction.kt:42-77`). The bundle must
name *this* Pin — it is checked against `ro.boot.deviceid`
(`CarryIdentityProvider.kt:247-252`). `ACTIVATION_STATUS` reports the result and
`DEACTIVATE` reverses it.

### 8. Get the Pin onto a network, and finish enrollment

`/wifi` is Center's public Wi-Fi QR page. It stays open without a session and
builds the QR payload entirely in the browser, reading no account data and never
calling the BFF — because a Pin that is off the network is exactly the moment
its owner may be unable to sign in (`center/src/middleware.ts:92-108`).

Saved network configurations are stored as already-encrypted envelopes and can
be ingested by an admin `POST /demo-api/admin/wifi`
(`cosmos/.../http.rs:206`, handler `:1530-1590`). **no command yet** — there is
no console for that route, and it accepts envelopes only, never plaintext
credentials.

With the device on the network and clone mode active, the stock onboarding flow
runs the OPAQUE ceremony against your enrollment pincode and receives a
DeviceUser certificate signed by your DeviceUser CA
(`cosmos/crates/cosmos/src/enrollment.rs:1-30`).

### 9. Confirm, and know what a pass does not mean

```sh
./revival canary
```

A green canary, a healthy container, or an HTTP 200 is not physical-Pin proof.
Physical sync, playback, signed installation, and clean stock-unit provisioning
stay `unknown` until an authorized acceptance run observes the exact target —
see [architecture](architecture.md#compatibility).

## Recovering a Pin that will not boot

Written on 2026-08-12, from a device in exactly this state. Every claim below is
marked **PROVEN** (observed on the affected Pin), **READ** (traced through the
source but not executed), or **UNKNOWN**. A confident-sounding wrong step here
costs the rest of the device, so the distinction is the point.

### What this failure looks like

**PROVEN.** `adb` connects and `adb shell` works, but the device never finishes
booting. `getprop sys.boot_completed` stays empty, `pidof system_server` returns
a *different* pid every ~20s, and `pm list packages` answers
`cmd: Can't find service: package`. The crash buffer shows, once per cycle:

```
PackageManager: PackageSetting for <package> is missing signatures. Collecting certs again to recover them.
AndroidRuntime: *** FATAL EXCEPTION IN SYSTEM PROCESS: main
java.lang.ArrayIndexOutOfBoundsException: length=0; index=0
	at com.android.server.pm.PackageManagerServiceUtils.verifySignatures
	at com.android.server.pm.PackageManagerService.reconcilePackagesLocked
	at com.android.server.pm.PackageManagerService.<init>
	at com.android.server.SystemServer.startBootstrapServices
```

A package record on `/data/app` has an empty signature list, and this firmware's
`PackageManagerService` throws on it while scanning at boot instead of dropping
the package. It happened here after an interrupted managed-package install: the
batch install restarts `system_server` mid-flight, and the install pipeline
reports `Failure calling service package: Broken pipe (32)`.

### Why the usual escape hatches do not apply

**PROVEN, and check these before assuming anything else.**

| Escape hatch | Result on this device | How to check |
| --- | --- | --- |
| Race `cmd package uninstall` against the loop | Impossible — the crash is inside `PackageManagerService.<init>`, called from `startBootstrapServices`, so the `package` service is **never registered**. There is no window. | the stack trace above |
| Delete the record as `shell` | Refused — `adb shell` is uid 2000, `/data/app` is `drwxrwx--x system:system`. `ls` answers `Permission denied`. | `adb shell id`, `adb shell ls -ld /data/app` |
| `adb root` | Refused, `adbd cannot run as root in production builds` | `getprop ro.build.type` → `user` |
| Unlock the bootloader | Locked, and unlock is not advertised | `ro.boot.vbmeta.device_state` → `locked`, `ro.boot.verifiedbootstate` → `green`, `ro.boot.veritymode` → `enforcing`, `sys.oem_unlock_allowed` → empty |

**PROVEN.** Android's own RescueParty escalates to `FACTORY_RESET` and retries it
every ~28s (`logcat | grep RescueParty`). On the affected Pin it did not complete
— but it is trying, so time is not on your side.

An earlier, milder version of this failure *was* recoverable by racing the
uninstall, because that crash happened at `systemReady()` — late enough that the
package service existed. That is the difference to look for: **`<init>` means no
window, `systemReady` means there is one.**

### The route back

**READ, not proven — nobody has walked this end to end.** The steps exist and the
tooling is in this repo; the sequencing below is traced from the source.

1. **Factory reset.** This is the only way to clear a package record without root
   or an unlocked bootloader. It destroys the device's provisioning and its iroh
   identity. Everything after this is the normal onboarding above, with the
   differences noted.
2. **UNKNOWN, and the one to establish first: can `adb` be re-authorized on a
   freshly reset Pin?** The Ai Pin has no conventional screen for the developer
   options toggle or the RSA-key prompt. If the answer is no, the steps below are
   unreachable and this section stops here. Establish this before planning
   anything else.
3. **Onboarding.** Follow [Onboarding a Pin](#onboarding-a-pin) from step 0. Note
   that `CarryOnboardingAutomation` — the hook that enters the clone-owned
   pincode — lives in the *hook payload*, so it cannot help until the packages
   are installed. On a bare device the stock onboarding UI is what you are
   driving.
4. **Install the managed packages.** **READ:** `decideInstallMigration` returns
   `bootstrap-recovery` rather than `blocked` for a bare device —
   `roleIsKnownForRecovery` treats `!pkg.installed` as known
   (`center/src/lib/pin-install/domain/migrationDecision.ts:165-177`), so all
   three absent roles pass and the missing installer selects that path
   (`:292-313`). It needs `--confirm-bootstrap-recovery`, refused by default
   because it removes managed packages before reinstalling them. The release
   ships a `bootstrap` artifact for exactly this case: a device with no working
   installer.
5. **Re-pair the bridge.** A reset regenerates the Pin's iroh identity, so the
   bridge ticket changes. That edits `/etc/penumbra`, which is a protected
   configuration input, and the next deploy will refuse on drift — the old ticket
   fails the canary and the new one fails the gate. Clear it with
   `./revival adopt-config` (plan first; `--confirm --reason` to act). This
   deadlock is the reason that command exists.
6. **Re-verify.** `./revival canary --remote vps` must pass with the wearer plane
   proven, and `./revival drift` must be clean.

### Avoiding a repeat

**PROVEN.** The install that caused this reported failure and *had already
partly succeeded* — `system_server` restarts during the hook install, the package
service disappears, and the pipeline's 60s wait times out while the install is
still settling. Twice this session that timeout reported a scary failure over a
device that was fine. The third time it was not fine.

Do not re-run an install against a device whose package state you have not
re-read after the restart. Wait for `sys.boot_completed` and a stable
`pidof system_server`, then read the versions back with `dumpsys package`, and
only then decide whether anything still needs installing.
