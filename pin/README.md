# Pin

Pin contains the device-side work needed to connect an operator-owned Ai Pin to
Cosmos. It does not contain Humane firmware, APKs, keys, or wearer data.

> Pin code uses privileged injection. A bad or incompatible bundle can cause a
> boot loop and may require a reflash. Host checks are not permission to install
> anything.

## Layout

| Path | Purpose |
| --- | --- |
| `injector` | Privileged bootstrap and trust-anchor project |
| `hook/payload` | Narrow hooks loaded into stock processes |
| `hook/loader` | Loader installed into `system_server` |
| `runtime/android` | Android service and packaging layer |
| `runtime/core` | Rust device runtime and stock-facing services |
| `bridge` | Authenticated remote connection to the owned Pin |
| `contracts` | Stock wire and native-action compatibility contracts |
| `../platform/containers/pin-builder` | Reproducible builder and code-generation internals |
| `../platform/deploy/acceptance/pin` | Host and exact-target acceptance harnesses |

## Host checks

Build prerequisites: JDK 17, Android SDK 34, Android NDK r28c, and Node >=22.14.0.

From the workspace root:

```sh
./revival test --source
```

For focused work:

```sh
cargo test --locked --manifest-path pin/runtime/core/Cargo.toml
./pin/gradlew --no-daemon -p pin projects
```

The browser-side installer console is not here. It is part of Center
(`center/src/app/settings/pin`, `center/src/lib/pin-install`,
`center/src/lib/pin-device`) and is checked by `npm --prefix center test`.

The System Injector project has its own Gradle boundary and requires
operator-supplied signing material for release builds.

## Device boundaries

- The injector is the privileged USB bootstrap and rare trust-anchor
  replacement path. Routine Hook and runtime updates must use the already
  installed injector and must never attempt to replace the injector itself.
- The installer consumes one same-origin, content-addressed five-APK release
  manifest; it verifies package, version, size, and SHA-256 before any device
  mutation. It runs in the browser and lives in Center, not here.
- The bridge is an authenticated, owner-bound transport. Its endpoint ticket,
  allowlist, and bearer material are credentials and never belong in source.
- Generated APKs, Cargo/Gradle/npm output, signer material, device snapshots,
  and recovery evidence live under the external Revival config/data roots.

- `implemented`: System Injector, hooks, Android/Rust runtime, bridge, and
  compatibility contracts are present in this tree.
- `derived`: exact package names and wire identifiers remain stable where the
  stock device boundary depends on them.
- `unknown`: safe installation, stock-unit provisioning, reboot stability, and
  wearer-visible behavior until an authorized exact-target run passes with a
  tested rollback path.

This work includes code derived from the PenumbraOS community project; license
notices remain with the relevant source. It is not affiliated with Humane.

Read the workspace [operations](../docs/operations.md) and
[compatibility boundary](../docs/architecture.md#compatibility) before target work.
