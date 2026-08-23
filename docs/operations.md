# Operations

## Local services

```sh
./revival up
./revival status
./revival logs
./revival down
```

`down` keeps service data and development caches. Use `./revival config` to
inspect the resolved Compose model.

## Development checks

```sh
./revival check changed
./revival check center
./revival check cosmos
./revival check platform
```

Use a Cosmos test name or substring to avoid running the entire workspace:

```sh
./revival check cosmos encrypted_weather_accepts_the_stock_location_envelope
```

The CLI verifies that a filter matches at least one test before running it.

## Production

On the production host, configure runtime settings outside the checkout, then run:

```sh
./revival config check
./revival doctor production
./revival deploy production --dry-run
./revival deploy production --confirm
```

Preflight checks connectivity, required tools, configuration, Compose input,
and available space. Dry-run renders the actions without changing the server.
Confirmed deployment sends the current Cosmos source and configuration to the
configured host and starts the production Compose project.

There is no alternate production command or migration mode. Fix the current
Cosmos configuration and deploy again when a deployment fails.

## Observe

Use:

```sh
./revival doctor production
./revival status
./revival logs
```

Center exposes wearer-visible status. Service logs and health endpoints provide
the direct operator view.

## Pin releases

The hosted Pin workflow builds and signs all five APK roles as one set. Before
shipping or installing:

```sh
./revival pin release inspect --release-dir DIR
./revival pin release verify --release-dir DIR
./revival pin release ship
```

`ship` plans by default and publishes only with `--confirm`.

## Install one Pin

```sh
./revival pin doctor --serial SERIAL
./revival pin install --serial SERIAL --release-dir DIR
./revival pin install --serial SERIAL --release-dir DIR --confirm
```

The first install command prints the plan. Confirmation rechecks the exact
serial, product, APK identities, signers, versions, available space, and
installed package paths. If the Hook is installed at an unexpected randomized
path, stop and correct the device state deliberately; do not bypass the guard.

After changing the Hook, restart the affected stock host processes so they load
the new bytes.

## Diagnostics

```sh
./revival support-bundle --output /external/path/support.json
```

The bundle is a fixed redacted allowlist and does not include secret values.
