# Configuration

Revival stores runtime configuration in one owner-only file outside the source
tree. The contract groups settings by when you need them: `local`, `production`,
`provider`, and `pin`. Start with the smallest group and add another only when
you enter that operating track.

## Find and inspect configuration

```sh
./revival config path
./revival config list --group local
./revival config template --group provider
./revival config check
```

- `path` prints the active external runtime file.
- `list` prints names, groups, sensitivity, homes, and aliases, never values.
- `template` emits only non-secret names and deliberately omits secrets.
- `check` validates the protected file, compatibility aliases, and supported
  dependencies, then prints one next action.

All four commands support contract-backed names. Use `--json` with `path`,
`list`, `get`, and `check` for automation.

## Set a non-secret value

```sh
./revival config set REVIVAL_CENTER_PORT 4000
./revival config get REVIVAL_CENTER_PORT
./revival config check
```

The edit is atomic and stays in the external mode-0600 runtime file. Setting a
canonical name removes duplicate compatibility aliases so the result is
unambiguous.

## Set a secret

Secret settings accept standard input only. This keeps the value out of the
process list and the literal command line.

```sh
printf '%s' "$VALUE_FROM_YOUR_SECRET_STORE" | \
  ./revival config set AZURE_SPEECH_KEY --stdin
./revival config get AZURE_SPEECH_KEY
```

`get` reports a secret only as `set` or `unset`. It never prints the value. Do
not type a real secret in documentation, an issue, chat, shell arguments, or a
checked-in file.

## Groups

### Local

Local settings cover the configuration schema, local release identity, Center
port, loopback authentication mode, optional local identity, and the local
model network. `revival init` supplies safe local defaults and generates blank
local secrets once.

Start here:

```sh
./revival config template --group local
```

### Production

Production settings cover public origins, OIDC/Keycloak, edge and projection
tokens, operator access, sharing, search session state, and principal scoping.
They belong to an existing reviewed deployment, not a clean local bootstrap.

Validate before any remote operation:

```sh
./revival config list --group production
./revival config check
./revival doctor production
```

The Center configuration pane may stage selected changes for the next deploy.
It never exposes secret values and does not directly rewrite production files.
See [operations](operations.md#changing-a-setting-from-the-dashboard).

### Provider

Provider settings enable optional speech, model, search, maps, weather,
knowledge, shopping, and interstitial services. An unset provider should remove
only that capability, not prevent the base local stack from starting.

Some switches have dependencies. For example, remote TTS requires both an
Azure Speech key and region. `config check` reports missing pairs.

### Pin

Pin settings cover enrollment, the DeviceUser CA mount paths, the generated
OPAQUE seed, and the optional Pin-native Spotify adapter. PKI files and signing
keystores are separate protected files; they never belong inline in
`runtime.env`.

Use the dedicated commands for DeviceUser PKI:

```sh
./revival pki init device-user
./revival pki import device-user --cert /protected/duc-ca.crt --key /protected/duc-ca.key
```

Both commands print a plan and require `--confirm` before committing. They do
not create or change the attestation CA.

## External directories

Set directory overrides in the shell before running `revival`; they do not
belong in the secret-bearing runtime file:

- `REVIVAL_CONFIG_DIR`
- `REVIVAL_SECRETS_DIR`
- `REVIVAL_DATA_DIR`
- `REVIVAL_BUILD_DIR`
- `REVIVAL_BACKUP_DIR`
- `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME`

Every selected path must be outside the checkout. Revival refuses linked,
unmarked, or overly permissive protected paths instead of taking ownership of
them.

## Compatibility aliases

`COSMOS_*` compatibility names remain accepted where the contract declares an
alias. New installations should use the matching canonical `REVIVAL_*` or
provider name. `config check` fails when a nonblank canonical value and its
alias disagree.

The complete value-free inventory is generated from
`contracts/operator-setup.json`:

```sh
./revival config list
```

Defaults and longer operational notes live in [`.env.example`](../.env.example).
