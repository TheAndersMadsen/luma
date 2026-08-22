# How to bring one Pin online

This guide is the short operator path from a compatible stock Ai Pin to a Pin
pointed at your Revival backend. Every device action is bound to one exact
serial. Read the [advanced onboarding reference](operations.md#onboarding-a-pin)
before the first physical write or when any step fails.

## Prerequisites

- An owned, authorized Pin whose current firmware and package state you have
  inspected.
- A known recovery path for that state.
- Docker and Node.js 22.14.0+ for the source-based CLI.
- Android platform-tools (`adb`) for exact-device operations.
- A Pin signing keystore and its four protected `PIN_SIGNING_*` settings.
- Both authorized, digest-matched private Pin build inputs.
- An existing attestation CA that chains to the root pinned by the Pin release.
- Either an existing DeviceUser CA pair or authorization to create a new one.
- An existing local or production Center/Cosmos stack.

No command in this guide creates or replaces the attestation CA. No network
name or passcode is accepted on the CLI.

## 1. Select the journey and inspect the host

```sh
./revival setup pin
./revival pin doctor
./revival pin activate status --serial <exact-serial>
./revival setup status
```

Setup records the journey outside the repository. It does not read or write the
Pin. `pin doctor` may inspect device presence but performs no device mutation.
Stop on an unexpected serial, signer, package, boot, battery, or transport
state.

## 2. Import or create DeviceUser PKI

Prefer importing the existing DeviceUser CA when one already issued
certificates:

```sh
./revival pki import device-user \
  --cert /protected/input/duc-ca.crt \
  --key /protected/input/duc-ca.key
```

Review the fingerprint and destinations, then repeat with `--confirm`. Both
input files must be non-linked regular files at mode 0600. The command validates
the current X.509 CA, EC P-256 PKCS#8 key, and key match before committing the
pair atomically.

For a new installation with no existing DeviceUser identity:

```sh
./revival pki init device-user
./revival pki init device-user --confirm
```

This creates only a self-signed DeviceUser CA. It refuses to overwrite nonempty
destinations. Back up the result off-host before enrolling a Pin:

```sh
./revival backup --confirm --fetch
```

## 3. Run the attested hosted Pin release

Choose a version name and strictly increasing Android version code:

Dispatch `.github/workflows/pin-release.yml` from `refs/heads/main` with the
version and version code. The workflow must receive its protected signing inputs
from the operator-owned GitHub environment integration after its provider-signed
pre-input attestation. Without that integration it fails closed. The retired
local `./revival pin release build ...` alias refuses before opening signing
inputs; it cannot create an authoritative release.

Download the resulting `pin-release-<version>` store artifact while preserving
its `current.json`, `history.json`, immutable release directory, five APKs, and
`hosted-attestation.json`. Confirmed ship reconstructs the separately pinned
verifier runtime if it is absent and treats the evidence-bound historical
builder image ID only as signed build data. Neither hosted publication nor the
local refusal runs ADB.

On the supported Linux x64 verifier host, register and point-of-use verify the
downloaded directory before shipping it:

```sh
./revival setup import pin-release \
  --release-root /external/downloaded-pin-release \
  --data-dir /external/revival-data
./revival setup artifacts pin --data-dir /external/revival-data
```

The exact-five release contains the four steady installed roles plus the
bootstrap recovery helper. A routine update retains/proves a healthy installer
and never runs bootstrap; bootstrap recovery requires a separate confirmation
only for a genuinely missing or unhealthy installer.
The lower-level `pin release inspect`, `verify`, and `plan` tools accept explicit
artifact, manifest, receipt, history, signer, installed-state, and serial inputs;
use their `--help` when auditing a non-default bundle rather than copying an
incomplete command.

For a production Center, ship the exact verified release:

```sh
./revival pin release ship --release-root /external/downloaded-pin-release
./revival pin release ship --release-root /external/downloaded-pin-release --confirm
```

The first command prints the local and remote identities and transfer plan. The
confirmed command publishes to the release store Center serves; it is separate
from a server deploy.

## 4. Install on the exact Pin

You can use Center at `/settings/pin/install` over WebUSB or the guarded CLI.
The CLI plans first:

```sh
./revival pin install --serial <exact-serial>
```

Read the plan, current package state, release identity, signer, and recovery
requirements. A managed package at Android's randomized
`/data/app/~~.../base.apk` path while the installer is healthy is a hard stop:
do not use bootstrap recovery as a fallback, because it uninstalls managed
packages and risks FBE data and device identity. A genuinely missing/unhealthy
installer remains a distinct, separately confirmed bounded recovery decision.
Only then use the confirmation form shown by
`./revival pin install --help`.

Center and the CLI verify package, version, size, and SHA-256 before mutation.
A completed install transaction is not proof of playback, projection, sync, or
wearer interaction. Wait for stable boot and re-read installed package versions
before deciding whether to retry anything.

## 5. Mint and protect the activation credential

Sign in as an operator and use Center's provisioning control under `/admin`.
It returns the device id, leaf certificate, private key, issuing certificate,
and enrollment pincode once. Save the credential JSON outside the checkout as a
regular mode-0600 file.

The file contains only:

```json
{
  "device_id": "<exact hardware device id>",
  "certificate_pem": "<issued leaf certificate>",
  "private_key_pem": "<issued private key>",
  "ca_certificate_pem": "<attestation issuer certificate>"
}
```

Do not add endpoints. Activation fixes both stock Humane HTTPS hostnames itself
and validates the full chain against the root pinned in the installed runtime.

## 6. Activate the exact Pin

```sh
./revival pin activate \
  --serial <exact-serial> \
  --credential-file /protected/activation.json \
  --edge-ipv4 <canonical-ipv4>
```

The plan validates the credential, exact hardware device id, current provider
state, pinned chain, key match, and canonical edge IPv4. It performs no provider
write. Review it, then repeat with `--confirm`.

The confirmed command streams the private envelope through standard input to
the Pin's identity provider, commits clone mode last, and re-reads all provider
postconditions. It never places the credential in ADB arguments or pushes a
temporary credential file.

Verify host-visible state:

```sh
./revival pin activate status --serial <exact-serial>
```

## 7. Join Wi-Fi without CLI credentials

Open Center's public, browser-local QR generator:

```sh
./revival pin network qr --open
```

The CLI accepts no SSID, password, or PSK flag. The page builds the QR payload
inside the browser without sending the network credential to Center's backend.
Use the Pin's supported setup scanner, then inspect only the redacted state:

```sh
./revival pin network --serial <exact-serial>
```

The status command reports only whether Wi-Fi is enabled and connected. It
classifies any SSID/BSSID-bearing ADB output in memory and does not print the
identifiers.

## 8. Verify the live and physical result

```sh
./revival canary --confirm
./revival drift
./revival setup status
```

These prove server semantics and recorded configuration, not the physical Pin.
On the exact device, separately observe the supported interactions you need:
network reachability, onboarding completion, spoken assistant response,
projection, capture sync, media playback, and any corrected wire behavior.

Record unobserved checks as `unknown`, not passed. If installation, activation,
boot, or enrollment fails, preserve the error and current state and switch to
[recovery](recovery.md); do not improvise a reset, reinstall, or retry.

## Troubleshooting

- `pki ...` refuses overwrite: determine whether the existing CA is the live
  issuer. Never rotate it as a setup shortcut.
- Center has no release: run `pin release inspect`, then plan and confirm `pin
  release ship` for the correct remote.
- Activation rejects the credential: verify it names this Pin and chains to the
  root pinned in the installed release. Do not add a root override.
- Wi-Fi status is unknown: preserve the raw device state privately; do not pass
  credentials to a shell fallback.
- Create a fixed, redacted host diagnostic with `./revival support-bundle` and
  review it before sharing.
