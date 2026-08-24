# CLI reference

Run `./revival --help` or append `--help` to any command.

## Local

| Command | Purpose |
| --- | --- |
| `revival init` | Create external configuration, secrets, data, and build roots. |
| `revival doctor [--json]` | Check local prerequisites. |
| `revival dev center` | Start Center with hot reload. |
| `revival dev down` | Stop the development stack. |
| `revival build` | Build the local Compose services. |
| `revival up` | Start the local stack. |
| `revival down` | Stop the local stack without deleting volumes. |
| `revival status` | Show service status. |
| `revival logs` | Show recent logs. |
| `revival config` | Render the resolved Compose model. |

## Checks

| Command | Purpose |
| --- | --- |
| `revival check center` | Typecheck and test Center and its Spotify adapter. |
| `revival check cosmos [TEST_FILTER]` | Format, lint, and test Cosmos, or run one matched test filter. |
| `revival check platform [--full]` | Run focused or complete Platform Node tests. |
| `revival check changed [--base REF]` | Select affected component checks. |
| `revival test [--source]` | Run the broad repository checks; `--source` includes Pin. |

## Configuration and setup

| Command | Purpose |
| --- | --- |
| `revival setup local\|contributor\|production\|pin` | Select and show a setup checklist. |
| `revival setup status [--json]` | Show the selected checklist. |
| `revival config path\|get\|set\|check\|list\|template` | Manage contract-backed settings. |
| `revival support-bundle --output FILE` | Write a redacted local diagnostic bundle. |
| `revival version [--json]` | Show the CLI and contract versions. |

## Production

| Command | Purpose |
| --- | --- |
| `revival doctor production [options]` | Run production preflight without changing the server. |
| `revival deploy production --dry-run [options]` | Show the direct Cosmos deployment. |
| `revival deploy production --confirm [options]` | Apply the direct Cosmos deployment. |

## Pin

| Command | Purpose |
| --- | --- |
| `revival pin doctor --serial SERIAL` | Check host, assets, and one exact device. |
| `revival pin check` | Run credential-free Pin source checks. |
| `revival pin build-debug --role ROLE` | Build selected non-installable debug APKs. |
| `revival pin release build --version YYYY-MM-DD.N --version-code INTEGER` | Build, sign, verify, and publish all five APK roles to Center's mounted store. |
| `revival pin install --serial SERIAL [--store DIR] [--confirm]` | Plan or perform an exact-device install. |
| `revival pin activate ... [--confirm]` | Plan or perform activation. |
| `revival pin network ...` | Inspect or prepare network onboarding. |
| `revival pki init\|import ... [--confirm]` | Plan or change device identity PKI. |

Pin installation and activation require an exact serial and explicit
confirmation. Build and doctor commands do not mutate a device.
