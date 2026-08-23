# Configuration

Runtime configuration is external to the repository.

## Paths

| Variable | Default |
| --- | --- |
| `REVIVAL_CONFIG_DIR` | `~/.config/ai-pin-revival` |
| `REVIVAL_SECRETS_DIR` | `~/.config/ai-pin-revival/secrets` |
| `REVIVAL_DATA_DIR` | `~/.local/share/ai-pin-revival` |
| `REVIVAL_BUILD_DIR` | `~/.local/share/ai-pin-revival/build` |
| `REVIVAL_ENV_FILE` | `$REVIVAL_SECRETS_DIR/runtime.env` |

Set path overrides before running `./revival init`.

## Commands

```sh
./revival config path
./revival config list
./revival config list --group production
./revival config get NAME
./revival config set NAME VALUE
./revival config set SECRET_NAME --stdin
./revival config check
./revival config template --group local
```

`config list` never prints values. `config get` reports secret settings only
as set or unset. Secret values must enter through standard input.

## Local identity

`./revival init` creates a sanitized Keycloak realm with a
`cosmos-operator` role and no wearer accounts. Create wearer accounts in the
running identity admin console.

## Applying changes

Local Compose reads the external runtime file on startup. Restart the affected
service after changing a runtime-only setting:

```sh
./revival down
./revival up
```

For production, validate first:

```sh
./revival config check
./revival doctor production
```

`./revival init` generates `COSMOS_PG_PASSWORD`, a matching in-stack
`COSMOS_DATABASE_URL`, and an independent `GRAFANA_ADMIN_PASSWORD`. It also
uses the onboarding endpoint built into Pin activation. Nonblank values are
preserved, so an external database can supply both database settings instead.

Set `COSMOS_CAPTURE_UPLOAD_BASE_URL` explicitly before production validation:

```sh
./revival config set COSMOS_CAPTURE_UPLOAD_BASE_URL https://uploads.example.com
```

That origin must route `/capture/*` to the loopback-published ai-bus HTTP
service. It is intentionally not inferred from Center or the mTLS gRPC edge,
which do not expose that route.
