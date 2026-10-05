# For developers

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


[AGENTS.md](../AGENTS.md) has the working rules and the source map. It also
explains how to extend Luma faithfully from the stock apps. It is written for
people and coding agents alike. You only need a clone if you are changing the
source.

Install Docker Desktop (macOS) or Docker Engine with Compose 2.34+ (Linux)
and start it. Clone the repository, then install the pinned JavaScript tools
once. Bun is the runtime and pnpm is the package manager. Neither needs Node
or npm.

```sh
git clone https://github.com/TheAndersMadsen/luma.git
cd luma
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"
export PATH="$HOME/.bun/bin:$HOME/.local/share/pnpm:$PATH"
bun platform/setup/install-pnpm.mjs "$HOME/.local/share/pnpm"
pnpm setup
pnpm setup:local
```

The pnpm installer checks the SHA-256 of the native 12.6.0 archive before it
runs it. `pnpm setup` saves its PATH entry for future terminals, and Bun's
installer saves its own. `pnpm setup:local` installs the workspace from its
frozen lockfile and creates Luma's configuration outside the checkout. You can
run it again safely.

Start Center with hot reload:

```sh
pnpm dev
```

This runs the Docker Compose development stack and serves Center at
`http://localhost:4000`. Rust and Android builds run in their own containers.
The three JavaScript packages share `pnpm-lock.yaml`. Use
`pnpm --dir center add PACKAGE` to change Center's dependencies. Do not create
npm, Yarn, or Bun lockfiles. `platform/containers/pin-builder/toolchain.json`
records the pinned tools that local checks, CI, and images use.

Rust checks on the host also need Rustup. `rust-toolchain.toml` picks the
right Rust version for you. Normal Center work needs only Bun, pnpm, and
Docker.

Each platform acceptance file runs in its own Bun process, with a three-minute
limit per file. This keeps their environments apart and avoids a hang in Bun's
shared test worker.

Run only what your change needs:

```sh
./luma check changed --base HEAD   # your uncommitted changes
./luma check center
./luma check cosmos TEST_FILTER
./luma check platform
./luma pin check
```

Without `--base`, `check changed` compares with `origin/HEAD`, so commits you
have not pushed count as changes too.

`./luma pin check` runs these steps in order:

1. The Pin builder's own tests, on your machine.
2. A format check of the Pin runtime core, and its tests with the `iroh`
   feature that the release APK ships.
3. Format, lint, and tests for the USB bridge.
4. In the pinned Pin builder container, the JVM unit tests of the contracts,
   the Compatibility Layer, Device Services, and Device Installer's common,
   installer, and Setup Helper modules.

So it needs Docker running, but no JDK or Android SDK of your own. The
container reads the checkout read-only and compiles in the external build
directory. Its first run builds the builder image.

To repeat the production image smoke check and save its report outside the
source tree:

```sh
bun platform/deploy/acceptance/javascript-runtime.mjs luma/center:YOUR_TAG /tmp/luma-center-runtime.json
bun center/verify/http-boundaries.mjs luma/center:YOUR_TAG /tmp/luma-center-http.json
```

The HTTP check starts throwaway Center and Cosmos-fixture containers. It tries
authenticated reads, writes, refusals, and partial failures, then removes the
containers. It uses made-up accounts and saves a JSON report. You need no
wearer or provider credentials.

For a broad change:

```sh
./luma check platform --full
./luma test
```

GitHub CI runs on every pull request and every push to `main`, including
documentation changes. Its **Run workflow** button can also check a branch you
choose. CI validates the workflows and runs:

- the full platform suite
- Center's tests and production build
- Cosmos tests with PostgreSQL
- the full Pin contributor checks with the pinned Android builder

A separate Linux job builds and checksums all five debug APKs. You can download
them to inspect, but they are never a signed release. Pin check logs are kept
for seven days. The final **CI passed** check succeeds only when every
component succeeds. A failed, cancelled, or skipped component blocks it. Every
job has a time limit.

Dependencies and compiler output are reused from the external build directory,
so a narrow rerun does not rebuild unrelated components. Configuration lives in
`~/.config/luma` by default, and data and caches in `~/.local/share/luma`.
After a successful Cosmos check, Luma keeps the eight newest incremental
variants per crate and deletes older ones. Repeated local rebuilds therefore
do not fill the disk.

Production stores everything in PostgreSQL. So `./luma check cosmos` (with or
without a filter) and `./luma test` need Docker running. The Cosmos tests run
against a throwaway container of production's pinned PostgreSQL image. It is
published only on loopback and removed afterwards. Without Docker the check
fails. It does not skip those tests.

The `./luma` in a source checkout has more commands than the one in a release.
These are the ones you will use most:

| Command | What it is for |
| --- | --- |
| `./luma setup contributor` or `./luma init` | Create the external configuration a checkout needs. `setup status` shows what is ready |
| `./luma doctor` | Check this machine's tools and configuration. It writes nothing |
| `./luma up`, `down`, `status`, `logs` | Run the local stack (`./luma stack ...` spells them out) |
| `./luma dev center` | Run Center with hot reload |
| `./luma check ...`, `./luma test` | Run the checks above |
| `./luma config ...` | Read and change settings ([Configuration](#configuration)) |
| `./luma pki init device-user` | Create the DeviceUser CA that a local stack needs to enroll a real Pin. `pki import device-user` imports an existing pair. Production setup creates its own |
| `./luma pin ...` | Build, check, and install the Pin apps ([Build the Pin apps](#build-the-pin-apps)). `pin install` and `pin activate` act on one exact Pin and only show a plan until you add `--confirm` |
| `./luma stock decompile` | Build the stock reference ([Stock reference](#stock-reference)) |
| `./luma release publish` | Publish a release ([Publish a release](#publish-a-release)) |
| `./luma release announce` | Post a published release's patch notes to Discord ([Publish a release](#publish-a-release)) |
| `./luma support-bundle` | Write a redacted diagnostic file to attach to a report |

`./luma COMMAND --help` describes each command and its options. It also says
what the command changes: only this machine, production or a published
release, or a device.

### Configuration

```sh
./luma config path
./luma config list
./luma config list --group provider
./luma config get NAME
./luma config set NAME VALUE
./luma config set SECRET_NAME --stdin
./luma config check
```

`./luma config list` shows each setting's group and whether it is secret. Once
the configuration exists, it also shows whether each setting is set. It never
prints a value.

`COSMOS_LLM_API_KEY` is the assistant model key. Cosmos reads no other name for
it. If a server set only the older `COSMOS_OPENROUTER_API_KEY`, `config list`
shows `COSMOS_LLM_API_KEY` as unset. Enter the key once with
`./luma config set COSMOS_LLM_API_KEY --stdin`.

At a terminal, `config set NAME --stdin` asks for the value without showing
it. From a script, pipe the value in, for example from your password manager's
command-line tool. That way it never reaches argv or shell history.

To keep configuration or data somewhere else, export these variables in every
shell that runs `./luma`. Do it before the first `./luma init` or
`./luma setup`. Luma does not remember them. A shell without them looks in the
default places. `doctor`, `deploy`, `verify`, `backup`, and `setup status` then
report that they found no configuration and name the path they checked.
`setup production` prints the `export` line for the variables it ran with. Put
that line in `~/.profile`.

| Variable | Default |
| --- | --- |
| `LUMA_CONFIG_DIR` | `~/.config/luma` |
| `LUMA_SECRETS_DIR` | `~/.config/luma/secrets` |
| `LUMA_DATA_DIR` | `~/.local/share/luma` |
| `LUMA_BUILD_DIR` | `~/.local/share/luma/build`. It must stay inside `LUMA_DATA_DIR` |

Do not create these directories yourself. `init` and `setup` create them
owner-only (mode 0700) and mark them as Luma's. They refuse a directory that
already exists without that mark.

### Stock reference

The stock Pin's own apps are the reference for faithful work. Build a local,
decompiled copy with one command:

```sh
./luma stock decompile --from-device SERIAL   # a connected stock Pin, read-only
./luma stock decompile --apk-dir DIR          # stock .apk/.jar files you already hold
```

`--from-device` only reads the Pin. It picks the `hu.ma.ne.*` and `humane.*`
packages on the system partitions (Ironman, Krypto, the experience apps, and
the rest), plus `/system/framework/humane_*.jar`. It copies them with
`adb -s SERIAL pull`.

The command then downloads jadx into the build directory and verifies it. The
version and SHA-256 are pinned in
`platform/containers/pin-builder/toolchain.json`. jadx runs with no network in
the builder's pinned JDK container, because host JVMs crash on some Macs. A
full Pin takes about 5 GB of disk and half an hour.

Output goes to `~/.local/share/luma/stock-reference/`, and the command prints
the path:

| Path | Contents |
| --- | --- |
| `apks/` | The stock APK and framework-jar inputs, pulled with `--from-device` or copied from `--apk-dir` |
| `decompiled/<app>/sources/` | Java for each app or jar, e.g. `decompiled/ironman/sources/` |
| `manifest.json` | jadx version, device build fingerprint, and each input's SHA-256 |

`./luma pin doctor` reports whether `decompiled/` is present. A failed run
leaves the previous reference in place.

This is the only place Luma reads stock evidence from. The Tier-A registry
proves each native action against it. The evidence-bound Kotlin and Rust tests
read it through the `LUMA_DATA_DIR` that `./luma` checks pass to them.
`./luma pin check` mounts it read-only at `/luma-data/stock-reference` for the
builder's `check-unit` lane, which runs the Kotlin tests. Some tests are pinned
to the stock apps of one firmware build. On a reference pulled from another
build, such a test skips and says why, until someone reviews its evidence
again.

> [!IMPORTANT]
> Stock APKs, framework jars, and their decompile are Humane's code. The
> command refuses to write them or read them inside the checkout. Never
> commit, publish, or attach them to an issue or release. Cite class and
> method names instead.

### Build the Pin apps

Building signed Pin apps needs the external signing material and the private
native assets already authorized for the project:

```sh
./luma pin doctor
./luma pin release build --version YYYY-MM-DD.N --version-code INTEGER
./luma pin release export --output luma-pin-YYYY-MM-DD.N.tar.gz
```

The pinned builder takes its tool versions from
`platform/containers/pin-builder/toolchain.json` and keeps its caches outside
the checkout. It always signs and verifies these five apps as one release:

| App | Manifest role |
| --- | --- |
| Device Installer | `installer` |
| Setup Helper | `bootstrap` |
| Compatibility Layer | `hook` |
| Device Services | `server` |
| Compatibility Loader | `hook-injector` |

These roles and their Android package IDs are fixed compatibility identifiers.
Building never runs ADB.

The maintainer holds the one private input, the Pin signing key
(`~/.config/luma/secrets/pin/signing.env`). The project does not distribute
it. Ask the maintainer when your change needs a signed release.
`./luma pin check` and `./luma pin build-debug` do not use it, and
`./luma pin doctor` reports it as missing.

For a compile-only check, run `./luma pin check`, then:

```sh
./luma pin build-debug --role installer --role bootstrap --role hook --role server --role hook-injector
```

This checks the Android app code without touching the Pin. The compile-only
Device Services APK leaves out the native Rust executable. The signed release
build also cross-compiles that executable for Android ARM64 and packages it.
Debug APKs are not release artifacts. A successful build does not prove live
hooking, decoding, or audible playback. Use a signed release for the physical
Pin check.

A build makes its release the current one in `~/.local/share/luma/pin-releases`
and removes the others from that store. Before that, it exports the release it
replaces to
`~/.local/share/luma/pin-release-exports/RELEASE_ID/luma-pin-VERSION.tar.gz`.
`setup production --pin-release-archive` accepts that file, so an earlier Pin
build stays available.

Operator releases republish the exact pinned signed Pin archive until someone
deliberately moves the Pin version forward. So a server-only release does not
replace an unchanged Pin build, and the wearer does not have to reinstall it.

### Publish a release

A release is one annotated `vVERSION` tag on a clean commit. One command
publishes it:

```sh
./luma check platform --full && ./luma test
git tag -a v1.2.3 -m "Luma 1.2.3" HEAD
./luma registry login --username GITHUB_USER    # a token that can write packages
./luma release publish --version 1.2.3            # checks and prints the plan only
./luma release publish --version 1.2.3 --notes notes.txt --confirm
```

`--notes FILE` (or `--notes -` to read standard input) adds plain-text release
notes of at most 2000 characters. They travel in the release descriptor and in
Center's `/api/version`. Center's update banner and Software updates page show
them as **What's new**. The `gh release create` command that the run prints
passes them as the GitHub release's text (`--notes-file`).

Publishing needs the maintainer's release signing key. You make it once with
`./luma release keygen`. cosign writes the private key to
`~/.config/luma/secrets/release/cosign.key` with mode 0600. The password comes
from `COSIGN_PASSWORD` or from cosign's hidden prompt. Back the key up with the
other secrets and never commit it. Keygen writes the public key to
`platform/distribution/release-signing.pub` and embeds the same bytes in
`bootstrap`.

After keygen, run `bun platform/setup/generate.mjs --write` so Center serves
the updated installer. Then commit the three files it names:
`platform/distribution/release-signing.pub`, `bootstrap`, and
`center/src/lib/pin-setup/generated/bootstrap.ts`. The plan says whether the
private key is on this machine and whether the committed public key is still
the empty placeholder. A confirmed run refuses without both.

The machine needs Docker with Compose 2.34 or newer, plus emulation for the
other CPU architecture. Docker Desktop includes the emulation. On Linux,
register QEMU through binfmt first. The machine also needs a GHCR login whose
token can write packages. To build new Pin apps it needs the Pin signing key,
and the plan says whether this machine has it.

Publish each version from one machine only. The plan and a resumed run decide
their steps from that machine's receipts, and image tags are meant never to
change.

Before it builds anything, even for the plan, the command:

- checks that the GHCR login can write this repository's packages
- reads the tag and release on GitHub through the authenticated GitHub CLI
- refuses a published GitHub release or existing image tags on GHCR

A tag already pushed to GitHub is allowed only when it is the identical
annotated tag object. If the GitHub metadata is unavailable or invalid,
publication stops before any build.

On macOS, Luma also finds Colima's default local Docker socket at
`~/.colima/default/docker.sock` when `/var/run/docker.sock` is missing. Source
checks and release builds work with it, without a system socket symlink.

With `--confirm` the command:

1. refuses a dirty tree, a tag that is missing, lightweight, or on another
   commit, a different tag on GitHub, a GHCR login that cannot write packages,
   and a version already published on GitHub or GHCR.
2. builds the five images (Cosmos, Center, the Spotify adapter, Keycloak, and
   the Center iroh bridge) for `linux/amd64` and `linux/arm64` in parallel into
   the build cache, while it prepares the Pin release.
3. pushes the images one at a time and records each verified digest in a
   receipt. Each push gets up to five attempts with growing pauses, because an
   unreliable uplink drops parallel uploads.
4. publishes the audited, digest-pinned Compose application.
5. packs the operator archive with `platform/distribution/build.mjs`.
6. signs `SHA256SUMS` with the release signing key. cosign asks for the key's
   password unless `COSIGN_PASSWORD` is set. It writes
   `SHA256SUMS.sigstore.json` and verifies it against the committed public
   key. Then it prints every artifact, `SHA256SUMS`, and the
   `sha256sum SHA256SUMS` line to send.

Everything lands in `~/.local/share/luma/publication/vVERSION` (under
`LUMA_DATA_DIR`): receipts, logs, the Pin archive, and `operator-release/`. If
a step fails, fix the cause and run the same command again. Its receipts make
it skip the steps that already finished. The directory belongs to one commit
and one Pin choice, so move it aside to start over.

Without `--pin-version`, the release republishes the signed Pin archive named
in `platform/distribution/pin-release-coordinates.json`. `gh` (logged in)
downloads it, and every coordinate is checked. Before it builds anything, even
for the plan, the command checks that the archive is an asset of that GitHub
release. If it is not, the command stops and tells you the fix. A server-only
release keeps that exact signed Pin bundle. If its GitHub release is missing,
publish the bundle from its publication directory with the `gh release create`
steps below, or ship new Pin apps instead.

To ship new Pin apps, add
`--pin-version YYYY-MM-DD.N --pin-version-code INTEGER`. The versionCode must
be higher than the one on the wearer's Pin. The command then runs
`./luma pin release build` and `export`, which sign only with
`~/.config/luma/secrets/pin/signing.env`. It writes the new coordinates to
`pin-release-coordinates.json` in the publication directory. Once the GitHub
release exists, commit that file over the checked-in one, so later releases
republish that Pin build.

The one-line installer installs the latest GitHub release, and only when its
signature checks out against the key built into the installer. To put the
release on GitHub, push the tag and create the release from the five files the
run printed:

```sh
git push origin v1.2.3
gh release create v1.2.3 --verify-tag --draft --title "Luma 1.2.3" \
  ~/.local/share/luma/publication/v1.2.3/operator-release/*
gh release edit v1.2.3 --draft=false    # after checking the draft's assets
```

Or hand the five files in `operator-release/` to the person installing it, who
follows [Get Luma](../README.md#get-luma). The five files are the operator
archive, the Pin archive, the release descriptor, `SHA256SUMS`, and
`SHA256SUMS.sigstore.json`. If that person has no cosign, also send the
`sha256sum SHA256SUMS` line that the confirmed run prints. Send it separately,
in a message, not next to the files.

Once the release is published on GitHub, announce it in Discord. The command
posts one embed to a channel webhook. The embed holds the release notes, the
commits since the previous tag as links, and how to update:

```sh
./luma release announce --set-webhook    # once: paste the channel's webhook URL
./luma release announce --version 1.2.3            # prints the message only
./luma release announce --version 1.2.3 --confirm  # posts it
```

The webhook URL is saved in `~/.config/luma/secrets/release/discord-webhook`
with mode 0600, and the command never prints it. The command refuses a
release that GitHub still has as a draft. A receipt in the publication
directory makes sure each release is posted only once.

There is no CI publication path. CI only runs the checks, and the release
signing key never leaves the maintainer's machine. Every release is built and
signed there.

The published images are public, so an installer pulls them without a GitHub
account or token. Production updates use the verified operator archive and the
backup, deployment, and live verification steps in
[Update Luma](operations.md#update-luma). Publishing alone updates no server.
Servers learn about a release from their update source's `/api/version`. So a
release reaches every server that follows your Center once it is on GitHub and
deployed to that Center
([Run your own update source](operations.md#run-your-own-update-source)).

### Keep root access after reboot

Luma includes a [rooting helper](../pin/ghostlock/README.md) for one exact
retail Pin firmware (45.20, slots `_a` and `_b`). Every signed Luma Pin release
contains the helper's native payload. The optional **Root access** device flag
lets the Pin root itself again after each reboot, with no computer or ADB
connection. This boot runner is Luma's own code. The stock Shell app supplies
only the proven `BOOT_COMPLETED` process start.

The flag is off by default. To turn it on:

1. Connect the exact Pin.
2. Open **Center → Settings → Advanced → Experimental features**.
3. Turn on **Root access** and save.
4. Restart the Pin while it has external power.

The setting is stored on the Pin and survives reboot. About two minutes into
each boot, the runner checks:

- the complete firmware fingerprint, kernel build, and slot
- the UID-2000 shell boundary and SELinux state
- the payload hash
- at least 20% battery, and external power

Rooting can take a while to finish. Before the kernel step, Luma also checks
that the runner can use the exact performance CPU this firmware profile needs.
The runner claims that boot atomically. It works out the current KASLR address
from a fresh local bugreport and makes at most one guarded attempt.

Root access ends at the next reboot. While the flag stays on, Luma roots the
Pin again on the next boot. Turning the flag off stops attempts on later boots.

If an attempt itself restarts the Pin, Luma turns **Root access** off on the
boot that follows. This keeps it out of an unattended restart loop.

The source-checkout commands still work for a temporary session while a
computer is connected. The vendored helper allows one attempt per boot.
Luma's wrapper uses the same boot claim as the standalone runner, so the two
paths cannot each use up an attempt in the same boot. `follow --confirm`
checks each fresh boot and restores the temporary session only while the Pin
stays on USB.

| Command | What it does |
| --- | --- |
| `./luma pin dock check --serial SERIAL` | Read-only inspection against the supported firmware, power, and build gates |
| `./luma pin dock build` | Build the dock helper in its pinned toolchain (NDK r28c, Python 3.10+) |
| `./luma pin dock run --serial SERIAL` | Start one guarded temporary session and confirm interactively |
| `./luma pin dock verify --serial SERIAL` | Check whether the temporary dock session is active |
| `./luma pin dock report RUN_DIR --output FILE` | Write a redacted report from a private run directory |
| `./luma pin dock follow --serial SERIAL --confirm` | While connected: check, then make one guarded attempt per fresh boot |

`follow` checks first on each boot, so it leaves an active session alone. It
retries a refusal raised before the boot's single attempt is used: missing
external power, low battery, or an offline device. Anything else settles that
boot, and `follow` waits for the next one. Ctrl-C stops it.

> [!WARNING]
> This is a low-level, firmware-specific device operation. It can panic,
> reboot, or leave the Pin unresponsive. Recovery may require waiting for the
> battery to drain. One exact firmware is supported. Read the vendored
> [safety guide](../pin/ghostlock/docs/SAFETY.md) and
> [compatibility notes](../pin/ghostlock/docs/COMPATIBILITY.md) before any
> attempt, and use it only on a Pin you own and can afford to recover.

The upstream copy under `pin/ghostlock/` stays pristine. Its
[UPSTREAM.md](../pin/ghostlock/UPSTREAM.md) records the original project's
identity, the exact vendored commit, and how to refresh it.
