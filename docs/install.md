# Install Luma on a server

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


This is the [Quick start](../README.md#quick-start) in full, with the reasons behind each
command. Luma's repository, releases, and container images are public, so the
one-line installer downloads everything it needs with no account or token. You
need:

- A fresh 64-bit Ubuntu 24.04 server, `amd64` or `arm64`, with at least 8 GiB
  of free disk, public ports 80 and 443, and a public IPv4 address. The Pin
  connects to that address directly, not through your domain.
- A domain name whose DNS points at that server.
- One release: the five files of the
  [latest GitHub release](https://github.com/TheAndersMadsen/luma/releases/latest),
  or of the maintainer's `operator-release` folder.
  They are the operator archive `luma-operator-VERSION-linux.tar.gz`, the Pin
  archive `luma-pin-PIN_VERSION.tar.gz`, the release descriptor
  `luma-VERSION.release.json`, `SHA256SUMS`, and `SHA256SUMS.sigstore.json`,
  the maintainer's cosign signature over `SHA256SUMS`. With push access you
  can build one yourself ([Publish a release](developers.md#publish-a-release)).
- For the Pin: a USB interposer, a USB-C data cable, and a computer with
  desktop Chrome or Edge ([Connect a Pin](../README.md#connect-a-pin)).
- Accounts with the providers you want. A useful Pin needs at least an
  assistant model and Azure Speech for transcription and its voice
  ([Configure services in Center](services.md#configure-services-in-center)).

### Choosing your server, domain, and providers

**Server.** Any provider that gives you a plain Ubuntu 24.04 machine with its
own public IPv4 works. A beginner-friendly choice is
[Hetzner Cloud](https://www.hetzner.com/cloud): pick the Ubuntu 24.04 image on
a CX (`amd64`, from about €4 a month) or CAX (`arm64`, from about €4.49)
server; both architectures work. Linode/Akamai (about $5) and DigitalOcean
(about $12 for 2 GB; choose plain Ubuntu 24.04, not its Docker image, which is
Ubuntu 22.04) are fine alternatives. Oracle's free tier works technically but
its sign-up is unreliable; treat it as advanced. Luma's production stack runs
15 containers with the default features (17 with every feature), including
Keycloak and PostgreSQL, so give it 4 GB of
RAM, 8 GB to be comfortable (an estimate: the repository sets per-container
limits, not a host minimum). The Pin connects to the server's public IPv4
directly, so an IPv6-only server, a home connection behind CGNAT, Cloudflare's
proxy ("orange cloud"), Cloudflare Tunnel (no public gRPC), and Tailscale
Funnel (no custom domain) do not work. Open only TCP ports 80 and 443 in the
provider's firewall or security group.

**Domain.** Buy one at [Porkbun](https://porkbun.com) or
[Namecheap](https://www.namecheap.com), or take a free `name.duckdns.org`
from [DuckDNS](https://www.duckdns.org); Let's Encrypt issues certificates
for both. Point it with one A record at the server's IPv4 and keep any proxy
off; for a DuckDNS name, setup can set that record for you with your DuckDNS
token. Avoid `nip.io` and `sslip.io`: every user of those shares one Let's
Encrypt certificate quota.

**Providers.** The smallest useful pair is an OpenAI-compatible assistant key
(OpenRouter or OpenAI) and Azure Speech (key and region). Everything else in
[Configure services in Center](services.md#configure-services-in-center) is optional and
can be added later without touching the Pin.

**Features.** Setup asks which optional features to turn on; the defaults are
`pin`, `search`, and `spotify`:

| Feature | What it adds |
| --- | --- |
| `pin` | The Pin's edge on your public IPv4, so a Pin can connect (needs the IPv4) |
| `search` | A bundled SearXNG web search, so the assistant can search without a SerpAPI key |
| `spotify` | Music playback: Spotify natively, YouTube Music and TIDAL through Center (needs `pin`) |
| `observability` | Prometheus and Grafana, served only on `127.0.0.1:13001` |

Keeping those defaults prepares the server for a Pin later; no physical Pin
is required during installation. For Center alone, enter `search` or `none`
at the Features question. Setup then skips the Pin address and Pin archive,
and keeps that choice when rerun. To enable the Pin later, rerun
`./luma onboard production`, change Features to `pin,search,spotify`, and
provide the server's public IPv4 and this release's Pin archive if asked.

**What guided setup asks, in order.** `onboard production` and
`setup production --guided` walk the same six numbered steps, each question
with the saved value as its default. The first is
`[1/6] Public Center domain (blank or "duckdns" for a free DuckDNS name):`;
leave it blank or type `duckdns` and it asks instead for the DuckDNS
subdomain, the server's public IPv4 (defaulted when the server's own address
and one HTTPS echo agree), and the DuckDNS token, typed hidden and not
stored: setup sets the `NAME.duckdns.org` record once, which is enough
because a VPS keeps its IPv4. Then the email Let's Encrypt sends certificate
notices to; the first Center owner's email; the features (`pin, search,
spotify`, or `none`); the server's public IPv4 for the Pin (only with `pin`,
defaulted to the detected address); with `pin`, when the release's Pin apps are not
staged yet, the path to the Pin archive; the Luma Center this server asks for
newer releases (its update source); and whether to install updates
automatically at night. It then shows `[6/6] Review` and asks
`Write this production configuration? [y/N]`.

### 1. Prepare the server

Sign in to the server over SSH as your normal sudo-capable user; the
commands below run there, after step 2 unpacks the release.

<details>
<summary>What the server needs</summary>

The release includes a prerequisite installer, `bootstrap --tools-only`, that
installs checksum-verified Bun 1.4.2 and Docker Engine with Compose 2.34 or
newer. It checks what is already installed and asks before installing Bun or
Docker; Ubuntu's `ca-certificates`, `curl`, `unzip`, and `gnupg` packages it
installs without asking. The server only needs Bun and Docker. pnpm, Rust, the Android SDK,
and source build tools stay on the development/build side; production pulls
prepared images.

</details>

### 2. Install the release

Put the five release files in a folder named after the release, one folder per
release, and copy it to the server. Below, `VERSION` stands for the release's
version, the one in its `luma-VERSION.release.json` file name: release 1.2.3
goes in `luma-1.2.3`. From your computer:

```sh
scp -r luma-VERSION you@203.0.113.10:
```

On the server, check the files, unpack the operator, and install:

```sh
cd ~/luma-VERSION
sha256sum --check SHA256SUMS
tar -xzf luma-operator-*-linux.tar.gz
cd luma-operator-*/
bash ./bootstrap --tools-only
# If the installer added you to Docker's group, reconnect over SSH first.
# A private fork only: ./luma registry login --username YOUR_GITHUB_USER
./luma onboard production --pin-release-archive ../luma-pin-*.tar.gz
```

The server is ready when `verify production` passes:
`https://YOUR_DOMAIN/api/version` returns this release and
`environment: "production"`. Every step is safe to rerun after an
interruption, and a failed check never deletes a working configuration,
server deployment, or Pin state.

<details>
<summary>What each command does</summary>

- `SHA256SUMS.sigstore.json` is the maintainer's cosign signature over
  `SHA256SUMS`. With [cosign](https://github.com/sigstore/cosign) installed,
  `cosign verify-blob --key luma-operator-*/platform/distribution/release-signing.pub --bundle SHA256SUMS.sigstore.json --insecure-ignore-tlog SHA256SUMS`,
  run in `~/luma-VERSION` after unpacking, proves the maintainer signed the
  checksums; `release-signing.pub` is the public key, at
  `platform/distribution/release-signing.pub` in the repository and inside the
  operator archive. `--insecure-ignore-tlog` only means the releases are
  signed without a public transparency log entry; the key check itself is
  complete. `sha256sum --check` must print `OK` for every file: it proves the
  copy is complete and undamaged. Without cosign, compare
  `sha256sum SHA256SUMS` with a value the maintainer gives you out of band,
  such as in a message, or use the one-line installer below, which checks the
  signature for you.
- `onboard production` asks for your domain, email addresses, and the services
  you want. It runs setup, checks the server, shows the deployment plan, and
  asks before deploying. It finishes by verifying the public site and printing
  the Guided setup link. Rerun the same command after fixing a reported issue.
  Its steps are the commands below, which you can also run one at a time:
  `setup production`, `doctor production`, `deploy production --dry-run`, and
  `deploy production --confirm`. Each ends with a `NEXT` line naming the
  command to run next.
- `setup production` writes configuration, secrets, certificates, and runtime
  data outside the release folder; it never deploys or changes a Pin. Before
  it writes the configuration, it checks the Pin archive against the size and
  SHA-256 bound into the operator, then its release ID and version, manifest,
  signer, package roles, and every APK, and stages it for Center's installer.
  Rerunning setup keeps existing nonblank values. Its flags:
  `./luma setup production (--domain HOST | --duckdns-subdomain NAME --duckdns-token-stdin) --acme-email EMAIL --operator-email EMAIL [--public-ip IPV4|auto] [--pin-release-archive FILE] [options]`.
  Without a domain of your own, `--duckdns-subdomain NAME` with
  `--duckdns-token-stdin` (the token typed hidden at a terminal, or piped)
  points the free `NAME.duckdns.org` at this server once and uses it as the
  domain; the token is not stored, and giving `--domain` as well is a usage
  error. `--public-ip auto` uses the server's own address when one HTTPS echo
  confirms it, and stops with the reason otherwise. The profiles are optional:
  `pin` (the Pin's edge; needs `--public-ip`), `search` (SearXNG web search),
  `spotify` (music playback; needs `pin`), and `observability` (Prometheus and
  Grafana on `127.0.0.1:13001`). To be asked for these values instead, run
  `./luma setup production --guided`. While this release's Pin apps are not
  staged, it also asks for the Pin archive's path unless you pass
  `--pin-release-archive`. Without the `pin` profile the Pin archive is
  accepted and not read.
- Setup keeps everything in `~/.config/luma` and `~/.local/share/luma`. To use
  other directories, export `LUMA_CONFIG_DIR` and `LUMA_DATA_DIR` before
  setup ([Configuration](developers.md#configuration)). Setup then prints an `export` line
  to add to `~/.profile`, because every later `./luma` command needs the same
  values; a shell without them reports that it found no configuration and
  names the path it checked.
- A mistyped domain or owner email can be corrected until the first
  `deploy production --confirm`: rerun setup with the right `--domain` or
  `--operator-email`. After that deploy, Keycloak holds them, so setup stops
  without changing anything and says so; changing the domain or owner of a
  deployed server is not supported yet.
- `registry login` is only needed for a private fork. It hands the prompt to
  Docker, which keeps the token in Luma's own Docker configuration for image
  pulls, so it never appears in arguments or output; Luma also saves it (mode
  0600, `~/.config/luma/secrets/github-token`) to download later releases for
  [updates](operations.md#update-luma). Public images pull and public
  releases update with no token, so you can skip this step.
- `doctor production` checks the configuration, ports 80 and 443, DNS, and
  that Docker can read the release's application from GHCR. It changes
  nothing.
- `deploy production --confirm` renders the edge configuration (Traefik, and
  Envoy with the `pin` profile) from this release's templates and your setup
  values, pulls the release's digest-pinned images, starts them, recreates the
  edge containers (a brief edge restart on every confirmed deploy), and runs
  the same public checks as `verify production`. It never compiles source.
  `--dry-run` in place of `--confirm` shows the plan and changes nothing. Your
  own `traefik-extra.json` and `traefik-extra-certs/`
  ([Serve other hostnames](operations.md#serve-other-hostnames-through-lumas-traefik-optional))
  are mounted as they are and never written.

</details>

### 3. Sign in and connect the Pin

```sh
cat ~/.config/luma/production/first-login.txt
```

Sign in at the Center address it shows, change the password in
**Settings → Passcode & password**, delete the file, then open the
**Guided setup** link and follow [Connect a Pin](../README.md#connect-a-pin) or the
step-by-step [Connect your Pin](../guides/connect-your-pin.md).

<details>
<summary>What the first sign-in file is</summary>

Setup saves your first sign-in to `~/.config/luma/production/first-login.txt`,
readable only by you: the Center address, the **Guided setup** link, the owner
email, and the initial password. Deleting
the file does not remove the initial password from the server: it is also the
seed in `~/.config/luma/production/realm.json`, which Keycloak reads only when
it first creates the realm, and every backup copies it, so change it rather
than keep it. From the Guided setup link, Center
walks through the USB connection, the Pin's network and clock, installation,
the required services, connecting the Pin to your Luma, its passcode, and one
real voice check ([Connect a Pin](../README.md#connect-a-pin)). You never run ADB commands
or move a private key by hand.

</details>

### The one-line installer

```sh
bash <(curl -fsSL https://YOUR-CENTER/install.sh)
```

Every Center serves this script at `/install.sh`; `YOUR-CENTER` is the
address of any Luma Center you trust, such as a friend's. It installs Bun
and Docker, installs the latest stable release whose `SHA256SUMS` carries the
maintainer's cosign signature `SHA256SUMS.sigstore.json`, and runs the same
`onboard production` as above, ending at `✓ Setup complete`. With no token it
installs anonymously and skips the registry login; given a token (a private
fork's), it also logs Docker into the registry and saves the token for
updates. The Center you fetched it from becomes the new server's update
source, and setup asks whether to install updates automatically at night (yes
unless you say no; [Update Luma](operations.md#update-luma)).

<details>
<summary>What it needs and what it refuses</summary>

The script is the repository's `bootstrap` file; read it before you run it,
with `curl -fsSL https://YOUR-CENTER/install.sh | less`. It embeds the
maintainer's public key, the same bytes as
`platform/distribution/release-signing.pub`, downloads the pinned cosign and
checks it against its size and SHA-256, verifies the release's
`SHA256SUMS.sigstore.json` against the embedded key, and only then downloads,
checks against `SHA256SUMS`, and installs the files it lists. The public
release needs no token; a private fork can supply one that reads the repository
and its packages (a classic token with the `repo` and `read:packages` scopes,
via the GitHub CLI or `LUMA_GITHUB_TOKEN_FILE`). Given a release without that
signature, or an installer whose key is
still the empty placeholder, it stops at **Authenticate the latest stable
release**, says so, and installs nothing from it; the Bun and Docker it set up
by then are step 1 above, so continue with the steps above from the release
files.

</details>

### Paste into Hetzner

The same installer runs with no SSH session at all. Download
`https://YOUR-CENTER/cloud-init.yaml` from any Luma Center you trust, fill in
every `REPLACE_ME` value (your domain or a free DuckDNS name, the certificate
and owner emails, and the DuckDNS token only if you chose a DuckDNS name;
no GitHub token is needed), and paste the whole file into the **Cloud config** box when
you create an Ubuntu 24.04 server in Hetzner Cloud. The server installs Bun
and Docker, downloads and verifies the latest signed release, configures,
deploys, and verifies production by itself, logging to
`/var/log/luma-install.log`. The DuckDNS token file is shredded as soon as it
was read (or unread, with a domain of your own), and the installer refuses to
start while any `REPLACE_ME` value remains. When the log ends with `✓ Setup complete`, open
`https://YOUR-DOMAIN/login`; the first password is in
`/root/.config/luma/production/first-login.txt` on the server (`cat` it once,
sign in, delete it). A stopped run ends with the same `Setup stopped` block
and `Safe retry:` line as the interactive installer: sign in as root and run
it interactively, or run it again with `LUMA_UNATTENDED=1`, the same `LUMA_*`
settings, and, with a DuckDNS name, a freshly written DuckDNS token file. The file's
`LUMA_AUTO_UPDATES=on` lets the server install newer releases at night (set
`off` to install them yourself), and the server follows the Center you
downloaded the file from unless you add `LUMA_UPDATE_SOURCE=https://CENTER`.
The template is
`platform/setup/cloud-init.yaml` in the repository and in the operator
archive.

