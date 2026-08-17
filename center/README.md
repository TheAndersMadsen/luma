# Center

Center is the Ai Pin wearer dashboard. It owns the web experience and its
server-side adapters; Cosmos owns device services and data.

## Develop

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Open <http://localhost:4000>. Run the component gate with:

```sh
npm test
REVIVAL_RELEASE_ID=local-review npm run build
```

The shared protocol definitions need no configuration here. Center resolves them
from `../contracts/wire` by default — where they live in this repo — so the three
commands above work as written. Production builds receive the same files through
the `wire_contracts` context and the image overrides `COSMOS_CONTRACTS_DIR` to
`/app/contracts`; set that variable yourself only if you keep the contracts
elsewhere. The default used to point at `cosmos/contracts`, a directory that has
never existed, and the resulting load failure surfaced as "carry error: …" on
every gRPC pane — Center's own misconfiguration, wearing Cosmos's name.

The Pin console is part of Center. It used to be a standalone SPA served at
`/setup/`; that bundle carried the device root shell on an ungated wearer path,
so it was never going to survive alongside a gated one. Its source is gone and
the console is native: `/settings/pin` for the wearer, `/admin/pin/terminal` for
the device root shell, which is operator-only. The installer and the ADB stack
live in `src/lib/pin-install` and `src/lib/pin-device`. The Pin's own on-device
setup page is unrelated and unaffected — the device ships its own copy.

## Bundle weight

`package.json` carries `"sideEffects": ["*.css"]`. JSON has nowhere to put a
comment, so the reasoning lives here.

Center's libraries are barrels — `@/lib/pin-device`, `@/lib/pin-device/adb`,
`@/lib/pin-install` — and each one's own header explains what it deliberately
does or does not re-export. Webpack, told nothing, assumes every module in a
package may have import-time side effects, so it keeps every module a barrel
re-exports even when nothing imports anything from it. That is how the Tier-A
symbol table, the release manifest verifier and the SystemInjector bootstrap
reached the FIRST LOAD of panes that only wanted a device settings read: the
whole `/settings/pin` console measured 168–195 kB against a 103 kB app
baseline. Declaring the source side-effect-free lets the barrels tree-shake and
takes 11–12 kB off every pane in the console.

The `*.css` entry is the load-bearing part, not decoration. CSS Modules are
imported for effect — the import's whole job is to emit a stylesheet — so a
bare `"sideEffects": false` would license webpack to drop them and ship the
console unstyled. Keep the array. The check that this is right is cheap: build
with and without the field and compare `.next/static/css`; the twelve emitted
stylesheets hash identically.

## Layout

| Path | Purpose |
| --- | --- |
| `src/app` | Pages and web API routes |
| `src/components` | Shared wearer interface |
| `src/server` | Authentication, Cosmos clients, and encrypted envelopes |
| `adapters/spotify` | Private, owner-bound Pin adapter |
| `public` | Fonts, icons, and web manifest |
| `verify` | Web behavior, release, and security contracts |

- `implemented`: memories, captures, notes, contacts, feature settings, Wi-Fi,
  Spotify controls, authentication, and operator routes exist in this source.
- `implemented`: Spotify credentials remain on the Pin; Center receives only
  bounded status and pairing operations through its purpose-scoped adapter.
- `implemented`: a backend outage renders as unavailable; it does not present
  bundled sample records as live wearer data.
- `unknown`: current physical-Pin synchronization until an authorized target
  test observes the device and Center together.

Workspace boundaries are in [architecture](../docs/architecture.md); shared
claim status is in [architecture](../docs/architecture.md#compatibility).
