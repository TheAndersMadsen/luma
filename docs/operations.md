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

Preflight checks the environment file, Docker Compose, and the resolved Compose
model. Dry-run prints the exact Compose command without changing services.
Confirmed deployment builds the current checkout and starts the production
Compose project on this host.

There is no alternate production command or migration mode. Fix the current
Cosmos configuration and deploy again when a deployment fails.

## Observe

Use:

```sh
./revival doctor production
```

The deployment prints `docker compose ps` after its health wait. Center,
service logs, and health endpoints provide the direct operator view.

## Pin releases

The pinned builder builds, signs, and verifies all five APK roles as one set:

```sh
./revival pin release build --version YYYY-MM-DD.N --version-code INTEGER
```

The successful build atomically updates the external release store that Center
mounts read-only. There is no separate upload or remote publication step.

## Install one Pin

```sh
./revival pin doctor
./revival pin install --serial SERIAL
./revival pin install --serial SERIAL --confirm
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
