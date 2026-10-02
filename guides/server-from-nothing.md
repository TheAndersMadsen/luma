# Set up a Luma server from nothing

This guide takes you from no server at all to a running Luma that passes
`./luma verify production`, with your first sign-in done and the assistant
and voice providers connected. It follows
[Install Luma on a server](../docs/install.md) and
[Configure services in Center](../docs/services.md), which stay the
reference. Unfamiliar words are in the [glossary](glossary.md).

**What you need**

- A computer with a terminal (macOS Terminal, Windows Terminal with
  PowerShell, or any Linux terminal) and an SSH key. If you have never made
  one, run `ssh-keygen` once and accept the defaults.
- A credit or debit card for the server (about 4 to 5 euros a month).
- No GitHub account is needed: Luma's repository, releases, and images are
  public, so installing and updating need no invitation or token.
- One Luma release: the five files of the latest GitHub release (see
  [Get the release files](#get-the-release-files)).
- Accounts with two providers, so the Pin can answer: an
  OpenAI-compatible assistant (an [OpenRouter](https://openrouter.ai) or
  [OpenAI](https://platform.openai.com) API key and a model ID) and
  [Azure Speech](https://portal.azure.com) (a key and a region). Everything
  else is optional.

**Time:** about 1.5 hours, plus waiting for DNS. Nothing here needs the Pin;
that is the next guide, [Connect your Pin](connect-your-pin.md).

**Decision points in this guide**

- [Which server provider](#part-a-get-a-server) (Hetzner recommended).
- [Free DuckDNS name or your own domain](#part-c-point-a-domain-at-the-server).
- [One-line installer or the five release files](#part-e-install-luma).

## Part A: Get a server

Luma needs a fresh 64-bit Ubuntu 24.04 server, `amd64` or `arm64`, with a
public IPv4 address, ports 80 and 443 reachable from the internet, and at
least 8 GiB of free disk. Any provider that sells that works. The steps below
use Hetzner Cloud because it is cheap and simple; alternatives follow.

### Hetzner Cloud (recommended)

1. Create an account at <https://console.hetzner.cloud> and add a payment
   method.

   You see: the Cloud Console with an empty project list.

2. Choose **New project**, name it `luma`, and open it.

3. Choose **Add Server**.

4. Under **Location**, pick the one nearest you.

5. Under **Image**, choose **Ubuntu 24.04**. Do not pick an "app" image such
   as Docker; Luma installs its own Docker.

6. Under **Type**, choose **Shared vCPU**. Pick the cheapest **x86 (CX)**
   plan (about 4 euros a month) or the cheapest **Arm64 (CAX)** plan (about
   4.49 euros a month). Both work; Luma publishes images for both.

7. Under **Networking**, keep **Public IPv4** ticked. The Pin needs it.

8. Under **SSH keys**, choose **Add SSH key**, paste the contents of your
   public key file (`~/.ssh/id_ed25519.pub` or `~/.ssh/id_rsa.pub`), and
   select it.

9. Under **Firewalls**, choose **Create firewall** and add three inbound
   rules: TCP port **22**, TCP port **80**, and TCP port **443**, each from
   **Any IPv4** and **Any IPv6**. Hetzner leaves outbound traffic open.


10. Name the server `luma` and choose **Create & Buy now**.

    You see: the server's page with a **Public IP** such as `203.0.113.10`.
    Write it down; the guide calls it `SERVER_IP`.

### Alternatives

- **Linode / Akamai** (about 5 dollars a month): create a Linode, choose the
  **Ubuntu 24.04 LTS** image, the smallest shared plan, add your SSH key, and
  attach a **Cloud Firewall** that allows inbound TCP 22, 80, and 443.
- **DigitalOcean** (about 12 dollars a month for 2 GB): create a Droplet,
  choose the plain **Ubuntu 24.04** image (not a Marketplace image), the
  basic plan, add your SSH key, and under **Networking → Firewalls** allow
  inbound TCP 22, 80, and 443.
- **Advanced: Oracle Cloud Free Tier.** Its always-free Arm shape runs Luma at
  no cost, but its network setup (security lists plus the instance's own
  iptables rules) trips up most first-time installs, and capacity is often
  unavailable. Use it only if you are comfortable debugging Linux firewalls.

> **If the plan you chose has no public IPv4** (some providers sell IPv6-only
> plans), add one. Luma's Pin edge needs a public IPv4; a home connection
> behind carrier-grade NAT cannot host it.

## Part B: Sign in to the server

1. On your computer, open a terminal and connect, replacing `SERVER_IP`:

   ```sh
   ssh root@SERVER_IP
   ```

   You see: a question ending in `Are you sure you want to continue connecting
   (yes/no/[fingerprint])?`.

2. Type `yes` and press Enter.

   You see: an Ubuntu welcome text and a prompt ending in `#`.

> **If you see `Permission denied (publickey)`:** the server was created
> without your SSH key. On Hetzner, open the server's **Rescue** tab, choose
> **Reset root password**, sign in with that password once, then add your key
> to `~/.ssh/authorized_keys`.

Hetzner signs you in as `root`; that is fine for Luma's installer. On
providers that give you a normal user with `sudo`, sign in as that user. Never
run the installer with `sudo` in front of it: it asks for `sudo` itself when
it needs it.

Keep this terminal open; every later command in Parts E to G runs here.

## Part C: Point a domain at the server

Center needs a name people (and Let's Encrypt) can reach over HTTPS, such as
`center.example.com`. Choose one path.

### Path 1: A free DuckDNS name

1. Open <https://www.duckdns.org> and sign in with one of the offered accounts.

2. Under **domains**, type a name (for example `mylumapin`) and choose
   **add domain**.

3. Optional: in the new row, put `SERVER_IP` in the **current ip** box and
   choose **update ip**. Or let setup set it: keep the **token** shown at the
   top of the page ready, and answer `duckdns` at the first prompt of Part F.

   You see: the row shows your IP (or, with setup, it will after Part F).
   Your domain is `mylumapin.duckdns.org`; the guide calls it `YOUR_DOMAIN`.


Let's Encrypt issues certificates for DuckDNS names, so Luma works with one.

### Path 2: A domain you own (Porkbun, Namecheap, or another registrar)

1. Buy a domain at <https://porkbun.com> or <https://www.namecheap.com>
   (typically 10 to 15 euros a year).

2. Open the domain's **DNS** settings.

3. Add one record: type **A**, host `center` (which makes
   `center.yourdomain.com`; use `@` to use the bare domain), answer
   `SERVER_IP`, default TTL.

   You see: the A record listed. Your domain is `center.yourdomain.com`; the
   guide calls it `YOUR_DOMAIN`.


> **If your DNS is on Cloudflare:** set the record to **DNS only** (grey cloud),
> never **Proxied** (orange cloud), and do not use a Cloudflare Tunnel. The Pin
> connects to your server's IPv4 directly, and Luma obtains its own
> certificate, so nothing may sit in front of the server. Tailscale Funnel
> and ngrok do not work either, for the same reason.

DNS changes take a few minutes to spread. `./luma doctor production` in Part F
tells you when the name resolves.

## Part D: Get the release files

Luma's repository, releases, and images are public, so you need no GitHub
account, invitation, or token.

1. Open <https://github.com/TheAndersMadsen/luma/releases/latest>.

2. Download the release's five files, the operator archive
   `luma-operator-VERSION-linux.tar.gz`, the Pin archive
   `luma-pin-PIN_VERSION.tar.gz`, the descriptor `luma-VERSION.release.json`,
   `SHA256SUMS`, and `SHA256SUMS.sigstore.json`, into one folder on your
   computer.

   (Or skip this part and use the one-line installer below, which downloads
   and verifies them for you.)

### Get the release files

Put the five files in one folder named after the release, for example
`luma-0.3.16` for release 0.3.16 (the version in the `.release.json` file
name). The maintainer may also hand you that folder ready-made:

- `luma-operator-0.3.16-linux.tar.gz` (the operator archive)
- `luma-pin-PIN_VERSION.tar.gz` (the Pin archive)
- `luma-0.3.16.release.json` (the release descriptor)
- `SHA256SUMS`
- `SHA256SUMS.sigstore.json` (the maintainer's cosign signature over
  `SHA256SUMS`)

If you have [cosign](https://github.com/sigstore/cosign), the signature
proves the files are the maintainer's (step 4 of Part E). Without it, compare
the checksum of `SHA256SUMS` with a value the maintainer gives you through a
second channel (a message), or use the one-line installer, which checks the
signature for you.

## Part E: Install Luma

There are two ways to get the release onto the server. Read both, then pick.

- **The one-line installer** downloads the latest GitHub release by itself and
  installs it only when its `SHA256SUMS` carries the maintainer's signature,
  which it verifies with the public key built into the script. A release
  published without one makes it stop at its
  **Authenticate the latest stable release** stage and install nothing from
  it, so it only prepares the server.
- **The five release files** from Part D always work.

### Install from the five release files

1. On your **own computer**, in a new terminal, copy the release folder to the
   server (replace `0.3.16` with your release's version, and `root` with your
   user if you are not root):

   ```sh
   scp -r luma-0.3.16 root@SERVER_IP:
   ```

   You see: five file names with progress bars reaching 100%.

2. Back in the **server** terminal, enter the folder and check the files:

   ```sh
   cd ~/luma-0.3.16
   sha256sum --check SHA256SUMS
   ```

   You see: one `OK` per file, for example
   `luma-operator-0.3.16-linux.tar.gz: OK`.

> **If any line says `FAILED` or a file is missing:** the copy is damaged. Run
> the `scp` command again. Never continue from files that fail the check.

3. Unpack the operator archive and enter it:

   ```sh
   tar -xzf luma-operator-*-linux.tar.gz
   cd luma-operator-*/
   ```

   You see: the prompt now ends in `luma-operator-0.3.16#`.

4. Check that the maintainer signed the checksums. Optional, with `cosign`
   installed; the public key is inside the operator folder you just entered:

   ```sh
   cosign verify-blob --key platform/distribution/release-signing.pub \
     --bundle ../SHA256SUMS.sigstore.json --insecure-ignore-tlog ../SHA256SUMS
   ```

   You see: `Verified OK`. Without cosign, compare the checksum of the
   checksum file with a value the maintainer sent you:

   ```sh
   sha256sum ../SHA256SUMS
   ```

   You see: a 64-character value. It must match the maintainer's message
   exactly.

5. Install the two tools the server needs (Bun and Docker):

   ```sh
   bash ./bootstrap --tools-only
   ```

   You see: a screen titled **Luma · prepare this server**, then
   `Ready to start?`. Press Enter. It asks
   `Install the pinned Bun 1.4.2 runtime under /usr/local?` and
   `Install or upgrade Docker Engine and Compose from Docker's official
   repository?`; answer `y` to both. It ends with `Bun and Docker are ready.`
   and `Continue with ./luma onboard production. (A private fork first runs
   ./luma registry login.)`

> **If it also printed `Reconnect over SSH so this session picks up Docker
> group membership.`:** type `exit`, run the `ssh` command from Part B again,
> and `cd ~/luma-0.3.16/luma-operator-*/` before continuing.

6. Skip the registry login. Luma's images are public, so Docker pulls them
   with no sign-in.

> **Private fork?** Only then do you need
> `./luma registry login --username YOUR_GITHUB_USER`, pasting a token with
> `read:packages` at Docker's `Password:` prompt (nothing is shown while you
> paste). If it says `denied` or `unauthorized`, the token is missing
> `read:packages` or lacks access to the fork's packages.

7. Continue to [Part F](#part-f-configure-and-deploy-with-onboard-production).

### Install with the one-line installer

Use this path when the newest GitHub release is signed. `YOUR-CENTER` is the
address of a Luma Center that already exists (the maintainer's, for
example); every Center serves the installer at `/install.sh`.

1. Read the script before running it:

   ```sh
   curl -fsSL https://YOUR-CENTER/install.sh | less
   ```

   Press `q` to leave.

2. Run it:

   ```sh
   bash <(curl -fsSL https://YOUR-CENTER/install.sh)
   ```

   You see: **Luma · install the latest signed release on this server**, five
   stages: **Host and prerequisites** (installs Bun and Docker, asking first),
   **Release access** (installs the public release with no token),
   **Authenticate the latest stable release**, **Container registry access**
   (public images, so no GHCR login), and **Configure, deploy, and open Guided
   Setup**, which runs the same `onboard production` walkthrough as Part F.
   The Center you fetched the installer from becomes your server's update
   source.

> **If it stops at "Authenticate the latest stable release" saying the release
> was published without the maintainer's signature:** the installer cannot
> authenticate that release. Bun and Docker are installed; follow the
> five-file path above from step 1 (step 5 finds both tools already there).

### Install by pasting into Hetzner (no SSH)

Use this path to skip Part B entirely: the server sets itself up on first
boot.

1. On your computer, open `https://YOUR-CENTER/cloud-init.yaml` and save it
   as `luma-cloud-init.yaml`.
   You see: a file starting with `#cloud-config`.
2. Fill in every `REPLACE_ME` value: `LUMA_DOMAIN` (your own name from
   Part C), or leave it empty and set `LUMA_DUCKDNS_SUBDOMAIN=mylumapin`;
   `LUMA_ACME_EMAIL`; `LUMA_OPERATOR_EMAIL`; and the DuckDNS token in place of
   `REPLACE_ME_DUCKDNS_TOKEN` (only for a DuckDNS name; otherwise leave it,
   the server removes it unread). Leave `LUMA_AUTO_UPDATES=on` to let the
   server install newer releases by itself at night, or set it to `off` to
   install them yourself ([Update Luma](update.md)). The server asks the
   Center you downloaded the file from for updates; add a line
   `LUMA_UPDATE_SOURCE=https://CENTER` to ask another.
3. In Hetzner Cloud, choose **Add server**: Ubuntu 24.04, a plan with a
   public IPv4, your firewall from Part A, and paste the whole file into
   **Cloud config**. Create the server.
4. Wait about 15 minutes, then open `https://YOUR-DOMAIN/login`.
   You see: the Center sign-in page.
5. For the password, sign in once as root (Part B) and run
   `cat /root/.config/luma/production/first-login.txt`; delete the file after
   signing in.

> **If the page does not load after 20 minutes:** sign in as root and read
> `/var/log/luma-install.log`. It shows the whole run; if it ends with
> **Setup stopped**, follow its `Safe retry:` line.

## Part F: Configure and deploy with `onboard production`

One command runs setup, the checks, a dry run, the deploy, and verification,
asking you before each thing that changes the server.

1. From the operator folder, start it, pointing at the Pin archive that came
   with the release:

   ```sh
   ./luma onboard production --pin-release-archive ../luma-pin-*.tar.gz
   ```

   You see: `[1/5] Configure this production server`, then
   `Luma guided production setup` and
   `This prepares the server only. It does not deploy or change a Pin.`

2. Answer the prompts. Press Enter to accept a value shown in
   `[brackets]`.

   | Prompt | Type |
   | --- | --- |
   | `[1/6] Public Center domain (blank or "duckdns" for a free DuckDNS name):` | `YOUR_DOMAIN` from Part C, for example `center.yourdomain.com`. For a DuckDNS name whose record you did not set by hand, type `duckdns`: it then asks `DuckDNS subdomain (NAME in NAME.duckdns.org):` (type `mylumapin`), `Server public IPv4 for mylumapin.duckdns.org [SERVER_IP]:` (press Enter), and `DuckDNS token (not shown, not stored):` (paste the token from the DuckDNS page), and prints `mylumapin.duckdns.org now points at SERVER_IP.` |
   | `[2/6] TLS certificate email:` | Your email. Let's Encrypt sends certificate notices here. |
   | `[3/6] First Center owner email:` | Your email again. This becomes your Center sign-in. |
   | `[4/6] Features (pin, search, spotify, observability; or none) [pin,search,spotify]:` | Press Enter. `pin` is the Pin's connection, `search` is built-in web search, `spotify` is music. |
   | `[5/6] Server public IPv4 for the Pin [SERVER_IP]:` | Press Enter. Setup detected the address; type `SERVER_IP` if no default is shown. |
   | `Where should this server check for updates? [https://...]:` | Press Enter. The address shown is the Luma Center this server asks for newer releases (its [update source](glossary.md)). |
   | `Install updates automatically at night? [Y/n]:` | Press Enter for yes: the server installs newer releases by itself between 03:00 and 05:00, with a backup first and the old release put back if anything fails ([Update Luma](update.md)). Type `n` to install them yourself. |
   | `[6/6] Review` | Read the summary (`Center: https://...`, `Certificate email`, `First owner`, `Features`, `Pin address`, `Updates: from https://..., installed automatically at night`). At `Write this production configuration? [y/N]:` type `y`. |

   No physical Pin is needed for any server step. Keep the default features
   to prepare for your one Pin later. If you want Center alone for now, enter
   `search` or `none` at Features: the Pin address and archive questions are
   skipped, and an archive passed on the command line is not read. You can
   sign in, use notes and account settings, and configure services before
   connecting the Pin. To add it later, rerun `./luma onboard production`,
   choose `pin,search,spotify`, and finish the Pin address and archive prompts.
   See [starting without a Pin](../docs/install.md#choosing-your-server-domain-and-providers).

   You see: `Production configuration is ready for https://YOUR_DOMAIN
   (optional profiles: pin, search, spotify).`, then
   `First sign-in: /root/.config/luma/production/first-login.txt (delete it
   after you sign in).`, `Generated Pin trust root: ...`, two update lines,
   `Updates: this server asks https://... for newer releases.` and
   `Automatic updates are on: ...`, and finally
   `After deployment: https://YOUR_DOMAIN/login?next=%2Fsettings%2Fpin%2Fsetup`.
   From the five release files, the second update line says the timers start
   once the server runs a release in `~/.local/share/luma/operators`; that is
   expected, and they arrive with the server's first update.

> **If a prompt says `Enter a public DNS name such as center.example.com, or
> "duckdns" for a free one.` or `Enter a valid email address.`:** the value
> was mistyped; it asks again.
> **If it says `DuckDNS refused to point ... the token is wrong or ... is not
> one of your DuckDNS domains`:** sign in at <https://www.duckdns.org>, add
> the subdomain if it is missing, copy the token at the top of the page, and
> run the command again.
> **If it prints `Could not detect this server's public IPv4: ...`:** the
> IPv4 prompts show no default; type `SERVER_IP` at them.
> A mistyped domain or owner email can still be fixed after this step by
> rerunning `./luma setup production --guided`, but only until the deploy in
> step 4.

3. Wait for the checks.

   You see: `[2/5] Check host, release, and configuration` and
   `[3/5] Prove the deployment plan without changing production`, each
   followed by its output. Nothing on the server changes yet.

> **If it stops with `Onboarding stopped during stage 2/5 (preflight)`:** read
> the `Reason:` line. The common ones are the domain not resolving yet (wait
> for DNS, see [troubleshooting](troubleshooting.md#domain-dns-and-certificates))
> and `Docker could not read this release's application from ghcr.io` (check
> the server's network; only a private fork needs the registry login of step 6
> in Part E). Then run the `Safe retry:` command it printed.

4. Confirm the deploy.

   You see: `[4/5] Deploy the verified release` and
   `Deploy this verified release now? [y/N]`. Type `y`.

   You see: Docker pulling the release's images (a few minutes on first
   run), the containers starting, then
   `Luma release ... is deployed and passed production verification.`

5. Wait for the final verification.

   You see: `[5/5] Verify production and hand off to Center`, a line starting
   `Verified healthy services, Center identity and public discovery, ...,
   plus the configured Pin certificate chain.`, then
   `Setup complete: https://YOUR_DOMAIN/login?next=%2Fsettings%2Fpin%2Fsetup`
   and `Finish provider setup and the stock Pin installation in Center.`

> **If verification prints `fetch failed`:** the next line names the cause:
> DNS not pointing here yet, ports 80 and 443 closed in the provider's
> firewall, or Let's Encrypt still issuing the certificate. Fix it, then run
> `./luma verify production`. The deploy is already done.

6. Prove it once more, and keep this command for later:

   ```sh
   ./luma verify production
   ```

   You see: the same `Verified healthy services, ...` line. In a browser,
   `https://YOUR_DOMAIN/api/version` shows the release you installed and
   `"environment":"production"`.

## Part G: Sign in for the first time

1. Show your first sign-in once:

   ```sh
   cat ~/.config/luma/production/first-login.txt
   ```

   You see four lines: `Center: https://YOUR_DOMAIN`,
   `Guided setup: https://YOUR_DOMAIN/login?next=%2Fsettings%2Fpin%2Fsetup`,
   `Operator: YOUR_EMAIL`, and `Initial password: ...`.

2. In a browser on your computer, open the `Center:` address and sign in with
   the operator email and the initial password.

   You see: Center's home page.


3. Open **Settings → Passcode & password** and change the password to one of
   your own.

4. Back on the server, delete the file:

   ```sh
   rm ~/.config/luma/production/first-login.txt
   ```

   The initial password also remains as the seed in
   `~/.config/luma/production/realm.json` and in every backup, which is why
   step 3 matters.

## Part H: Connect the providers

The Pin cannot answer until an assistant and a voice are configured. Open
**Settings → Assistant & voice** in Center.


1. Under **Assistant**, choose **OpenAI-compatible API**.

2. Fill in **API base URL** (for OpenRouter, `https://openrouter.ai/api/v1`;
   for OpenAI, `https://api.openai.com/v1`), **API key** (from your provider's
   dashboard), and **Model** (the provider's exact model identifier, as shown
   in its model list).

3. Choose **Test**.

   You see: **Working** beside the button. A **Test** also saves pending
   changes.

4. Under **Voice**, fill in **Azure Speech key** and **Azure region** (for
   example `westeurope`), both from the Speech resource's **Keys and
   Endpoint** page in the Azure portal, and pick an **Azure voice**.

5. Choose **Test**, then **Save changes**.

   You see: both required services, **Assistant** and **Speech**, show
   **Ready**; nothing shows **Needs setup**.

6. Optional services, whenever you like, on the same page: **SearXNG** is
   already there if you kept the `search` feature; otherwise **SerpAPI**. Add
   **Google Maps** (in Google Cloud, enable **Places API (New)**, **Geocoding
   API**, and **Routes API** for the key), **Pirate Weather**, **Wolfram**,
   **Perplexity**, and **Open Food Facts** for places, weather, facts, and
   food logging. **Settings → Music** links Spotify, YouTube Music, and TIDAL.
   **OS3 (Rabbit)** is off by default.

Secret fields are never shown again after saving; a configured field says so.
Leave it blank to keep the value or choose **Remove** to clear it.

Your server is done. Next: [Connect your Pin](connect-your-pin.md).

## What it costs per month

The software is free. Roughly, at the time of writing (check each provider's
current prices):

| Item | Typical cost |
| --- | --- |
| Server (Hetzner CX or CAX) | about 4 to 5 euros |
| Domain | free with DuckDNS, or about 1 euro a month for your own |
| Assistant (OpenRouter or OpenAI, pay per use) | a few euros for everyday use; depends on the model |
| Azure Speech | free tier covers light personal use; pay per hour of audio beyond it |
| Optional: Google Maps, Pirate Weather, Wolfram, Perplexity, SerpAPI | each has a free tier or small pay-per-use cost |

Budget about 10 euros a month for a Pin used every day.
