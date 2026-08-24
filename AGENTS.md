# Agent instructions

Read `README.md` before changing this repository. Work toward the requested
outcome, keep the implementation small, and finish with evidence.

## Product map

- `center/`: Next.js owner UI and provider adapters.
- `cosmos/`: Rust backend and stock-compatible services.
- `pin/`: Android apps, injected Hook, installer, and Rust runtime.
- `platform/`: root CLI, release packaging, Compose, CI, and deployment.
- `contracts/`: machine-readable configuration and wire contracts.

Center, Cosmos, and the Pin are one release-coupled product. Preserve required
stock `humane.*` protobuf names, Android package IDs, and five APK roles. Those
are compatibility identifiers, not product branding.

## Working rules

- Prefer the direct implementation over wrappers, receipts, duplicated policy,
  compatibility modes, or speculative abstractions.
- Remove dead paths instead of maintaining two ways to do the same job.
- Do not add historical production, migration, alternate deployment, or hidden
  fallback flows.
- Keep secrets, runtime data, APKs, and generated output outside the checkout.
- Never print secrets. Send secret configuration through `--stdin`.
- Inspect before changing. Preserve unrelated work in a dirty checkout.
- Use `rg` for exact text. Use Serena for symbols and callers when available.
  Read the original source before editing it.
- Use `apply_patch` for source edits. Generated files may be refreshed by their
  checked-in generator.

## Fast loop

Start with:

```sh
git status --short
./revival check changed
```

Then run only the owning component while iterating:

```sh
./revival check center
./revival check cosmos TEST_FILTER
./revival check platform
./revival pin check
```

Use external caches through the CLI. Do not create `target`, `.gradle`,
`.kotlin`, `.next`, or `build` directories manually in source.

Before handing off a cross-component change:

```sh
./revival check platform --full
./revival test
git diff --check
```

Do not repeatedly run the broad suite while a narrow test can prove the edit.

## Generated and canonical files

- `contracts/operator-setup.json` owns commands and configuration metadata.
- Run `node platform/setup/generate.mjs --write` after changing its projected
  Pin setup journey.
- `platform/containers/pin-builder/toolchain.json` owns build tool versions.
- `README.md` is the single human guide. Do not add component READMEs or a docs
  tree; improve the root README instead.
- `CLAUDE.md` imports this file. Keep agent rules here once.

## Center

```sh
npm --prefix center run typecheck
npm --prefix center test
npm --prefix center run test:ui
REVIVAL_RELEASE_ID=source-check npm --prefix center run build
```

Keep public pages useful without JavaScript. Public machine endpoints must have
real status codes, explicit content types, bounded schemas, and tests. Private
wearer/admin routes stay authenticated.

## Cosmos

Rust is pinned by `rust-toolchain.toml`. Use a test substring during iteration:

```sh
./revival check cosmos encrypted_weather_accepts_the_stock_location_envelope
```

Do not change protobuf field numbers or stock wire shapes without updating the
wire contracts and equivalence tests in the same change.

## Pin

- Build and release commands never run ADB.
- Installation and activation require an exact serial and explicit confirmation.
- Never bypass signer, version, package-path, free-space, or keep-data checks.
- Debug APKs are not release artifacts.
- Signed releases always contain installer, bootstrap, Hook, Server, and
  injector as one verified set.
- Use the pinned container for Android/JDK/NDK work.

Useful commands:

```sh
./revival pin doctor
./revival pin build-debug --changed
./revival pin release build --version YYYY-MM-DD.N --version-code INTEGER
./revival pin release export --output ai-pin-revival-pin-YYYY-MM-DD.N.tar.gz
```

## Production

Production consumes the checksum-verified operator archive from a tagged
release. It does not deploy a source checkout or compile on the server.

```sh
./revival doctor production
./revival deploy production --dry-run
./revival deploy production --confirm
./revival verify production
```

Deployment is complete only when public verification returns the intended
release ID and `environment: "production"`.

## Completion

A task is done when behavior is implemented, focused tests pass, relevant broad
checks pass once, documentation matches the behavior, and any requested release
or deployment is verified live. If credentials, DNS, firewall access, or a
physical device action is required, report that single concrete blocker and the
evidence for it.
