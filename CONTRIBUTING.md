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
./revival check platform              # source policy + platform acceptance
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

`check platform` first scans the complete real source tree, including ignored
agent instructions and hidden source directories, then `check center` and
`check platform` make a unique, disposable Git snapshot below the external
`REVIVAL_BUILD_DIR`. Ignored editor/agent files and generated residue therefore
cannot weaken or obstruct source-layout assertions, and concurrent checks
cannot replace each other's workspace. Center and its Spotify adapter
reuse atomically published dependency seeds only when the OS, architecture,
exact Node/npm versions, normalized `npm ci --include=dev` policy, and package
manifests all match. User npm behavior settings are ignored during that install.
Each invocation gets a private copy, so test caches cannot race. Cosmos
build artifacts already use the external Cargo target directory. Ordinary
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

`check changed` compares with `origin/HEAD` when available, then the conventional
local/remote `main` or `master` branch. If none exists, it checks the full tracked
tree instead of guessing from commit ancestry. It includes committed branch
changes plus staged, unstaged, and untracked files, and treats both sides of a
rename as changed. Center-, Cosmos-, and Pin-owned files select their respective checks.
Known platform, Compose, release, and workflow paths select their affected
components; unfamiliar shared/root paths and wire contracts conservatively fan
out to every check. The Pin selection uses the contributor-safe source gate;
among source checks, private signing material remains required only by
`test --source` and `release check --source`.

Platform acceptance keeps safe test files in one bounded-concurrency Node
runner. The repository-cleanliness fixture and release/package fixture run
sequentially afterward, so neither can observe or race transient root state.

Keep generated output outside the checkout. These supported commands redirect
caches and build directories. When running bare `cargo` or `npm`, set external
target and cache directories; the layout gate rejects in-tree `target/`,
`node_modules/`, `.gradle/`, and similar residue.

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
