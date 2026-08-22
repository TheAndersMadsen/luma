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
| `revival setup import vps-candidate --handoff-root DIR` | local | Provider-verify and import a downloaded hosted VPS candidate handoff. |
| `revival setup artifacts vps` | local | Freshly provider-verify the imported VPS candidate and persisted evidence. |
| `revival setup import pin-release --release-root DIR` | local | Provider-verify and register a downloaded hosted exact-five Pin release store. |
| `revival setup artifacts pin` | local | Reverify the registered Pin release and provider bundles at point of use. |
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
| `revival dev center` | local | Run Center with Turbopack and Compose source watch. |
| `revival dev down` | local | Stop only the isolated development stack and retain its caches. |
| `revival check center` | local | Run Center type, server, UI, and Spotify adapter checks from external build state. |
| `revival check cosmos [TEST_FILTER]` | local | Run full Cosmos checks or a nonempty, verified Cargo test filter. |
| `revival check platform` | local | Run source policy and platform acceptance tests. |
| `revival check changed [--base REF]` | local | Select conservative checks from Git changes. |
| `revival test` | local | Run the repository release gate; writes only external build/cache state. |
| `revival release check` | local | Run immutable release checks; writes only external build/cache state. |
| `revival release build` | local | Build an immutable release archive. |
| `revival release verify` | read | Verify an archive and manifest. |

Short aliases `build`, `up`, `down`, `status`, `logs`, and bare `config` retain
their stack behavior.

The `dev` and component `check` commands are the supported inner loop. They
keep generated dependencies, compiler targets, and Next output below external
build state or in container volumes. Center checks include the purpose-scoped
Spotify adapter. Filtered Cosmos checks use Cargo/libtest discovery and fail if
the filter selects no tests. `check changed` prefers the remote default branch,
falls back only to conventional `main`/`master` refs, checks the full tracked
tree when no trustworthy default exists, and includes both sides of renames.
Contributor-safe Pin checks explicitly remove signing/private build variables.
`test` and `release check` remain the full release boundary;
the fast commands do not weaken or replace them. See the [fast local
loop](../CONTRIBUTING.md#fast-local-loop).

## Production

| Command | Effect | Purpose |
| --- | --- | --- |
| `revival doctor production` | read | Check production prerequisites. |
| `revival release candidate prepare [--commit COMMIT]` | local | Build a sealed local diagnostic candidate from an exact detached commit; it is candidate-only and cannot deploy. |
| `revival release candidate verify (--candidate PATH | --id SHA256)` | read | Recompute every candidate identity and digest without Git, Docker, a shell, or candidate-controlled code. |
| `revival release candidate inspect (--candidate PATH | --id SHA256)` | read | Report provenance, image identities, and protected Carry compatibility. |
| `revival deploy carry-baseline (--candidate PATH | --candidate-id SHA256) [--dry-run\|--confirm]` | remote | One-time only: observe and seal the already-running Carry predecessor using held registrar code from the exact hosted forward candidate, without changing the runtime. |
| `revival deploy production (--candidate PATH | --candidate-id SHA256) --confirm` | remote | Freshly provider-verify, transfer, and deploy one imported GitHub-hosted immutable candidate; never build or pull on the host. |
| `revival backup --confirm` | remote | Create a verified server backup; `--fetch` adds the off-host copy. |
| `revival canary --confirm` | remote | Run semantic production canaries. |
| `revival drift` | read | Compare protected state with its recorded contract. |
| `revival adopt-config` | remote | Plan or confirm a protected configuration adoption. |
| `revival prune-state` | remote | Plan or confirm safe release/backup retention. |
| `revival rollback --deployment ID --confirm` | remote | Move the release pointer to an exact deployment. |

Production commands target an existing reviewed installation. Rollback does not
restore a database. See [operations](operations.md#production) and
[recovery](recovery.md).

Dispatch the pinned hosted workflow from the production-safe commit, then
provider-verify and import its handoff before selecting it for deploy. Local
`release candidate prepare` output is useful for diagnostics but is structurally
candidate-only. Candidate IDs are the canonical
SHA-256 of their internal descriptor; a directory name, `--candidate-id`, and
that internal ID must all agree. Interrupted transfers resume for at most three
attempts, while retained candidates and stale incoming workspaces are reported
by `prune-state` and removed only by its dry-run/confirm contract.
The sealed candidate identity also commits the complete 15-service
`{role, reference, imageId}` Compose mapping; production and recovery paths use
that held mapping rather than reconstructing authority from mutable tags or
paths.

The already-running pre-workflow Carry release cannot honestly be reproduced
and relabeled as provider-built. For the first Carry-to-Cosmos cutover only,
`deploy carry-baseline` uses held registrar code from the same freshly
provider-verified forward candidate to capture it twice as the exceptional
`adopted-live-carry-v1` predecessor. The record explicitly does not claim the
observed Carry images were provider-built, changes no runtime resource, is
bound to that one forward candidate, and is eligible only as that candidate's
immediate rollback predecessor. Deploy the same candidate immediately after
registration; every later canonical predecessor must be a normally
provider-verified retained candidate. Descriptor schemas 2/3 and every
local-origin candidate remain ineligible as canonical candidates; the
registrar is not a legacy candidate-adoption or promotion bypass.

State retirement is non-destructive and receipt-based. Its linearization point
is the final complete filesystem-watch drain after the exact held inventory has
been revalidated. Success returns a name such as
`.candidate-retired-<32 lowercase hex>` whose suffix commits to that inventory;
it does not promise that a same-user-writable pathname stays immutable after
the command returns. Every later consumer or retention scan reopens the name
without following links and recomputes the receipt. A post-commit exchange
therefore does not alter the historical receipt, but the next scan refuses the
current path and leaves both trees recoverable for inspection.

The live storage authority remains `/home/anders/carry-center-data` with
`humane-carry-clone_carry-state`, `humane-carry-clone_carry-pgdata`,
`humane-carry-clone_prometheus-data`, and
`humane-carry-clone_grafana-data`. Candidate preparation intentionally refuses
a source snapshot whose effective Compose/common values rename those paths.
Logical Cosmos keys attach directly to the existing Carry resources; no
automatic create, copy, rename, migration, deletion, or “adoption” exists.

## Pin host, PKI, release, and device commands

| Command | Effect | Purpose |
| --- | --- | --- |
| `revival pin doctor` | read | Check host, signing, assets, and connected-device prerequisites. |
| `revival pin check` | local | Run Pin source checks in isolated external build/cache state. |
| `revival pki init device-user` | local | Plan or confirm creation of the DeviceUser CA only. |
| `revival pki import device-user` | local | Plan or confirm import of a DeviceUser CA pair. |
| `revival pin release build` | read | Refuse the retired local signed-build alias and point to the attested hosted workflow. |
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
