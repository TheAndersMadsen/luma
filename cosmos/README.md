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

`COSMOS_*` remains the logical source/configuration namespace. The development
Compose model may use `/var/lib/cosmos`, but production deliberately overrides
the physical state target to the legacy `/var/lib/carry` path and reuses the
exact deployed legacy volumes, network, database identities, and Center
directory. Those are
persistent ABI, not product names; changing them requires a separately reviewed,
reversible migration and is not part of the rename.

Workspace boundaries are in [architecture](../docs/architecture.md); runtime
commands are in [operations](../docs/operations.md).
