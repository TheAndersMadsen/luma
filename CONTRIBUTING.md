# Contributing

Ai Pin Revival has four product boundaries: `center/`, `cosmos/`, `pin/`, and
`platform/`. Versioned cross-component behavior lives in `contracts/`. Start
with [architecture](docs/architecture.md), then keep each change inside the
smallest boundary that owns it.

## Contributor setup

The supported versions are pinned in
`platform/containers/pin-builder/toolchain.json`:

- Node.js 22.14.0 or newer on the Node 22 line.
- Rust 1.91.1 or newer on the Rust 1.91 line.
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
Node 22.14.0, Rust 1.91.1, and Docker-outside-of-Docker, with caches and Revival
state in an external workspace volume. It does not supply credentials, private
Pin assets, signing keys, production access, or a device.

Provider credentials belong only in the protected runtime file created by
`init`. Use [configuration](docs/configuration.md); never add a secret to source,
Compose, arguments, fixtures, logs, or documentation.

## Run and test

```sh
./revival build && ./revival up       # Center at http://127.0.0.1:4000
./revival test                        # repository release gate
./revival test --source               # adds Pin source/toolchain checks
./revival pin check                   # focused Pin source path
```

Focused loops:

```sh
npm --prefix center test
cargo test --workspace --locked --manifest-path cosmos/Cargo.toml
cargo test --locked --manifest-path pin/runtime/core/Cargo.toml
```

Keep generated output outside the checkout. `./revival test` redirects caches
and build directories. When running bare `cargo` or `npm`, set external target
and cache directories; the layout gate rejects in-tree `target/`,
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
- Build Pin releases in the pinned container. The host does not need a local
  Android SDK/JDK/Rust toolchain for the canonical build.
- Preserve each operation's documented target and confirmation boundary. Do not
  add a bypass; device install/activation and named plan/confirm commands must
  stay dry-run first.
- Run production canary and drift checks after deployment.
- Run `./revival backup --fetch` after PKI changes and regularly thereafter.
- Use [recovery](docs/recovery.md) for server rebuilds and database restoration;
  rollback does not restore a database.

## CI

`.github/workflows/ci.yml` pins Node 22.14.0 and Rust 1.91.1. It checks layout,
wire equivalence, the operator contract, CLI and Center projections,
distribution, a clean isolated-XDG installation, Center, Cosmos, Pin runtime,
and the release source gate. It does not contact a device, VPS, provider, or
production service.

See [installation](docs/installation.md), the [CLI reference](docs/cli-reference.md),
and [operations](docs/operations.md) for the user-facing contracts contributors
must preserve.
