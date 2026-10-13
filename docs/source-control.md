# Source control and Scion agents

Luma's source-control service runs on m1box. It stores immutable file blobs and
changesets, serves sparse checkouts, and publishes work as normal GitHub branches
and pull requests. Google Scion runs coding agents against these workspaces.
The service is an independent implementation inspired by the supplied Anthropic
article; Google's Scion is the separate agent runner.

GitHub main is the integration authority. Existing contributors can keep cloning,
committing, opening PRs and merging through GitHub. Every 30 seconds the service
imports newly reachable main commits, preserving Git parents and authors, and
processes its durable publication queue. A server changeset ID and a Git commit
ID are distinct; the bridge records their mapping.

## Daily workflow on m1box

```sh
ssh m1box
luma-scm checkout /srv/dev/luma-work --at main --branch scion/luma-work
cd /srv/dev/luma-work
luma-scm status
luma-scm diff
```

The checkout is a normal directory with `.luma-scm.json` recording its immutable
base and work ref. Edit it with your usual editor. To fetch a subset instead,
repeat `--prefix`, for example `--prefix cosmos/ --prefix contracts/`. Include the
root build files needed by the task, or use a full checkout for cross-component
builds. Sparse selection matches a complete file or directory boundary.

```sh
luma-scm commit -m "Describe the change"
luma-scm status
luma-scm land
```

Commit detects edits, deletions, executable bits and symlinks and queues GitHub
publication. Status shows the resulting PR and failures. `land` requests merging
when the exact PR head passes Luma CI and GitHub permits the merge. Alternatively,
`commit --auto-merge` requests that behavior when committing. Pending, failed or
missing checks, review requests for changes, drafts, conflicts and branch
protection blocks prevent automatic landing. The service never uses an admin
bypass or force-pushes a work branch. GitHub performs the final merge with an
expected-head guard.

After a merge, or to incorporate another contributor's main changes:

```sh
luma-scm update
luma-scm log
luma-scm log cosmos/Cargo.toml
luma-scm blame cosmos/Cargo.toml
```

Update requires a clean workspace and merges main into unlanded work, preserving
branch ancestry. Text merges use Git's three-way merge engine; overlapping edits
and binary conflicts are reported for resolution. Committed changes outside a
sparse selection are preserved. Untracked obstructions and escaping symlinks are
never overwritten. `.gitignore` rules apply to untracked files.

## Run an agent

```sh
luma-scm agent start docs-review \
  "Review docs/source-control.md for unclear instructions and improve them. Keep the change small." \
  --prefix docs/ --prefix AGENTS.md --wait
luma-scm agent status docs-review
```

`--wait` waits for task completion, stops the agent and submits its edits to the
source-control service. Publication then continues in the background. Add
`--auto-merge` when starting a task to request CI-gated landing. Use a unique name
for each task. The model defaults to the working host Codex configuration; an
explicit `--model` overrides it.

For a task started without waiting, or after disconnecting:

```sh
luma-scm agent wait docs-review
luma-scm agent submit docs-review
luma-scm agent stop docs-review
```

Wait/submit are restartable. Submission collects a stopped agent's source from
its recorded workspace and uses a persistent request ID. The trusted base and
publication metadata stay on the host outside the agent's mount. The agent gets
its inference credential through Scion; the host keeps GitHub and source-control
credentials out of the agent container.

Agent status includes the project directory. To inspect an agent interactively,
change to that directory and run `scion attach docs-review`; detach with Ctrl-B,
then D. The Scion dashboard is available through a Mac SSH tunnel:

```sh
ssh -N -L 18080:127.0.0.1:8080 m1box
```

Open `http://localhost:18080` and choose **Continue with GitHub**. The configured
owner is `TheAndersMadsen`. Keep the tunnel running while using the dashboard;
the OAuth callback is registered for this exact hostname and port. The dashboard
operates agents; `luma-scm` operates source history, workspaces and publication.

The dashboard requires GitHub authentication, uses invite-only access, and has
development auto-login disabled. Anonymous requests to protected APIs receive
401. The m1box CLI is already signed in as the GitHub owner. Check its identity
and token expiration with `scion hub status`. To renew an expired CLI login:

```sh
ssh m1box
scion hub auth login --hub-url http://127.0.0.1:8080 --provider github --no-browser
```

Open the GitHub device-activation URL printed by that command and enter its code
in the browser. A web login and a CLI login are separate sessions. The dashboard
service starts automatically; inspect it with `systemctl --user status
scion.service` and restart it after configuration changes with `systemctl --user
restart scion.service`. OAuth credentials live in
`/srv/state/scion/dashboard.env` with mode 600. The owner's inference credential
is stored separately as the Scion user secret `CODEX_AUTH`.

## Service and recovery

- Source: `/srv/dev/luma-scm`
- State: `/srv/state/luma-scm`
- Service: `systemctl --user status luma-scm.service`
- Logs: `journalctl --user -u luma-scm.service`
- API: `http://127.0.0.1:8100`; `/health` responds with `OK`
- Owner token: `/srv/state/luma-scm/token`, mode 600; clients read the file.
- Existing GitHub authentication: host `gh` credential store.

`luma-scm api GET /v1/status` reports synchronization and publication state.
`luma-scm sync` runs a synchronization immediately. Network failures are retried
with backoff. Accepted commits survive an abrupt process exit because their
changeset, ref movement and publication job share a database transaction. Blob
files are flushed before their changesets are accepted. Retrying a commit after
a lost response recovers the same result. Resolve a blocked publication's stated
cause, then POST `/v1/publications/ID/retry` through the API client.

Run `python3 /srv/dev/luma-scm/backup.py` on m1box for a consistent snapshot. It
contains the SQLite database, blobs, Git bridge and an integrity manifest; tokens
and provider credentials are excluded. The Mac's installed backup job copies and
verifies snapshots off-machine daily, retaining the most recent 14 under
`~/.local/state/luma-scm/backups`. Its script is
`~/.local/share/luma-scm/backup_from_mac.py`; run it manually after important work.

To restore, stop the service, preserve the current state directory, copy a verified
snapshot into `/srv/state/luma-scm`, retain or reprovision the owner token with mode
600, then start the service. Existing GitHub credentials remain in the host's gh
store. Verify the restored copy first with
`python3 /srv/dev/luma-scm/backup.py --verify /path/to/backup`. A restore changes
active state and should be performed deliberately, never as an automatic response
to a transient error.

## Boundaries

This is a single-host service with a serialized SQLite writer. It has bounded
local tree/blob caches and path-history indexes; it does not implement distributed
cache tiers or high availability. Sparse checkout materializes selected files;
there is no virtual filesystem. Git remains the bridge and the blame engine.

Submodule entries survive server import/export, but client submodule checkout is
not implemented. Ambiguous crisscross merge bases require explicit resolution.
GitHub main rewrites are imported as GitHub publishes them; work refs remain
separate. Work-branch divergence is reported, never resolved by force-pushing.

Publication succeeds independently of CI; landing is a separate recorded request.
Passing CI demonstrates the configured checks, not the absence of every possible
application defect. Normal GitHub review remains available.

## Development checks

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s tools/source-control -p 'test*_e2e.py' -v
```

The tests use real HTTP, Git repositories, abrupt subprocess exits and a local
GitHub protocol fixture. Google Scion's real container/model integration is also
verified on m1box. GitHub CI includes this suite in its `CI passed` aggregate and
stores its output as `source-control-evidence`.
