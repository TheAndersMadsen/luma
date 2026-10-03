# Set up a Luma server from nothing

This guide starts with no server at all. At the end you have a running Luma
that passes `./luma verify production`, you have signed in once, and the
assistant and voice providers are connected. The reference pages behind it
are [Install Luma on a server](../docs/install.md) and
[Configure services in Center](../docs/services.md). Unfamiliar words are in
the [glossary](glossary.md).

What you need:

- [ ] A computer with a terminal (macOS Terminal, Windows Terminal with
      PowerShell, or any Linux terminal) and an SSH key. If you have never
      made one, run `ssh-keygen` once and accept the defaults.
- [ ] A credit or debit card for the server (about 4 to 5 euros a month).
- [ ] One Luma release: the five files of the latest GitHub release (see
      [Get the release files](#get-the-release-files)).
- [ ] Accounts with two providers, so the Pin can answer. The first is an
      OpenAI-compatible assistant: an [OpenRouter](https://openrouter.ai) or
      [OpenAI](https://platform.openai.com) API key and a model ID. The
      second is [Azure Speech](https://portal.azure.com): a key and a region.
      Everything else is optional.

You don't need a GitHub account. Luma's repository, releases, and images are
public, so installing and updating need no invitation or token.

Plan on about 1.5 hours, plus waiting for DNS. Nothing here needs the Pin.
That comes in the next guide, [Connect your Pin](connect-your-pin.md).

You make three choices along the way:

1. [Which server provider](#part-a-get-a-server) to use. Hetzner is
   recommended.
2. [A free DuckDNS name or your own domain](#part-c-point-a-domain-at-the-server).
3. [The one-line installer or the five release files](#part-e-install-luma).

## Part A: Get a server

Luma needs a fresh 64-bit Ubuntu 24.04 server, `amd64` or `arm64`. It must
have a public IPv4 address, ports 80 and 443 reachable from the internet, and
at least 8 GiB of free disk. Any provider that sells that works. The steps
below use Hetzner Cloud because it is cheap and simple. Other providers
follow.

### Hetzner Cloud (recommended)

1. Create an account at <https://console.hetzner.cloud> and add a payment
   method.

   You see: the Cloud Console with an empty project list.

2. Choose **New project**, name it `luma`, and open it.

3. Choose **Add Server**.

4. Under **Location**, pick the one nearest you.

5. Under **Image**, choose **Ubuntu 24.04**. Don't pick an "app" image such
   as Docker. Luma installs its own Docker.

6. Under **Type**, choose **Shared vCPU**. Pick the cheapest **x86 (CX)**
   plan (about 4 euros a month) or the cheapest **Arm64 (CAX)** plan (about
   4.49 euros a month). Both work, because Luma publishes images for both.

7. Under **Networking**, keep **Public IPv4** ticked. The Pin needs it.

8. Under **SSH keys**, choose **Add SSH key**, paste the contents of your
   public key file (`~/.ssh/id_ed25519.pub` or `~/.ssh/id_rsa.pub`), and
   select it.

9. Under **Firewalls**, choose **Create firewall** and add three inbound
   rules: TCP port **22**, TCP port **80**, and TCP port **443**, each from
   **Any IPv4** and **Any IPv6**. Hetzner leaves outbound traffic open.

10. Name the server `luma` and choose **Create & Buy now**.

    You see: the server's page with a **Public IP** such as `203.0.113.10`.
    Write it down. The rest of this guide calls it `SERVER_IP`.

### Alternatives

- Linode / Akamai (about 5 dollars a month): create a Linode with the
  **Ubuntu 24.04 LTS** image and the smallest shared plan. Add your SSH key
  and attach a **Cloud Firewall** that allows inbound TCP 22, 80, and 443.
- DigitalOcean (about 12 dollars a month for 2 GB): create a Droplet with
  the plain **Ubuntu 24.04** image (not a Marketplace image) and the basic
  plan. Add your SSH key, and under **Networking → Firewalls** allow inbound
  TCP 22, 80, and 443.
- Oracle Cloud Free Tier, for advanced users only. Its always-free Arm shape
  runs Luma at no cost. But its network setup (security lists plus the
  instance's own iptables rules) trips up most first-time installs, and
  capacity is often unavailable. Use it only if you are comfortable debugging
  Linux firewalls.

> [!IMPORTANT]
> If the plan you chose has no public IPv4, add one. Some providers sell
> IPv6-only plans. Luma's Pin edge needs a public IPv4, and a home connection
> behind carrier-grade NAT cannot host it.

## Part B: Sign in to the server

1. On your computer, open a terminal and connect. Replace `SERVER_IP` with
   your server's address:

   ```sh
   ssh root@SERVER_IP
   ```

   You see: a question ending in `Are you sure you want to continue connecting
   (yes/no/[fingerprint])?`.

2. Type `yes` and press Enter.

   You see: an Ubuntu welcome text and a prompt ending in `#`.

<details>
<summary>If you see <code>Permission denied (publickey)</code></summary>

The server was created without your SSH key. On Hetzner, open the server's
**Rescue** tab and choose **Reset root password**. Sign in with that password
once, then add your key to `~/.ssh/authorized_keys`.

</details>

Hetzner signs you in as `root`, and that is fine for Luma's installer. Some
providers give you a normal user with `sudo` instead. In that case, sign in
as that user. Never put `sudo` in front of the installer. It asks for `sudo`
itself when it needs it.

Keep this terminal open. Every later command in Parts E to G runs here.

## Part C: Point a domain at the server

Center needs a name that people (and Let's Encrypt) can reach over HTTPS,
such as `center.example.com`. Choose one of the two paths.

### Path 1: A free DuckDNS name

1. Open <https://www.duckdns.org> and sign in with one of the offered accounts.

2. Under **domains**, type a name (for example `mylumapin`) and choose
   **add domain**.

3. Optional: in the new row, put `SERVER_IP` in the **current ip** box and
   choose **update ip**. You can also let setup do this for you. In that
   case, keep the **token** shown at the top of the page ready, and answer
   `duckdns` at the first prompt of Part F.

   You see: the row shows your IP. If you left it to setup, it shows the IP
   after Part F. Your domain is `mylumapin.duckdns.org`. The rest of this
   guide calls it `YOUR_DOMAIN`.

Let's Encrypt issues certificates for DuckDNS names, so Luma works with one.

### Path 2: A domain you own (Porkbun, Namecheap, or another registrar)

1. Buy a domain at <https://porkbun.com> or <https://www.namecheap.com>. It
   typically costs 10 to 15 euros a year.

2. Open the domain's **DNS** settings.

3. Add one record of type **A**. Set the host to `center`, which makes
   `center.yourdomain.com` (use `@` for the bare domain). Set the answer to
   `SERVER_IP` and keep the default TTL.

   You see: the A record in the list. Your domain is
   `center.yourdomain.com`. The rest of this guide calls it `YOUR_DOMAIN`.

> [!WARNING]
> If your DNS is on Cloudflare, set the record to **DNS only** (grey cloud),
> never **Proxied** (orange cloud), and don't use a Cloudflare Tunnel. The Pin
> connects to your server's IPv4 directly, and Luma gets its own
> certificate, so nothing may sit in front of the server. Tailscale Funnel
> and ngrok don't work either, for the same reason.

DNS changes take a few minutes to spread. `./luma doctor production` in Part F
tells you when the name resolves.

## Part D: Get the release files

You need no GitHub account, invitation, or token for this. Luma's repository,
releases, and images are public.

The simplest way is to download the release straight onto the server. In the
server terminal from Part B, run:

```sh
mkdir -p ~/luma && cd ~/luma
curl -fsSL https://api.github.com/repos/TheAndersMadsen/luma/releases/latest \
  | grep browser_download_url | cut -d '"' -f 4 | xargs -n 1 curl -fsSLO
```

You see: the prompt again, with no errors. `ls` now lists the five files.
With this download, the release folder is `~/luma`. Use it wherever Parts E
and F say `~/luma-0.3.16`, and skip Part E's `scp` step.

To download the files to your computer instead:

1. Open <https://github.com/TheAndersMadsen/luma/releases/latest>.

2. Download the release's five files into one folder on your computer:
   - the operator archive `luma-operator-VERSION-linux.tar.gz`
   - the Pin archive `luma-pin-PIN_VERSION.tar.gz`
   - the descriptor `luma-VERSION.release.json`
   - `SHA256SUMS`
   - `SHA256SUMS.sigstore.json`

You can also skip this part and use the one-line installer in Part E, which
downloads and verifies the files for you.

### Get the release files

If you downloaded to your computer, put the five files in one folder named
after the release. For release 0.3.16 (the version in the `.release.json`
file name), that is `luma-0.3.16`. The maintainer may also hand you this
folder ready-made:

- `luma-operator-0.3.16-linux.tar.gz` (the operator archive)
- `luma-pin-PIN_VERSION.tar.gz` (the Pin archive)
- `luma-0.3.16.release.json` (the release descriptor)
- `SHA256SUMS`
- `SHA256SUMS.sigstore.json` (the maintainer's cosign signature over
  `SHA256SUMS`)

If you have [cosign](https://github.com/sigstore/cosign), the signature
proves the files are the maintainer's (step 4 of Part E). Without it, you
have two options. Compare the checksum of `SHA256SUMS` with a value the
maintainer gives you through a second channel, such as a message. Or use the
one-line installer, which checks the signature for you.

## Part E: Install Luma

There are two ways to get the release onto the server. Read both, then pick
one.

- The one-line installer downloads the latest GitHub release by itself. It
  installs the release only when its `SHA256SUMS` carries the maintainer's
  signature, which it checks with the public key built into the script. If a
  release was published without one, the installer stops at its
  **Authenticate the latest stable release** stage and installs nothing from
  it. In that case it only prepares the server.
- The five release files from Part D always work.

### Install from the five release files

1. On your own computer, in a new terminal, copy the release folder to the
   server. Replace `0.3.16` with your release's version, and `root` with your
   user if you are not root:

   ```sh
   scp -r luma-0.3.16 root@SERVER_IP:
   ```

   You see: five file names with progress bars reaching 100%.

   Skip this step if you downloaded the release straight onto the server.

2. Back in the server terminal, enter the folder and check the files:

   ```sh
   cd ~/luma-0.3.16
   sha256sum --check SHA256SUMS
   ```

   You see: one `OK` per file, for example
   `luma-operator-0.3.16-linux.tar.gz: OK`.

   **If any line says `FAILED` or a file is missing**, the copy is damaged.
   Run the `scp` command (or the download) again. Never continue from files
   that fail the check.

3. Unpack the operator archive into Luma's own folder and enter it.
   Automatic updates only start for a release that lives there:

   ```sh
   install -d -m 0700 ~/.local/share/luma ~/.local/share/luma/operators ~/.local/share/luma/build
   tar -xzf luma-operator-*-linux.tar.gz -C ~/.local/share/luma/operators
   cd ~/.local/share/luma/operators/luma-operator-*/
   ```

   You see: the prompt now ends in `luma-operator-0.3.16#`. Keep the release
   folder from step 2: setup reads the Pin archive from it.

4. Optional: check that the maintainer signed the checksums. This needs
   `cosign` installed. The public key is inside the operator folder you just
   entered:

   ```sh
   cosign verify-blob --key platform/distribution/release-signing.pub \
     --bundle ~/luma-0.3.16/SHA256SUMS.sigstore.json --insecure-ignore-tlog ~/luma-0.3.16/SHA256SUMS
   ```

   You see: `Verified OK`.

   Without cosign, compare the checksum of the checksum file with a value the
   maintainer sent you:

   ```sh
   sha256sum ~/luma-0.3.16/SHA256SUMS
   ```

   You see: a 64-character value. It must match the maintainer's message
   exactly.

5. Install the two tools the server needs, Bun and Docker:

   ```sh
   bash ./bootstrap --tools-only
   ```

   You see: a screen titled **Luma · prepare this server**, then
   `Ready to start?`. Press Enter. It asks
   `Install the pinned Bun 1.4.2 runtime under /usr/local?` and
   `Install or upgrade Docker Engine and Compose from Docker's official
   repository?`. Answer `y` to both. It ends with `Bun and Docker are ready.`
   and `Continue with ./luma onboard production. (A private fork first runs
   ./luma registry login.)`

   **If it also printed `Reconnect over SSH so this session picks up Docker
   group membership.`**, type `exit` and run the `ssh` command from Part B
   again. Then run `cd ~/.local/share/luma/operators/luma-operator-*/`
   before you continue.

6. Skip the registry login. Luma's images are public, so Docker pulls them
   with no sign-in.

   <details>
   <summary>Only for a private fork</summary>

   Run `./luma registry login --username YOUR_GITHUB_USER` and paste a token
   with `read:packages` at Docker's `Password:` prompt. Nothing is shown
   while you paste. If it says `denied` or `unauthorized`, the token is
   missing `read:packages` or has no access to the fork's packages.

   </details>

7. Continue to [Part F](#part-f-configure-and-deploy-with-onboard-production).

### Install with the one-line installer

Use this path when the newest GitHub release is signed. `YOUR-CENTER` is the
address of a Luma Center that already exists, such as the maintainer's. Every
Center serves the installer at `/install.sh`.

1. Read the script before you run it:

   ```sh
   curl -fsSL https://YOUR-CENTER/install.sh | less
   ```

   Press `q` to leave.

2. Run it:

   ```sh
   bash <(curl -fsSL https://YOUR-CENTER/install.sh)
   ```

   You see: **Luma · install the latest signed release on this server**,
   followed by five stages:

   1. **Host and prerequisites** installs Bun and Docker, asking first.
   2. **Release access** installs the public release with no token.
   3. **Authenticate the latest stable release**.
   4. **Container registry access** needs no GHCR login, because the images
      are public.
   5. **Configure, deploy, and open Guided Setup** runs the same
      `onboard production` walkthrough as Part F. With the `pin` feature it
      also asks for `Path to this release's Pin archive`. Press Enter, and setup downloads
      the Pin archive from GitHub.

   When it is done, the screen clears and shows `✓ Setup complete`. Continue
   with [Part G](#part-g-sign-in-for-the-first-time).

   The Center you fetched the installer from becomes your server's update
   source.

   **If it stops at "Authenticate the latest stable release"** and says the
   release was published without the maintainer's signature, the installer
   cannot authenticate that release. Bun and Docker are installed by then.
   Follow the five-file path above from step 1. Step 5 finds both tools
   already there.

### Install by pasting into Hetzner (no SSH)

With this path you skip Part B entirely. The server sets itself up the first
time it starts.

1. On your computer, open `https://YOUR-CENTER/cloud-init.yaml` and save it
   as `luma-cloud-init.yaml`.

   You see: a file starting with `#cloud-config`.

2. Fill in every `REPLACE_ME` value:
   - `LUMA_DOMAIN`: your own name from Part C. Or leave it empty and set
     `LUMA_DUCKDNS_SUBDOMAIN=mylumapin`.
   - `LUMA_ACME_EMAIL` and `LUMA_OPERATOR_EMAIL`.
   - The DuckDNS token, in place of `REPLACE_ME_DUCKDNS_TOKEN`. This is only
     for a DuckDNS name. Otherwise leave it, and the server removes it
     unread.

   Leave `LUMA_AUTO_UPDATES=on` to let the server install newer releases by
   itself at night. Set it to `off` to install them yourself
   ([Update Luma](update.md)). The server asks the Center you downloaded the
   file from for updates. To ask a different one, add a line
   `LUMA_UPDATE_SOURCE=https://CENTER`.

3. In Hetzner Cloud, choose **Add server**. Pick Ubuntu 24.04, a plan with a
   public IPv4, and your firewall from Part A. Paste the whole file into
   **Cloud config**, then create the server.

4. Wait about 15 minutes, then open `https://YOUR-DOMAIN/login`.

   You see: the Center sign-in page.

5. To get the password, sign in once as root (Part B) and run
   `cat /root/.config/luma/production/first-login.txt`. Delete the file after
   you sign in.

<details>
<summary>If the page does not load after 20 minutes</summary>

Sign in as root and read `/var/log/luma-install.log`. It shows the whole run.
If it ends with **Setup stopped**, follow its `Safe retry:` line.

</details>

## Part F: Configure and deploy with `onboard production`

One command runs setup, the checks, a dry run, the deploy, and verification.
It asks you before each step that changes the server.

1. From the operator folder, start it. Point it at the Pin archive that came
   with the release:

   ```sh
   ./luma onboard production --pin-release-archive ~/luma-0.3.16/luma-pin-*.tar.gz
   ```

   You see: `[1/5] Configure this production server`, then
   `Luma guided production setup` and
   `This prepares the server only. It does not deploy or change a Pin.`

2. Answer the prompts. Press Enter to accept a value shown in
   `[brackets]`.

   | Prompt | Type |
   | --- | --- |
   | `[1/6] Public Center domain (blank or "duckdns" for a free DuckDNS name):` | `YOUR_DOMAIN` from Part C, for example `center.yourdomain.com`. For a DuckDNS name whose record you did not set by hand, type `duckdns`. It then asks `DuckDNS subdomain (NAME in NAME.duckdns.org):` (type `mylumapin`), `Server public IPv4 for mylumapin.duckdns.org [SERVER_IP]:` (press Enter), and `DuckDNS token (not shown, not stored):` (paste the token from the DuckDNS page). It prints `mylumapin.duckdns.org now points at SERVER_IP.` |
   | `[2/6] TLS certificate email:` | Your email. Let's Encrypt sends certificate notices here. |
   | `[3/6] First Center owner email:` | Your email again. This becomes your Center sign-in. |
   | `[4/6] Features (pin, search, spotify, observability; or none) [pin,search,spotify]:` | Press Enter. `pin` is the Pin's connection, `search` is built-in web search, and `spotify` is music. |
   | `[5/6] Server public IPv4 for the Pin [SERVER_IP]:` | Press Enter. Setup found the address. If no default is shown, type `SERVER_IP`. |
   | `Where should this server check for updates? [https://...]:` | Press Enter. The address shown is the Luma Center this server asks for newer releases (its [update source](glossary.md)). |
   | `Install updates automatically at night? [Y/n]:` | Press Enter for yes. The server then installs newer releases by itself between 03:00 and 05:00. It takes a backup first and puts the old release back if anything fails ([Update Luma](update.md)). Type `n` to install them yourself. |
   | `[6/6] Review` | Read the summary (`Center: https://...`, `Certificate email`, `First owner`, `Features`, `Pin address`, `Updates: from https://..., installed automatically at night`). At `Write this production configuration? [y/N]:` type `y`. |

   No server step needs a physical Pin. Keep the default features to prepare
   for your one Pin later.

   If you want Center alone for now, enter `search` or `none` at Features.
   Setup then skips the Pin address and archive questions, and it does not
   read an archive passed on the command line. You can sign in, use notes and
   account settings, and configure services before you connect the Pin. To
   add the Pin later, rerun `./luma onboard production`, choose
   `pin,search,spotify`, and finish the Pin address and archive prompts. See
   [starting without a Pin](../docs/install.md#choosing-your-server-domain-and-providers).

   You see, in order:
   - `Production configuration is ready for https://YOUR_DOMAIN
     (optional profiles: pin, search, spotify).`
   - `First sign-in: /root/.config/luma/production/first-login.txt (delete it
     after you sign in).`
   - `Generated Pin trust root: ...`
   - two update lines, `Updates: this server asks https://... for newer
     releases.` and `Automatic updates are on: ...`
   - `After deployment: https://YOUR_DOMAIN/login?next=%2Fsettings%2Fpin%2Fsetup`

   If you are not root, setup asks for your `sudo` password to install the
   update timers. If it cannot, the second update line says the timers need
   root and lists commands. Run them once as root (`sudo -i`).

   <details>
   <summary>If a prompt rejects your answer</summary>

   - `Enter a public DNS name such as center.example.com, or "duckdns" for a
     free one.` or `Enter a valid email address.` means the value was
     mistyped. It asks again.
   - `DuckDNS refused to point ... the token is wrong or ... is not one of
     your DuckDNS domains` means the token or subdomain is wrong. Sign in at
     <https://www.duckdns.org> and add the subdomain if it is missing. Copy
     the token at the top of the page and run the command again.
   - `Could not detect this server's public IPv4: ...` means the IPv4 prompts
     show no default. Type `SERVER_IP` at them.

   You can still fix a mistyped domain or owner email after this step by
   rerunning `./luma setup production --guided`, but only until the deploy
   in step 4.

   </details>

3. Wait for the checks.

   You see: `[2/5] Check host, release, and configuration` and
   `[3/5] Prove the deployment plan without changing production`, each
   followed by its output. Nothing on the server changes yet.

   **If it stops with `Onboarding stopped during stage 2/5 (preflight)`**,
   read the `Reason:` line. One common reason is that the domain does not
   resolve yet. Wait for DNS (see
   [troubleshooting](troubleshooting.md#domain-dns-and-certificates)).
   Another is `Docker could not read this release's application from ghcr.io`.
   Check the server's network. Only a private fork needs the registry login
   from step 6 in Part E. Then run the `Safe retry:` command it printed.

4. Confirm the deploy.

   You see: `[4/5] Deploy the verified release` and
   `Deploy this verified release now? [y/N]`. Type `y`.

   You see: Docker pulling the release's images (a few minutes on the first
   run), the containers starting, then
   `Luma release ... is deployed and passed production verification.`

5. Wait for the final verification.

   You see: `[5/5] Verify production and hand off to Center`, a line starting
   `Verified healthy services, Center identity and public discovery, ...,
   plus the configured Pin certificate chain.`, then
   `Setup complete: https://YOUR_DOMAIN/login?next=%2Fsettings%2Fpin%2Fsetup`
   and `Finish provider setup and the stock Pin installation in Center.`

   **If verification prints `fetch failed`**, the next line names the cause.
   DNS may not point here yet, ports 80 and 443 may be closed in the
   provider's firewall, or Let's Encrypt may still be issuing the
   certificate. Fix it, then run `./luma verify production`. The deploy is
   already done.

6. Check once more, and keep this command for later:

   ```sh
   ./luma verify production
   ```

   You see: the same `Verified healthy services, ...` line. In a browser,
   `https://YOUR_DOMAIN/api/version` shows the release you installed and
   `"environment":"production"`.

## Part G: Sign in for the first time

1. Show your first sign-in details:

   ```sh
   cat ~/.config/luma/production/first-login.txt
   ```

   You see four lines: `Center: https://YOUR_DOMAIN`,
   `Guided setup: https://YOUR_DOMAIN/login?next=%2Fsettings%2Fpin%2Fsetup`,
   `Operator: YOUR_EMAIL`, and `Initial password: ...`.

2. In a browser on your computer, open the `Center:` address. Sign in with
   the operator email and the initial password.

   You see: Center's home page.

3. Open **Settings → Passcode & password** and change the password to one of
   your own.

4. Back on the server, delete the file:

   ```sh
   rm ~/.config/luma/production/first-login.txt
   ```

   The initial password also stays as the seed in
   `~/.config/luma/production/realm.json` and in every backup. That is why
   step 3 matters.

## Part H: Connect the providers

The Pin cannot answer until an assistant and a voice are set up. In Center,
open **Settings → Assistant & voice**.

1. Under **Assistant**, choose **OpenAI-compatible API**.

2. Fill in three fields:
   - **API base URL**: `https://openrouter.ai/api/v1` for OpenRouter, or
     `https://api.openai.com/v1` for OpenAI.
   - **API key**: from your provider's dashboard.
   - **Model**: the provider's exact model identifier, as shown in its model
     list.

3. Choose **Test**.

   You see: **Working** beside the button. **Test** also saves pending
   changes.

4. Under **Voice**, fill in **Azure Speech key** and **Azure region** (for
   example `westeurope`). Both are on the Speech resource's **Keys and
   Endpoint** page in the Azure portal. Then pick an **Azure voice**.

5. Choose **Test**, then **Save changes**.

   You see: both required services, **Assistant** and **Speech**, show
   **Ready**. Nothing shows **Needs setup**.

6. Optional: add more services on the same page whenever you like.
   **SearXNG** is already there if you kept the `search` feature. Otherwise
   use **SerpAPI**. For places, weather, facts, and food logging, add
   **Google Maps**, **Pirate Weather**, **Wolfram**, **Perplexity**, and
   **Open Food Facts**. For the Google Maps key, enable
   **Places API (New)**, **Geocoding API**, and **Routes API** in Google
   Cloud. **Settings → Music** links Spotify, YouTube Music, and TIDAL.
   **OS3 (Rabbit)** is off by default.

After you save a secret field, Center never shows its value again. The field
says it is configured instead. Leave it blank to keep the value, or choose
**Remove** to clear it.

Your server is ready. Next: [Connect your Pin](connect-your-pin.md).

## What it costs per month

The software is free. These are rough prices at the time of writing. Check
each provider's current prices.

| Item | Typical cost |
| --- | --- |
| Server (Hetzner CX or CAX) | about 4 to 5 euros |
| Domain | free with DuckDNS, or about 1 euro a month for your own |
| Assistant (OpenRouter or OpenAI, pay per use) | a few euros for everyday use, depending on the model |
| Azure Speech | free tier covers light personal use, then pay per hour of audio |
| Optional: Google Maps, Pirate Weather, Wolfram, Perplexity, SerpAPI | each has a free tier or small pay-per-use cost |

Budget about 10 euros a month for a Pin used every day.
