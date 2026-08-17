# Recovery

This page is for the two situations no other page covers: the server is gone,
or a database has to be put back. Both are rare and both are unforgiving, so
everything here is written to be followed by someone who did not build the
system.

Read [What cannot be regenerated](#what-cannot-be-regenerated) before anything
else. Every item in it survives on exactly one machine until you run
`./revival backup --fetch`, and one of them — the Pin signing keystores — exists
as exactly one copy anywhere.

## What cannot be regenerated

| Material | Lives at | What its loss costs | Carried by |
| --- | --- | --- | --- |
| Attestation CA private key | server `<attestation root>/ca.key` (+ `ca.crt`) | Its public root is pinned inside the APKs already installed on the Pin. Lose the key and no device-attestation credential the installed Pin accepts can ever be minted again. | `protected.tar.gz` |
| DeviceUser CA private key | server `<DeviceUser root>/duc-ca.key` (+ `duc-ca.crt`) | Signs the client certificates the mTLS edge checks. Lose it and no new device certificate verifies. | `protected.tar.gz` |
| Pin signing keystores | operator machine `~/.config/ai-pin-revival/secrets/pin/*.keystore` + `signing.env` | Android refuses an update signed by a different key. Lose these and no signed upgrade can ever be installed on the Pin already in the wearer's hand. | **no server backup** — only a `--fetch` bundle |
| Center channel key | server `/home/anders/carry-center-data/channel-key.json` | The AES key Center seals wearer content with. Lose it and everything already sealed stays sealed. | `center-data.tar.gz` |
| Cosmos key material | server volume `humane-carry-clone_carry-state` | Holds the device channel keys. The Pin mints its key id once and never re-establishes it. | `cosmos-state.tar.gz` |

**Do not assume where the two CA roots live.** The backup does not: it reads the
active root off the running container's read-only bind and accepts either the
canonical `~/ai-pin-revival/private/{attest,duc}` or the legacy
`/home/anders/carry-{attest,duc}`, refusing anything else
(`platform/deploy/vps/remote/common.sh:1256-1297`). Whichever it found is written
into `active-security-roots.tsv` in every backup, and the fetch-side key-material
proof follows that file rather than a constant. Both pairs of directories existed
on the live host when this was checked (2026-08-11), and `protected.tar.gz`
restores absolute paths — so a rebuilt host can easily end up with two plausible
roots and a Compose model pointed at the wrong one, which mints certificates no
installed Pin will accept. `active-security-roots.tsv` in the bundle you are
restoring from is the only statement of which one was live; read it before you
set `REVIVAL_ATTEST_DIR`, `REVIVAL_DUC_DIR` or `REVIVAL_PRIVATE_DIR`, which are
what `platform/compose/production.yaml:74-75` and `:155-156` bind from.

Four of the five are captured by the backup — and every backup the server has
ever written lives on the same filesystem as the thing it protects: checked on
2026-08-11, 59 backups, 2.6 GB, on the same `/dev/sda1` as `private/`. Redundant
copies of a file on the disk that would be lost are not redundancy. Losing that
disk loses the attestation CA *and* all 59 backups that would have rescued it, in
one event. The fifth — the Pin signing keystores — is on one laptop and appears
in no server backup at all.

`./revival backup --fetch` is the command that makes that untrue. Nothing else
in this project produces a copy of either half that is not on the machine that
would lose it.

## Making an off-host copy

```sh
./revival backup --fetch                      # bundle lands in $REVIVAL_BACKUP_DIR
./revival backup --fetch --fetch-dir /Volumes/…/revival   # or straight to removable media
```

This runs the ordinary verified backup on the server, then:

1. pulls that one backup directory to the operator machine over SSH;
2. re-verifies it here — every file against `SHA256SUMS`, and `BACKUP_ID`
   against the backup that was asked for;
3. proves the irreplaceable key material is really inside `protected.tar.gz`,
   by re-hashing those four members out of the archive rather than trusting the
   inventory that describes it;
4. copies the operator-only half in beside it — the whole of
   `${REVIVAL_SECRETS_DIR}/pin`, not just the store `signing.env` names, because
   the keystore beside it is equally unrecoverable and is referenced by nothing;
5. writes `RECOVERY.json` naming both halves with their digests.

The capture refuses rather than half-succeeds: a `signing.env` that is missing, a
`PIN_SIGNING_STORE_FILE` it does not name, a store that is empty, a symlink, or a
path *outside* `${REVIVAL_SECRETS_DIR}/pin` all stop the command
(`platform/deploy/vps/backup.sh:196-231`). That last rule is why the directory
copy is complete — with one exception to know about: if you have set
`REVIVAL_PIN_EMBEDDED_PATCH_SIGNING_STORE_FILE` to a keystore outside that
directory, nothing captures it. Move it inside, or it is in no bundle.

The result:

```
<backup-dir>/<backup-id>/
  RECOVERY.json     both halves, with digests, and a pointer back to this page
  host/             byte-identical copy of the server's backup directory
  operator/         Pin signing keystores and signing.env
```

**`RECOVERY.json` is written last and only on success.** A directory without it
is not a backup: the pull or the operator capture failed, and the command said
why on stderr.

**Its presence is not proof the operator half is there.** If
`${REVIVAL_SECRETS_DIR}/pin` does not exist at all, the capture emits a warning,
returns success, and the index is still written — with an empty
`operatorHalf.files` and a `note` saying no Pin signing material was present
(`platform/deploy/vps/backup.sh:198-201`, `:259-262`). That is the one bundle
shape that looks complete and is not. Open `RECOVERY.json` and check that
`operatorHalf.files` is non-empty; a warning on stderr is easy to scroll past,
and the material it is warning about exists nowhere else.

The bundle contains every private key in the system. Keep it encrypted, keep it
off the server, and keep at least one copy somewhere neither the server nor the
laptop can take with it.

`./revival drift` fails when the newest server-side backup is older than 36
hours; that guard says nothing about whether an off-host copy exists. Only the
presence of a recent bundle does.

## Rebuilding the server from a bundle

Work from `host/` inside one bundle. Every step below is the same operation the
backup itself performs and verifies on every run — the volume archives, the
protected archive and the three SQL dumps are each restored into isolated
targets and compared against the source before a backup is allowed to succeed.
That is why this order is trustworthy: it is exercised continuously, not
written from memory.

**0. Provision the host.** Ubuntu on arm64, hostname `anders-server`, user
`anders`, Docker, and `~/ai-pin-revival` owned by that user. The deploy drivers
refuse to run against any other identity.

**1. Verify the bundle before relying on it.**

```sh
cd <bundle>/host && sha256sum -c SHA256SUMS
```

**2. Restore the protected paths.** This is the step that brings back both CA
private keys, and it must preserve ownership, modes and extended attributes:

```sh
sudo tar --numeric-owner --acls --xattrs --xattrs-include='*' -xzpf protected.tar.gz -C /
```

`protected.paths` lists exactly what that archive holds, and it is the file to
read — not this page — because it is generated from the host that was backed up
(`platform/deploy/vps/remote/backup.sh:672-751`). It always includes both CA
roots, `/etc/nginx/{nginx.conf,sites-available,sites-enabled}`,
`/etc/systemd/system/penumbra-center-bridge.service`, `/etc/penumbra` and
`/var/lib/penumbra-center`; and, when they existed on the source host,
`~/ai-pin-revival/private`, `/home/anders/carry-edge`, the three private env
files, the Keycloak theme, `/etc/nginx/conf.d`, `/etc/cloudflared` and
`~/.cloudflared`. `protected-presence.tsv` records which optional paths were
present, so an absence is visible rather than assumed.

**What it does not hold: `/etc/nginx/streams-enabled/`.** That directory is not
in either list, so `protected.tar.gz` restores an `nginx.conf` whose
`stream { include /etc/nginx/streams-enabled/*.conf; }` block points at nothing.
Since the device edge landed, the public `:443` is owned exclusively by
`/etc/nginx/streams-enabled/ai-pin-revival-device-edge.conf` and Center's TLS
listener moved to a loopback port
(`platform/deploy/vps/remote/domain.py:29`, `platform/edge/nginx/ai-pin-revival-center.conf.template:49`).
A restored host therefore serves **nothing at all on `:443`** — not the device
plane and not the dashboard — and nginx reports no error, because an `include`
glob that matches no file is legal. Only a deploy puts that file back; see
step 7.

**3. Recreate the four external volumes and restore them.** The names are fixed
(`external: true` in `platform/compose/production.yaml`):

```sh
for volume in carry-state carry-pgdata prometheus-data grafana-data; do
  docker volume create "humane-carry-clone_$volume"
done
```

then, for each archive/volume pair — `cosmos-state.tar.gz` → `carry-state`,
`postgres-data.tar.gz` → `carry-pgdata`, `prometheus-data.tar.gz` →
`prometheus-data`, `grafana-data.tar.gz` → `grafana-data`:

```sh
docker run --rm --network none \
  -v "humane-carry-clone_<volume>:/restore" \
  -v "$PWD/<archive>.tar.gz:/backup/data.tar.gz:ro" \
  <helper-image> sh -euc 'tar -xzpf /backup/data.tar.gz -C /restore'
```

Use the digest-pinned helper image named in `platform/deploy/vps/remote/common.sh`
(`HELPER_IMAGE`), so the restore runs the same image the backup verified with.

**4. Restore Center's bind directory.**

```sh
sudo mkdir -p /home/anders/carry-center-data
sudo tar --numeric-owner --acls --xattrs --xattrs-include='*' \
  -xzpf center-data.tar.gz -C /home/anders/carry-center-data
```

This is where `channel-key.json` comes back. Its mode and owner are recorded in
`invariants.tsv`; check them afterwards, because Center reads an unreadable key
store as "first run" and would mint a new identity over it.

**5. Restore PostgreSQL.** `postgres-data.tar.gz` (step 3) is a physical
snapshot of a cleanly stopped cluster and is the fastest path — start the
Postgres container against the restored `carry-pgdata` volume, using the image
recorded in `postgres-restore-image-id.txt`.

If you instead rebuild logically into a blank cluster, restore in this order and
no other, as the backup's own verification does:

```sh
gunzip -c postgres-globals.sql.gz | psql -X -v ON_ERROR_STOP=1 -U <bootstrap> -d postgres
gunzip -c cosmos.sql.gz          | psql -X -v ON_ERROR_STOP=1 -U <bootstrap> -d postgres
gunzip -c keycloak.sql.gz        | psql -X -v ON_ERROR_STOP=1 -U <bootstrap> -d postgres
```

`postgres-globals.sql.gz` is `pg_dumpall --globals-only` — roles, memberships and
tablespaces, which is why it goes first. The two database dumps are written
`--clean --if-exists --create` (`platform/deploy/vps/remote/backup.sh:623-629`),
so each of them drops and recreates its own database and is safe to re-run.

The `keycloak` database is the only place the realm exists — clients, session
lifetimes, theme binding, and the wearer's account. There is no realm export in
this repository for production; `keycloak.sql.gz` is it.

**6. Prove the restore.** `invariants.tsv` carries the expected row count for the
eight `carry_*` relations the system cares about, the Cosmos state volume's file
and byte counts, and the channel key's digest, mode and owner
(`platform/deploy/vps/remote/common.sh:1673-1703`). `postgres-data.tsv` carries
one line per relation in *both* databases with its kind, its row count and a
digest over its rows; `postgres-schema.tsv` carries the schema semantics. A
restore that does not reproduce those has not finished.

Compare `postgres-data.tsv` **through its `postgres-data.tsv.columns` sidecar**,
not column-for-column. The digest is taken over `to_jsonb(row)`, which encodes
the schema as well as the data, so a migration that merely adds a nullable column
changes every digest without moving a byte of anyone's data. The sidecar records
which columns each digest was taken over, so projecting onto it stays blind to an
additive change while still catching a changed value, a vanished row, or a
dropped column — that last one fails loudly, because the projection no longer
resolves (`platform/deploy/vps/remote/common.sh:2153-2163`). Backups taken before
the sidecar existed have none; the capture then falls back to the live column
list, which is the older, stricter behaviour.

Expect one legitimate difference: the reviewed data-removal statement in
`0005_device_status_namespacing.sql` and the `carry_memory.thumbnail_count`
backfill are both held back unless `CARRY_ALLOW_DATA_REMOVALS=1` is set on the
Cosmos workload, so a restored stack reproduces the backup's counts rather than a
post-cleanup shape. That is the intended result here — see
[operations](operations.md#what-a-deploy-will-not-do-to-the-wearers-rows).

**7. Re-point DNS and the tunnel, and give `:443` an owner again.**
`cloudflared/` in the backup holds the route transaction evidence (`before.yml`,
`desired.yml`, the journal, and which state was active). Bring the tunnel up
against the restored `~/.cloudflared` credentials before opening nginx.

Then put the device edge back. As step 2 said, `protected.tar.gz` does not carry
`/etc/nginx/streams-enabled/`, and the restored Center vhost listens only on its
loopback TLS port — so until a deploy renders and installs the stream file,
nothing binds the public `:443`. Two things have to be true before that deploy
can succeed:

- `/etc/nginx/nginx.conf` must contain a `stream { include
  /etc/nginx/streams-enabled/*.conf; }` block. On a restored host it does,
  because `nginx.conf` is in `protected.tar.gz`. On a host built from scratch
  nothing in this repository writes it — add it by hand. The deploy creates the
  directory itself when it installs the file.
- Exactly one file in the whole expanded configuration may bind a non-loopback
  `:443`. The deploy parses `nginx -T` between `nginx -t` and the reload and
  refuses both zero owners and two (`platform/deploy/vps/remote/domain.py:219-261`),
  because `nginx -t` calls an `http`/`stream` collision on one socket "syntax is
  ok" and the master then fails to bind — which is how this port previously took
  the whole host's ingress down. If you hand-edited a vhost back onto `:443`
  during recovery, remove that listener first.

`./revival deploy production` performs the install; `./revival drift` afterwards
re-checks the stream file's digest and re-runs the `:443` owner check, so a host
that came back without it fails drift rather than looking healthy.

**8. Restore the operator half** on the machine that will build Pin releases:
copy `operator/` back to `~/.config/ai-pin-revival/secrets/pin/`. The build
enforces the modes exactly — every file `0600`, and no group or other bits
anywhere on the directory (`platform/deploy/pin/build.mjs:133-169`) — so restore
them as `0700` directory, `0600` files or the first build fails on permissions.
`signing.env` refers to the keystore by absolute path, and that path is resolved
and re-checked (`build.mjs:285-291`) — fix it if the new machine's home directory
differs, or `./revival pin release build` will refuse.

What no backup contains, and what you therefore rebuild rather than restore:
container images (repackage the release), the release archives themselves, and
anything on the Pin.

## Restoring a database

**There is no command for this, and rollback is not one.**

`./revival rollback --deployment ID` moves the release pointer back. It takes a
fresh verified backup first, returns the previous release's containers, and
prints `databases were not restored` when it succeeds. Writes made after the
cutover — notes, captures, memories, device status — are still there when it
finishes. That is deliberate: rolling an app back is reversible, discarding a
wearer's data is not.

Earlier revisions of `docs/operations.md` and the CLI help advertised
`./revival rollback --confirm-database-restore ID`. No script ever parsed it. It
failed with a bare usage error, which reads as a typo, at the one moment someone
would type it. That claim has been removed, and both surfaces that can be handed
the argument now refuse it by name and point here: the CLI (`revival:1160-1168`)
and the local wrapper (`platform/deploy/vps/rollback.sh:18-22`). Do not
re-document the flag — if it ever comes back it has to come back as a script that
parses it, and this page is the procedure that flag would have to implement.

To actually restore a database, do it deliberately:

1. **Take a backup first.** `./revival backup --fetch`. You are about to discard
   data; the current state must be recoverable before you start.
2. **Pick the source.** Every backup directory on the server
   (`~/ai-pin-revival/backups/<id>`) holds `postgres-globals.sql.gz`,
   `cosmos.sql.gz` and `keycloak.sql.gz`. Verify it with `sha256sum -c
   SHA256SUMS` before using it.
3. **Know what you are discarding.** Compare `invariants.tsv` in that backup
   with the current values: the difference is what the restore deletes. There
   is no partial or point-in-time restore here.
4. **Stop every writer**, not just the obvious ones. Compose services, the
   `penumbra-center-bridge.service` unit, and anything else holding the durable
   volumes. `backup.sh` derives that set from live mounts rather than a service
   list, and `quiesced-containers.txt` in any backup records what it stopped —
   use it as the checklist.
5. **Restore into the running cluster** with the dumps from step 2, globals
   first. `cosmos.sql.gz` and `keycloak.sql.gz` are written
   `--clean --if-exists --create`, so each one drops and recreates its own
   database; `postgres-globals.sql.gz` is `pg_dumpall --globals-only` and only
   restores roles, memberships and tablespaces.
6. **Verify before reopening.** Re-run the comparison from step 3 and confirm
   the restored counts match the backup's, then start the writers and run
   `./revival canary`.

If the restore is part of undoing a bad deploy, do the app rollback first and
decide about the database separately. They are different decisions with
different blast radii, and the moment they get bundled into one flag is the
moment someone discards a day of the wearer's memories to fix a web bug.
