# Ai Pin Revival

Ai Pin Revival is a self-hosted replacement service for a Humane Ai Pin. It
keeps the stock device experience while replacing the retired cloud with three
current components:

- Center: the owner-facing web application.
- Cosmos: device APIs, identity, assistant tools, media, and data services.
- Pin: the Android/Rust Server, injected Hook, installer, and injector.

This is an independent community project. It is not affiliated with or endorsed
by Humane. You are responsible for the device, server, accounts, credentials,
and third-party services you connect.

## Start here

Choose one path:

- Deploying a server: use a verified GitHub release and the small operator
  bundle. A production server does not need this repository or a compiler.
- Developing the project: clone the repository and use the root `revival` CLI.
- Connecting a Pin: deploy Cosmos first, import the signed Pin archive, install
  from Center, and activate the exact device.

## Architecture

| Part | Runs on | Purpose |
| --- | --- | --- |
| Center | Your server | Sign-in, settings, provider connections, Pin installer, and owner data |
| Cosmos | Your server | Stock-compatible APIs, enrollment, assistant orchestration, search, media, and storage |
| Server | Ai Pin | Local service bridge and device runtime |
| Hook | Ai Pin | Integrates Cosmos with the stock voice, settings, navigation, camera, and music apps |

The repository retains required stock `humane.*` protocol names and Android
package identities because the original software calls them byte-for-byte.
Product, deployment, configuration, and operator-facing names use Cosmos.

## Deploy Cosmos

The supported production host is Ubuntu 24.04 x86-64 with:

- Node.js 22.14 or newer on the Node 22 line.
- Docker Engine and Docker Compose 2.34 or newer.
- A domain whose DNS points to the server.
- Public ports 80 and 443 available.
- A public IPv4 address when the `pin` profile is enabled.

### 1. Download a verified release

Choose a version from
[GitHub Releases](https://github.com/TheAndersMadsen/ai-pin-revival/releases),
then download all three operator files from that tag:

```sh
RELEASE_VERSION=0.0.0
RELEASE_TAG="v${RELEASE_VERSION}"
RELEASE_BASE="https://github.com/TheAndersMadsen/ai-pin-revival/releases/download/${RELEASE_TAG}"

curl --fail --location --remote-name \
  "${RELEASE_BASE}/ai-pin-revival-operator-${RELEASE_VERSION}-linux-x64.tar.gz"
curl --fail --location --remote-name \
  "${RELEASE_BASE}/ai-pin-revival-${RELEASE_VERSION}.release.json"
curl --fail --location --remote-name "${RELEASE_BASE}/SHA256SUMS"
sha256sum --check SHA256SUMS
tar -xzf "ai-pin-revival-operator-${RELEASE_VERSION}-linux-x64.tar.gz"
cd "ai-pin-revival-operator-${RELEASE_VERSION}"
```

Replace `0.0.0` with the chosen release version. Do not skip the checksum.

### 2. Create the production configuration

```sh
./revival setup production \
  --domain center.example.com \
  --acme-email admin@example.com \
  --operator-email owner@example.com \
  --public-ip 203.0.113.10 \
  --profile pin \
  --profile search
```

The command writes configuration, secrets, certificates, and runtime data to
owner-controlled directories outside the extracted release. It prints the path
to a mode-0600 first-login file. Use that file once, sign in, then remove it.
Rerunning setup preserves existing nonblank values.

Optional profiles are `pin`, `search`, `spotify`, and `observability`. Spotify
also needs the Iroh ticket file named by `./revival setup production --help`.

### 3. Configure the assistant and speech

See the available provider settings without exposing values:

```sh
./revival config list --group provider
```

An OpenAI-compatible assistant uses these settings:

```sh
./revival config set COSMOS_LLM_BASE_URL https://provider.example/v1
./revival config set COSMOS_LLM_MODEL YOUR_MODEL
./revival config set COSMOS_LLM_API_KEY --stdin
```

Paste the secret on standard input, then press Ctrl-D. This keeps it out of
shell history. Azure Speech uses the same external configuration model:

```sh
./revival config set COSMOS_REMOTE_TTS_ENABLED true
./revival config set COSMOS_AZURE_SPEECH_REGION YOUR_REGION
./revival config set COSMOS_AZURE_SPEECH_VOICE YOUR_VOICE
./revival config set COSMOS_AZURE_SPEECH_KEY --stdin
```

Existing Azure, assistant, search, music, and other provider values survive
normal setup and deployment runs. Validate their dependencies with:

```sh
./revival config check
```

### 4. Deploy and verify

```sh
./revival doctor production
./revival deploy production --dry-run
./revival deploy production --confirm
./revival verify production
```

`--dry-run` changes nothing. `--confirm` pulls the release's digest-pinned OCI
application, starts it, and runs the same public verification used by
`verify production`; it does not compile source.

If GHCR packages are private, first run:

```sh
./revival registry login --username YOUR_GITHUB_USER
```

Enter a package-read token only at Docker's hidden prompt.

### Public verification and agent discovery

Center publishes a small unauthenticated discovery surface. It contains no
wearer data and is useful for release checks, search engines, and setup agents:

| URL | Purpose |
| --- | --- |
| `/api/version` | Product, immutable release ID, and runtime environment |
| `/api/pin/releases/current` | Current verified five-APK release manifest, when imported |
| `/developers` or `/developers.md` | Deployment, CLI, API, and agent guidance |
| `/openapi.json` | Typed OpenAPI 3.1 contract for public read operations |
| `/llms.txt` | Concise when-to-use instructions and canonical links |
| `/sitemap.xml` and `/robots.txt` | Public page discovery and crawler policy |

Public information pages are server-rendered and return Markdown when requested
with `Accept: text/markdown`. Unknown paths return HTTP 404 rather than the app
shell. Public API responses include `RateLimit-Policy` and `RateLimit`; a 429
also includes `Retry-After`.

## Connect a Pin

The GitHub release publishes the signed five-APK Pin set as a separate archive.
On the server, import it into the operator-owned release store:

```sh
./revival pin release import ai-pin-revival-pin-YYYY-MM-DD.N.tar.gz
```

The importer validates the archive, manifest, signer receipt, package roles,
sizes, and every APK digest before making the complete release available to
Center. A partial set is never published.

Then:

1. Open `https://center.example.com/settings/pin/install` in a Chromium browser.
2. Connect and unlock the Pin over USB-C.
3. Select the exact Pin and run the Center installer.
4. In Center's operator provisioning view, create and download the one-time
   activation document for that device.
5. On the computer connected to the Pin, use the exact plan command Center
   shows. Review it, then repeat it with `--confirm`.
6. Run the shown `pin activate status --serial SERIAL` command and make one real
   voice request on the device.

Activation stores the server hostname, device-status endpoint, trust roots, and
device identity as one transaction. It does not use a project-wide default
server. Installation and activation both bind to the exact serial and plan
without changing the device until explicitly confirmed.

## Build the Pin apps

Building signed Pin apps requires the external signing material and private
native assets already authorized for the project:

```sh
./revival pin doctor
./revival pin release build --version YYYY-MM-DD.N --version-code INTEGER
./revival pin release export --output ai-pin-revival-pin-YYYY-MM-DD.N.tar.gz
```

The pinned builder uses JDK 17, Android SDK 34, NDK r28c, Rust 1.91.1, and
external caches. It always signs and verifies installer, bootstrap, Hook,
Server, and injector as one release. Building never runs ADB.

## AI-assisted setup

The following prompt is intentionally outcome-based and gives Claude, Codex, or
another coding agent the constraints it needs without prescribing every shell
step. Fill in the bracketed values and run it on the target server:

```text
Set up the latest stable Ai Pin Revival release on this Ubuntu 24.04 x86_64
server.

Outcome:
- Cosmos and Center run at https://[DOMAIN].
- The deployment reports environment "production" and one immutable release ID.
- The pin and search profiles are enabled.
- My existing external Ai Pin Revival configuration and provider credentials are
  preserved if this is an upgrade.

Inputs:
- Domain: [DOMAIN]
- ACME email: [ACME_EMAIL]
- First operator email: [OPERATOR_EMAIL]
- Public IPv4: [PUBLIC_IPV4]
- Assistant provider base URL and model: [BASE_URL] and [MODEL]
- I will enter assistant and Azure secrets through stdin when asked.

Rules:
- Read the repository README first.
- After deployment, read https://[DOMAIN]/llms.txt and use the linked developer
  index and OpenAPI document as the public machine-readable authority.
- Deploy only the checksum-verified operator archive from the latest stable
  GitHub release. Do not clone or deploy a source checkout.
- Use the bundled ./revival commands and their --help output as authority.
- Never print, log, commit, or place a secret in argv or shell history.
- Do not add compatibility, migration, backup, or alternate deployment paths.
- Run one narrow diagnostic after a failure; fix the cause and resume.
- Ask me only for a missing input, credential, DNS change, firewall change, or
  device interaction you cannot perform.

Success evidence:
- ./revival config check passes.
- ./revival doctor production passes.
- ./revival deploy production --dry-run passes before confirmation.
- ./revival verify production passes after deployment.
- GET https://[DOMAIN]/api/version returns the expected release and
  environment "production".
- https://[DOMAIN]/llms.txt, /openapi.json, /sitemap.xml, and /developers.md
  return successful machine-readable responses.

Continue until all success evidence is green or report one exact blocker and
the command/output that proves it.
```

For a new Pin, follow with: “Download the signed Pin archive from the same
release, import it, guide me through Center's USB installer, and use Center's
one-time activation document for the exact connected serial.”

## Development

Clone only when changing source:

```sh
git clone https://github.com/TheAndersMadsen/ai-pin-revival.git
cd ai-pin-revival
./revival setup contributor
./revival doctor
```

Run Center with hot reload:

```sh
./revival dev center
```

Run only what your change needs:

```sh
./revival check changed
./revival check center
./revival check cosmos TEST_FILTER
./revival check platform
./revival pin check
```

For a broad change:

```sh
./revival check platform --full
./revival test
```

Dependencies and compiler output are reused from the external build directory,
so narrow reruns avoid rebuilding unrelated components. Configuration defaults
to `~/.config/ai-pin-revival`; data and caches default to
`~/.local/share/ai-pin-revival`.

## Configuration

```sh
./revival config path
./revival config list
./revival config list --group provider
./revival config get NAME
./revival config set NAME VALUE
./revival config set SECRET_NAME --stdin
./revival config check
```

Path overrides must be set before initialization:

| Variable | Default |
| --- | --- |
| `REVIVAL_CONFIG_DIR` | `~/.config/ai-pin-revival` |
| `REVIVAL_SECRETS_DIR` | `~/.config/ai-pin-revival/secrets` |
| `REVIVAL_DATA_DIR` | `~/.local/share/ai-pin-revival` |
| `REVIVAL_BUILD_DIR` | `~/.local/share/ai-pin-revival/build` |

## Troubleshooting

- `cmd: Can't find service: package`: confirm Center and the imported Pin archive
  are from the latest release, unlock the Pin, reboot it once, reconnect USB,
  and rerun the installer. The current installer waits for Android's package
  service before making changes.
- Center shows an old release or unknown environment: run
  `./revival verify production`, then inspect `https://YOUR_DOMAIN/api/version`.
  A production deployment must return `environment: "production"` and the
  release revision you deployed.
- Assistant or Azure speech does not start: run
  `./revival config list --group provider` and `./revival config check`; values
  remain external and are not replaced by deployment.
- A command is unclear: use `./revival COMMAND --help`. Help is read-only and
  states whether a command can change local, remote, or device state.

## License

See [LICENSE](LICENSE). Third-party code retains its own license files and
notices in the vendored source.
