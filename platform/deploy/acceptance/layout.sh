#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd -P)

fail() {
  echo "repo layout: $*" >&2
  exit 1
}

for path in \
  center cosmos pin contracts \
  center/adapters/spotify cosmos/search \
  pin/injector pin/hook pin/runtime pin/bridge pin/contracts \
  contracts/wire \
  platform platform/compose platform/containers platform/deploy platform/distribution \
  platform/deploy/acceptance platform/edge \
  docs
do
  [ -d "$ROOT/$path" ] || fail "required directory is missing: $path"
done

for path in \
  revival compose.yaml README.md rust-toolchain.toml \
  docs/architecture.md docs/operations.md \
  contracts/compatibility.json \
  center/package.json cosmos/Cargo.toml pin/settings.gradle.kts \
  cosmos/search/settings.yml \
  contracts/wire/humane/aibus.proto \
  platform/deploy/release.json platform/deploy/release.mjs \
  platform/distribution/version.json platform/distribution/build.mjs \
  platform/distribution/render-homebrew-formula.mjs \
  platform/distribution/homebrew/ai-pin-revival.rb.template \
  platform/containers/pin-builder/toolchain.json \
  platform/compose/development.yaml platform/compose/production.yaml
do
  [ -f "$ROOT/$path" ] || fail "required file is missing: $path"
done

# `.claude` is per-developer tooling state (the coding agent writes its local
# permission grants there), in the same category as .editorconfig: it is not
# source, it is not generated build output, and it reappears the moment anyone
# grants a permission — so deleting it only makes this gate fail again later.
#
# `.gstack` is the same category: a local terminal agent writes its pid, port and
# an internal token there while it runs. It holds a credential, so the thing that
# matters is that it cannot LEAVE this machine — and it cannot: platform/deploy/
# release.json builds every payload from an explicit `include` allowlist, and no
# profile lists it. Allowing it here is a statement about tidiness, not exposure.
#
# `diagrams` is local operator work product in the same never-leaves category:
# untracked, listed in no release profile, and not a source boundary. It is
# allowed so an unrelated working directory cannot fail the layout gate; it is
# NOT an invitation to commit a miscellaneous root source area.
#
# `.github` carries the CI workflows, `.devcontainer` is the reproducible
# contributor environment, and `CONTRIBUTING.md` is the newcomer path. All are
# deliberate root entries, not a relaxation of the no-miscellaneous rule:
# everything else still fails here by name.
allowed_root_entries='.claude
.devcontainer
.git
.github
.gstack
.dockerignore
.editorconfig
.env.example
.gitignore
CONTRIBUTING.md
README-INTRO.md
README.md
center
compose.yaml
contracts
cosmos
diagrams
docs
pin
platform
revival
rust-toolchain.toml'

for entry in "$ROOT"/* "$ROOT"/.[!.]* "$ROOT"/..?*
do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  name=${entry##*/}
  if ! printf '%s\n' "$allowed_root_entries" | grep -Fqx "$name"; then
    fail "unexpected top-level entry: $name"
  fi
done

# The docs policy is constrained rather than enumerated: the core pages every
# newcomer path relies on must exist, and every other page must be an ordinary
# lowercase-hyphenated Markdown file directly in docs/. Other file types,
# nested or generated output, and symlinked pages are rejected — a docs tree
# that needs a build step or an escape hatch has stopped being documentation.
# recovery.md stays separate from operations.md because it is read under
# different circumstances and by a different person.
for page in index.md architecture.md operations.md recovery.md
do
  [ -f "$ROOT/docs/$page" ] || fail "required docs page is missing: docs/$page"
done

find "$ROOT/docs" -mindepth 1 -print | while IFS= read -r entry
do
  name=${entry#"$ROOT"/docs/}
  if [ -L "$entry" ]; then
    fail "docs pages must be regular files, not links: docs/$name"
  fi
  if [ -d "$entry" ]; then
    fail "docs must stay flat; nested or generated output is rejected: docs/$name"
  fi
  case "$name" in
    *.md) ;;
    *) fail "docs accepts Markdown pages only: docs/$name" ;;
  esac
  case "$name" in
    [a-z0-9]*) ;;
    *) fail "docs page names are lowercase and hyphenated: docs/$name" ;;
  esac
  if printf '%s' "${name%.md}" | LC_ALL=C grep -q '[^a-z0-9-]'; then
    fail "docs page names are lowercase and hyphenated: docs/$name"
  fi
done

generated_dirs=$(find -P "$ROOT" -type d \( \
  -name .gradle -o -name .kotlin -o -name .next -o -name .turbo -o -name __pycache__ -o \
  -name build -o -name coverage -o -name dist -o -name dist-center -o \
  -name node_modules -o -name target -o -name test-runs \
\) -prune -print)
if [ -n "$generated_dirs" ]; then
  echo "repo layout: generated directories belong outside the source tree:" >&2
  echo "$generated_dirs" >&2
  exit 1
fi

generated_files=$(find -P "$ROOT" -type f \( -name '*.pyc' -o -name '*.tsbuildinfo' \) -print)
if [ -n "$generated_files" ]; then
  echo "repo layout: generated files belong outside the source tree:" >&2
  echo "$generated_files" >&2
  exit 1
fi

for legacy in src apps services integration manifest components device private state \
  ops config tools tests \
  humane-carry-clone humane-cosmos-clone PenumbraOS PenumbraOS-Revival-Fork
do
  if [ -e "$ROOT/$legacy" ] || [ -L "$ROOT/$legacy" ]; then
    fail "legacy top-level source boundary is forbidden: $legacy"
  fi
done

# Retired source boundaries: directories this repository used to have, whose
# capability now lives somewhere else. Naming them keeps a re-creation failing
# here rather than quietly reintroducing two implementations of one thing.
#
# `pin/setup` was a standalone Vite SPA — a second, whole Pin console. It is now
# native to Center: `center/src/app/settings/pin/**` for the wearer console,
# `center/src/lib/pin-install` and `center/src/lib/pin-device` for the installer
# and the ADB stack, `center/src/app/admin/pin/terminal` for the device root
# shell it used to hand to any signed-in wearer. The Pin's own on-device setup
# page is unaffected and unrelated: it ships from
# `pin/runtime/core/assets/setup-page` as committed static assets.
for retired in pin/setup
do
  if [ -e "$ROOT/$retired" ] || [ -L "$ROOT/$retired" ]; then
    fail "retired source boundary is forbidden: $retired"
  fi
done

for nested_entrypoint in \
  cosmos/compose.yaml \
  cosmos/compose.vps.yml \
  cosmos/compose.monitoring.yml \
  cosmos/deploy
do
  [ ! -e "$ROOT/$nested_entrypoint" ] || \
    fail "root operations are authoritative; nested entrypoint is forbidden: $nested_entrypoint"
done

# `find -P` inspects links but never follows them. Resolve only the link text,
# then reject any target whose normalized lexical path leaves this repository.
RESOLVE_LINK_JS='const fs=require("node:fs"),path=require("node:path"),link=process.argv[1];process.stdout.write(path.resolve(path.dirname(link),fs.readlinkSync(link)))'
ESCAPED_LINKS_FILE=$(mktemp "${TMPDIR:-/tmp}/ai-pin-revival-links.XXXXXX")
trap 'rm -f "$ESCAPED_LINKS_FILE"' EXIT HUP INT TERM

find -P "$ROOT" -type l -print | while IFS= read -r link
do
  resolved=$(node -e "$RESOLVE_LINK_JS" "$link")
  case "$resolved" in
    "$ROOT") ;;
    "$ROOT"/*) ;;
    *) printf '%s -> %s\n' "${link#"$ROOT"/}" "$resolved" >> "$ESCAPED_LINKS_FILE" ;;
  esac
done

if [ -s "$ESCAPED_LINKS_FILE" ]; then
  echo "repo layout: symlink target leaves the repository:" >&2
  cat "$ESCAPED_LINKS_FILE" >&2
  exit 1
fi

node - "$ROOT/contracts/compatibility.json" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const labels = new Set(['observed', 'derived', 'implemented', 'unknown']);
const usedLabels = new Set([manifest.product?.evidence?.label]);
const expectedComponents = new Map([
  ['center', 'center'],
  ['cosmos', 'cosmos'],
  ['pin', 'pin'],
  ['platform', 'platform'],
]);

if (manifest.schemaVersion !== 1) throw new Error('compatibility schemaVersion must be 1');
if (manifest.product?.stockProductId !== '00000001') {
  throw new Error('stock product contract must be 00000001');
}
if (!Array.isArray(manifest.contracts) || manifest.contracts.length === 0) {
  throw new Error('at least one cross-component contract is required');
}
const components = manifest.components ?? {};
if (JSON.stringify(Object.keys(components).sort()) !== JSON.stringify([...expectedComponents.keys()].sort())) {
  throw new Error('components must be named center, cosmos, pin, and platform');
}
for (const [name, expectedPath] of expectedComponents) {
  if (components[name]?.path !== expectedPath || components[name]?.owner !== name) {
    throw new Error(`component ${name} must own the ${expectedPath} source boundary`);
  }
}
for (const contract of manifest.contracts) {
  if (!contract.id || !contract.version || !contract.owner) {
    throw new Error('every contract requires id, version, and owner');
  }
  if (!labels.has(contract.evidence?.label)) {
    throw new Error(`invalid evidence label for ${contract.id}`);
  }
  for (const role of [contract.owner, contract.producer, ...(contract.consumers ?? [])]) {
    if (!expectedComponents.has(role)) {
      throw new Error(`contract ${contract.id} refers to unknown component ${role}`);
    }
  }
  usedLabels.add(contract.evidence.label);
}
for (const label of labels) {
  if (!usedLabels.has(label)) {
    throw new Error(`compatibility manifest does not classify any claim as ${label}`);
  }
}
NODE

echo "repo layout: ok"
