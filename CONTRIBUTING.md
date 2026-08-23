# Contributing

Ai Pin Revival has four product boundaries: `center/`, `cosmos/`, `pin/`, and
`platform/`. Versioned cross-component behavior lives in `contracts/`. Start
with [architecture](docs/architecture.md), then keep each change inside the
smallest boundary that owns it.

## Contributor setup

The supported versions are pinned in
`platform/containers/pin-builder/toolchain.json`:

- Node.js 22.14.0 or newer on the Node 22 line.
- Rust 1.91.1 exactly. The root `rust-toolchain.toml` selects the compiler,
  Cargo, rustfmt, and Clippy together when rustup is installed.
- JDK 17 when running the Pin source gate.
- Docker Compose 2.33.1 or newer for the product stack.

Prepare a source checkout:

```sh
./revival setup contributor
./revival init
./revival doctor
./revival version
```

`doctor` checks the local product runtime and does not require Rust. The
contributor and source gates check the pinned compiler where needed.

Alternatively, reopen the checkout in the checked-in Dev Container. It supplies
Node 22.14.0, Rust 1.91.1, and Docker-outside-of-Docker from an immutable base
digest and exact Feature lockfile. A project/devcontainer-scoped cache volume
contains only rebuildable targets and package caches. A different owner-only
volume holds tool configuration plus Revival config, secrets, data, backups,
and release state. It does not supply credentials, private Pin assets, signing
keys, production access, or a device, and no release path treats its cache as
authority.

Provider credentials belong only in the protected runtime file created by
`init`. Use [configuration](docs/configuration.md); never add a secret to source,
Compose, arguments, fixtures, logs, or documentation.

## Run and test

```sh
./revival build && ./revival up       # Center at http://127.0.0.1:4000
./revival test                        # repository release gate
./revival test --source               # adds Pin source/toolchain checks
./revival pin check                   # focused Pin source path; no signing secrets
```

`pin check` runs both Pin Cargo suites with external targets and the
credential-free contract/common Gradle unit tasks in the canonical pinned
builder. It captures one deterministic, recursively watched source generation
into sealed tar/manifest memfds, uses fresh container-private tool homes,
and shares with the debug lane only the narrow Cargo registry/git, Gradle
caches/wrapper, and npm content-cache directories. The host Docker client uses
an anonymous descriptor-held empty config and the local Unix socket. This lane never signs,
installs, or opens a device; signed role builds remain a release-stage check.
The compiler lane requires Linux x86_64 guest-visible kernel/userspace and
Intel/AMD CPU evidence and refuses observed binfmt, QEMU/TCG, Rosetta, or other
translation markers. These are negative filters, not proof that translation or
a hypervisor is absent. ARM, detected translation, and macOS hosts stop before
Docker and direct the all-five proof to hosted native-x64 CI. That refusal occurs before `--changed` or external
state preparation. On an accepted host, one long-lived trusted broker installs a
parent/name watch before every nofollow open or staged creation from the
filesystem root. It holds the exact data, build, lane-state, five cache, tool,
Docker-config, and sealed-source descriptors through source policy, changed
selection, Docker build/run, and final revalidation. Source policy and Node
tests run from a verified private extraction; `--changed` resolves held refs and
uses only config-free `cat-file`/`ls-tree` object plumbing against the sealed
manifest. Docker builds from the sealed tar on stdin and mounts only the sealed
tar/manifest descriptors, never the live checkout. A later source edit therefore
belongs to the next invocation and cannot change the current build.
The real-tree policy likewise uses fixed trusted shell and Node executables;
an ambient `PATH` cannot replace the scan.

## Fast local loop

Use the development and component checks while editing; reserve the complete
release gate above for a release candidate:

```sh
./revival dev center                  # Turbopack hot reload + Compose Watch
./revival dev down                    # stop only the isolated development stack
./revival check center                # typecheck + server/UI + Spotify adapter tests
./revival check cosmos                # fmt + clippy + full workspace tests
./revival check cosmos TEST_FILTER    # fmt + matching Cargo tests only
./revival check platform              # behavior-focused platform acceptance
./revival check platform --full       # every top-level Node acceptance test
./revival pin check                   # credential-free canonical Pin checks
./revival check changed               # checks selected from Git changes
./revival check changed --base REF    # explicit comparison base
```

`dev center` builds a distinctly tagged Center development image once, starts
its dependencies, then synchronizes source edits into the container. Changes
to `package.json`, `package-lock.json`, or the development image rebuild it;
wire-contract changes sync and restart Center. `node_modules` remains in the
image and `.next` remains in a named development volume, never in the checkout.
The watcher uses the isolated `ai-pin-revival-dev` Compose project, so it cannot
replace an existing `ai-pin-revival` runtime with development containers. Stop
it with `./revival dev down` when finished; its cache volumes are retained.

The component checks run directly from the working tree. Center runs `npm ci`
only when its package manifests, project `.npmrc`, Node/npm versions, OS, or architecture change,
then reuses the
working-tree `node_modules`; npm's download cache and TypeScript incremental
file stay below external `REVIVAL_BUILD_DIR`. User npm behavior settings are
ignored during installation. Cosmos reuses one external Cargo target. Platform
checks default to behavior-focused acceptance tests without cloning or hashing
the repository; `--full` dynamically adds every top-level Node acceptance test.
CI and release checks own layout and source policy explicitly. Release-candidate
provenance and publication checks remain in
`./revival test` and release workflows, so run those boundaries from a clean
isolated checkout rather than a development tree containing ignored dependencies. Ordinary
Cosmos wrapping-key tests generate one process-local 2048-bit key in memory
through a `cfg(test)`-only seam. Each test still gets fresh mutable
`KeyMaterial`, including the empty -> generate -> persist -> restart path; no
private key bytes are stored in source or release packages. One dedicated
`cosmos-crypto` test still generates a real 4096-bit key and verifies explicit
RSA-OAEP/SHA-1 compatibility. That nondeterministically expensive test is
ignored by the ordinary workspace suite; the release gate first proves that
exactly one test has its expected name, then invokes it by exact name.
Production key generation is not feature-switched and remains 4096-bit. Every
check prints concise stage timings so a regression is visible without profiling
a complete release.

The operational toolchain is Rust 1.91.1 everywhere above. Cosmos keeps
`rust-version = "1.85"` as package MSRV metadata for its own source contract;
that lower metadata floor does not select the compiler used by contributors,
CI, Docker builds, or releases.

A nonempty Cosmos `TEST_FILTER` is first passed to Cargo/libtest with `--list`.
The check fails when it matches zero tests instead of reporting a false green;
an explicitly empty filter is invalid.

`check changed` compares with `origin/HEAD` when available, then `origin/main` or
`origin/master`. If no remote default exists, it checks the full tracked
tree instead of guessing from commit ancestry. It includes committed branch
changes plus staged, unstaged, and untracked files, and treats both sides of a
rename as changed. Center-, Cosmos-, and Pin-owned files select their respective checks.
Known platform, Compose, release, contract, and workflow paths select their affected
components and run the dynamic full platform inventory. Documentation and ordinary
component paths retain the fast platform subset; unfamiliar shared/root paths and
wire contracts conservatively fan out to every check, with platform in full mode.
The Pin selection uses the contributor-safe source gate;
among source checks, private signing material remains required only by
`test --source` and `release check --source`.

Platform acceptance keeps safe test files in one bounded-concurrency Node
runner. Release-only source and package fixtures remain in the full release
gate instead of slowing every edit-test cycle. Run `check platform --full` to
dynamically include every top-level Node acceptance test. CI additionally runs
the exact layout and source-policy scripts from a clean checkout.

Install and typecheck locks fail immediately and print their exact external
path. After confirming no matching check is running, remove only that printed
stale file: `REVIVAL_BUILD_DIR/check-state/center-npm.install.lock`,
`REVIVAL_BUILD_DIR/check-state/spotify-adapter-npm.install.lock`, or
`REVIVAL_BUILD_DIR/center/typecheck.lock`.

Keep compiler output outside the checkout. These supported commands redirect
Cargo targets, Gradle state, TypeScript incremental output, and package-manager
caches. Center's ignored `node_modules` is the sole development dependency
directory in the checkout. The release layout gate still rejects it and all
other generated directories, which is why releases use a clean isolated tree.

Run the contract and clean-install checks when changing operator setup:

```sh
node --test platform/deploy/acceptance/operator-setup-contract.test.mjs
node --test platform/deploy/acceptance/cli-help.test.mjs
node --test platform/deploy/acceptance/cli-setup.test.mjs
node --test platform/deploy/acceptance/cli-config.test.mjs
node --test platform/deploy/acceptance/fresh-install.test.mjs
```

## Ground rules

- Preserve behavior across refactors: add the stable export, run the nearest
  test, move the caller, and only then remove the old path.
- Exact package names, gRPC names, ALPN values, certificate subjects, settings,
  and storage keys are compatibility boundaries. Do not rename them for style.
- Wearer language stays short and concrete. Operator diagnostics keep technical
  detail and one actionable next step.
- Evidence labels are `observed`, `derived`, `implemented`, and `unknown`.
  Include a current source or artifact reference for compatibility claims.
- Do not commit firmware, APKs, decompiled source, keys, credentials, device
  identities, wearer data, support bundles, or production logs.
- Keep physical acceptance separate from host, release, server, and ADB health.

## Releases, deployment, and recovery

- Build and verify immutable server releases with `./revival release build` and
  `./revival release verify`.
- Build authoritative Pin releases only through the pinned GitHub-hosted
  pre-attest/sign/post-attest/publish workflow. The retired local all-in-one
  alias refuses before opening signing material; contributor/debug lanes remain
  credential-free and cannot publish.
- Preserve each operation's documented target and confirmation boundary. Do not
  add a bypass; device install/activation and named plan/confirm commands must
  stay dry-run first.
- Run production canary and drift checks after deployment.
- Run `./revival backup --confirm --fetch` after PKI changes and regularly thereafter.
- Use [recovery](docs/recovery.md) for server rebuilds and database restoration;
  rollback does not restore a database.

## CI

`.github/workflows/ci.yml` pins Node 22.14.0 and Rust 1.91.1. Independent jobs
run the complete platform/release-policy suite, Center tests and production
build, the Spotify adapter, Cosmos format/lint/tests and release-only crypto
check, Pin runtime tests, the canonical Pin builder's credential-free unit and
all-five debug-artifact lanes on native Linux x64, and the real Darwin rooted-reader test. This preserves
the former release-check coverage without serially rebuilding Center and Cosmos
after their parallel jobs. CI does not contact a device, VPS, provider, or
production service.

See [installation](docs/installation.md), the [CLI reference](docs/cli-reference.md),
and [operations](docs/operations.md) for the user-facing contracts contributors
must preserve.
