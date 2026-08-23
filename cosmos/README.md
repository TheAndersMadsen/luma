# Cosmos

Cosmos is the cloud for Ai Pin Revival. It owns device-facing services, shared
wire contracts, persistence, assistant behavior, search, and speech providers.

## Validate

```sh
cargo metadata --no-deps
cargo fmt --all -- --check
cargo test --workspace --locked
```

Use `./revival up` from the workspace root to run the composed service set.
Individual workloads share one binary and select their service family through
Compose.

## Layout

| Path | Purpose |
| --- | --- |
| `../contracts/wire` | Canonical independently authored device protocols |
| `crates` | Rust services, cryptography, and protocol bindings |
| `prompts` | Versioned `.prompt` runtime assets and their registry check |
| `search` | Private SearXNG policy |
| `verify` | Content-free hygiene and behavioral compatibility checks |
| `vendor` | Pinned enrollment dependency patch |

- `implemented`: account, AI Bus, contacts, feature flags, notable events,
  provisioning, capture storage, enrollment, and Center projections exist.
- `implemented`: Azure Speech is an optional AI Bus adapter; credentials remain
  in the protected runtime environment.
- `derived`: the service and message shapes are independent implementations of
  behavior observed at the owned-device boundary.
- `unknown`: complete stock parity and physical-Pin speech playback until an
  authorized target run observes them.

`COSMOS_*` is the runtime configuration namespace. Compose mounts the shared
`cosmos-state` volume at `/var/lib/cosmos`; production pins it as
`ai-pin-revival_cosmos-state` and stores PostgreSQL data in
`ai-pin-revival_cosmos-pgdata`. Validate production configuration with
`./revival doctor production`, then deploy the root Compose model with its
production overlay through `./revival deploy production`.

Workspace boundaries are in [architecture](../docs/architecture.md); runtime
commands are in [operations](../docs/operations.md).
