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

After an update merges main into unlanded work, run `luma-scm publish` to update
the existing GitHub PR. `luma-scm land` then requests its CI-gated merge.

## Run an agent

```sh
luma-scm agent start docs-review \
  "Review docs/source-control.md for unclear instructions and improve them. Keep the change small." \
  --wait
luma-scm agent status docs-review
```

Each agent works in its own full checkout of main; `--prefix` narrows it, but
most `./luma` checks need the whole tree. `--wait` waits until the agent reports
completion, stops it and submits its edits to the source-control service.
Publication then continues in the background. Add `--auto-merge` to request
CI-gated landing. A name identifies the job, its work ref `work/NAME` and its
branch `scion/NAME`, so give each task a new name. To continue an earlier
agent's unlanded work, start the new job with `--at work/NAME`.

Agents run Claude Code with `claude-opus-5-5`. `--harness codex` or
`--harness opencode` picks another of the owner's accounts, and
`LUMA_SCION_HARNESS` changes the default. Codex uses the model in the host's
`~/.codex/config.toml` and OpenCode the one in
`~/.config/opencode/opencode.json`; `--model` overrides either.

For a task started without waiting, or after disconnecting:

```sh
luma-scm agent wait docs-review
luma-scm agent submit docs-review
luma-scm agent stop docs-review
luma-scm agent delete docs-review
```

`wait` returns early when the agent needs a person: it waits for input, is
blocked, crashed, went offline or exceeded its limits. Inspect it, then submit
or stop it. Wait and submit are restartable. Submission collects a stopped
agent's source from its recorded workspace and uses a persistent request ID.
The trusted base and publication metadata stay on the host outside the agent's
mount. An agent that changed nothing ends as `no_changes`.

The agent's hand-off, `/workspace/HANDOFF.md`, becomes the pull request: its
first line, a `# ` heading, is the title and the rest the description, above a
footer naming the job, harness, model and base. `--message` on `start` or
`submit` sets the title instead. Publication is public, so submission refuses
a hand-off or changed file that contains decompiler output or a credential and
marks the job `refused`; fix the workspace and submit again.

`delete` removes the Scion agent, the job's Hub project and its folder,
including several gigabytes of build state. It refuses unsubmitted work unless
you pass `--force`. The work ref and the GitHub branch stay. Delete a job once
its pull request has landed or closed.

To watch an agent, `scion attach docs-review` in the job's project directory
(`agent status` shows it) opens its terminal; detach with Ctrl-B, then D. The
Scion dashboard shows every job as a project named `luma-NAME`. It is available
through a Mac SSH tunnel:

```sh
ssh -N -L 18080:127.0.0.1:8080 m1box
```

Open `http://localhost:18080` and choose **Continue with GitHub**. The configured
owner is `TheAndersMadsen`. Keep the tunnel running while using the dashboard;
the OAuth callback is registered for this exact hostname and port. The dashboard
operates agents; `luma-scm` operates source history, workspaces and publication,
so start Luma agents with `luma-scm agent start`.

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
`/srv/state/scion/dashboard.env` with mode 600.

### Agent environment

Agents start from the `luma` Scion template in `tools/scion/templates/luma/`. It
points them at the repository's AGENTS.md, describes the container and the
hand-off, and adds two skills: `luma-checks`, the checks that run in the
container, and `luma-stock-reference`. A template cannot set an image, mounts
or limits, so `luma-scm agent start` supplies them:

- The image `luma.invalid/agent-HARNESS:current`: the Scion harness image plus
  Luma's pinned Bun, pnpm and Rust from
  `platform/containers/pin-builder/toolchain.json`, protoc and, for Claude, a
  current Claude Code. The agent runs without sudo. The reserved `.invalid`
  domain keeps Scion and Docker from ever pulling that name.
- The job folder `~/.local/state/luma-scm/agents/NAME`. Only its
  `luma-NAME/workspace` is mounted, at `/workspace`: `source` is the checkout,
  `state` the agent's `LUMA_DATA_DIR`, `cache` its Cargo, pnpm and Bun state,
  and `HANDOFF.md` the hand-off. No agent sees another job.
- The stock reference from `/srv/dev/luma-stock-reference`, read-only at
  `$LUMA_DATA_DIR/stock-reference`, so `./luma pin doctor` finds it and the
  evidence-bound tests run against it. When the host has none, agents start
  without it and follow AGENTS.md.
- Six CPUs and 12 GiB of memory, and at most four hours per task (the
  template's `max_duration`).

In the container, `./luma check center`, `check platform` (`--full` after
`pnpm install --frozen-lockfile --prod=false`) and `check changed --base HEAD`
run as they do on a laptop. The Cosmos and Pin lanes need Docker, which agents
never get, so agents run those lanes' Cargo and Bun steps directly. The
Postgres-backed Cosmos tests and the Pin apps' JVM tests run only in CI, which
gates every landing.

Agents should use Docker's bridge network: there they reach the internet and,
through `scion-agent-gateway.service` on the Docker bridge address, the Scion
Hub, but none of m1box's loopback services. m1box's firewall drops what
containers send to host ports, so until the owner allows the gateway port
(`sudo ufw allow in proto tcp from 172.16.0.0/12 to 172.17.0.1 port 8080`,
then run the installer again) the installer keeps Scion's loopback Hub
endpoint, which puts agents on the host network.

### Agent host

`tools/scion/install` sets up the agent host and is safe to repeat. Run it on
m1box from an up-to-date checkout:

```sh
ssh m1box
luma-scm checkout /srv/dev/luma-main --at main   # later: cd /srv/dev/luma-main && luma-scm update
cd /srv/dev/luma-main
tools/scion/install
```

It builds the agent images; installs and syncs the `luma` template; runs the Hub
forwarder for the Docker bridge and points Scion's `server.hub.agent_endpoint`
at it once a container can reach it; makes `luma` and `claude` Scion's default template and harness and turns
off new projects' scratchpads, which would live on `/srv/state`; links
`~/.local/state/luma-scm` to `/data/luma-agents`, where job folders and their
build state live; and copies `tools/source-control` to `/srv/dev/luma-scm`,
restarting the service when its server modules changed. Run it again after
changing the template, the image or the toolchain, and to pick up a newer
Claude Code. `--harness` builds only the named images.

Docker keeps images on the root file system of m1box, which has little room;
the installer refuses to pull or build without enough of it. Each agent image
adds about 1.6 GB to its harness image.

Each harness signs in with one of the owner's accounts through a Scion user
secret: Claude Code with `CLAUDE_CODE_OAUTH_TOKEN`, Codex with `CODEX_AUTH`
(its `auth.json`) and OpenCode with `OPENCODE_AUTH` (its `auth.json`). Storing
or replacing one is an owner step. Claude agents take a token that
`claude setup-token` issues for this purpose. A copy of an interactive Claude
login does not work in a container, and refreshing it would sign the owner's
own Claude Code out. To store the token on m1box without it reaching argv or
shell history:

```sh
claude setup-token          # on the Mac; prints the token after the browser sign-in
ssh m1box
read -rs TOKEN && (umask 077; printf %s "$TOKEN" > ~/.claude-agent-token) && unset TOKEN
scion --global hub secret set --type environment --target CLAUDE_CODE_OAUTH_TOKEN \
  CLAUDE_CODE_OAUTH_TOKEN @$HOME/.claude-agent-token
shred -u ~/.claude-agent-token
```

`luma-scm agent start` refuses a harness whose secret is missing. To provide
or refresh the stock reference, the owner copies it from a machine that has
one, for example `rsync -a ~/.local/share/luma/stock-reference/
m1box:/srv/dev/luma-stock-reference/` from the Mac.

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
