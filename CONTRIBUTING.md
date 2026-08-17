# Contributing

Ai Pin Revival is one workspace with four owned boundaries — `center/`,
`cosmos/`, `pin/`, `platform/` — plus `contracts/` for cross-component wire
compatibility. Start with the [README](README.md), then
[docs/index.md](docs/index.md) for the page you need.

## Setup

Requirements are pinned in `platform/containers/pin-builder/toolchain.json`
(Node and Rust; JDK 17 / Android SDK for Pin builds) and checked by:

```sh
./revival init
./revival doctor
```

Provider credentials go only in the protected runtime file `init` creates —
never in source, Compose, arguments, or docs.

## Run and test

```sh
./revival build && ./revival up     # local stack; Center at http://127.0.0.1:4000
./revival test                      # the VPS release gate
./revival test --source             # adds the Pin toolchain and source checks
```

Focused loops while editing one component:

```sh
npm --prefix center test                                        # Center
cargo test --workspace --locked --manifest-path cosmos/Cargo.toml   # Cosmos
cargo test --locked --manifest-path pin/runtime/core/Cargo.toml     # Pin runtime
```

Keep generated output outside the tree — `./revival test` redirects caches and
build dirs itself, and the layout gate fails on in-tree `node_modules/`,
`target/`, and friends. Run bare `cargo`/`npm` with external target/cache dirs.

## Ground rules

- Behavior-preserving refactors move code behind stable exports, run the
  nearest tests, and only then remove the old location.
- Exact stock identifiers (package names, gRPC names, ALPN, certificate
  subjects, storage keys) are compatibility boundaries — never rename them for
  aesthetics; see [docs/architecture.md](docs/architecture.md#compatibility).
- Wearer-visible language stays short, truthful, and free of implementation
  vocabulary; operator diagnostics keep their technical detail.
- Evidence labels are `observed`, `derived`, `implemented`, `unknown` — cite
  `file:line` for any claim you add.
- Do not commit firmware, APKs, decompiled source, keys, device identities,
  wearer data, or production logs.

## Releases, deployment, recovery

- Immutable releases: `./revival release build --profile vps`, verified with
  `./revival release verify` — see [docs/operations.md](docs/operations.md).
- Production deploys, canary, drift, backup: the Production section of the
  same page. `./revival backup --fetch` is the only off-host copy of the
  irreplaceable key material.
- Server rebuild and database restore: [docs/recovery.md](docs/recovery.md).

## CI

`.github/workflows/ci.yml` runs the fast source checks on every push:
formatting, the focused component suites, repository layout, wire equivalence,
and the release source gate. Everything it runs is a command you can run
locally, listed above.
