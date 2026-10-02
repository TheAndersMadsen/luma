# Contributing to Luma

Thank you for helping keep the Ai Pin working. This page is the short
version; [README.md](README.md) is the entry point that links to the
reference in [docs/](docs/README.md) and the how-tos in [guides/](guides/),
and [AGENTS.md](AGENTS.md) holds the full working rules that people and coding
agents follow alike. Everyone here follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Before you write code

- **Ask first for anything large.** Open an issue describing the stock
  behaviour you want to recreate or the problem you hit. Small fixes and
  documentation changes can go straight to a pull request.
- **The stock apps are the specification.** A feature the Pin calls comes
  from the decompiled stock apps (`./luma stock decompile`, README "Stock
  reference"). Cite the stock class and method in a code comment for every
  stock behaviour you implement, and mark anything without stock or
  recovered-web evidence `INFERRED`.
- **Stock code, binaries, and assets never enter the repository.** Not
  decompiled sources, not APKs, not excerpts in comments, not test fixtures,
  and not fonts, stylesheets, images, icons, or other design assets taken from
  Humane software or humane.center. Describe behaviour and interfaces in your
  own words and cite the stock class or route as evidence; never paste the
  original. The stock reference lives outside the checkout under
  `~/.local/share/luma/stock-reference/`.
- **Compatibility identifiers stay byte-for-byte.** Stock `humane.*` protobuf
  names, installed Android package IDs, the five APK roles, and the OPAQUE
  seed in `enrollment.rs` are what the original software calls. Everything
  project-owned is named Luma, with `LUMA_` (Center, CLI, build, Pin) or
  `COSMOS_` (Cosmos runtime) variables.

## Set up a checkout

Follow [docs/developers.md](docs/developers.md) (README "For developers"
links to it): Docker, Bun 1.4.2, and pnpm, then
`pnpm setup:local`, which installs the workspace and creates Luma's
configuration outside the checkout. Rust work needs Rustup
(`rust-toolchain.toml` picks the version); Android work runs in the pinned
builder container through `./luma pin ...`, never `pin/gradlew` in the
checkout.

Keep secrets, runtime data, APKs, stock code, and build output outside the
checkout. `./luma` places caches and build directories outside it for you;
do not create `target`, `.gradle`, `.kotlin`, `.next`, or `build` in source.

## Make the change

1. Find the stock behaviour: the app that calls it, the exact request and
   response, and what humane.center did with it.
2. Wire it with what the stock message already carries. Never add a field
   the stock app does not send; a capability the stock request cannot
   express belongs in Luma's own tool schema, marked `INFERRED`. Stock
   messages live in `contracts/wire` and again in `pin/runtime/core/proto`;
   change both in one commit, add fields, and never renumber or retype one.
3. Put a device RPC in its `cosmos/.../services/*` module, a humane.center
   route in its scope's `*_api.rs`, and Center pages behind
   `center/src/server/domain/*`. Filtering, counting, joining, and keys stay
   in Cosmos.
4. Prefer the small, reversible change with behaviour evidence over a
   framework rewrite. Remove dead paths instead of keeping two ways to do one
   job. Add no compatibility modes, hidden fallbacks, or data migrations.
5. Update the documentation the owner reads: the README overview, the
   reference page in `docs/`, or the how-to in `guides/`. Some README
   sentences and headings are pinned by tests; change a heading together with
   everything that references it
   (`rg -n documentationAnchor contracts/operator-setup.json`).

## Test it

Start with your uncommitted changes:

```sh
git status --short
./luma check changed --base HEAD
```

Then run only the owning component while iterating:

```sh
./luma check center
./luma check cosmos TEST_FILTER
./luma check platform
./luma pin check
```

Cosmos and Pin checks need Docker running. Before opening a cross-component
pull request:

```sh
./luma check platform --full
./luma test
git diff --check
```

Prefer end-to-end and acceptance tests that leave a repeatable artifact over
unit tests written after the code. A behaviour change in the assistant also
updates its cases in `platform/deploy/vps/assistant-eval.mjs`.

## Commit and open a pull request

- Small, coherent commits, one concern each. The subject line is an
  imperative sentence under about 70 characters ("Serve forecast answers
  from Pirate Weather"); the body says why, names the stock evidence, and
  calls out anything `INFERRED`.
- No secrets, tokens, serials, or personal data in commits, issues, or
  attachments. `./luma support-bundle` writes a redacted diagnostic file
  for bug reports.
- Fill in the pull request template: which checks you ran, what
  documentation you updated, and what evidence proves the behaviour.
- CI (`.github/workflows/ci.yml`) runs the platform, Center, Cosmos, and Pin
  checks on every pull request. Its final "CI passed" check fails if any
  component failed, was cancelled, or was skipped; the assistant eval and the
  Pin device harnesses need a server or a Pin and do not run in CI.

## Owner-only actions

Some steps only the repository owner or the person who owns a server or Pin
can do: typing credentials, DNS and firewall changes, publishing releases,
and physical Pin actions. Prepare the step, say exactly what it changes, and
wait; never ask for a credential in an issue or pull request.

## Licence

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE) like the rest of Luma. Vendored code keeps its own
licence files.
