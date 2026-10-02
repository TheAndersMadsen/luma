# For developers

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


[AGENTS.md](../AGENTS.md) holds the working rules, the source map, and how to
extend Luma faithfully from the stock apps, for people and coding agents
alike. Clone only when changing source:

Install Docker Desktop (macOS) or Docker Engine with Compose 2.34+ (Linux)
and start it. Clone the repository, then install the pinned JavaScript tools
once. Bun is the runtime; pnpm is the package manager. Neither needs Node or npm.

```sh
git clone https://github.com/TheAndersMadsen/luma.git
cd luma
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"
export PATH="$HOME/.bun/bin:$HOME/.local/share/pnpm:$PATH"
bun platform/setup/install-pnpm.mjs "$HOME/.local/share/pnpm"
pnpm setup
pnpm setup:local
```

The pnpm installer verifies the native 12.6.0 archive's SHA-256 before running
it. `pnpm setup` saves its PATH entry for future terminals; Bun's installer
saves its own. `pnpm setup:local` installs the workspace from its frozen lockfile
and creates Luma's configuration outside the checkout. It is safe to rerun.

Start Center with hot reload:

```sh
pnpm dev
```

This runs the existing Docker Compose development stack and serves Center at
`http://localhost:4000`. Rust application builds and Android builds use their
containers. The three JavaScript packages share `pnpm-lock.yaml`; use
`pnpm --dir center add PACKAGE` to change Center dependencies. Do not create
npm, Yarn, or Bun lockfiles. `platform/containers/pin-builder/toolchain.json`
records the pinned tools used by local checks, CI, and images.

Rust-specific host checks also need Rustup; `rust-toolchain.toml` selects the
required Rust version automatically. Normal Center development needs only
Bun, pnpm, and Docker.

Platform acceptance files run in separate Bun processes with a three-minute
deadline per file. This keeps their environment isolated and avoids Bun's
shared test-worker hang.

Run only what your change needs:

```sh
./luma check changed --base HEAD   # your uncommitted changes
./luma check center
./luma check cosmos TEST_FILTER
./luma check platform
./luma pin check
```

Without `--base`, `check changed` compares with `origin/HEAD`, so commits you
have not pushed count as changes too. `./luma pin check` runs the Pin builder's
own tests on your machine, then checks the formatting of the Pin runtime core
and tests it with the `iroh` feature the release APK ships, and formats, lints and tests
the USB bridge, then the JVM unit tests of the contracts, the Compatibility Layer,
Device Services, and Device Installer's common, installer, and Setup Helper
modules in the pinned Pin builder container, so it needs Docker running but no
JDK or Android SDK of your own. The container reads the checkout read-only and
compiles in the external build directory; its first run builds the builder image.

To repeat the production image smoke check and save its report outside source:

```sh
bun platform/deploy/acceptance/javascript-runtime.mjs luma/center:YOUR_TAG /tmp/luma-center-runtime.json
bun center/verify/http-boundaries.mjs luma/center:YOUR_TAG /tmp/luma-center-http.json
```

The HTTP check starts disposable Center and Cosmos-fixture containers, exercises
authenticated reads, writes, refusals, and partial failures, then removes them.
It uses synthetic accounts and saves a JSON report; no wearer or provider
credentials are needed.

For a broad change:

```sh
./luma check platform --full
./luma test
```

GitHub CI runs on every pull request and push to `main`, including documentation
changes. Its **Run workflow** button also checks a chosen branch. It validates
the workflows, runs the full platform suite, Center tests and production build,
Cosmos tests with PostgreSQL, and the full Pin contributor checks with the pinned
Android builder. A separate Linux job builds and checksums all five debug APKs;
its downloadable artifact is for inspection, never a signed release. Pin check
logs are retained for seven days. The final **CI passed** check succeeds only
when every component succeeds; a failed, cancelled, or skipped component blocks
it. Every job has a time limit.

Dependencies and compiler output are reused from the external build directory,
so narrow reruns avoid rebuilding unrelated components. Configuration defaults
to `~/.config/luma`; data and caches default to `~/.local/share/luma`.
Successful Cosmos checks keep the eight newest incremental variants per crate
and remove superseded ones automatically, so repeated local rebuilds do not
fill the disk.

Production stores everything in PostgreSQL, so `./luma check cosmos` (with or
without a filter) and `./luma test` need a running Docker: the Cosmos tests run
against a throwaway container of production's pinned PostgreSQL image,
published only on loopback and removed afterwards. Without Docker the check
fails instead of skipping those tests.

The source checkout's `./luma` has more commands than a release's. The ones
you use most:

| Command | What it is for |
| --- | --- |
| `./luma setup contributor` or `./luma init` | Create the external configuration a checkout needs; `setup status` shows what is ready |
| `./luma doctor` | Check this machine's tools and configuration; it writes nothing |
| `./luma up`, `down`, `status`, `logs` | Run the local stack (`./luma stack ...` spells them out) |
| `./luma dev center` | Run Center with hot reload |
| `./luma check ...`, `./luma test` | Run the checks above |
| `./luma config ...` | Read and set settings ([Configuration](#configuration)) |
| `./luma pki init device-user` | Create the DeviceUser CA a local stack needs to enroll a real Pin; `pki import device-user` imports an existing pair. Production setup creates its own |
| `./luma pin ...` | Build, check, and install the Pin apps ([Build the Pin apps](#build-the-pin-apps)); `pin install` and `pin activate` act on one exact Pin and only plan until given `--confirm` |
| `./luma stock decompile` | Build the stock reference ([Stock reference](#stock-reference)) |
| `./luma release publish` | Publish a release ([Publish a release](#publish-a-release)) |
| `./luma support-bundle` | Write a redacted diagnostic file to attach to a report |

`./luma COMMAND --help` describes each one, with its options and whether it
changes only this machine, what production runs or a published release, or a
device.

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

`./luma config list` shows each setting's group, whether it is secret, and,
once the configuration exists, whether it is set; it never prints a value.
`COSMOS_LLM_API_KEY` is the assistant model key, and Cosmos reads no other
name for it. A server that set only the older `COSMOS_OPENROUTER_API_KEY`
shows `COSMOS_LLM_API_KEY` as unset in `config list`; enter the key once with
`./luma config set COSMOS_LLM_API_KEY --stdin`. At a terminal,
`config set NAME --stdin` asks for the value without showing it; from a
script, pipe the value in, for example from your password manager's
command-line tool, so it never reaches argv or shell history.

To keep configuration or data somewhere else, export these variables in every
shell that runs `./luma`, before the first `./luma init` or `./luma setup`.
Luma does not remember them: a shell without them looks in the defaults, and
`doctor`, `deploy`, `verify`, `backup`, and `setup status` then say they found
no configuration and name the path they checked. `setup production` prints the
`export` line for the variables it ran with; put it in `~/.profile`.

| Variable | Default |
| --- | --- |
| `LUMA_CONFIG_DIR` | `~/.config/luma` |
| `LUMA_SECRETS_DIR` | `~/.config/luma/secrets` |
| `LUMA_DATA_DIR` | `~/.local/share/luma` |
| `LUMA_BUILD_DIR` | `~/.local/share/luma/build`; it must stay inside `LUMA_DATA_DIR` |

Do not create the directories yourself: `init` and `setup` create them owner-only
(mode 0700) and mark them as Luma's, and they refuse a directory that already
exists without that mark.

### Stock reference

The stock Pin's own apps are the reference for faithful work. Build a local,
decompiled copy with one command:

```sh
./luma stock decompile --from-device SERIAL   # a connected stock Pin, read-only
./luma stock decompile --apk-dir DIR          # stock .apk/.jar files you already hold
```

`--from-device` only reads the Pin. It selects the `hu.ma.ne.*` and `humane.*`
packages on the system partitions (Ironman, Krypto, the experience apps, and
the rest) plus `/system/framework/humane_*.jar`, then copies them with
`adb -s SERIAL pull`. The command downloads the jadx release pinned by version
and SHA-256 in `platform/containers/pin-builder/toolchain.json` into the build
directory and verifies it. jadx then runs without network in the builder's
pinned JDK container, because host JVMs crash on some Macs. A full Pin takes
about 5 GB of disk and half an hour.

Output goes to `~/.local/share/luma/stock-reference/`, and the command prints
the path:

| Path | Contents |
| --- | --- |
| `apks/` | The stock APK and framework-jar inputs, pulled with `--from-device` or copied from `--apk-dir` |
| `decompiled/<app>/sources/` | Java for each app or jar, e.g. `decompiled/ironman/sources/` |
| `manifest.json` | jadx version, device build fingerprint, and each input's SHA-256 |

`./luma pin doctor` reports whether `decompiled/` is present. A failed run
leaves the previous reference in place. This is the only place stock evidence
is read from: the Tier-A registry proves each native action against it, and
the evidence-bound Kotlin and Rust tests read it through the `LUMA_DATA_DIR`
that `./luma` checks pass them (`./luma pin check` mounts it read-only at
`/luma-data/stock-reference` for the builder's `check-unit` lane, which runs the
Kotlin tests). A test pinned to the
stock apps of one firmware build skips, and says why, on a reference pulled
from another build until its evidence is reviewed again.

> [!IMPORTANT]
> Stock APKs, framework jars, and their decompile are Humane's code. The
> command refuses to write them or read them inside the checkout. Never
> commit, publish, or attach them to an issue or release. Cite class and
> method names instead.

### Build the Pin apps

Building signed Pin apps requires the external signing material and private
native assets already authorized for the project:

```sh
./luma pin doctor
./luma pin release build --version YYYY-MM-DD.N --version-code INTEGER
./luma pin release export --output luma-pin-YYYY-MM-DD.N.tar.gz
```

The pinned builder takes its tool versions from
`platform/containers/pin-builder/toolchain.json` and keeps its caches outside
the checkout. It always signs and verifies Device Installer (`installer`),
Setup Helper (`bootstrap`), Compatibility Layer (`hook`), Device Services
(`server`), and Compatibility Loader (`hook-injector`) as one release. These
manifest roles and their Android package IDs remain fixed compatibility
identifiers. Building never runs ADB.

The maintainer holds the one private input, the Pin signing key
(`~/.config/luma/secrets/pin/signing.env`), which the project does not
distribute. Ask the maintainer when your change needs a signed release.
`./luma pin check` and `./luma pin build-debug` do not use it, and
`./luma pin doctor` reports it as missing.

For a compile-only check, run `./luma pin check`, then
`./luma pin build-debug --role installer --role bootstrap --role hook --role server --role hook-injector`.
This checks the Android app code without touching the Pin; the compile-only
Device Services APK omits the native Rust executable. The signed release build
also cross-compiles and packages that executable for Android ARM64.
Debug APKs are not release artifacts; a successful build does not prove live
hooking, decoding, or audible playback. Use a signed
release for the physical Pin check.

A build makes its release the current one in `~/.local/share/luma/pin-releases`
and removes the others from that store. It first exports the release it
replaces to `~/.local/share/luma/pin-release-exports/RELEASE_ID/luma-pin-VERSION.tar.gz`,
which `setup production --pin-release-archive` accepts, so an earlier Pin build
stays available.

Operator releases republish the exact pinned signed Pin archive until the Pin
version is deliberately advanced. A server-only release therefore does not
replace an unchanged Pin build or require the wearer to reinstall it.

### Publish a release

A release is one annotated `vVERSION` tag on a clean commit, and one command
publishes it:

```sh
./luma check platform --full && ./luma test
git tag -a v1.2.3 -m "Luma 1.2.3" HEAD
./luma registry login --username GITHUB_USER    # a token that can write packages
./luma release publish --version 1.2.3            # checks and prints the plan only
./luma release publish --version 1.2.3 --notes notes.txt --confirm
```

`--notes FILE` (or `--notes -` to read standard input) adds plain-text
release notes of at most 2000 characters. They travel in the release
descriptor and Center's `/api/version`, so Center's update banner and
Software updates page show them as **What's new**, and the `gh release create`
command the run prints passes them as the GitHub release's text
(`--notes-file`).

Publishing needs the maintainer's release signing key, made once with
`./luma release keygen`: cosign writes the private key to
`~/.config/luma/secrets/release/cosign.key` (mode 0600, password from
`COSIGN_PASSWORD` or cosign's hidden prompt; back it up with the other
secrets, never commit it) and the public key to
`platform/distribution/release-signing.pub`, and embeds the same bytes in
`bootstrap`. After keygen, run `bun platform/setup/generate.mjs --write` so
Center serves the updated installer, and commit the three files it names:
`platform/distribution/release-signing.pub`, `bootstrap`, and
`center/src/lib/pin-setup/generated/bootstrap.ts`. The plan says whether the
private key is present on this machine and whether the committed public key
is still the empty placeholder; a confirmed run refuses without both.

The machine needs Docker with Compose 2.34 or newer and emulation for the
other CPU architecture. Docker Desktop includes the emulation. On Linux,
register QEMU through binfmt first. It also needs a GHCR login whose token
can write packages, and, to build new Pin apps, the Pin signing key; the plan
says whether this machine has it. Publish each version from one machine only:
the plan and a resumed run decide their steps from that machine's receipts,
and image tags are meant never to change. Before building anything, even for
the plan, the command verifies that the GHCR login can write this
repository's packages, reads the tag and release on GitHub through the
authenticated GitHub CLI, and refuses a published GitHub release or existing
image tags on GHCR. A tag already pushed to GitHub is allowed only when it is
the identical annotated tag object. Unavailable or invalid GitHub metadata
stops publication before any build.

On macOS, Luma also recognizes Colima's default local Docker socket at
`~/.colima/default/docker.sock` when `/var/run/docker.sock` is absent. This
works for source checks and release builds without a system socket symlink.

With `--confirm` the command:

1. refuses a dirty tree, a tag that is missing, lightweight, or on another
   commit, a different tag on GitHub, a GHCR login that cannot write packages,
   and a version already published on GitHub or GHCR;
2. builds the five images (Cosmos, Center, the Spotify adapter, Keycloak, and
   the Center iroh bridge) for `linux/amd64` and `linux/arm64` in parallel into
   the build cache, while it prepares the Pin release;
3. pushes the images one at a time, giving each push up to five attempts with
   growing pauses, because an unreliable uplink drops parallel uploads, and
   records each verified digest in a receipt;
4. publishes the audited, digest-pinned Compose application;
5. packs the operator archive with `platform/distribution/build.mjs`;
6. signs `SHA256SUMS` with the release signing key (cosign asks for the key's
   password unless `COSIGN_PASSWORD` is set), writes
   `SHA256SUMS.sigstore.json`, verifies it against the committed public key,
   and prints every artifact, `SHA256SUMS`, and the `sha256sum SHA256SUMS`
   line to send.

Everything lands in `~/.local/share/luma/publication/vVERSION` (under
`LUMA_DATA_DIR`): receipts, logs, the Pin archive, and `operator-release/`. If
a step fails, fix the cause and run the same command again; finished steps are
skipped by their receipts. The directory belongs to one commit and one Pin
choice, so move it aside to start over.

Without `--pin-version`, the release republishes the signed Pin archive named
in `platform/distribution/pin-release-coordinates.json`: `gh` (logged in)
downloads it and every coordinate is checked. Before building anything, even
for the plan, the command checks that the archive is an asset of that GitHub
release and stops with the fix when it is not. A server-only release keeps
that exact signed Pin bundle. If its GitHub release is missing, publish the
bundle from its publication directory with the `gh release create` steps below,
or ship new Pin apps instead. To ship new Pin apps, add
`--pin-version YYYY-MM-DD.N --pin-version-code INTEGER` with a versionCode
higher than the one on the wearer's Pin. The command then runs
`./luma pin release build` and `export`, which sign only with
`~/.config/luma/secrets/pin/signing.env`, and writes the new coordinates to
`pin-release-coordinates.json` in the publication directory. Commit that file
over the checked-in one once the GitHub release exists, so later releases
republish that Pin build.

The one-line installer installs the latest GitHub release, and only when its
signature verifies against the key it embeds. Put the release on GitHub by pushing the
tag and creating the release from the five files the run printed:

```sh
git push origin v1.2.3
gh release create v1.2.3 --verify-tag --draft --title "Luma 1.2.3" \
  ~/.local/share/luma/publication/v1.2.3/operator-release/*
gh release edit v1.2.3 --draft=false    # after checking the draft's assets
```

Or hand the five files in `operator-release/` (the operator archive, the Pin
archive, the release descriptor, `SHA256SUMS`, and `SHA256SUMS.sigstore.json`)
to the person installing it, who follows [Get Luma](../README.md#get-luma); for someone
without cosign, also send the `sha256sum SHA256SUMS` line the confirmed run
prints, separately, in a message rather than beside the files. No CI
publication path exists: CI only runs the checks, and the release signing key
never leaves the maintainer's machine, so every release is built and signed
there.
The published images are public, so an installer pulls them without a GitHub
account or token. Production updates use the verified
operator archive and the backup, deployment, and live verification steps in
[Update Luma](operations.md#update-luma). Publishing alone updates no server: servers
learn about a release from their update source's `/api/version`, so a release
reaches every server following your Center once it is on GitHub and deployed
to that Center ([Run your own update source](operations.md#run-your-own-update-source)).

### Keep root access after reboot

Luma includes a firmware-specific [rooting helper](../pin/ghostlock/README.md) for
one exact retail Pin firmware (45.20, slots `_a` and `_b`). Every signed Luma Pin release
contains the helper's native payload. The optional **Root access** device flag
lets the Pin re-root itself after each reboot without a computer or ADB
connection. This boot runner is Luma-owned behavior (INFERRED); the stock Shell
app supplies only the proven `BOOT_COMPLETED` process start.

The flag is off by default. Connect the exact Pin, open **Center → Settings →
Advanced → Experimental features**, turn on **Root access**, save, and restart the Pin
while it has external power. The setting is stored on the Pin and survives
reboot. About two minutes into each boot, the runner checks the complete
firmware fingerprint, kernel build, slot, UID-2000 shell boundary, SELinux
state, payload hash, at least 20% battery, and external power. Rooting can take
a while to finish. Before the kernel step, Luma also verifies that the runner
can use the exact performance CPU required by this firmware profile. The
runner claims that boot atomically, derives the current KASLR address from a
fresh local bugreport, and makes at most one guarded attempt. Root access ends
at the next reboot; while the flag remains enabled, Luma re-roots the Pin on
the next boot. Turning the flag off prevents attempts on later boots.

If an attempt itself restarts the Pin, Luma turns **Root access** off on the
recovered boot so it cannot enter an unattended restart loop. The
source-checkout commands remain available for a temporary session while a
computer is connected. The vendored helper permits one attempt per boot, and
Luma's wrapper uses the same boot claim as the standalone runner, so the two
paths cannot consume separate attempts in one boot. `follow --confirm` checks
each fresh boot and restores the temporary session only while the Pin remains
on USB.

| Command | What it does |
| --- | --- |
| `./luma pin dock check --serial SERIAL` | Read-only inspection against the supported firmware, power, and build gates |
| `./luma pin dock build` | Build the dock helper in its pinned toolchain (NDK r28c, Python 3.10+) |
| `./luma pin dock run --serial SERIAL` | Start one guarded temporary session and confirm interactively |
| `./luma pin dock verify --serial SERIAL` | Check whether the temporary dock session is active |
| `./luma pin dock report RUN_DIR --output FILE` | Write a redacted report from a private run directory |
| `./luma pin dock follow --serial SERIAL --confirm` | While connected: check, then make one guarded attempt per fresh boot |

`follow` checks first each boot, so an active session is left untouched. A
refusal raised before consuming the boot's single attempt, missing external
power, low battery, or an offline device, is retried; anything else settles
the boot and waits for the next one. Ctrl-C stops the supervisor.

> [!WARNING]
> This is a low-level, firmware-specific device operation. It can panic,
> reboot, or leave the Pin unresponsive; recovery may require waiting for the
> battery to drain. One exact firmware is supported. Read the vendored
> [safety guide](../pin/ghostlock/docs/SAFETY.md) and
> [compatibility notes](../pin/ghostlock/docs/COMPATIBILITY.md) before any
> attempt, and use it only on a Pin you own and can afford to recover.

The upstream copy under `pin/ghostlock/` stays pristine. Its
[UPSTREAM.md](../pin/ghostlock/UPSTREAM.md) records the original project
identity, exact vendored commit, and refresh procedure.

