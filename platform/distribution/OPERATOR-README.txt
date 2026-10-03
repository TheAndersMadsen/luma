Luma operator bundle

This archive deploys one immutable Luma release. It contains the operator
CLI and a digest-pinned application descriptor. It does not contain
application source.

Requirements: 64-bit Ubuntu 24.04 on amd64/x86_64 or arm64/aarch64,
Bun 1.4.2, Docker Engine, and Docker Compose 2.34+.


CHECK THE RELEASE

A release comes as five files:

  - this operator archive
  - the Pin archive luma-pin-PIN_VERSION.tar.gz
  - the release descriptor
  - SHA256SUMS
  - SHA256SUMS.sigstore.json, the maintainer's cosign signature over
    SHA256SUMS

In the folder that holds the five files, check the checksums before you
unpack anything. Then check the signature against the maintainer's public
key. This archive carries that key as
platform/distribution/release-signing.pub, and the repository and the
one-line installer carry the same key.

  sha256sum --check SHA256SUMS
  cosign verify-blob --key luma-operator-VERSION/platform/distribution/release-signing.pub \
    --bundle SHA256SUMS.sigstore.json --insecure-ignore-tlog SHA256SUMS

`--insecure-ignore-tlog` only says the releases are not in a public
transparency log. The key check itself is complete.

Luma's repository, releases, and images are public, so installing and
updating need no GitHub account or token. A private fork needs a classic
token with the repo and read:packages scopes.


INSTALL

From this directory:

  bash ./bootstrap --tools-only
  # Reconnect over SSH if Docker group membership was just added.
  # Public images need no login; a private fork runs: ./luma registry login --username GITHUB_USER
  ./luma onboard production --pin-release-archive ../luma-pin-PIN_VERSION.tar.gz

For a private fork, `registry login` hands the prompt to Docker. Paste the
token at Password:. Public images need no login.

With the pin profile, setup checks the Pin archive against the size and
SHA-256 bound into this release and stages it for Center's installer.
Without --pin-release-archive, it downloads the archive from the release's
GitHub page after it verifies that release's signed SHA256SUMS with the same
public key.

`./luma setup production --guided --pin-release-archive FILE` asks for the
setup values instead. `./luma onboard production --pin-release-archive FILE`
runs that guided setup (your saved answers are the defaults), doctor, the
dry run, the confirmed deploy, and verification in one go.

Until the first deploy, you can correct a mistyped domain or owner email by
running setup again with the right value. After the first deploy, setup
keeps them.


UPDATE

`./luma update production --check` asks the update source whether a newer
release exists. The update source is setup's --update-source, by default the
Center named in the release.

`./luma update production` then:

  1. downloads the new release from GitHub's public releases with no token
     (a private fork uses the token `registry login` saved)
  2. verifies its signature with the key in this archive
  3. unpacks it into ~/.local/share/luma/operators/VERSION
  4. runs from there the backup, setup with the saved values, the dry run,
     the confirmed deploy, and verification

Automatic updates are on by default for a new server
(`setup production --auto-updates on|off`). With them on, a systemd timer
runs `./luma update production --auto` at night. If a step after the new
setup fails, it restores the backup. ~/.local/share/luma/operators/current
names the folder to run `./luma` from.

To update by hand, unpack the new release next to this one. Then, from the
new release's directory, run:

  1. `./luma backup production`
  2. the same `setup production`, with only `--pin-release-archive` pointing
     at the new Pin archive (your saved values are reused)
  3. `deploy production --confirm`, which ends with the checks of
     `verify production`

Always run `./luma` from the newest release's directory. Setup refuses to
move the server back to an older release. Only a restore does that.


BACK UP AND RESTORE

This backs up the database, volumes, configuration, keys, and secrets. Copy
the directory it prints off this server afterwards.

  ./luma backup production

Restore a backup on a stopped or fresh server with the operator release that
made the backup. The first command only checks and prints the plan. A backup
taken before that release's setup ran is restored without a deploy, and the
restore names the older release folder to deploy it from.

  ./luma restore production --from DIR
  ./luma restore production --from DIR --confirm


LOST THE OWNER PASSWORD?

This writes a new one-time password to the mode-0600 first-login file, as
setup does, and never prints it:

  ./luma reset-password production --confirm


SETTINGS AND SECRETS

Use `./luma config list` to see the settings. Pass secret values through
`./luma config set NAME --stdin`, which asks for the value without showing
it. Do not put secrets in shell history.


CONNECT THE PIN

Check the staged or active Pin release with:

  ./luma pin release acquire --check

Center then serves the verified five-APK set to its browser installer.

  1. Sign in at the Guided setup link that production setup prints. The
     link is also in the first-login file.
  2. Connect the Pin over USB and install the release.
  3. Choose `Connect this Pin to Cosmos`. Center activates the exact
     connected Pin, pairs it with the owner account, and pairs the remote
     bridge.

Return to Guided setup after activation. A factory-reset Pin
needs one re-entry of the same four-digit passcode over USB. A Pin that
already finished setup keeps its current passcode. Finish by asking one real
question and confirming the Pin's microphone, speaker, and gesture response.
Activation files and CLI activation remain recovery tools.


WHERE THINGS LIVE

Configuration, secrets, runtime data, and build caches live outside this
archive, in ~/.config/luma and ~/.local/share/luma. A server set up with
LUMA_CONFIG_DIR and LUMA_DATA_DIR needs the same values exported in every
shell that runs ./luma. Setup prints the export line to put in ~/.profile.

Rerunning setup keeps existing values that are not blank.
`deploy --confirm` pulls prebuilt images and verifies the running release.
It does not compile. `./luma COMMAND --help` describes each command and
whether it changes this server.

Project guide: https://github.com/TheAndersMadsen/luma#readme
