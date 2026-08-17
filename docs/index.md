# Documentation index

One page per subject, flat under `docs/`, lowercase and hyphenated. The layout
gate (`platform/deploy/acceptance/layout.sh`) enforces that shape and requires
this index plus the three core pages.

## Core pages

| Page | Read it when |
| --- | --- |
| [architecture.md](architecture.md) | You need the component boundaries, the runtime flow, the two protobuf trees, or the compatibility labels. |
| [operations.md](operations.md) | You are running, validating, releasing, deploying, or onboarding a Pin. |
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
- Contributing, setup, and the fast source checks: [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- Cross-component wire compatibility is data, not prose:
  `contracts/compatibility.json`, `contracts/features.json`,
  `contracts/wire-divergence.json`.
