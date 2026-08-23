# Ai Pin Revival

Ai Pin Revival brings the Humane AI Pin back online with three parts:

- **Center** — the wearer-facing web app.
- **Cosmos** — the backend for device APIs, enrollment, tools, media, and data.
- **Pin** — the Android/Rust runtime and injected Hook that keep the stock device experience.

The repository is designed to be used directly. Contributor checks run from the
working tree, reuse external caches, and avoid building unrelated components.

## Repository

| Path | Purpose |
| --- | --- |
| [`center/`](center/) | Next.js Center and provider adapters |
| [`cosmos/`](cosmos/) | Rust services and device protocols |
| [`pin/`](pin/) | Android apps, Hook, installer, and Rust runtime |
| [`platform/`](platform/) | CLI, Compose, CI helpers, deployment, and Pin tooling |
| [`contracts/`](contracts/) | Machine-readable product and wire contracts |
| [`docs/`](docs/) | Setup, architecture, operations, and Pin guides |

Generated output, dependencies, credentials, APKs, and wearer data stay outside
the checkout.

## Requirements

- Node.js 22.14 or newer on the Node 22 line
- Docker with Compose 2.33.1 or newer
- Rust 1.91.1 for Cosmos work
- Linux/x86-64 Docker for Android and Pin builds

Run:

```sh
./revival doctor
```

It reports missing tools and the next action.

## Run locally

```sh
git clone https://github.com/TheAndersMadsen/ai-pin-revival.git
cd ai-pin-revival
./revival init
./revival dev center
```

Open <http://127.0.0.1:4000>. `init` creates owner-only configuration,
secrets, data, and build directories outside the checkout. Rerunning it keeps
existing nonblank values.

For the complete Compose stack:

```sh
./revival up
./revival status
./revival logs
./revival down
```

## Fast development loop

Use the narrow command that matches what changed:

```sh
./revival check center
./revival check cosmos
./revival check cosmos TEST_FILTER
./revival check platform
./revival check changed
./revival pin check
```

`check changed` examines committed and working-tree changes and runs only the
affected components. Center dependencies and build metadata, Cargo targets,
Gradle state, and npm downloads live in the external build directory and are
reused between runs.

Before pushing a broad change:

```sh
./revival check platform --full
./revival test
```

CI runs Center, Cosmos, Platform, and Pin work in parallel using the same
component commands.

## Configuration

The default external paths are:

- `~/.config/ai-pin-revival`
- `~/.config/ai-pin-revival/secrets`
- `~/.local/share/ai-pin-revival`
- `~/.local/share/ai-pin-revival/build`

Override them before invoking the CLI with:

- `REVIVAL_CONFIG_DIR`
- `REVIVAL_SECRETS_DIR`
- `REVIVAL_DATA_DIR`
- `REVIVAL_BUILD_DIR`

Useful commands:

```sh
./revival config path
./revival config list
./revival config check
./revival config get NAME
./revival config set NAME VALUE
```

Secret settings accept `--stdin` instead of a command-line value.

## Deploy Cosmos

Production uses one direct path:

```sh
./revival doctor production
./revival deploy production --dry-run
./revival deploy production --confirm
```

The preflight checks the host where the command runs. Dry-run shows the
deployment without changing it; `--confirm` applies the current Cosmos stack. See
[`docs/operations.md`](docs/operations.md).

## Pin

Pin builds and installs remain separate because they use protected signing
material and can modify a physical device.

```sh
./revival pin doctor --serial SERIAL
./revival pin check
./revival pin build-debug --role server
./revival pin release build --version YYYY-MM-DD.N --version-code INTEGER
./revival pin release ship --confirm
./revival pin install --serial SERIAL
```

An install is a plan until `--confirm` is supplied. The installer rechecks the
exact serial, APK set, signatures, versions, and installed Hook path. It refuses
unsafe partial updates.

The pinned builder signs and verifies all five APK roles as one set. Building
and shipping never run ADB or touch a Pin.

## Documentation

- [Getting started](docs/getting-started.md)
- [Installation](docs/installation.md)
- [Configuration](docs/configuration.md)
- [CLI reference](docs/cli-reference.md)
- [Architecture](docs/architecture.md)
- [Operations](docs/operations.md)
- [Pin onboarding](docs/pin-onboarding.md)
- [Prompting and tool reference](docs/prompting-and-tool-reference.md)

## License

See [LICENSE](LICENSE).
