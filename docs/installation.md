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

## Use the Dev Container

Contributors using a Dev Container-capable editor can open the checkout in
`.devcontainer/devcontainer.json`. It supplies Node 22.14.0, Rust 1.91.1, and
Docker-outside-of-Docker, while keeping Cargo, Gradle, npm, and Revival state in
an external workspace volume.

After the container opens:

```sh
./revival setup contributor
./revival doctor
./revival test
```

The Dev Container does not supply private signing keys, gated native inputs, a
connected Pin, production access, or physical acceptance.

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
