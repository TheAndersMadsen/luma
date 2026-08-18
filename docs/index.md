# Documentation index

One page per subject, flat under `docs/`, lowercase and hyphenated. The layout
gate (`platform/deploy/acceptance/layout.sh`) enforces that shape and requires
this index plus the three core pages.

## Core pages

| Page | Read it when |
| --- | --- |
| [getting-started.md](getting-started.md) | You want a clean local Center/Cosmos stack and a first visible result. |
| [installation.md](installation.md) | You need the source, Dev Container, PWA, or prepared release-distribution path. |
| [configuration.md](configuration.md) | You need to find, inspect, validate, or change external runtime settings. |
| [cli-reference.md](cli-reference.md) | You need every current `revival` command, effect boundary, or exact new command form. |
| [pin-onboarding.md](pin-onboarding.md) | You are bringing one exact Pin online and want the short guarded sequence. |
| [architecture.md](architecture.md) | You need the component boundaries, the runtime flow, the two protobuf trees, or the compatibility labels. |
| [operations.md](operations.md) | You need the advanced validation, production, deployment, or Pin evidence reference. |
| [recovery.md](recovery.md) | The server is gone, or a database has to be put back. |

## Reference pages

| Page | Contents |
| --- | --- |
| [prompting-map.md](prompting-map.md) | Short, copyable list of all model tools and native prompt routes. |
| [prompting-and-tool-reference.md](prompting-and-tool-reference.md) | Every source-reachable wearer capability, exact grammars, feature gates, and the Cosmos gRPC interface. |
| [stock-tool-parity-checklist.md](stock-tool-parity-checklist.md) | Audited stock action names, marked callable or not. |
| [stock-feel-migration-goal.md](stock-feel-migration-goal.md) | The execution contract for the stock-feel architecture migration and release pass. |

## Where things are not documented here

- Component internals live beside the component: `center/README.md`,
  `cosmos/README.md`, `pin/README.md`.
- Contributor setup and focused source checks: [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- Cross-component wire compatibility is data, not prose:
  `contracts/compatibility.json`, `contracts/features.json`,
  `contracts/wire-divergence.json`.
