# CLI reference

`revival` is the supported operator interface. This page lists every current
contract-backed command. Run `./revival <command> --help` for exact options and
safety text; nested group help is side-effect free.

Effects mean:

- **read**: inspects local, remote, or device state without changing it;
- **local**: changes only protected state or build output on this machine;
- **remote**: can change a configured remote host; inspect its target and help
  before invocation because only commands that name a plan/confirm gate are
  dry-run first;
- **device**: can change one exact Pin and requires both its serial and
  confirmation.

## Guided setup and configuration

| Command | Effect | Purpose |
| --- | --- | --- |
| `revival setup local` | local | Select the local journey and recompute evidence. |
| `revival setup contributor` | local | Select the contributor journey and recompute evidence. |
| `revival setup production` | local | Select the production journey without contacting a host. |
| `revival setup pin` | local | Select the Pin journey without reading a device. |
| `revival setup --resume` | read | Resume the selected journey at its current next action. |
| `revival setup status` | read | Show complete, next, and blocked steps. |
| `revival init` | local | Initialize external protected directories and defaults. |
| `revival doctor` | read | Check local requirements and print one next action. |
| `revival config path` | read | Print the active external runtime configuration path. |
| `revival config list` | read | List setting metadata without values. |
| `revival config template` | read | Print a scoped template with secrets omitted. |
| `revival config get NAME` | read | Read a non-secret, or report a secret as set/unset. |
| `revival config set NAME VALUE` | local | Set a supported non-secret value atomically. |
| `revival config set NAME --stdin` | local | Set a supported value from standard input; required for secrets. |
| `revival config check` | read | Validate the setting contract, aliases, and dependencies. |
| `revival version` | read | Show product, CLI, and setup-contract versions. |
| `revival support-bundle` | local | Write a fixed, redacted diagnostic allowlist outside source. |

`support-bundle` accepts `--output FILE` and refuses to replace an existing
file. The output is mode 0600 and excludes environment values, runtime
configuration, logs, serials, and wearer data.

## Local stack and gates

| Command | Effect | Purpose |
| --- | --- | --- |
| `revival stack build` | local | Build the local containers. |
| `revival stack up` | local | Start the local product stack. |
| `revival stack down` | local | Stop the stack without deleting volumes. |
| `revival stack status` | read | Show service state. |
| `revival stack logs` | read | Show recent service logs. |
| `revival stack config` | read | Render the Compose model without secret interpolation. |
| `revival test` | read | Run the repository release gate. |
| `revival release check` | read | Run immutable release checks. |
| `revival release build` | local | Build an immutable release archive. |
| `revival release verify` | read | Verify an archive and manifest. |

Short aliases `build`, `up`, `down`, `status`, `logs`, and bare `config` retain
their stack behavior.

## Production

| Command | Effect | Purpose |
| --- | --- | --- |
| `revival doctor production` | read | Check production prerequisites. |
| `revival deploy production` | remote | Deploy an immutable release. |
| `revival backup` | remote | Create a verified server backup; `--fetch` adds the off-host copy. |
| `revival canary` | remote | Run semantic production canaries. |
| `revival drift` | read | Compare protected state with its recorded contract. |
| `revival adopt-config` | remote | Plan or confirm a protected configuration adoption. |
| `revival prune-state` | remote | Plan or confirm safe release/backup retention. |
| `revival rollback` | remote | Move the release pointer to an exact deployment. |

Production commands target an existing reviewed installation. Rollback does not
restore a database. See [operations](operations.md#production) and
[recovery](recovery.md).

## Pin host, PKI, release, and device commands

| Command | Effect | Purpose |
| --- | --- | --- |
| `revival pin doctor` | read | Check host, signing, assets, and connected-device prerequisites. |
| `revival pin check` | read | Run Pin source checks. |
| `revival pki init device-user` | local | Plan or confirm creation of the DeviceUser CA only. |
| `revival pki import device-user` | local | Plan or confirm import of a DeviceUser CA pair. |
| `revival pin release build` | local | Build and publish a signed bundle to the local store. |
| `revival pin release inspect` | read | Inspect signed release metadata. |
| `revival pin release verify` | read | Verify a signed release bundle. |
| `revival pin release plan` | read | Plan the transition for one exact Pin. |
| `revival pin release ship` | remote | Plan or confirm publication to Center's release store. |
| `revival pin install` | device | Plan or confirm installation on one exact Pin. |
| `revival pin activate status` | read | Inspect activation on one exact Pin. |
| `revival pin activate` | device | Plan or confirm activation with a protected credential. |
| `revival pin network` | read | Report Wi-Fi enabled/connected state without identifiers. |
| `revival pin network qr` | local | Print or open Center's browser-local QR page. |

Important exact forms:

```sh
./revival pki init device-user [--confirm]
./revival pki import device-user --cert FILE --key FILE [--confirm]
./revival pin activate status --serial SERIAL
./revival pin activate --serial SERIAL --credential-file FILE \
  --edge-ipv4 A.B.C.D [--confirm]
./revival pin network --serial SERIAL
./revival pin network qr [--open]
```

`pin network` has no SSID, password, or PSK option. The QR page creates the
payload in the browser and sends no network credential through CLI arguments.

## Exit and output contracts

Bad usage exits with code 64 where supported. Operational failure exits
nonzero. Commands that expose `--json` write one machine-readable document and
do not mix it with human guidance. A plan is not a successful mutation, and a
successful host transaction is not physical acceptance.

The machine-readable source is `contracts/operator-setup.json`; its projection
tests keep this CLI, Center, and the four journeys aligned.
