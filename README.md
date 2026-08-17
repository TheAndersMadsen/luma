# Ai Pin Revival

One workspace for bringing an operator-owned Humane Ai Pin back online.

| Part | Owns |
| --- | --- |
| [`center/`](center/) | The wearer dashboard: memories, captures, notes, contacts, services, and settings |
| [`cosmos/`](cosmos/) | The cloud: device APIs, data, identity, AI, search, and speech |
| [`pin/`](pin/) | The device side: System Injector, hooks, runtime, and bridge |
| [`platform/`](platform/) | Compose, edge, release packaging, deployment, and acceptance checks |

`center`, `cosmos`, and `pin` are the product architecture. `platform` only
joins and operates them. Generated output, secrets, state, releases, and
backups stay outside the source tree. Verification and build internals stay
behind the component boundary they protect; there is no root miscellaneous
scripts or tools area.

## Run locally

Requirements: Docker with Compose 2.33.1+, plus the Node.js and Rust versions
named in `platform/containers/pin-builder/toolchain.json` — today Node 22.14.0+
and Rust 1.91.1+. That file is the single source of truth; `./revival doctor`
reads it and requires the same major line, so check it there rather than here.

```sh
./revival init
./revival doctor
./revival build
./revival up
./revival status
```

Center opens at <http://127.0.0.1:4000>. Stop the stack with `./revival down`;
the command preserves volumes.

Run the release gate with `./revival test`. Add `--source` to check the Pin
toolchain, Rust metadata, and the Gradle project graph; that check does not
install to a device.

## Prompt the Pin

[Quick prompting map](docs/prompting-map.md) is the short, copyable list of all
37 model tools and 52 native prompt routes.

[Stock tool/action parity checklist](docs/stock-tool-parity-checklist.md) marks
every one of the 138 audited stock action names ✅ or ❌, including all 105
callable native actions and the non-promptable stock ledger.

[Pin prompting and tool reference](docs/prompting-and-tool-reference.md) lists
all 89 source-reachable wearer capabilities, every model-callable tool and
native prompt action in that catalog, exact compatibility grammars, feature
gates, safe examples, side effects, and the complete 22-service/98-method
Cosmos gRPC interface.

## Bring a Pin online

[Onboarding a Pin](docs/operations.md#onboarding-a-pin) is the ordered path from
a stock Ai Pin to a device talking to your own stack: what `./revival init`
produces and what it leaves for you, the two CAs you must supply yourself, how a
Pin release is built and how it reaches the server, how the five APK roles are
installed from `/settings/pin`, and how the injector repoints the device without
root or a reflash. Steps that still have no command are marked as such rather
than left out.

The Pin console is part of Center: `/settings/pin` for the wearer, and
`/admin/pin/terminal` — an ADB root shell on your device — for operators only.
It used to be a separate browser app served at `/setup`; there is no `/setup`
now and there must not be, see [architecture](docs/architecture.md#runtime-flow).
The Pin serves its own on-device setup page, which is a different thing.

## Safety

The root CLI can inspect Pin build readiness and immutable release metadata, but
it cannot select, reset, flash, install to, or provision a Pin.
Physical device work requires an exact serial, a compatible signed bundle,
current-state capture, a tested recovery path, and explicit authorization at
the write step.

`observed`, `derived`, `implemented`, and `unknown` are the only compatibility
labels used here. A passing build or healthy container is not proof that a
physical Pin works.

Read [architecture](docs/architecture.md) for the boundaries and compatibility
rules, and [operations](docs/operations.md) for the operator workflow.

[Recovery](docs/recovery.md) covers the two cases the other pages do not: the
server is gone, or a database has to be put back. Its first section lists the key
material that cannot be regenerated. All of it survives on exactly one machine
until `./revival backup --fetch` is run — server backups do not count, because
they live on the same disk as what they protect — and the Pin signing keystores
exist as exactly one copy anywhere.
