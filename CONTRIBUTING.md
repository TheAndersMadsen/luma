# Contributing

Work directly from a normal checkout. Keep credentials and generated output in
the external directories created by `./revival init`.

## Setup

```sh
./revival init
./revival doctor
./revival setup contributor
```

Node 22.14, Rust 1.91.1, and Docker Compose 2.34.0 are the pinned host tools.
Pin Android builds use the repository's Linux/x86-64 builder.

## Development

Start only the service you are changing:

```sh
./revival dev center
```

For the complete stack:

```sh
./revival up
./revival status
```

Center hot reloads source changes. Dependency manifests trigger the rebuilds
that actually need to happen.

## Checks

Run the narrowest relevant check while editing:

```sh
./revival check center
./revival check cosmos
./revival check cosmos TEST_FILTER
./revival check platform
./revival pin check
```

Or let the CLI select components:

```sh
./revival check changed
./revival check changed --base origin/main
```

Use `./revival check platform --full` after broad Platform or contract changes.
Use `./revival test` before pushing a cross-component change.

Checks reuse:

- `REVIVAL_BUILD_DIR/npm-cache`
- `REVIVAL_BUILD_DIR/cosmos-target`
- `REVIVAL_BUILD_DIR/gradle-home`
- component `node_modules` directories when lockfiles and tool versions match

Do not create `target`, `.gradle`, `.kotlin`, `.next`, or `build`
directories in source. If a tool does so, move that output outside the checkout
before continuing.

## Code changes

- Keep Center, Cosmos, and Pin changes in their owning component.
- Add behavior tests beside the changed boundary.
- Preserve stock protobuf field numbers, Android package identities, and the
  exact five-role Pin release set.
- Keep user-visible configuration in the operator contract.
- Prefer direct library or tool calls over wrappers, snapshots, receipt stores,
  and duplicated policy layers.

## Production

Production has one deployment interface:

```sh
./revival doctor production
./revival deploy production --dry-run
./revival deploy production --confirm
```

Do not add alternate deployment commands or hidden compatibility modes.

## Pin safety

Pin inspection is read-only. Build and release commands do not run ADB.
Installation and activation require both an exact serial and explicit
confirmation. Never bypass the installer's signer, version, path, or keep-data
checks.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs component jobs in
parallel. Signed Pin releases are built locally with `./revival pin release build`
so signing keys and private assets never need to be copied into GitHub.
