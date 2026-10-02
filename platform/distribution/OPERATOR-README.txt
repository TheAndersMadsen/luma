Luma operator bundle

This archive deploys one immutable Luma release. It contains the operator
CLI and digest-pinned application descriptor, not application source.

Requirements: 64-bit Ubuntu 24.04 on amd64/x86_64 or arm64/aarch64,
Bun 1.4.2, Docker Engine, and Docker Compose 2.34+.

A release comes as five files: this operator archive, the Pin archive
luma-pin-PIN_VERSION.tar.gz, the release descriptor, SHA256SUMS, and
SHA256SUMS.sigstore.json, the maintainer's cosign signature over SHA256SUMS.
In the folder that holds the five files, check the checksums before
unpacking, then the signature against the maintainer's public key, which
this archive carries as platform/distribution/release-signing.pub (the
repository and the one-line installer carry the same key):

  sha256sum --check SHA256SUMS
  cosign verify-blob --key luma-operator-VERSION/platform/distribution/release-signing.pub \
    --bundle SHA256SUMS.sigstore.json --insecure-ignore-tlog SHA256SUMS

`--insecure-ignore-tlog` only says the releases are not in a public
transparency log; the key check itself is complete. Luma's repository, releases,
and images are public, so installing and updating need no GitHub account or
token (a private fork needs a classic token with the repo and read:packages
scopes).

Install, from this directory:

  bash ./bootstrap --tools-only
  # Reconnect over SSH if Docker group membership was just added.
  # Public images need no login; a private fork runs: ./luma registry login --username GITHUB_USER
  ./luma onboard production --pin-release-archive ../luma-pin-PIN_VERSION.tar.gz


For a private fork, `registry login` hands the prompt to Docker: paste the
token at Password:; public images need no login.
With the pin profile, setup verifies the Pin archive against the size and
SHA-256 bound into this release and stages it for Center's installer. Without
--pin-release-archive it downloads the archive from the release's GitHub page
after verifying that release's signed SHA256SUMS with the same public key.

`./luma setup production --guided --pin-release-archive FILE` asks for the
setup values instead. `./luma onboard production --pin-release-archive FILE`
walks through that guided setup (saved answers are the defaults), doctor, the
dry run, the confirmed deploy, and verification in one go.

Until the first deploy, a mistyped domain or owner email is corrected by
running setup again with the right value. After it, setup keeps them.

Update: `./luma update production --check` asks the update source (setup's
--update-source, by default the Center named in the release) whether a newer
release exists. `./luma update production` then downloads it from GitHub's
public releases with no token (a private fork uses the token `registry login`
saved), verifies its signature with the key in this archive, unpacks it into
~/.local/share/luma/operators/VERSION, and runs from there the backup, setup
with the saved values, the dry run, the confirmed deploy, and verification.
With automatic updates on (the default for a new server;
`setup production --auto-updates on|off`), a systemd timer runs
`./luma update production --auto` at night and restores the backup when a
step after the new setup fails. ~/.local/share/luma/operators/current names
the folder to run `./luma` from.

By hand: unpack the new release next to this one, then from the new release's
directory run `./luma backup production`, the same `setup production` with
only `--pin-release-archive` pointing at its Pin archive (saved values are
reused), and `deploy production --confirm`, which ends with the checks of
`verify production`. Always run `./luma` from the newest release's directory:
setup refuses to move the server back to an older release, which only a
restore does.

Back up the database, volumes, configuration, keys, and secrets, then copy the
printed directory off this server:

  ./luma backup production

Restore it on a stopped or fresh server with the operator release that made
the backup. The first command only checks and prints the plan; a backup taken
before that release's setup ran is restored without a deploy, and the restore
names the older release folder to deploy it from:

  ./luma restore production --from DIR
  ./luma restore production --from DIR --confirm

Lost the owner password? This writes a new one-time password to the mode-0600
first-login file, like setup does, and never prints it:

  ./luma reset-password production --confirm

Use `./luma config list` to discover settings. Pass secret values through
`./luma config set NAME --stdin`, which asks for the value without showing it;
do not put secrets in shell history.

Verify the staged or active Pin release with:

  ./luma pin release acquire --check

Center then serves the verified five-APK set to its browser installer. Sign in
at the Guided setup link production setup prints (it is also in the
first-login file), connect the Pin
over USB, install the release, and choose `Connect this Pin to Cosmos`. Center
activates the exact connected Pin, pairs it with the owner account, and pairs
the remote bridge. Return to Guided setup after activation. A factory-reset Pin
needs one re-entry of the same four-digit passcode over USB; a Pin that already
finished setup keeps its current passcode. Finish by asking one real question
and confirming the Pin's microphone, speaker, and gesture response. Activation
files and CLI activation remain recovery tools.

Configuration, secrets, runtime data, and build caches live outside this
archive, in ~/.config/luma and ~/.local/share/luma. A server set up with
LUMA_CONFIG_DIR and LUMA_DATA_DIR needs the same values exported in every shell
that runs ./luma; setup prints the export line to put in ~/.profile. Rerunning setup preserves existing nonblank values. `deploy --confirm`
pulls prebuilt images and verifies the running release; it does not compile.
`./luma COMMAND --help` describes each command and whether it changes this
server.

Project guide: https://github.com/TheAndersMadsen/luma#readme
