# Luma source-control prototype

This is an independent experiment inspired by the supplied Anthropic article. It is not Anthropic's private Scion and is unrelated to Google's Scion agent orchestrator.

The server owns changesets, refs, merges, history and the Git bridge. Clients request only selected paths and their blobs. A changeset stores only changed paths relative to its first parent. Files are immutable SHA-256 blobs. Changesets are immutable SHA-256 canonical JSON records. Ref updates use compare-and-swap; creating a changeset does not move a ref.

Luma remains at https://github.com/TheAndersMadsen/luma. The initial import starts prototype history at a snapshot of GitHub main. The bare Git bridge retains the full Git history and attaches exported commits to that original history. Only branches beginning `scion-prototype/` can be published. Pushes are never forced. Importing subsequent GitHub main snapshots advances `github`; it advances prototype `main` only when main still points at the previous import.

## Installed on m1box

- Source: `/srv/dev/luma-scm`
- Private persistent state: `/srv/state/luma-scm`
- Service: `systemctl --user status luma-scm.service`
- API: `http://127.0.0.1:8100`
- Credential: `/srv/state/luma-scm/token`, mode 600; do not commit it.
- GitHub authentication: the existing m1box gh login through Git's credential helper.

`GET /health` returns exactly `OK`. Other routes require `Authorization: Bearer` with the token from that file. The client reads the file itself.

Run on m1box:

```sh
cd /srv/dev/luma-scm
python3 client.py api GET /v1/refs
python3 client.py checkout /srv/dev/luma-scm-cosmos --at main --prefix cosmos/
python3 client.py api POST /v1/github/import --json '{}'
```

For access from your Mac, forward port 8100 over SSH. Keep the API on loopback; it is an owner-only prototype.

## API

| Method | Route | Body/query | Result |
|---|---|---|---|
| POST | `/v1/blobs` | Raw file bytes | SHA-256 hash |
| GET | `/v1/blobs/{hash}` | | Raw file bytes |
| POST | `/v1/changesets` | `parent`, `message`, `changes` | New immutable changeset |
| GET | `/v1/changesets/{id}` | | Delta and parents |
| GET | `/v1/refs` | | Named refs |
| POST | `/v1/refs/{name}` | `expected`, `target` | CAS update, or 409 |
| GET | `/v1/files` | `at`, optional `prefix` | Sparse file metadata |
| GET | `/v1/diff` | `base`, `head` | Changed paths and before/after blobs |
| GET | `/v1/history` | `at`, `path` | First-parent path history |
| POST | `/v1/merge` | `left`, `right`, `message` | Two-parent changeset or 409 conflicts |
| POST | `/v1/rebase` | `changeset`, `onto`, optional `message` | Squashed delta replay or 409 conflicts |
| POST | `/v1/github/import` | `{}` | Import current GitHub main |
| POST | `/v1/github/publish` | `at`, `branch` | Non-forced push to experimental branch |

A change is `{ "path": "cosmos/file", "blob": "SHA-256 from blob upload", "mode": "100644" }` or `{ "path": "cosmos/file", "delete": true }`. Executables, symlinks and Git links retain their Git modes. The thin client's `commit` command uploads files and creates a changeset; ref movement and publication are explicit API operations.

## Practical limits

This is a single-host SQLite prototype with serialized writes, not the article's distributed, lock-free service. Tree reconstruction and history walk stored deltas, so long histories need derived indexes. Blobs are stored as raw files; no distributed cache, virtual filesystem, blame index, per-path IAM or garbage collection is implemented. Merge resolution operates at whole-file granularity. Rebase replays the net branch delta rather than recreating each commit. There is no background GitHub sync: import and publish are explicit. GitHub remains authoritative for production work.

The checkout client refuses nonempty destinations, traversal, escaping symlinks, path collisions and submodule materialization. Requests are limited to 32 MiB. Run with one server process per state directory.

## Verification

`python3 -m unittest -v test_e2e.py` exercises real HTTP requests and real Git repositories: authentication, deltas, sparse binary reads, deletion, path history, concurrent CAS, disjoint merge/rebase, conflicting edits, executable/symlink import, repeat import, original Git ancestry, sequential mirror commits, rejected divergent pushes and restart persistence. Failure cases were written before implementation.
