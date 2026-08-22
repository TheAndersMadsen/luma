# Ai Pin Revival

Ai Pin Revival is an independent, operator-owned stack for bringing a Humane
Ai Pin back online. It keeps the stock device experience, replaces the retired
cloud boundary with Cosmos, and gives the wearer a private control plane in
Center. The repository also contains the guarded build, test, release, backup,
and recovery machinery needed to operate the system as one release-coupled
product.

This is active revival engineering for owned hardware, not a drop-in consumer
firmware or a generic server installer. It is not affiliated with Humane.

> [!CAUTION]
> **Never deploy from a dirty checkout. Never deploy `HEAD` or `main` while the
> Carry → Cosmos production-compatibility work remains unresolved.** Production
> still owns exact Carry-era volumes, paths, database identities, certificates,
> settings, and rollback authority. A normal `git pull`, merge, Compose launch,
> or source-tree deploy can strand durable data. Production releases must come
> only from an isolated, immutable, provider-verified candidate after every
> Carry compatibility gate passes. See [Production safety](#production-safety).

## Project status

| Area | Current evidence |
| --- | --- |
| Local Center + Cosmos | Implemented and available through the root `revival` CLI and Docker Compose. No provider keys or Pin are required for the base loopback stack. |
| Center | Wearer pages, authentication, memories, captures, notes, contacts, settings, service connections, Pin setup, and guarded operator routes are implemented. |
| Cosmos | Device APIs, enrollment, persistence, feature flags, assistant/tool routing, search, speech adapters, and Center projections are implemented. |
| Pin | System Injector, Hook, Android/Rust runtime, authenticated bridge, stock-wire contracts, and deterministic builders are present. Safe installation and wearer-visible behavior still require exact-device acceptance. |
| CI and release evidence | Push/PR CI, an attested VPS-candidate workflow, and an attested exact-five-APK workflow are defined. The hosted workflows build evidence; they do not deploy a VPS or mutate a Pin. |
| Production | Existing-installation operations are implemented, but deploying current `main` remains blocked until the Carry physical-resource contract and first-cutover rollback path are completely verified. |
| Distribution | Source checkout and Dev Container are the supported entry points today. Release-archive and Homebrew publication machinery exists, but no public binary/formula is advertised without a reachable matching release. |

The project uses four evidence labels consistently: `observed`, `derived`,
`implemented`, and `unknown`. A passing compiler, healthy container, HTTP 200,
or completed ADB transaction does not prove physical playback, projection,
sync, reboot stability, or wearer interaction. Those remain `unknown` until an
authorized acceptance run observes the exact Pin.

## How it fits together

```text
wearer/browser
      |
      v
   Center  <------ encrypted wearer data and controls
      |
      v
   Cosmos  <------ compatible cloud APIs, identity, AI, providers
      ^
      |  authenticated stock-compatible device traffic
      |
Pin stock apps -> injected Hook -> Pin Server/bridge

Platform = CLI + Compose + edge + builders + releases + deployment + proof
```

The three product tiers move together:

- **Center** is the wearer and operator web plane. It owns browser APIs,
  authentication, configuration proposals, account connections, and the
  WebUSB Pin console.
- **Cosmos** is the compatible cloud. It owns device-facing protocols,
  identity, storage, assistant behavior, search, speech, and provider adapters.
- **Pin** is the device tier. It owns the privileged injector, narrowly scoped
  hooks, the Android/Rust Server, the on-device setup page, and the authenticated
  bridge.

`platform/` composes those tiers, but does not own product behavior. Shared
cross-component behavior is versioned under `contracts/`.

### The stock-app Hook model

Ai Pin Revival does not ship Humane firmware or replace the stock experience
with a second launcher. The System Injector loads a guarded Hook into selected
stock processes; the Hook adapts stock service boundaries to the local Pin
runtime and Cosmos. Clone mode is committed only after activation has validated
the device identity, certificate chain, endpoint, and exact hardware target.

For music, the native Humane intent flow, queue, MediaManager, and ExoPlayer
remain in charge. The Hook replaces the retired provider boundary and delegates
network/auth work to the Pin runtime or the wearer-scoped Center gateway. No
YouTube Music, TIDAL, or Apple Music app is installed on the Pin by this project.
Compatibility identifiers such as `penumbra_carry_*`, stock authorities,
Android package names, and the pinned Carry root are intentionally retained
where an in-place upgrade depends on them.

Read [Architecture](docs/architecture.md) for the runtime, edge, wire, and trust
boundaries.

## Repository map

| Path | Owns |
| --- | --- |
| [`center/`](center/) | Next.js wearer dashboard, browser APIs, operator UI, Pin installer/console, and purpose-scoped adapters |
| [`cosmos/`](cosmos/) | Rust services, device protocols, persistence, assistant, search, enrollment, and provider backends |
| [`pin/`](pin/) | System Injector, Hook, loader, Android/Rust runtime, bridge, setup assets, and device contracts |
| [`platform/`](platform/) | Root CLI, Compose overlays, edge, deterministic builders, immutable releases, deployment, backup, and acceptance gates |
| [`contracts/`](contracts/) | Versioned feature, setup, release, compatibility, and wire contracts |
| [`docs/`](docs/) | Operator, contributor, onboarding, recovery, and prompting guides |

Generated output, dependencies, secrets, release stores, backups, APKs, device
evidence, and wearer data belong outside this source tree.

## Prerequisites

| Goal | Required |
| --- | --- |
| Run locally | macOS or Linux, Git, Node.js 22.14.0+ on the Node 22 line, Docker with Compose 2.33.1+ |
| Contribute to Center/Cosmos | Local requirements plus Rust 1.91.1 exactly; the checked-in Dev Container supplies the pinned Node/Rust environment |
| Run Pin source gates | A supported Linux/amd64 host with Docker; the canonical builder supplies JDK 17, Android SDK 34, and NDK r28c |
| Work with a physical Pin | A compatible owned Pin, exact serial, ADB/WebUSB access, reviewed PKI, protected private inputs, and a verified signed release |
| Operate production | An existing reviewed installation, its protected external configuration/state, and imported provider-verified release evidence |

Rust, Java, the Android SDK, provider credentials, and a physical Pin are not
needed for the basic local stack. The complete pinned toolchain contract is
[`platform/containers/pin-builder/toolchain.json`](platform/containers/pin-builder/toolchain.json);
the contributor environment is [`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json).

## Run locally

### Safe quick start

From a clean source checkout:

```sh
git clone https://github.com/TheAndersMadsen/ai-pin-revival.git
cd ai-pin-revival

./revival setup local
./revival init
./revival doctor
./revival build
./revival up
./revival status
```

Open <http://127.0.0.1:4000>. Local authentication is allowed only on loopback.
`init` creates owner-only configuration, secret, data, build, and backup roots
outside the checkout; rerunning it preserves existing nonblank values.

```sh
./revival logs
./revival down
./revival setup status
./revival setup --resume
```

`down` preserves volumes. Setup status recomputes evidence instead of trusting
a checklist. Start with [Getting started](docs/getting-started.md) if this is
your first run.

## Fast development and verification

Use the smallest gate that covers the edit, then run the full release boundary
at a checkpoint. The root commands keep caches and generated output in external
state or isolated container volumes.

```sh
# Center hot reload in an isolated Compose project
./revival dev center
./revival dev down

# Focused component checks
./revival check center
./revival check cosmos
./revival check cosmos TEST_FILTER
./revival check platform

# Conservatively select checks from committed + working-tree changes
./revival check changed
./revival check changed --base origin/main
```

`check cosmos TEST_FILTER` fails if the filter matches no tests. `check changed`
includes staged, unstaged, and untracked changes and fans unfamiliar shared
paths out to all relevant checks.

For Pin edits on a supported Linux/x64 host, run the focused source gate:

```sh
./revival pin check
```

For a debug compile, choose one selector. Name the exact roles:

```sh
./revival pin build-debug --role hook --role server
```

Or derive the affected roles from Git changes:

```sh
./revival pin build-debug --changed --base origin/main
```

Debug APK sets are credential-free, debug-signed rather than release-signed,
non-release, deliberately non-installable, and outside the checkout. The local
Pin compiler lane refuses macOS, ARM, and observed translation/emulation before
Docker; use hosted native-x64 CI for the all-role proof when the host is
ineligible.

Before a release checkpoint, run one canonical full source gate:

```sh
./revival test --source
```

`./revival release check --source` is the equivalent release-oriented spelling;
choose one, not both. Each runs the expensive VPS release gate once and then
adds the Pin toolchain/source boundary. If the checkpoint is intentionally
VPS-only, `./revival test` and `./revival release check` are likewise equivalent
spellings; choose one. None of these commands release-signs, installs, opens a
device, or proves physical behavior.

After a passing gate, build the immutable VPS archive only when one is needed:

```sh
./revival release build --profile vps
```

The VPS gate covers source policy, packaging, Center, Cosmos, platform
acceptance, and the private Spotify adapter. `release build` produces an
allowlisted archive; runtime state and secrets are never release contents.

See [Contributing](CONTRIBUTING.md) for cache isolation, changed-file selection,
test expectations, and component ownership.

## CI and release flow

| Workflow | Trigger and outcome | Authority it does **not** have |
| --- | --- | --- |
| [CI](.github/workflows/ci.yml) | Pushes and pull requests run platform/release policy, Center, Cosmos, Pin runtime, canonical Linux/x64 Pin unit/debug, and macOS rooted-reader jobs. | No signing, VPS deployment, or device mutation. |
| [Attested VPS candidate](.github/workflows/vps-candidate.yml) | Manual dispatch on `main` builds the exact commit, seals the candidate and image bundle, provider-attests the file set, and uploads one handoff artifact. | No production secrets, SSH, deployment, or promotion of a locally built candidate. |
| [Attested Pin release](.github/workflows/pin-release.yml) | Manual dispatch on `main` performs prepare → pre-attest → protected sign → exact-five attest → reverify/publish. | No ADB, USB, installation, activation, or fallback when protected inputs/attestation support are absent. |
| [Distribution release](.github/workflows/release-cli.yml) | Manual build of the full immutable payload; publication is an explicit second job allowed only from the matching existing `vVERSION` tag. | No implicit publication, production deployment, signing material, or physical acceptance. |

The Pin release is always one atomic, content-addressed set with exactly these
roles:

```text
installer.apk
bootstrap.apk
hook.apk
server.apk
hook-injector.apk
```

Preserve downloaded workflow artifacts as complete stores. Import and reverify
them at point of use:

```sh
./revival setup import vps-candidate \
  --handoff-root /external/downloaded-vps-candidate \
  --data-dir /external/revival-data
./revival setup artifacts vps --data-dir /external/revival-data

./revival setup import pin-release \
  --release-root /external/downloaded-pin-release \
  --data-dir /external/revival-data
./revival setup artifacts pin --data-dir /external/revival-data
```

A local `revival release candidate prepare` result is diagnostic and
structurally ineligible for deployment. A hosted artifact is evidence, not
permission to deploy or install; the operator still reviews the plan and
crosses the separate confirmation boundary. The full procedure is in
[Operations](docs/operations.md).

## Configuration and external state

Use the contract-backed CLI instead of editing Compose or checking in an env
file:

```sh
./revival config path
./revival config list --group local
./revival config template --group provider
./revival config check
```

Set ordinary values atomically with `config set`. Secrets are accepted through
standard input only and are never printed by `config get`:

```sh
printf '%s' "$VALUE_FROM_YOUR_SECRET_STORE" | \
  ./revival config set AZURE_SPEECH_KEY --stdin
./revival config get AZURE_SPEECH_KEY
```

Directory overrides are shell variables, not entries in the secret-bearing
runtime file:

- `REVIVAL_CONFIG_DIR`
- `REVIVAL_SECRETS_DIR`
- `REVIVAL_DATA_DIR`
- `REVIVAL_BUILD_DIR`
- `REVIVAL_BACKUP_DIR`

Every selected root must be external, unlinked, owner-controlled, and suitably
private. Canonical and compatibility aliases that disagree fail validation.
Read [Configuration](docs/configuration.md) before adding a provider or
production setting.

## Production safety

Production is an immutable-release consumer for an **existing reviewed
installation**. It is not a clean-server bootstrap and must never build, pull,
or infer authority from the live source tree. The supported release path uses a
downloaded hosted handoff, fresh provider verification, exact service → image
IDs, resumable upload, `--pull never`, `--no-build`, dry-run/confirm gates,
semantic canaries, drift proof, and retained rollback evidence.

The current deployment's physical ABI remains Carry even though the logical
product and source are Cosmos. At minimum, production authority includes:

| Resource | Exact retained identity |
| --- | --- |
| Remote release root | `/home/anders/ai-pin-revival` |
| Center data | `/home/anders/carry-center-data` |
| Cosmos state volume | `humane-carry-clone_carry-state` |
| PostgreSQL volume | `humane-carry-clone_carry-pgdata` |
| Prometheus volume | `humane-carry-clone_prometheus-data` |
| Grafana volume | `humane-carry-clone_grafana-data` |
| Local-model network | `humane-carry-clone_carry-local` |
| Container state target | `/var/lib/carry` |

The physical PostgreSQL role/database/schema/sequence identities, PKI files,
public hostnames/SNI, protected configuration paths, backup-v1 fields, metrics,
and Pin/Center compatibility keys must also remain Carry-compatible. There is
no authorized automatic create, copy, rename, migration, deletion, relabeling,
or second-writer alias for these resources.

Until the compatibility bridge and one-time first-cutover predecessor record
are completely implemented and verified, **stop before any deployment from
`main`**. After that gate is cleared, follow
[Operations → Production](docs/operations.md#production) exactly; do not invent
a merge-and-deploy shortcut.

Production data has additional invariants:

- Run exactly one Center writer and one writer per Cosmos workload identity.
- Treat protected configuration drift as a stop condition; use the guarded
  adoption plan only for a reviewed legitimate change.
- A server-side backup is still on the server. After PKI changes and regularly,
  create the separately verified off-host copy with
  `./revival backup --confirm --fetch`. This is a confirmed remote operation:
  it quiesces production writers and the Pin bridge while taking and verifying
  the snapshot, then restarts them unless `--leave-quiesced` was explicitly
  requested.

- Never remove or prune candidate, incoming, release, deployment, or backup
  state by hand. Use the documented dry-run/plan-token retention command.

## Pin installation hard stops

The five-role release is broader than the steady installed profile. Routine
installation keeps `installer`, `hook`, `server`, and `hook-injector` installed;
`bootstrap` is a separately confirmed recovery helper for a genuinely missing
or unhealthy installer.

> [!WARNING]
> If a healthy installer finds an existing managed Hook or runtime package at
> Android's randomized `/data/app/~~.../base.apk` path, **stop**. Do not invoke
> bootstrap recovery as a fallback. That recovery path uninstalls managed
> packages and can destroy FBE-scoped app data and device identity.

Always bind device work to the exact serial, inspect the plan, and use only the
confirmation form printed by command help. After an install restarts
`system_server`, wait for stable boot and re-read package versions before
deciding whether to retry. A partially reported failure can still have changed
package state; a blind retry can turn it into an unrecoverable boot loop.

Start with [Pin onboarding](docs/pin-onboarding.md). If the device is unstable,
stop and read [Recovery](docs/recovery.md) and the exact failure section in
[Operations](docs/operations.md#recovering-a-pin-that-will-not-boot) before
changing anything.

## Music and provider constraints

The base stack starts without third-party credentials. Capabilities remain
honestly unavailable until their exact provider contract is configured.

| Provider | Current boundary |
| --- | --- |
| Spotify | Experimental personal-use embedded `librespot` runtime on the Pin. It is off by default, requires Spotify Premium plus explicit acknowledgement, and keeps credentials in app-private Pin storage. Center receives only owner/device-bound adapter operations. It is not an official Spotify integration. |
| YouTube Music | Wearer sign-in and encrypted Center session storage are implemented. The stock Music experience receives only bounded catalog/stream results; ad/tracker hosts are refused. Physical playback still needs exact-Pin acceptance. |
| TIDAL | Official OAuth authorization-code + PKCE and full-track gateway code are implemented, but the provider stays unavailable until the operator supplies an official TIDAL client. No third-party client credential or auth-bypassing test-tone PoC is accepted. |
| Apple Music | MusicKit user-token storage is implemented only when an operator provides a developer token. Pin playback remains unavailable until an official Android playback/DRM runtime exists; the project does not substitute previews or bypass DRM. |

GPL music projects may be studied as clean-room references; their code is not
copied into this product. Provider terms, subscriptions, geographic
availability, and account eligibility remain the operator/wearer's
responsibility.

## Troubleshooting

- Run `./revival doctor`, then `./revival setup status` or
  `./revival setup --resume`; each reports the next unmet contract instead of
  silently installing tools.
- If Node is missing or rejected, install Node 22.14.0 or newer on the Node 22
  line. If Compose is rejected, start Docker and verify Compose is at least
  2.33.1.
- If a source/layout gate reports `node_modules`, `.next`, `target`, `build`,
  `.gradle`, or `.kotlin`, move that generated output to external build state.
  Never delete or overwrite source to make a release gate pass.
- If the Pin compiler refuses the host, use the hosted Linux/x64 CI lane. A
  refusal on macOS, ARM, or detected translation is expected safety behavior.
- If Center returns `404` for the current Pin release, no complete release store
  has been published. Ship the verified store as one unit; never copy individual
  APKs into place.
- A large `server.apk` publication may be quiet. The supported ship path uses a
  bounded resumable `rsync` transaction and verifies the remote size and
  SHA-256; do not replace it with plain SCP.
- Treat the randomized-package-path installer result as a hard stop, not a
  troubleshooting branch.
- Create a fixed, redacted diagnostic archive with
  `./revival support-bundle`, review it locally, and share only what is needed.

## Security, privacy, and contribution rules

- Keep secrets, provider tokens, PKI, signing keys, bridge tickets, device
  identities, wearer data, captures, logs, and raw evidence outside Git and
  outside release payloads.
- Do not commit firmware, APKs, decompiled proprietary source, packet captures,
  or production snapshots. Do not probe unrelated Humane infrastructure or
  third-party data.
- Wi-Fi credentials stay in the browser-local QR flow; no supported CLI command
  accepts an SSID or passphrase.
- Keep changes inside the owning component. Update `contracts/` when behavior
  crosses Center, Cosmos, Pin, or Platform, and add the narrow regression test
  that proves the boundary.
- Preserve stock package names, wire fields, authorities, certificate subjects,
  persistent keys, and Carry-era storage identities unless a separately
  reviewed reversible migration explicitly proves otherwise.
- Run focused checks during development and the full applicable release gate
  before asking another person or a hosted workflow to trust the change.
- Report physical or production behavior as `unknown` until direct evidence
  proves it on the named target.

## Documentation

| Need | Read |
| --- | --- |
| First local run | [Getting started](docs/getting-started.md) |
| Install from source or use the Dev Container | [Installation](docs/installation.md) |
| Understand the runtime and trust model | [Architecture](docs/architecture.md) |
| Find or change a setting | [Configuration](docs/configuration.md) |
| Look up command effects and exact forms | [CLI reference](docs/cli-reference.md) |
| Bring one exact Pin online | [Pin onboarding](docs/pin-onboarding.md) |
| Build, attest, deploy, back up, and operate | [Operations](docs/operations.md) |
| Recover server data or an unstable Pin | [Recovery](docs/recovery.md) |
| See prompt routes and capability gates | [Prompting map](docs/prompting-map.md) and [tool reference](docs/prompting-and-tool-reference.md) |
| Contribute code | [Contributing](CONTRIBUTING.md) |
| Browse everything | [Documentation index](docs/index.md) |
