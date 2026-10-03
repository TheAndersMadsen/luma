# Install Luma on a server

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


This page is the [Quick start](../README.md#quick-start) in full, with the
reason for each command. Luma's repository, releases, and container images
are public, so the installer downloads everything it needs without a GitHub
account or token.

There are three ways to install. They all end with the same server:

| Way | What you do | Section |
| --- | --- | --- |
| Step by step | Copy the release to the server and run four commands over SSH | [1. Prepare the server](#1-prepare-the-server) to [3. Sign in and connect the Pin](#3-sign-in-and-connect-the-pin) |
| One-line installer | Run one command over SSH | [The one-line installer](#the-one-line-installer) |
| Hetzner cloud-init | Paste a filled-in file when you create the server, with no SSH at all | [Paste into Hetzner](#paste-into-hetzner) |

You need:

- A fresh 64-bit Ubuntu 24.04 server, `amd64` or `arm64`, with at least 8 GiB
  of free disk, public ports 80 and 443, and a public IPv4 address. The Pin
  connects to that address directly, not through your domain.
- A domain name whose DNS points at that server.
- One release. That is the five files of the
  [latest GitHub release](https://github.com/TheAndersMadsen/luma/releases/latest),
  or of the maintainer's `operator-release` folder:
  - the operator archive `luma-operator-VERSION-linux.tar.gz`
  - the Pin archive `luma-pin-PIN_VERSION.tar.gz`
  - the release descriptor `luma-VERSION.release.json`
  - `SHA256SUMS`
  - `SHA256SUMS.sigstore.json`, the maintainer's cosign signature over
    `SHA256SUMS`

  With push access you can build a release yourself
  ([Publish a release](developers.md#publish-a-release)).
- For the Pin: a USB interposer, a USB-C data cable, and a computer with
  desktop Chrome or Edge ([Connect a Pin](../README.md#connect-a-pin)).
- Accounts with the providers you want. A useful Pin needs at least an
  assistant model, plus Azure Speech for transcription and the Pin's voice
  ([Configure services in Center](services.md#configure-services-in-center)).

### Choosing your server, domain, and providers

#### Server

Any provider that gives you a plain Ubuntu 24.04 machine with its own public
IPv4 address works. Both architectures work.

| Provider | What to pick | Price |
| --- | --- | --- |
| [Hetzner Cloud](https://www.hetzner.com/cloud) (easiest for beginners) | The Ubuntu 24.04 image on a CX (`amd64`) or CAX (`arm64`) server | CX from about €4 a month, CAX from about €4.49 |
| Linode/Akamai | Ubuntu 24.04 | About $5 |
| DigitalOcean | Plain Ubuntu 24.04, not its Docker image, which is Ubuntu 22.04 | About $12 for 2 GB |

Oracle's free tier works technically, but its sign-up is unreliable. Treat it
as an advanced option.

Luma's production stack runs 15 containers with the default features (17
with every feature), including Keycloak and PostgreSQL. Give it 4 GB of RAM,
or 8 GB to be comfortable. That is an estimate: the repository sets limits
per container, not a minimum for the host.

The Pin connects to the server's public IPv4 address directly, so these do
not work:

- an IPv6-only server
- a home connection behind CGNAT
- Cloudflare's proxy (the "orange cloud")
- Cloudflare Tunnel (no public gRPC)
- Tailscale Funnel (no custom domain)

In the provider's firewall or security group, open only TCP ports 80 and 443.

#### Domain

Buy one at [Porkbun](https://porkbun.com) or
[Namecheap](https://www.namecheap.com), or get a free `name.duckdns.org`
from [DuckDNS](https://www.duckdns.org). Let's Encrypt issues certificates
for both.

Point the domain at the server with one A record for the server's IPv4
address, and keep any proxy off. For a DuckDNS name, setup can set that
record for you with your DuckDNS token.

Avoid `nip.io` and `sslip.io`. Everyone who uses them shares one Let's
Encrypt certificate quota.

#### Providers

The smallest useful pair is an OpenAI-compatible assistant key (OpenRouter
or OpenAI) and Azure Speech (a key and a region). Everything else in
[Configure services in Center](services.md#configure-services-in-center) is
optional. You can add it later without touching the Pin.

#### Features

Setup asks which optional features to turn on. The defaults are `pin`,
`search`, and `spotify`.

| Feature | What it adds |
| --- | --- |
| `pin` | The Pin's edge on your public IPv4, so a Pin can connect (needs the IPv4) |
| `search` | A bundled SearXNG web search, so the assistant can search without a SerpAPI key |
| `spotify` | Music playback: Spotify natively, YouTube Music and TIDAL through Center (needs `pin`) |
| `observability` | Prometheus and Grafana, served only on `127.0.0.1:13001` |

The defaults prepare the server for a Pin later. You don't need a physical
Pin during installation.

For Center alone, enter `search` or `none` at the Features question. Setup
then skips the Pin address and the Pin archive, and keeps that choice when
you rerun it. To enable the Pin later, rerun `./luma onboard production`,
change Features to `pin,search,spotify`, and give the server's public IPv4
and this release's Pin archive if it asks.

#### What guided setup asks

`onboard production` and `setup production --guided` ask the same questions,
grouped into six numbered steps. Each question offers the saved value as its
default. In order, setup asks for:

- The domain, at
  `[1/6] Public Center domain (blank or "duckdns" for a free DuckDNS name):`.
  If you leave it blank or type `duckdns`, it asks instead for:
  - the DuckDNS subdomain
  - the server's public IPv4 (filled in for you when the server's own
    address and one HTTPS echo agree)
  - the DuckDNS token, typed hidden and not stored

  Setup sets the `NAME.duckdns.org` record once. That is enough, because a
  VPS keeps its IPv4 address.
- The email address Let's Encrypt sends certificate notices to.
- The first Center owner's email address.
- The features: `pin, search, spotify`, or `none`.
- The server's public IPv4 for the Pin. Setup asks only with `pin`, and
  fills in the detected address.
- The path to the Pin archive. Setup asks only with `pin`, only when the
  release's Pin apps are not staged yet, and only when you did not pass
  `--pin-release-archive`. Press Enter to have setup download it from GitHub
  instead.
- The Luma Center this server asks for newer releases (its update source).
- Whether to install updates automatically at night.

Then it shows `[6/6] Review` and asks
`Write this production configuration? [y/N]`.

### 1. Prepare the server

Sign in to the server over SSH as your normal user with sudo rights. The
commands in step 2 run there, after you unpack the release.

<details>
<summary>What the server needs</summary>

The release includes a prerequisite installer, `bootstrap --tools-only`. It
installs checksum-verified Bun 1.4.2 and Docker Engine with Compose 2.34 or
newer. It checks what is already installed and asks before it installs Bun
or Docker. It installs Ubuntu's `ca-certificates`, `curl`, `unzip`, and
`gnupg` packages without asking.

The server only needs Bun and Docker. pnpm, Rust, the Android SDK, and the
tools that build from source stay on the development and build side.
Production pulls prepared images.

</details>

### 2. Install the release

1. **Download the release onto the server.**

   ```sh
   mkdir -p ~/luma && cd ~/luma
   curl -fsSL https://api.github.com/repos/TheAndersMadsen/luma/releases/latest \
     | grep browser_download_url | cut -d '"' -f 4 | xargs -n 1 curl -fsSLO
   ```

   You should see five files in `~/luma`: the operator archive, the Pin
   archive, `luma-VERSION.release.json`, `SHA256SUMS`, and
   `SHA256SUMS.sigstore.json`.

   <details>
   <summary>Downloaded the files on your computer instead?</summary>

   Put the five files in a folder named `luma` and copy it over:

   ```sh
   scp -r luma you@203.0.113.10:
   ```

   </details>

2. **Check the files and unpack the operator.** Unpack it into Luma's own
   folder. Automatic updates only start for a release that lives there.

   ```sh
   cd ~/luma
   sha256sum --check SHA256SUMS
   install -d -m 0700 ~/.local/share/luma ~/.local/share/luma/operators ~/.local/share/luma/build
   tar -xzf luma-operator-*-linux.tar.gz -C ~/.local/share/luma/operators
   cd ~/.local/share/luma/operators/luma-operator-*/
   ```

   You should see `OK` after every file name. If a line says `FAILED`,
   download that file again.

3. **Install Bun and Docker.**

   ```sh
   bash ./bootstrap --tools-only
   ```

   Press Enter at `Ready to start?`, then answer `y` to install Bun and `y`
   to install Docker. You should see `Bun and Docker are ready.` If the
   installer added you to Docker's group, it also says `Reconnect over SSH so
   this session picks up Docker group membership.` In that case, type
   `exit`, sign in again, and run
   `cd ~/.local/share/luma/operators/luma-operator-*/`.

4. **Set up and deploy.**

   ```sh
   ./luma onboard production --pin-release-archive ~/luma/luma-pin-*.tar.gz
   ```

   Answer the questions in
   [What guided setup asks](#what-guided-setup-asks). Use real email
   addresses: Let's Encrypt refuses `example.com`. Answer `y` to
   `Write this production configuration? [y/N]` and to
   `Deploy this verified release now? [y/N]`. You should see
   `Setup complete: https://YOUR_DOMAIN/login?...` at the end.

   If deploying stops with `The operation timed out.` or says nothing
   answered at your domain, the internet can't reach ports 80 and 443 on
   the server. Open them in your provider's firewall and run the same
   command again.

> [!NOTE]
> On a private fork only, run
> `./luma registry login --username YOUR_GITHUB_USER` before
> `./luma onboard production`. The public release needs no login.

The server is ready when `verify production` passes. That means
`https://YOUR_DOMAIN/api/version` returns this release and
`environment: "production"`. You can safely rerun every step after an
interruption. A failed check never deletes a working configuration, server
deployment, or Pin state.

<details>
<summary>Check the maintainer's signature</summary>

`SHA256SUMS.sigstore.json` is the maintainer's cosign signature over
`SHA256SUMS`. With [cosign](https://github.com/sigstore/cosign) installed,
run this in `~/luma` after you unpack the operator:

```sh
cosign verify-blob --key ~/.local/share/luma/operators/luma-operator-*/platform/distribution/release-signing.pub --bundle SHA256SUMS.sigstore.json --insecure-ignore-tlog SHA256SUMS
```

It proves the maintainer signed the checksums. `release-signing.pub` is the
public key. It is at `platform/distribution/release-signing.pub` in the
repository and inside the operator archive. `--insecure-ignore-tlog` only
means the releases are signed without an entry in a public transparency log.
The key check itself is complete.

`sha256sum --check` must print `OK` for every file. That proves the copy is
complete and undamaged.

Without cosign, compare the output of `sha256sum SHA256SUMS` with a value the
maintainer gives you another way, such as in a message. Or use the
[one-line installer](#the-one-line-installer), which checks the signature
for you.

</details>

<details>
<summary>What each command does</summary>

- `onboard production` asks for your domain, email addresses, and the
  services you want. It runs setup, checks the server, shows the deployment
  plan, and asks before it deploys. It finishes by verifying the public site
  and printing the Guided setup link. After you fix a reported problem, rerun
  the same command.

  Its steps are these commands, which you can also run one at a time:
  `setup production`, `doctor production`, `deploy production --dry-run`,
  `deploy production --confirm`, and `verify production`. Run on their own,
  setup, doctor, and the dry run each end with a `NEXT` line that names the
  command to run next.
- `setup production` writes configuration, secrets, certificates, and runtime
  data outside the release folder. It never deploys or changes a Pin.

  Before it writes the configuration, it checks the Pin archive against the
  size and SHA-256 bound into the operator. Then it checks the archive's
  release ID and version, manifest, signer, package roles, and every APK, and
  stages it for Center's installer. When you rerun setup, it keeps existing
  values that are not blank.

  Its flags:

  ```text
  ./luma setup production (--domain HOST | --duckdns-subdomain NAME --duckdns-token-stdin) --acme-email EMAIL --operator-email EMAIL [--public-ip IPV4|auto] [--pin-release-archive FILE] [options]
  ```

  - Without a domain of your own, use `--duckdns-subdomain NAME` with
    `--duckdns-token-stdin`. You type the token hidden at a terminal, or pipe
    it in. Setup points the free `NAME.duckdns.org` at this server once and
    uses it as the domain. The token is not stored. Giving `--domain` as well
    is a usage error.
  - `--public-ip auto` uses the server's own address when one HTTPS echo
    confirms it. Otherwise it stops and gives the reason.
  - The profiles are optional: `pin` (the Pin's edge, needs `--public-ip`),
    `search` (SearXNG web search), `spotify` (music playback, needs `pin`),
    and `observability` (Prometheus and Grafana on `127.0.0.1:13001`).
  - To be asked for these values instead, run
    `./luma setup production --guided`. While this release's Pin apps are not
    staged, it also asks for the Pin archive's path unless you pass
    `--pin-release-archive`.
  - Without the `pin` profile, setup accepts the Pin archive and does not
    read it.
- Setup keeps everything in `~/.config/luma` and `~/.local/share/luma`. To use
  other directories, export `LUMA_CONFIG_DIR` and `LUMA_DATA_DIR` before
  setup ([Configuration](developers.md#configuration)). Setup then prints an
  `export` line to add to `~/.profile`, because every later `./luma` command
  needs the same values. A shell without them reports that it found no
  configuration and names the path it checked.
- You can correct a mistyped domain or owner email until the first
  `deploy production --confirm`. Rerun setup with the right `--domain` or
  `--operator-email`. After that deploy, Keycloak holds them, so setup stops
  without changing anything and tells you so. Changing the domain or owner of
  a deployed server is not supported yet.
- `registry login` is only needed for a private fork. It hands the prompt to
  Docker, which keeps the token in Luma's own Docker configuration for image
  pulls, so the token never appears in arguments or output. Luma also saves it
  (mode 0600, `~/.config/luma/secrets/github-token`) to download later
  releases for [updates](operations.md#update-luma). Public images pull and
  public releases update with no token, so you can skip this step.
- `doctor production` checks the configuration, that nothing else on this
  server uses ports 80 and 443, that the domain resolves, and that Docker can
  read the release's application from GHCR. It changes nothing. It cannot see
  your provider's firewall, or whether the domain points at this server.
- `deploy production --confirm` does the following, and never compiles
  source:
  1. Renders the edge configuration (Traefik, and Envoy with the `pin`
     profile) from this release's templates and your setup values.
  2. Pulls the release's digest-pinned images and starts them.
  3. Recreates the edge containers. The edge restarts briefly on every
     confirmed deploy.
  4. With the `pin` profile, switches Center to this release's staged Pin
     apps.
  5. Applies this release's sign-in policy to the running Keycloak realm.
  6. Runs the same public checks as `verify production`.

  `--dry-run` in place of `--confirm` shows the plan and changes nothing.
  Your own `traefik-extra.json` and `traefik-extra-certs/`
  ([Serve other hostnames](operations.md#serve-other-hostnames-through-lumas-traefik-optional))
  are mounted as they are and never written.

</details>

### 3. Sign in and connect the Pin

1. Show your first sign-in details:

   ```sh
   cat ~/.config/luma/production/first-login.txt
   ```

2. Open the Center address it shows and sign in.
3. Change the password in **Settings → Passcode & password**.
4. Delete the file:

   ```sh
   rm ~/.config/luma/production/first-login.txt
   ```

5. Open the **Guided setup** link and follow
   [Connect a Pin](../README.md#connect-a-pin) or the step-by-step
   [Connect your Pin](../guides/connect-your-pin.md).

<details>
<summary>What the first sign-in file is</summary>

Setup saves your first sign-in to `~/.config/luma/production/first-login.txt`,
which only you can read. It holds the Center address, the **Guided setup**
link, the owner email, and the initial password.

Deleting the file does not remove the initial password from the server. The
password is also the seed in `~/.config/luma/production/realm.json`, which
Keycloak reads only when it first creates the realm, and every backup copies
it. So change the password rather than keep it.

From the Guided setup link, Center walks you through the USB connection, the
Pin's network and clock, installation, the required services, connecting the
Pin to your Luma, its passcode, and one real voice check
([Connect a Pin](../README.md#connect-a-pin)). You never run ADB commands or
move a private key by hand.

</details>

### The one-line installer

```sh
bash <(curl -fsSL https://YOUR-CENTER/install.sh)
```

Every Center serves this script at `/install.sh`. `YOUR-CENTER` is the
address of any Luma Center you trust, such as a friend's.

The script installs Bun and Docker. Then it installs the latest stable
release whose `SHA256SUMS` carries the maintainer's cosign signature,
`SHA256SUMS.sigstore.json`, and runs the same `onboard production` as above.
It has no Pin archive file to pass on, so setup asks for the archive's path.
Press Enter, and setup downloads this release's Pin archive from GitHub and
checks it. When onboarding finishes, the screen clears and shows
`✓ Setup complete`. Then continue with
[3. Sign in and connect the Pin](#3-sign-in-and-connect-the-pin).

With no token, it installs anonymously and skips the registry login. Given a
token (a private fork's), it also logs Docker into the registry and saves the
token for updates.

The Center you fetched the script from becomes the new server's update
source. Setup asks whether to install updates automatically at night. The
answer is yes unless you say no ([Update Luma](operations.md#update-luma)).

<details>
<summary>What it needs and what it refuses</summary>

The script is the repository's `bootstrap` file. Read it before you run it:

```sh
curl -fsSL https://YOUR-CENTER/install.sh | less
```

It embeds the maintainer's public key, the same bytes as
`platform/distribution/release-signing.pub`. It downloads the pinned cosign
and checks its size and SHA-256. It verifies the release's
`SHA256SUMS.sigstore.json` against the embedded key. Only then does it
download the files `SHA256SUMS` lists, check them against it, and install
them.

The public release needs no token. A private fork can supply one that reads
the repository and its packages: a classic token with the `repo` and
`read:packages` scopes, through the GitHub CLI or `LUMA_GITHUB_TOKEN_FILE`.

Given a release without that signature, or an installer whose key is still
the empty placeholder, it stops at **Authenticate the latest stable
release**, says so, and installs nothing from that release. The Bun and
Docker it set up by then are step 3 of
[2. Install the release](#2-install-the-release), so continue with those
steps from the release files.

</details>

### Paste into Hetzner

The same installer can run with no SSH session at all.

1. Download `https://YOUR-CENTER/cloud-init.yaml` from any Luma Center you
   trust.
2. Fill in the `REPLACE_ME` values in its `install.env` part: your domain in
   `LUMA_DOMAIN`, and the certificate and owner emails. For a free DuckDNS
   name instead, empty `LUMA_DOMAIN`, set `LUMA_DUCKDNS_SUBDOMAIN`, and put
   the DuckDNS token in place of `REPLACE_ME_DUCKDNS_TOKEN`. You don't need a
   GitHub token. The installer refuses to start while `install.env` still
   holds a `REPLACE_ME` value.
3. Create an Ubuntu 24.04 server in Hetzner Cloud and paste the whole file
   into the **Cloud config** box.

The server installs Bun and Docker, downloads and verifies the latest signed
release, then configures, deploys, and verifies production by itself. It logs
to `/var/log/luma-install.log`. The DuckDNS token file is shredded as soon as
it is read, or unread when you use a domain of your own.

When the log ends with `✓ Setup complete`:

1. Open `https://YOUR-DOMAIN/login`.
2. The first password is in `/root/.config/luma/production/first-login.txt`
   on the server. `cat` it once, sign in, and delete the file.

A run that stops ends with the same `Setup stopped` block and `Safe retry:`
line as the interactive installer. Then either sign in as root and run the
installer interactively, or run it again with `LUMA_UNATTENDED=1` and the
same `LUMA_*` settings. With a DuckDNS name, also write the DuckDNS token
file again.

The file's `LUMA_AUTO_UPDATES=on` lets the server install newer releases at
night. Set it to `off` to install them yourself. The server follows the
Center you downloaded the file from unless you add
`LUMA_UPDATE_SOURCE=https://CENTER`.

The template is `platform/setup/cloud-init.yaml`, in the repository and in
the operator archive.
