---
name: luma-checks
description: Verify a Luma change inside a Scion agent container - which ./luma check lanes run here, how to run the Cosmos and Pin Rust checks without Docker, and what only CI proves.
---

# Verify a Luma change in this container

Start from your edits, as AGENTS.md "Fast loop" describes:

    cd /workspace/source
    git status --short
    ./luma check changed --base HEAD

`check changed` picks lanes from the paths you changed and stops at the
first lane that needs Docker; run that lane's steps below instead. Iterate
with the narrowest command that proves the edit, and run each affected lane
once in full before you hand off. Times are for this host with a cold cache.

## Center and platform

| Lane | Command | Time |
| --- | --- | --- |
| Center | `./luma check center` | 30 s |
| Platform | `./luma check platform` | 20 s |
| Full platform | `pnpm install --frozen-lockfile --prod=false`, then `./luma check platform --full` | 30 s |

Run `--full` when you change `README.md` or anything under `platform/`,
`contracts/` or `.github/`; it imports Center modules, so install the
dependencies first. `check center` installs them itself.

## Cosmos

`./luma check cosmos` refuses to start without Docker, which its last step
uses for a throwaway Postgres. Run the steps of `runCosmosCheck`
(`platform/cli/checks.js`) directly:

    cd /workspace/source/cosmos
    cargo fmt --all --check
    cargo clippy --workspace --all-targets --locked -- -D warnings
    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s verify
    PYTHONDONTWRITEBYTECODE=1 python3 verify/hygiene.py
    cargo test --workspace --locked

All of it takes about three minutes cold and much less once
`CARGO_TARGET_DIR` is warm. While iterating, run `cargo test --workspace
--locked FILTER`, and first confirm with `cargo test --workspace --locked
FILTER -- --list` that the filter names your test: one that matches nothing
proves nothing. Fix formatting with `cargo fmt --all`. The Postgres-backed
tests print `SKIPPED` here because no database is offered; CI runs them.

## Pin

`./luma pin check` needs Docker for the pinned Android builder. Its host
steps run here (`platform/cli/gates.js` `runPinContributorChecks`):

    cd /workspace/source
    bun test --isolate --parallel=4 --timeout=120000 platform/containers/pin-builder/*.test.mjs
    (cd pin/runtime/core && cargo fmt --check && cargo test --locked --features iroh)
    (cd pin/bridge && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked)

The runtime core takes about a minute and a half cold. The JVM unit tests of
the Pin apps run only in CI's builder container.

## Everything else

- Source control: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tools/source-control -p 'test*_e2e.py'`
- Whitespace in changed lines: `git diff --check`

In your hand-off, name each command you ran with its result, and say which
lanes only CI covers.
