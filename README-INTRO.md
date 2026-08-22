<h1 align="center">Ai Pin Revival</h1>

<p align="center"><strong>Bring it back. Make it yours.</strong></p>

<p align="center">
An independent cloud, control center, assistant, and device runtime<br>
for an operator-owned Humane Ai Pin.
</p>

<p align="center">
<code>Self-hosted</code> · <code>Rust</code> · <code>React</code> · <code>Android</code> · <code>Docker</code>
</p>

---

The Ai Pin was always more than a piece of hardware. It was an idea: computing
that could look up, listen, remember, navigate, capture, and help without asking
you to live inside a screen.

Ai Pin Revival gives that idea a new home.

Run the product on your own machine. Put its cloud on your own server. Manage it
from a beautiful web control center. Build and sign the device software. Connect
an owned Pin to a service you operate.

Your Pin. Your cloud. Your data. Your rules.

## This is the whole system

Ai Pin Revival is not just a dashboard or a chat demo. It contains the four
parts needed to run, manage, and evolve the product:

| Part | What it gives you |
| --- | --- |
| **Center** | A clean web home for memories, captures, notes, contacts, services, settings, device setup, and diagnostics. |
| **Cosmos** | The cloud behind the Pin: identity, storage, assistant behavior, search, speech, location, weather, music, and device APIs. |
| **Pin** | The on-device runtime, compatibility hooks, authenticated bridge, installer roles, and setup experience. |
| **Platform** | Docker composition, edge routing, immutable releases, deployment, health checks, backups, canaries, drift detection, and rollback. |

One repository. One release identity. One path from source code to a living Pin.

## What you can do

### Ask for the everyday things

Once the Pin and required providers are connected, you can ask things like:

```text
What time is it?
How much battery do I have left?
Am I connected to the internet?
What's the weather here?
What's nearby?
Where is the Eiffel Tower?
Translate good morning to French.
What do you remember about me?
What song is playing right now?
```

### Let the Pin act

```text
Set a timer for 10 minutes.
Set the volume to 30.
Play my favourites.
Take a photo.
Record a video.
Connect to Wi-Fi.
Turn on Bluetooth.
Enter privacy mode.
Start tracking my workout.
Change my quick action to notes.
```

Messages, calls, camera actions, Bluetooth changes, fitness tracking, and saved
data can have real effects. Test them deliberately.

The current source catalog covers:

| Surface | Count |
| --- | ---: |
| Wearer prompt capabilities | **89** |
| Model-callable tools | **37** |
| Strict native prompt routes | **52** |
| Device-visible Cosmos service families | **22** |
| Registered Cosmos RPC paths | **98** |
| Signed Android package roles | **5** |

These are source and contract counts. They do not turn a healthy container into
proof that every action has passed on every physical Pin.

See the [quick prompting map](docs/prompting-map.md) for every copyable example.

## Start locally in five commands

You do not need a physical Pin to run the local product and explore Center.

### What you need

| Requirement | Version |
| --- | --- |
| Docker with Compose | 2.33.1 or newer |
| Node.js | 22.14.0 or newer |
| Rust | 1.91.1 exactly |

The live version source is
[`platform/containers/pin-builder/toolchain.json`](platform/containers/pin-builder/toolchain.json).
`./revival doctor` checks your machine against it.

### Run it

```sh
./revival init
./revival doctor
./revival build
./revival up
./revival status
```

Open **[http://127.0.0.1:4000](http://127.0.0.1:4000)**.

That is Center: your account, data, captures, notes, services, Pin controls, and
system status in one place.

When you are done:

```sh
./revival down
```

Your volumes are preserved.

## Add the intelligence you want

`./revival init` creates a protected runtime file at:

```text
~/.config/ai-pin-revival/secrets/runtime.env
```

Add provider credentials there, never in the repository. You can configure:

- an OpenAI-compatible language model endpoint;
- maps, places, routing, and weather providers;
- web search and factual lookup providers;
- Azure Speech for remote text to speech;
- Spotify through the linked music service;
- optional vision, nutrition, and shopping integrations.

The stack can start without every optional provider. A feature whose account,
key, consent, or runtime flag is missing stays unavailable instead of pretending
to work.

For every variable and provider boundary, read
[`docs/operations.md`](docs/operations.md).

## Bring a real Pin online

This is where software meets hardware. It is powerful, exact, and still an
advanced setup. Some steps are manual today.

### Extra requirements

| Need | Why it exists |
| --- | --- |
| JDK 17, Android SDK 34, and NDK r28c | Builds the Pin software in the pinned toolchain. |
| A Pin signing keystore | Lets future updates match the signer already installed on your Pin. |
| Two hash-pinned native build inputs | Reproduces the required native device components. |
| A WebUSB browser on HTTPS or `localhost` | Connects Center's installer to the Pin over USB. |
| DeviceUser and attestation certificate authorities | Establishes durable device identity and enrollment trust. |
| An operator-owned compatible Ai Pin | Physical writes must target a known device with a recovery plan. |

The certificate authorities are supplied by the operator. `./revival init` does
not invent temporary roots that would invalidate the device after a restart.

### The path

1. Check the host without touching a device.

   ```sh
   ./revival pin doctor
   ./revival pin check
   ```

2. Add the signing material, pinned native inputs, and durable certificate
   authorities described in
   [Onboarding a Pin](docs/operations.md#onboarding-a-pin).

3. Dispatch the commit-pinned **Attested Pin release** workflow from `main`.
   It prepares and provider-attests the credential-free input before the
   operator-owned protected-input integration may expose signing material. If
   that external integration is not installed, the workflow stops closed.
   Download its complete `pin-release-<version>` file artifact, then verify and
   register the directory that contains `current.json`, `history.json`, and
   `releases/`:

   ```sh
   ./revival setup import pin-release \
     --release-root /external/downloaded-pin-release \
     --data-dir /external/revival-data
   ./revival setup artifacts pin --data-dir /external/revival-data
   ```

   The old local `pin release build` alias intentionally refuses before it can
   open a signing key.

4. Inspect the server publish plan, then publish when the target is correct.

   ```sh
   ./revival pin release ship --release-root /external/downloaded-pin-release
   ./revival pin release ship --release-root /external/downloaded-pin-release --confirm
   ```

5. Open `/settings/pin/install` in Center. Connect the Pin over WebUSB. Center
   verifies the exact-five release manifest, then maintains the four steady
   installed roles. The bootstrap APK is recovery-only and is never part of a
   routine healthy-installer update.

6. Provision the device identity, activate the clone endpoint, connect Wi-Fi,
   and complete enrollment. Activation is a journalled device transaction, but
   invoking it is still a documented manual step.

7. Run the canary, then verify the actual Pin experience.

   ```sh
   ./revival canary --confirm
   ```

A green canary proves the deployed service checks it performs. It does not, by
itself, prove projector output, audio, radio state, signed installation, or
every physical action. Those pass only when you observe them on the exact Pin.

## Put the cloud on a server

Production commands are for an existing, reviewed installation. They are not a
clean-VPS bootstrap wizard.

```sh
./revival doctor production
./revival setup import vps-candidate \
  --handoff-root /external/downloaded-vps-candidate \
  --data-dir /external/revival-data
./revival setup artifacts vps --data-dir /external/revival-data
REVIVAL_DATA_DIR=/external/revival-data ./revival deploy production --candidate-id CANDIDATE_SHA256 --dry-run
./revival backup --confirm --fetch
./revival canary --confirm
./revival drift
```

When the dry run, identity checks, release evidence, recovery path, and operator
review all agree, the deployment command publishes one immutable Center and
Cosmos release.

```sh
REVIVAL_DATA_DIR=/external/revival-data \
  ./revival deploy production --candidate-id CANDIDATE_SHA256 --confirm
```

Create the downloaded handoff by dispatching the SHA-pinned **Attested VPS
candidate** workflow on `main`; it has no secret, signing, SSH, or deployment
authority. Its provider attestation binds the exact Git source, toolchain,
builder/image receipts, run identity, and candidate file set. This proves
GitHub-hosted trusted-workflow provenance, not bare metal or absence of a
hypervisor. Local ARM/macOS candidate preparation remains an intentional
pre-Docker refusal.

The operational model is built around proof:

- releases are content-addressed and verified after extraction;
- Center and every Cosmos workload run the same release identity;
- canaries test health and the signed-in wearer path;
- drift checks compare the live host with the recorded release;
- rollback moves the application release pointer without silently rewriting the database;
- backups can be fetched and re-verified off-host.

## Your source stays source

Runtime material lives outside the repository:

| Material | Default location |
| --- | --- |
| Configuration | `~/.config/ai-pin-revival` |
| Secrets | `~/.config/ai-pin-revival/secrets` |
| Builds and Pin releases | `~/.local/share/ai-pin-revival` |
| Off-host backup bundles | `~/.local/state/ai-pin-revival/backups` |

Do not commit APKs, firmware, private keys, device identities, wearer data,
captures, packet traces, or production logs.

One warning matters more than the rest: a backup that exists only on the server
is not an off-host backup. Use `./revival backup --confirm --fetch` to bring home a
verified bundle that also includes the Pin signing material stored only on your
operator machine.

## Built to be understood

Start with the page that matches what you are doing:

- [Prompting map](docs/prompting-map.md): every supported prompt in one brief list.
- [Stock tool/action parity checklist](docs/stock-tool-parity-checklist.md): every audited stock action marked ✅ or ❌.
- [Prompting and tool reference](docs/prompting-and-tool-reference.md): tool schemas, gates, exact grammar, and the Cosmos interface.
- [Architecture](docs/architecture.md): how Center, Cosmos, Pin, and Platform fit together.
- [Operations](docs/operations.md): local use, production, releases, and physical onboarding.
- [Recovery](docs/recovery.md): off-host backups, server reconstruction, and database restoration.

## What this project is, honestly

Ai Pin Revival is an independent implementation for operator-owned devices. It
does not claim to be Humane's hidden service or a byte-for-byte copy of it.

It gives you a real local stack, a real control center, independently authored
device services, a signed release pipeline, a guarded route to owned hardware,
and tests that separate implemented behavior from assumptions.

Provider accounts can expire. Feature flags can disable a path. A device build
can differ. Physical acceptance remains its own gate.

That honesty is part of the product. When the Pin says it works, there should be
evidence behind it.

---

<p align="center"><strong>The hardware was never the whole idea.</strong></p>

<p align="center">Now the rest can belong to you.</p>
