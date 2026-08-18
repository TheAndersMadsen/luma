# Ai Pin Revival

One workspace for bringing an operator-owned Humane Ai Pin back online. Center
is the wearer dashboard, Cosmos is the compatible cloud, Pin is the device-side
runtime, and Platform builds, releases, and operates the whole system.

| Start here | What you need | Guide |
| --- | --- | --- |
| Try the product locally | Docker Compose 2.33.1+ and Node.js 22.14.0+ on the Node 22 line | [Getting started](docs/getting-started.md) |
| Contribute source changes | The local requirements plus Rust 1.91.1; JDK 17 for the Pin source gate | [Contributing](CONTRIBUTING.md) |
| Bring one Pin online | A compatible Pin, exact serial, ADB, signing material, private build inputs, and reviewed PKI | [Pin onboarding](docs/pin-onboarding.md) |
| Operate production | An existing reviewed installation and its protected configuration | [Operations](docs/operations.md#production) |

The supported interface is `revival`. It remembers only the selected setup
track outside the checkout, recomputes evidence, and reports completed, blocked,
and next steps from the same contract used by Center.

## Run locally

From a source checkout:

```sh
./revival setup local
./revival init
./revival doctor
./revival up
./revival status
```

Center opens at <http://127.0.0.1:4000>. `./revival down` stops the stack
without deleting volumes. `./revival setup status` shows what is complete and
`./revival setup --resume` returns to the next action.

Local use does **not** require Rust, a JDK, or an Android SDK. The source-based
CLI needs Node.js 22.14.0 or newer on the Node 22 line; Docker supplies the
product services. See [installation](docs/installation.md) for clean-checkout,
Dev Container, and Center PWA instructions.

The pinned source contributor line is **JDK 17, Android SDK 34, NDK r28c, Node >= 22.14.0, and Rust 1.91.1**.
The exact machine-readable toolchain lives in
`platform/containers/pin-builder/toolchain.json`.

## Bring a Pin online

Start with a plan bound to the exact connected device:

```sh
./revival setup pin
./revival pin doctor
./revival pin activate status --serial <exact-serial>
./revival pin network --serial <exact-serial>
```

The guided path covers DeviceUser PKI, signed immutable releases, publication
to Center, exact-serial installation, activation, browser-local Wi-Fi QR setup,
and physical acceptance. The CLI never accepts a Wi-Fi name or passcode.

Use the short [Pin onboarding guide](docs/pin-onboarding.md) while doing the
work. [Operations](docs/operations.md#onboarding-a-pin) remains the advanced,
evidence-backed reference for each boundary and recovery condition.

## Prompt the Pin

- [Quick prompting map](docs/prompting-map.md): all model tools and native prompt routes.
- [Prompting and tool reference](docs/prompting-and-tool-reference.md): exact grammars, gates, side effects, and Cosmos gRPC methods.
- [Stock parity checklist](docs/stock-tool-parity-checklist.md): every audited stock action marked available or not.

## What lives where

| Part | Owns |
| --- | --- |
| [`center/`](center/) | Wearer data, settings, service connections, Pin setup, and the install PWA |
| [`cosmos/`](cosmos/) | Device APIs, identity, data, AI, search, speech, and compatibility services |
| [`pin/`](pin/) | System Injector, hooks, runtime, on-device setup page, and authenticated bridge |
| [`platform/`](platform/) | CLI, Compose, edge, packaging, deployment, backup, canary, and acceptance checks |
| [`contracts/`](contracts/) | Versioned cross-component command, setup, feature, and wire contracts |

Generated output, secrets, state, releases, support bundles, and backups stay
outside the source tree. [Architecture](docs/architecture.md) explains the
runtime and compatibility boundaries.

## Distribution status

The repository contains a deterministic full-product archive builder, checksum
generation, a Homebrew formula template, and a tag-gated release workflow. No
public binary or Homebrew release is advertised until a reachable version tag
and release exist. Today, use a source checkout or the Dev Container described
in [installation](docs/installation.md).

## Safety and proof

Commands whose help names a plan/confirm gate are dry-run first. Other remote
operations can execute when invoked, so read their exact target and help before
running them. Device installation and activation require an exact serial plus
explicit confirmation. PKI commands handle only the DeviceUser CA; they do not
invent or replace the attestation root.

`observed`, `derived`, `implemented`, and `unknown` are the compatibility
labels used here. A green build, healthy container, successful server canary,
or completed ADB transaction is not physical proof. Pin playback, projection,
sync, and wearer interaction remain unknown until observed on the exact device.

Run `./revival backup --fetch` after PKI changes and on a regular schedule. It
is the supported off-host copy of irreplaceable server key material plus the
Pin signing keystores. See [recovery](docs/recovery.md).
