# Security policy

Luma runs your own Ai Pin cloud. The server holds your captures, notes,
contacts, provider keys, and the trust roots your Pin relies on. A security
problem in Luma affects every server that runs it, so please report it
privately.

## Report a vulnerability

Use GitHub's private vulnerability reporting on the repository:
**Security → Report a vulnerability** at
<https://github.com/TheAndersMadsen/luma/security/advisories/new>. The
report is visible only to you and the maintainer.

> [!NOTE]
> The repository owner has to enable **Private vulnerability reporting** once,
> under **Settings → Code security**, before that page accepts reports. If the
> page says reporting is not enabled, open an issue that only asks
> [@TheAndersMadsen](https://github.com/TheAndersMadsen) for a private
> channel. Leave out the details of the problem. GitHub has no private
> messages.

Do not open a public issue, pull request, or discussion for a security
problem, and do not post it in chat.

Include what you can:

- The release ID and version (`https://YOUR_DOMAIN/api/version`) or the
  commit you tested.
- The component: Center, Cosmos, the `./luma` CLI or `bootstrap`, the edge
  (Traefik or Envoy), or one of the five Pin apps.
- Steps to reproduce, the impact you observed, and any proof of concept.
- Whether the problem needs an account, a paired Pin, physical USB access,
  or nothing.

Never include real credentials, tokens, a Pin's serial or device identity,
or another person's data. `./luma support-bundle` writes a redacted
diagnostic file if logs help.

## What to expect

- An acknowledgement within seven days, and a first assessment within
  fourteen. One person maintains Luma in their spare time, so please allow
  for that.
- Coordinated disclosure. The fix ships in a signed release, and the README's
  update section tells operators how to apply it. The advisory is published
  afterwards, with credit to you unless you prefer otherwise.
- Only the newest release is supported. Production installs a
  checksum-verified operator archive. There is no backport branch.

## In scope

- Cosmos: authentication and account partitioning of the `humane.*` gRPC
  services and the web API, enrollment and device identity, provider
  credential handling, and the assistant's policy checks (confirmation,
  keyguard, untrusted tool output).
- Center: sign-in and session handling, the operator API, the Pin installer
  and activation flow, the music gateways, and public endpoints.
- The `./luma` CLI, `bootstrap`, setup, deploy, backup, and restore: secret
  handling, release verification, and anything that could run untrusted
  input on the server.
- The Pin apps and Compatibility Layer: anything that lets a Pin talk to a
  server other than its activated Cosmos, leaks a key to the device, or
  bypasses the serial, signer, or confirmation checks.

## Out of scope

- Vulnerabilities in the stock Humane software, Android, or the Pin
  hardware itself, including the PenumbraOS device foundation. Report those
  to the projects that own them.
- Problems in third-party providers (OpenAI, OpenRouter, Azure, Google,
  Spotify, YouTube, TIDAL, Rabbit, and so on) or in Docker, Traefik, Envoy,
  Keycloak, PostgreSQL, and other upstream images, unless Luma configures
  them unsafely.
- Attacks that need root or the operator's shell on the server, the
  operator's own credentials, or physical access to an unlocked Pin.
- Denial of service by volume, missing security headers with no
  demonstrated impact, and reports from automated scanners without a
  reproduction.
- Servers other than your own. Only test against a Luma you run.

## Design notes for researchers

- Provider keys never reach the Pin. Activation copies only the Cosmos
  endpoint, the operator trust root, and the device identity.
- Center delegates ADB authorization to PenumbraOS's remote signing service
  (`adb.penumbraos.workers.dev` by default, proxied server-side through
  `/api/pin/adb/sign`). Luma generates, stores, and ships no ADB private key
  or certificate. Center's local ADB key generation is disabled, so the
  remote signer is the only way Center is authorized over WebUSB. The CLI's
  device commands (`./luma pin install`, `pin activate`, `stock decompile
  --from-device`) use the computer's own `adb` and whatever authorization it
  already holds.
- The Compatibility Layer fails closed. Before activation, or while the
  server is unreachable, the Pin talks to no other cloud.
- Secrets enter through `./luma config set NAME --stdin` and Center's
  settings, never argv, logs, or the browser. A configured secret is never
  returned to the browser.
- Luma collects no telemetry. Cosmos's metric labels are bounded names such
  as service, method, route, transport, tool, stage, and outcome. They never
  hold anything a wearer said, captured, or stored, or any account or device
  identifier.

See [docs/privacy.md](docs/privacy.md) ("App privacy") and
[docs/architecture.md](docs/architecture.md) for the trust boundaries these
notes come from.
