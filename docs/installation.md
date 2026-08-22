# How to install Ai Pin Revival

Use a source checkout today. Release archive and Homebrew machinery exists in
the repository, but no public binary or formula is considered available until a
reachable release and matching version tag are published.

## Install from source

### Prerequisites

- Git.
- Node.js 22.14.0 or newer on the Node 22 line.
- Docker with Compose 2.33.1 or newer for the local product.

### Steps

1. Clone the repository.

   ```sh
   git clone https://github.com/TheAndersMadsen/ai-pin-revival.git
   cd ai-pin-revival
   ```

2. Confirm the CLI and contract identity.

   ```sh
   ./revival version
   ./revival --help
   ```

3. Choose a guided track.

   ```sh
   ./revival setup local
   ```

   Use `contributor`, `production`, or `pin` instead when that is your goal.

4. Follow [the local tutorial](getting-started.md) or the next action printed by
   setup.

### Verification

```sh
./revival setup status
./revival doctor
```

The doctor should name every failed prerequisite and a next action. It does not
install missing tools for you.

Guided setup advances only after the referenced authoritative command returns
its exact action-specific success result. Before dispatch it captures the exact
argv, command contract, implementation bytes, and file identities; it
recaptures them after success and writes a bounded mode-`0600` receipt outside
the checkout only when nothing changed. A failed, planned, dry-run, weakened,
or concurrently replaced action produces no receipt. Live/physical device
acceptance is never made sticky. Hosted artifact imports additionally persist
and revalidate their provider evidence, and `setup artifacts vps|pin` repeats
that check explicitly.

Production setup has one additional cutover prerequisite: before the first
hosted-only deployment, the currently running production release (the
immutable Carry release) must be produced by the accepted GitHub-hosted
workflow, imported, and freshly
provider-verified as the retained rollback baseline. Descriptor schemas 2/3
and local-origin candidates are intentionally ineligible; the Carry→Cosmos
migration has no legacy auto-adoption or promotion bypass. If that exact
baseline cannot be attested, stop before deploying the forward candidate.

## Use the Dev Container

Contributors using a Dev Container-capable editor can open the checkout in
`.devcontainer/devcontainer.json`. It supplies Node 22.14.0, Rust 1.91.1, and
Docker-outside-of-Docker from a digest-pinned base and exact feature lockfile.
One `${devcontainerId}`-scoped volume holds disposable build/package caches;
a separate owner-only volume holds Cargo/Gradle configuration and every
`REVIVAL_*` config, secret, data, backup, and release-state directory. Release
authority is never stored in the shared cache volume.

Outside the Dev Container, rustup reads the root `rust-toolchain.toml` and
selects Rust 1.91.1 with rustfmt and Clippy. A different patch or newer stable
compiler is rejected by contributor and release checks so local lint behavior
cannot drift from CI or the Cosmos build image.

After the container opens:

```sh
./revival setup contributor
./revival doctor
./revival test
```

The Dev Container does not supply private signing keys, gated native inputs, a
connected Pin, production access, or physical acceptance. Rebuild with a
frozen `devcontainer-lock.json`; changing a feature, digest, or tool version is
a reviewed dependency update rather than an implicit `latest` refresh.
This follows the official Dev Container
[lockfile contract](https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainer-lockfile.md)
and [exact Feature versioning](https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainer-features.md#referencing-a-feature).

## Install Center as a PWA

Center includes an installable web app manifest with a standalone display mode.
Open Center from HTTPS in production or from `localhost` during development,
then use your browser's **Install app** or **Add to Home Screen** action.

The installed app starts at `/` and stays within the Center origin. Installation
does not make device operations or account data available offline; confirm the
live connection before relying on a setting or Pin action.

## Prepared release distribution

Maintainers can build a deterministic full-product archive with checksums and
render the checked-in Homebrew formula template. Publication is deliberately
separate and tag-gated. See `platform/distribution/README.md`.

Do not publish an archive by copying a development build or replacing template
placeholders by hand. A release must have immutable payload verification,
`SHA256SUMS`, a matching version tag, and the guarded publication workflow.

## Troubleshooting

- `env: node: No such file or directory`: install the pinned Node 22 runtime.
- `Docker with Compose v2 is required`: install or start Docker; source checkout
  alone only installs the CLI.
- A setup path inside the checkout is refused: remove the `REVIVAL_*_DIR`
  override or point it to an external directory.
- A browser offers no PWA install action: use HTTPS or localhost and check that
  `/manifest.json` loads from the same origin.
