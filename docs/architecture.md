# Architecture

Ai Pin Revival has three product parts and one integration layer.

```text
wearer -> Center -> Cosmos <- Pin
             |      ^         |
             |      +-- bridge
             +-- installer and console, over USB to the Pin

platform = composition, edge, releases, deployment, and acceptance
```

## Ownership

| Part | Owns | Does not own |
| --- | --- | --- |
| `center` | Wearer pages, browser APIs, authentication, Cosmos adapters | Device protocols, persistence, infrastructure |
| `cosmos` | Device APIs, data, identity, assistant, providers | Wearer UI, device injection |
| `pin` | System Injector, hooks, runtime, on-device setup page, authenticated bridge | Cloud persistence, Center UI, the browser installer |
| `platform` | Compose, edge, observability, packaging, deployment, acceptance | Product behavior |

`implemented`: the workspace and release allowlist enforce these four top-level
boundaries. Component internals must not be copied across them. Center and Pin
consume versioned Cosmos contracts or public service interfaces.

## Runtime flow

```text
Ai Pin
  -> Pin hook/runtime
  -> authenticated device service
  -> Cosmos
  -> encrypted wearer projection
  -> Center
```

`implemented`: Center and all Cosmos workloads receive one immutable release
identity. Development and production add their policy through
`platform/compose`; `compose.yaml` remains the base application model.

`implemented`: the public `:443` belongs to one file, and it is not a vhost. The
Pin's hook redirects every stock gateway hostname to the edge's `:443` and
nothing else, so that socket carries both the device plane and the dashboard. It
is owned by an Nginx **`stream`** server —
`platform/edge/nginx/ai-pin-revival-device-edge.stream.conf.template`, installed
at `/etc/nginx/streams-enabled/ai-pin-revival-device-edge.conf` — which reads
only the SNI out of the ClientHello and copies bytes: clone gateway names go to
Envoy, everything else to Center's TLS listener, which moved to a loopback port
for exactly this reason. A `server` block with `ssl_certificate` here would
terminate the handshake at the wrong hop and turn every authenticated device into
an unauthenticated caller, so mTLS stays end to end between Pin and Envoy.

Two invariants hold that together, and neither is checkable by eye.
`platform/edge/render-envoy.py:53-77` refuses to render the edge unless the SNIs
the stream routes are exactly the SNIs Envoy declares filter chains for — a name
the device is redirected to but the server does not serve is the failure this
whole arrangement exists to end. And `nginx -t` does **not** detect an
`http`/`stream` collision on one address:port: it answers "syntax is ok" and the
master then fails to bind, taking every vhost on the host with it. The deploy
therefore parses `nginx -T` between `nginx -t` and any reload and requires
exactly one file in the expanded configuration to bind a non-loopback `:443` —
refusing two owners *and* zero (`platform/deploy/vps/remote/domain.py:219-261`).

`implemented`: Center serves no Pin Setup SPA, `/setup` does not exist, and the
SPA's source is deleted. Recreating it would be a security regression, not a
convenience: that bundle carried an interactive ADB PTY — a root shell on the
wearer's own device — and `/setup` was a plain wearer path, so every signed-in
wearer could reach it. The reason is recorded at `center/Dockerfile:15-31`, and
`center/verify/public-assets.test.mjs` keeps the build files from naming it
again — deletion removed the bundle, not the ability to add one.

`implemented`: the Pin console is native to Center. `/settings/pin` is the
wearer surface; the device shell is `/admin/pin/terminal`, behind
`isOperatorPath` and the `app/admin/pin` layout guard
(`center/src/server/auth.ts:139-162`). `/settings/pin/terminal` is named in that
same file as a retired path so that re-creating the shell at the "obvious"
settings location fails closed instead of becoming wearer-reachable.

`implemented`: Pin owns no browser console source. The installer and the ADB
stack are Center's (`center/src/lib/pin-install`, `center/src/lib/pin-device`).
What Pin still owns is its own on-device setup page — committed static HTML and
CSS under `pin/runtime/core/assets/setup-page`, packed by
`platform/containers/pin-builder/embed-setup-assets.mjs` and served by the
device itself for on-device onboarding. It shares no source with Center.

`implemented`: what Center does serve for the device is the immutable five-APK
release manifest at `/api/pin/releases/current` — read-only, and reachable
before a Center session exists because the installer needs it then
(`center/src/middleware.ts:25-33`, `:83-89`).
Center reads it exclusively from an operator-mounted directory
(`REVIVAL_PIN_RELEASE_DIR`); it never discovers APKs in the source tree and
never synthesises a manifest. Publishing a built release into that directory is
a separate, still-manual step — see
[operations](operations.md#4-publish-the-release-to-the-server--no-command-yet).

`implemented`: Azure Speech belongs to Cosmos AI Bus. Private search belongs to
Cosmos but gets a separate egress boundary. Spotify credentials remain on the
Pin; Center can call only typed, owner-bound adapter operations.

## Contracts and compatibility names

Shared, independently authored wire definitions live in `contracts/wire`.
Cosmos serves them and Center's server-side adapter loads them. **Pin does
not**: nothing under `pin/` compiles `contracts/wire`. The device runtime
compiles its OWN second copy of the same stock schemas, listed explicitly at
`pin/runtime/core/build.rs:23-35` and rooted at `pin/runtime/core/proto`. Two
trees, one wire — the classified divergence between them is
`contracts/wire-divergence.json`, and repointing `build.rs` at `contracts/wire`
stays blocked until that inventory is burned down. The registry
(`contracts/compatibility.json`, `device-cloud-wire`) lists `center` as the only
consumer for exactly this reason.

`derived`: that inventory is now an allowlist AND an equivalence gate, and both
halves of what its `gate` field asks for run.
`platform/deploy/acceptance/wire-divergence.test.mjs` holds the file to its own
rules: the per-class counts must equal what it lists, the (class, kind) matrix
must be exact, every entry must be a unique symbol-plus-field-number citation,
every cited symbol must still exist in one of the two trees, and no cross-tree
citation anywhere — in the inventory or in either proto tree — may be a
`path:LINE` (all five line citations checked on 2026-08-10 had already rotted,
three of them onto a real, syntactically valid field in the sibling tree).

`platform/deploy/acceptance/wire-equivalence.test.mjs` is the half that was
owed. It parses both trees with a small proto3 parser of its own — deliberately
not `protoc`, which with the Python protobuf package is not a deploy-time
dependency here, and a gate that skips when its tool is missing is green exactly
where it matters least — and asserts that the set of shared field numbers the
two trees encode differently is EXACTLY the inventory's `wire-incompatible`
list. Set equality in both directions: a new byte-changing divergence fails
because it is unlisted, and a fixed one fails because it is still listed, which
is the direction that let the counts drift in the first place. Renames,
relocated types, `int32` against `int64` and prefix-convention enum spellings do
not fail anything — a gate that broke the build for a rename gets switched off —
so the file's own classification is the granularity. Enum values are compared at
meaning rather than spelling: a shared number whose two names still differ after
the enum's `UPPER_SNAKE` prefix is stripped must be classified in the inventory,
because a disagreement about what a NUMBER means cannot fail at runtime and this
is the only place it can fail at all.

95 entries as of 2026-08-12, **none of them byte-changing**. The last two —
`humane.provisioning.VerifyHmcAssociationRequest` fields 1 and 2 — were settled
from the stock client's own decompiled class, which declares `hmc_id` at 1 and
the verification signature at 2, and the pin tree was corrected onto that
layout. The `semantic-only` class is empty for the same reason: all three enum
numbers that meant two different things were decided from the client's enum
classes, all three for `contracts`. Both empty classes are absent from `counts`
rather than listed as zero; their definitions stay in `wireClasses`, because the
vocabulary is what the next entry gets classified against.

The gate also holds the inventory's recorded declarations to the source — a
present side must render back exactly, an absent side must still be absent, and
an entry with both sides must still actually differ — which is what makes an
empty `wire-incompatible` class trustworthy rather than merely short. The counts
are a live measurement of today's source rather than a snapshot of the last
regeneration.

Two of those corrections change what the DEVICE does and are therefore in the
tree but not on the Pin: `humane.capture.DeleteMemoryStatus`, whose store-error
arm moves from 3 to 4, and the pairing request above, which starts decoding
instead of failing `InvalidArgument`. They are recorded under
`stagedForRelease` in the inventory, held there by the same gate, and written up
for whoever installs the release in
[operations](operations.md#what-the-next-release-changes-on-the-wire-and-what-to-check).

Pin-specific native action and injection contracts remain in `pin/contracts`;
the cross-component registry is `contracts/compatibility.json`.

`derived`: Android package names, stock service identifiers, certificate
identities, `CARRY_*` variables, and some durable storage names cannot be
renamed safely without coordinated compatibility fixtures and state migration.
They are boundary details, not product architecture.

## Source, secrets, and state

The source tree is immutable release input. Runtime material lives outside it:

| Variable | Default |
| --- | --- |
| `REVIVAL_CONFIG_DIR` | `~/.config/ai-pin-revival` |
| `REVIVAL_SECRETS_DIR` | `${REVIVAL_CONFIG_DIR}/secrets` |
| `REVIVAL_DATA_DIR` | `~/.local/share/ai-pin-revival` |
| `REVIVAL_BUILD_DIR` | `${REVIVAL_DATA_DIR}/build` |
| `REVIVAL_BACKUP_DIR` | `~/.local/state/ai-pin-revival/backups` |

`implemented`: release packaging rejects generated output, firmware, private
keys, credentials, wearer data, captures, and raw evidence. The root CLI keeps
device mutation outside its command surface.

## Compatibility

Ai Pin Revival is an independent implementation for operator-owned devices. It
does not claim Humane's hidden implementation.

- `observed`: directly measured on the named target.
- `derived`: supported by observations but not directly exercised.
- `implemented`: independently authored behavior exists in this source.
- `unknown`: evidence is missing or the check has not been run.

Nothing in the gates verifies these labels: an `implemented` claim here is a
hand-maintained assertion about the tree, and one of them (Center serving the
Setup SPA at `/setup/`) stayed in this file for the whole life of the topology
that replaced it. Cite `file:line` when you make a claim, so the next reader can
check it in one step, and re-read the cited code before trusting a label.

`derived`: stock-facing Android components, gRPC names, authorities, ALPN,
protobuf fields, certificate subjects, encrypted storage keys, and durable
state names can require exact compatibility identifiers. Those names stay at
the boundary and do not define the product architecture.

`implemented`: Center contains adapters for memories, captures, notes,
contacts, settings, and deletion; Cosmos contains three-frame capture
selection, feature overrides, and optional Azure Speech; Pin contains the
native runtime and Spotify pairing path.

`unknown`: physical sync, playback, signed installation, stock-unit
provisioning, and clean production bootstrap remain unknown until the exact
target passes an authorized acceptance run. A compiler, healthy container, or
HTTP 200 is not physical-Pin proof.

Do not commit firmware, APKs, decompiled source, keys, device identities,
wearer data, captures, packet traces, or production logs. Do not probe
unrelated Humane infrastructure or third-party data.
