# Working in this container

## Your workspace

| Path | What it is |
| --- | --- |
| `/workspace/source` | Your Luma checkout. Work here. |
| `/workspace/HANDOFF.md` | Your hand-off, published as the pull request description. |
| `/workspace/state` | `LUMA_DATA_DIR`: `./luma` keeps its build state here, outside the checkout. |
| `/workspace/state/stock-reference` | The decompiled stock apps, read-only (skill `luma-stock-reference`). Absent when the host has none. |
| `/workspace/cache` | `CARGO_HOME`, `CARGO_TARGET_DIR`, the pnpm store and Bun's cache for commands you run yourself. |

`/workspace/source` is a scratch Git repository with one commit, so
`git status` and `git diff` show your edits. Never commit, push, or change
Git configuration or remotes: after you stop, the host collects your files
and publishes them through Luma's source-control service. A sparse checkout
holds only the directories your task selected; a missing file is outside the
selection, not deleted, and a file you create outside it blocks publication.

You run as an unprivileged user, without sudo or Docker. The image carries
Luma's pinned toolchain: Bun 1.4.2, pnpm 12.6.0, Rust 1.91.1 with clippy and
rustfmt, protoc, Python 3, Git, `rg` and `jq`. You can reach package
registries.

## Verify your change

Run what proves your change before you hand off; the skill `luma-checks` has
the commands that work here. CI runs every lane again, including those this
container cannot: the Postgres-backed Cosmos tests and the Pin builder's
Android unit tests. Never report a check you did not run.

## Owner-only steps

The owner is not present. When the task needs an owner-only action from
AGENTS.md (credentials, DNS, GitHub settings, a physical Pin, a production
deploy or release), do not attempt it: prepare it, name the exact page or
command in your hand-off, and finish.

## Hand off

Before you finish, write `/workspace/HANDOFF.md`:

    # Remove the dead .luma-scm-pending.json ignore rule

    What changed and why, for a reviewer who has not read your task.
    The stock evidence behind it (class and method), or what is INFERRED.
    Each check you ran and its result, and what only CI covers.
    Owner steps, if any.

The first line is the pull request title: a short imperative sentence about
the change, as in the example, without a prefix such as "Hand-off:". The rest
becomes its description. The host refuses to publish a hand-off or file that
contains decompiled stock code or a credential.

Then report completion. This is your last command, and the host waits for it:

    sciontool status task_completed "One-line summary"

If you cannot finish, write the hand-off, then report
`sciontool status blocked "the reason"` instead.
