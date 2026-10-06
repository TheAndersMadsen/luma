# Fix a problem with your Luma server or Pin

Find your symptom below and open it to see the cause and the fix. Every fix
here matches the short [troubleshooting reference](../docs/troubleshooting.md),
which stays authoritative. This page adds the hosting and browser problems
people hit while following the guides. Words in **bold** are Center buttons,
pages, or messages. Unfamiliar terms are in the [glossary](glossary.md).

Run every `./luma` command on the server, from the newest release's
`luma-operator-VERSION` folder. If the one-line installer or an update
installed the release, that folder is `~/.local/share/luma/operators/current`.
When in doubt, start with:

```sh
./luma verify production
```

## Installing the release

<details>
<summary><code>sha256sum --check</code> prints <code>FAILED</code> or a missing file</summary>

Cause: the copy to the server is incomplete or damaged.

Fix: copy the release folder again with `scp -r`. Never install from files
that fail the check.

</details>

<details>
<summary><code>Production setup requires 64-bit Ubuntu 24.04. This server reports ...</code></summary>

Cause: the server image is not Ubuntu 24.04.

Fix: rebuild the server with the provider's plain Ubuntu 24.04 image (not a
"Docker" or "app" image).

</details>

<details>
<summary><code>Production setup supports only amd64/x86_64 and arm64/aarch64; this server reports ...</code></summary>

Cause: the server has a 32-bit or other processor that Luma's images do not
support, such as an older Raspberry Pi image.

Fix: use a 64-bit server. Both Intel/AMD (`x86_64`) and Arm (`aarch64`)
plans work, for example Hetzner's CX and CAX plans. This shows what you have:

```sh
uname -m
```

</details>

<details>
<summary><code>At least 8 GiB of free disk space is required ...</code>, or Docker later says <code>no space left on device</code></summary>

Cause: the disk is too small or full. The first check runs before anything
downloads. Docker's message appears when the images fill the disk later.

Fix: choose a bigger plan or free some space. This shows the free space and
what Docker uses:

```sh
df -h /
docker system df
```

Then run this again:

```sh
bash ./bootstrap --tools-only
```

</details>

<details>
<summary><code>Could not get lock /var/lib/dpkg/lock-frontend</code>, then <code>stopped with exit status 100</code></summary>

Cause: Ubuntu installs its own security updates in the background for the
first minutes after a new server starts. While it does, no other program can
install packages.

Fix: wait five to ten minutes, then run the same command again. Finished
steps are kept. To see whether Ubuntu is still busy:

```sh
ps aux | grep -E 'apt|unattended' | grep -v grep
```

</details>

<details>
<summary><code>This account needs sudo access to install host tools.</code> or <code>Sudo access was not granted.</code></summary>

Cause: the user you signed in as cannot use `sudo`, or you typed the wrong
password at the `sudo` prompt.

Fix: sign in as `root`, or as the user your provider created with `sudo`
rights, and run the command again. If you type your own password at the
`[sudo] password` prompt, check it carefully. Nothing shows while you type.

</details>

<details>
<summary><code>bootstrap requires an interactive terminal (LUMA_UNATTENDED=1 runs it without one).</code></summary>

Cause: the installer asks questions, but it was started without a terminal.
This happens when you pipe it into `bash` or run it through `ssh HOST
'command'`.

Fix: sign in over SSH first, then run it at the prompt:

```sh
bash ./bootstrap --tools-only
```

The one-line installer must use the `bash <(curl ...)` form exactly as shown,
not `curl ... | bash`.

</details>

<details>
<summary><code>GitHub could not be reached securely.</code> or <code>GitHub could not confirm repository read access (HTTP 403)</code></summary>

Cause: the server cannot reach `api.github.com`, or GitHub refused the
request. `HTTP 403` without a token usually means GitHub's limit for anonymous
requests: 60 per hour for each address. Many installs from the same network
or repeated retries use it up.

Fix: check that the server reaches GitHub:

```sh
curl -sI https://api.github.com | head -n 1
```

For `HTTP 403`, wait an hour and run the same command again. Or install from
the five release files instead
([Set up a server from nothing](server-from-nothing.md#install-from-the-five-release-files)).

</details>

<details>
<summary><code>run bootstrap as your normal user; it asks for sudo only when needed.</code></summary>

Cause: you ran `sudo bash ./bootstrap`.

Fix: run it without `sudo`. Signing in directly as `root` is fine.

```sh
bash ./bootstrap --tools-only
```

</details>

<details>
<summary><code>/var/log/luma-install.log</code> says <code>still holds a REPLACE_ME value</code> or <code>still holds the template placeholder</code></summary>

Cause: a `REPLACE_ME` value was left in the cloud-init file.

Fix: fill in every `REPLACE_ME` value and create the server again. The
token files were already removed.

</details>

<details>
<summary>You created the server with cloud-init, but Center never loads</summary>

Cause: the install is still running, or it stopped. It takes about 15
minutes, and the server writes every step to `/var/log/luma-install.log`.

Fix: sign in as `root` over SSH and read the end of the log:

```sh
cloud-init status --long
tail -n 40 /var/log/luma-install.log
```

If the log ends with **Setup stopped**, the `What failed:` line names the
problem and the `Safe retry:` line names the way back. Find the `What failed:`
text on this page. If the log ends at the deploy or verify step, the domain,
DNS, or firewall is usually the cause (see
[Domain, DNS, and certificates](#domain-dns-and-certificates)).

</details>

<details>
<summary>The cloud-init log says <code>Set either LUMA_DOMAIN or LUMA_DUCKDNS_SUBDOMAIN, not both.</code> or <code>LUMA_DOMAIN (a DNS name that points at this server) or LUMA_DUCKDNS_SUBDOMAIN (a free DuckDNS name) is required.</code></summary>

Cause: `install.env` in the cloud-init file needs exactly one of the two
names.

Fix: for your own domain, fill `LUMA_DOMAIN` and leave
`LUMA_DUCKDNS_SUBDOMAIN=` empty. For DuckDNS, empty `LUMA_DOMAIN=` and fill
`LUMA_DUCKDNS_SUBDOMAIN` and the DuckDNS token. Then delete the server and
create it again with the corrected file.

</details>

<details>
<summary><code>docker: permission denied while trying to connect to the Docker daemon socket</code></summary>

Cause: the installer added you to Docker's group, but this SSH session
started before that.

Fix: sign out and back in over SSH, then rerun the command. When this
applies, `bash ./bootstrap --tools-only` prints:

```text
Reconnect over SSH so this session picks up Docker group membership.
```

</details>

<details>
<summary><code>Docker is installed, but this user cannot use it yet.</code></summary>

Cause: Docker is not running, or your user is not in Docker's group yet.

Fix: start Docker and check that your user name appears after `docker:`:

```sh
sudo systemctl start docker
getent group docker
```

If your name is missing, run `bash ./bootstrap --tools-only` again, which adds
it. Then sign out, sign back in over SSH, and rerun the command.

</details>

<details>
<summary><code>./luma</code> says <code>Luma requires Bun 1.4.2</code>, or <code>doctor</code> says <code>Docker Compose 2.34.0 or newer is required</code></summary>

Cause: Bun 1.4.2 or Docker Compose 2.34+ is missing.

Fix: run this from the release folder:

```sh
bash ./bootstrap --tools-only
```

If the server already runs Ubuntu's `docker.io`, the installer stops and names
the conflicting package. Use a fresh server, or remove the package after you
check what else uses it.

</details>

<details>
<summary><code>An incompatible Docker package is installed: ...</code></summary>

Cause: Ubuntu's own Docker packages are installed.

Fix: same as the entry above. A fresh server is simplest.

</details>

<details>
<summary>Docker is denied access to <code>ghcr.io</code>, or <code>doctor</code> says <code>Docker could not read this release's application from ghcr.io</code></summary>

Cause: public images pull with no login, so this affects only a private
fork, or a network that blocks `ghcr.io`.

Fix: check your network. For a private fork, run this with a classic token
that has `read:packages`, and paste the token at Docker's `Password:` prompt:

```sh
./luma registry login --username YOUR_GITHUB_USER
```

</details>

<details>
<summary>(Private fork) Docker login worked last month but now fails, and <code>deploy</code> cannot pull images</summary>

Cause: the GitHub token expired. Classic tokens have an expiry you chose
when you created them. Public images are unaffected.

Fix: create a new classic token with the same scopes (`repo` and
`read:packages`) and run this again:

```sh
./luma registry login --username YOUR_GITHUB_USER
```

Docker keeps the new token for later deploys, and Luma saves it for updates.

</details>

<details>
<summary>The one-line installer stops at "Authenticate the latest stable release"</summary>

Cause: the latest GitHub release has no `SHA256SUMS.sigstore.json` from
the maintainer's key (the installer says it `was published without the
maintainer's signature`). Or the installer carries no release signing key, and
it says so.

Fix: Bun and Docker are installed. Continue with the five-file path in
[Set up a server from nothing](server-from-nothing.md#install-from-the-five-release-files).

</details>

<details>
<summary>Setup says the matching Pin release acquisition failed</summary>

Cause: setup found no staged Pin archive and could not download one. Either
the GitHub release has no signed `SHA256SUMS`, or GitHub could not be reached.

Fix: pass the release's Pin archive from the folder you downloaded the
release into (`~/luma` if you followed the README):

```sh
./luma setup production --guided --pin-release-archive ~/luma/luma-pin-*.tar.gz
```

</details>

<details>
<summary><code>Pin release archive does not exist: ...</code></summary>

Cause: no file is at the path you gave to `--pin-release-archive`. If the
path still contains a `*`, nothing matched it. The archive is usually in a
different folder, or it was never downloaded.

Fix: find the archive. It is one of the five release files:

```sh
ls ~/luma/luma-pin-*.tar.gz
```

If `ls` finds nothing, download the release again (README, step 2 of
"Install"). Then rerun with the path `ls` printed:

```sh
./luma onboard production --pin-release-archive ~/luma/luma-pin-VERSION.tar.gz
```

</details>

<details>
<summary><code>setup production with the pin profile must run from an extracted operator release</code></summary>

Cause: you ran `./luma` from a copy of the source code (a `git clone`), not
from an unpacked release. Only a release knows which Pin apps belong to it.

Fix: unpack the operator archive and run `./luma` from its
`luma-operator-VERSION` folder, as in the README's "Install" steps:

```sh
cd ~/.local/share/luma/operators/luma-operator-*/
```

</details>

<details>
<summary><code>--acme-email needs a real address: Let's Encrypt refuses example.com, example.net, and example.org</code></summary>

Cause: the certificate email uses a placeholder domain. Guided setup accepts
it at the prompt, and the check runs after **Write this production
configuration?**.

Fix: run setup again and type an email address you really use. The same
applies to the owner email. Nothing was written.

```sh
./luma onboard production --pin-release-archive ~/luma/luma-pin-*.tar.gz
```

</details>

<details>
<summary><code>this is the Luma ... operator, but this server is configured for ...</code></summary>

Cause: you ran `./luma` from a different release's folder than the one the
server runs. This often happens after an update, from an old terminal tab.

Fix: run it from the folder the server uses:

```sh
cd ~/.local/share/luma/operators/current
```

If you installed from the five release files, `cd` into the newest
`luma-operator-VERSION` folder instead. The message names the next step if you
meant to move the server to this release.

</details>

<details>
<summary>Setup says <code>does not match operator release Pin</code></summary>

Cause: the server already has newer Pin apps than this release.

Fix: use the newest operator release. Setup never moves a server back to
older Pin apps.

</details>

<details>
<summary>Setup refuses to change the domain or owner email</summary>

Cause: the server has already been deployed once, and Keycloak now holds
those values.

Fix: you cannot change the domain or owner of a deployed server. Before the
first `deploy production --confirm`, rerun setup with the right `--domain` or
`--operator-email`.

</details>

<details>
<summary><code>./luma</code> says <code>no production configuration at ...</code></summary>

Cause: one of these:

- Setup has not run yet. `doctor`, `deploy`, and `verify` need it first.
- Setup stopped before it wrote anything.
- You run `./luma` as a different user than the one who ran setup, for
  example with `sudo`. Each user has their own configuration folder.
- You set the server up with `LUMA_CONFIG_DIR` and `LUMA_DATA_DIR`, and this
  shell does not have them.

Fix: run `./luma` as the same user, without `sudo`. If setup never finished,
run onboarding, which does setup first:

```sh
./luma onboard production --pin-release-archive ~/luma/luma-pin-*.tar.gz
```

If you used `LUMA_CONFIG_DIR` and `LUMA_DATA_DIR`, export the same values.
Setup printed the `export` line, so put it in `~/.profile`. To see what this
shell finds, run:

```sh
./luma setup status
```

</details>

## Domain, DNS, and certificates

<details>
<summary>Setup says <code>DuckDNS refused to point NAME.duckdns.org at ...</code> (DuckDNS answered <code>KO</code>)</summary>

Cause: the token is wrong, or the subdomain is not one of your DuckDNS
domains.

Fix:

1. Sign in at <https://www.duckdns.org>.
2. Add the subdomain under **domains** if it is missing.
3. Copy the **token** shown at the top of the page.
4. Rerun setup, either guided or with
   `--duckdns-subdomain NAME --duckdns-token-stdin`.

Nothing was written.

</details>

<details>
<summary>Setup says <code>Could not detect this server's public IPv4: ...</code> (guided) or <code>could not detect this server's public IPv4 ...; pass --public-ip IPV4 instead</code></summary>

Cause: the server's own address and the address the internet sees disagree
(NAT), or the HTTPS echo could not be reached.

Fix: guided setup asks for the address without a default. Type the public
IPv4 that reaches this server. With flags, replace `--public-ip auto` with
`--public-ip IPV4`.

</details>

<details>
<summary>Preflight (<code>doctor</code>) says <code>public DNS name ... does not resolve from this server</code></summary>

Cause: the A record does not exist yet, has a typo, or has not propagated.
DuckDNS names usually work within a minute. A new domain at a registrar can
take up to an hour.

Fix: create or correct the A record at your registrar or DuckDNS. Wait a few
minutes, then rerun:

```sh
./luma doctor production
```

</details>

<details>
<summary><code>verify production</code> prints <code>fetch failed</code> and <code>... does not resolve from this server</code></summary>

Same cause and fix as the entry above.

</details>

<details>
<summary><code>verify production</code> prints <code>fetch failed (TimeoutError: The operation timed out.)</code> or <code>nothing answered at https://...; open ports 80 and 443 in the server provider's firewall</code></summary>

Cause: the provider's firewall blocks the ports, Ubuntu's own firewall
(`ufw`) blocks them, or Traefik is not running.

Fix: open inbound TCP 80 and 443 in the provider's firewall:

- Hetzner: **Firewalls** in the Cloud Console
- DigitalOcean: **Networking → Firewalls**
- Linode/Akamai: **Cloud Firewall**

If `sudo ufw status` says `Status: active`, open them there too:

```sh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

Then rerun:

```sh
./luma verify production
```

</details>

<details>
<summary><code>verify production</code> prints <code>fetch failed</code> and <code>... presented a certificate that is not valid for it yet</code></summary>

Cause: right after the first deploy, Let's Encrypt is still issuing the
certificate. If it stays this way, the domain points at a different address
(an old server, or Cloudflare's proxy), or port 80 is closed. Preflight checks
only that the name resolves, not that it resolves to this server.

Fix: wait a few minutes and rerun `./luma verify production`. A confirmed
deploy already waits up to 120 seconds for the first answer. If it still
fails, compare the two addresses these print. They must be the same:

```sh
dig +short YOUR_DOMAIN
curl -4 -s https://api.ipify.org; echo
```

If they differ, fix the A record (and turn off Cloudflare's orange cloud), wait
a few minutes, and run `./luma verify production` again.

</details>

<details>
<summary>The certificate never appears and Traefik's log mentions <code>invalidContact</code></summary>

Cause: Let's Encrypt refused the certificate email. It accepts only an
address on a real domain that can receive mail.

Fix: rerun setup with a real address, then deploy again:

```sh
./luma setup production --acme-email you@your-real-domain.com
./luma deploy production --confirm
```

Check the Traefik log with:

```sh
docker compose -p luma logs --tail 100 traefik
```

</details>

<details>
<summary>The certificate never appears and Traefik's log mentions <code>too many certificates already issued</code> or <code>rateLimited</code></summary>

Cause: Let's Encrypt's rate limit. Too many certificates were requested for
this name recently. This happens after repeated reinstalls, or on a domain
shared by many hosts, such as a busy DuckDNS name.

Fix: wait. The limit clears within a week. Do not redeploy in a loop. Check
the Traefik log with:

```sh
docker compose -p luma logs --tail 100 traefik
```

</details>

<details>
<summary>The site works in a browser but the Pin never connects, or <code>verify</code> fails on the Pin certificate checks</summary>

Cause: the domain is behind Cloudflare's proxy (orange cloud) or a
Cloudflare Tunnel.

Fix: turn the proxy off (grey cloud, "DNS only") and remove the tunnel. The
Pin reaches your public IPv4 directly, so nothing may sit in between. Tailscale
Funnel and ngrok do not work for the same reason.

</details>

<details>
<summary>The server has no public IPv4 (IPv6-only plan, or a home connection behind CGNAT)</summary>

Cause: setup's `pin` profile needs a public IPv4 the Pin can reach.

Fix: choose a plan with a public IPv4. Hetzner adds one for a small monthly
fee if you unticked it. A home server behind CGNAT cannot host the Pin edge.

</details>

<details>
<summary>Preflight reports ports 80 or 443 in use</summary>

Cause: another web server (Nginx, Apache, Caddy, another Compose stack) is
listening.

Fix: stop or reconfigure it, then rerun `./luma doctor production`. Luma
never stops an unrelated listener. To keep your other sites, see
[Serve other hostnames through Luma's Traefik](../docs/operations.md#serve-other-hostnames-through-lumas-traefik-optional).

</details>

## Deploying and running

<details>
<summary>Preflight says a release defines data volumes differently</summary>

Cause: Docker Compose would delete those volumes and recreate them empty.
Luma stops before it changes anything.

Fix: keep your current release running, take a backup, and report the
release:

```sh
./luma backup production
```

</details>

<details>
<summary>Deployment or verification stops, or says <code>these configured production services are not running:</code></summary>

Cause: a service did not start.

Fix: run `./luma verify production`. It names each service that is not
running. This shows why:

```sh
docker compose -p luma logs --tail 100 SERVICE
```

Fix the cause and rerun `./luma deploy production --confirm`. Existing
configuration and started containers are kept.

</details>

<details>
<summary><code>production container ... is state=... health=unhealthy</code>, or Docker says a container <code>is unhealthy</code></summary>

Cause: a service started but did not become healthy in time. On a server
with less than 4 GB of memory, Keycloak, PostgreSQL, and Cosmos often run out
of memory, and Linux stops one of them.

Fix: check the memory and whether Linux stopped a process:

```sh
free -h
sudo dmesg | grep -i -E 'out of memory|killed process'
```

If `total` memory is under 4 GB, or `dmesg` shows a killed process, resize
the server to a plan with at least 4 GB (8 GB is comfortable). In Hetzner,
power the server off and use **Rescale**. Your data stays. Then rerun:

```sh
./luma deploy production --confirm
```

Otherwise, read the log of the service the message names:

```sh
docker compose -p luma logs --tail 100 SERVICE
```

</details>

<details>
<summary>Center shows an old release, or <code>environment</code> is not <code>production</code></summary>

Cause: the old containers are still running, or the browser cached the old
page.

Fix: run `./luma verify production`, then open
`https://YOUR_DOMAIN/api/version`. It must show the release you deployed and
`"environment":"production"`. If it shows the old one, rerun
`./luma deploy production --confirm` from the new release's folder.

</details>

<details>
<summary><code>onboard production</code> stopped with <code>Onboarding stopped during ...</code>, or the installer says <code>Onboarding did not finish.</code></summary>

Cause: one of its five stages failed. The message names the reason and a
`Recovery check` command. The one-line installer runs onboarding too, so its
`Onboarding did not finish.` points at the onboarding message just
above it.

A `Reason:` such as `deploy.sh exited with status 1` or
`preflight.sh exited with status 1` only says which step failed. The real
error is printed in the lines above the `Onboarding stopped` block. Find that
text on this page.

Fix: run the named recovery command and fix what it reports. Then rerun the
`Safe retry` command it printed. No Pin was contacted.

</details>

<details>
<summary>Center keeps asking you to sign in again</summary>

Cause: Cosmos refused the identity your session carries.

Fix: this names the check that failed:

```sh
docker logs luma-ai-bus-1 2>&1 | grep "rejected a web Bearer"
```

`token has no sub claim` means the realm predates this release's policy. Run
`./luma deploy production --confirm`, then sign in again.

</details>

<details>
<summary>Center rejects your password after you added a second-factor code to your account</summary>

Cause: Center's sign-in form has fields for a username and a password and no
field for a one-time code, so Keycloak's direct password grant fails for an
account that carries an authenticator — Keycloak's own pages ask for the code
and work. Luma 0.3.37 fixed this: its realm policy makes the direct grant
validate the password alone, and the code keeps protecting Keycloak's own
pages. Center itself stays password-only, because the stock sign-in form and
the Pin's enrollment have no field for a code.

Fix: update the server (the **Install now** button on the Software updates
page, or `./luma update production`), which reconciles the realm on deploy.
Until then, removing the authenticator under **Account security** in
Keycloak's account console restores sign-in.

</details>

<details>
<summary>Center says "this server's Keycloak did not answer" on 0.3.40 to 0.3.42, though Keycloak's own pages accept your password</summary>

Cause: those releases disabled only the code step inside Keycloak's direct
grant subflow. Its condition then matched every account and Keycloak failed
each password grant with HTTP 500 (`AuthenticationFlowException` in the
Keycloak log), with or without an authenticator, so adding or removing one
does not help. Luma 0.3.43 disables the whole subflow instead and restores
the step inside it.

Fix: update the server (the **Install now** button on the Software updates
page, or `./luma update production`), which reconciles the realm on deploy.
Update from the server itself: Center cannot sign you in until it has.

</details>

<details>
<summary>Sign-in says it is unavailable, or asks you to wait</summary>

Cause: "Unavailable" means Keycloak did not answer. "Wait" means too many
wrong passwords.

Fix: for "Unavailable", check the Keycloak log:

```sh
docker logs luma-keycloak-1
```

For "Wait", wait the time it names (at most 15 minutes), or reset the password
([Reset a lost password](../docs/operations.md#reset-a-lost-password)):

```sh
./luma reset-password production --confirm
```

</details>

<details>
<summary>You lost the owner password</summary>

Cause: no email reset is configured.

Fix: on the server, run:

```sh
./luma reset-password production --confirm
```

The new one-time password goes to
`~/.config/luma/production/first-login.txt`. Show it once with `cat`, sign in,
change it in **Settings → Passcode & password**, and delete the file.

</details>

<details>
<summary>Assistant, search, maps, or speech is <b>Unavailable</b> or <b>Needs setup</b></summary>

Cause: the provider is not configured, or its key is wrong.

Fix: open **Settings → Assistant & voice**, complete the field marked
**Needs setup**, choose **Test**, then **Save changes**. Changing providers
never needs a Pin reinstall.

</details>

<details>
<summary>A video stays on "This video is still uploading from your Pin."</summary>

Cause: the video is larger than the server accepts. Cosmos logs
`capture upload refused: larger than COSMOS_CAPTURE_MAX_UPLOAD_BYTES`, and the
Pin keeps its copy and retries. Releases before 0.3.45 allowed only 32 MiB,
about 8 seconds of Pin video.

Fix: update Luma. If you set a lower limit yourself, raise it (up to
1073741824) and deploy:

```sh
docker logs luma-ai-bus-1 2>&1 | grep 'capture upload refused'
./luma config set COSMOS_CAPTURE_MAX_UPLOAD_BYTES 268435456
./luma deploy production --confirm
```

The Pin uploads the waiting video on its next retry.

</details>

## Updates

<details>
<summary>An update was rolled back</summary>

**Settings → Advanced → Software updates** says **The update to Luma … failed
and your previous version … was restored**.

Cause: a step of the nightly update failed after the new release was set
up. The server restored the backup it took just before, started the previous
release again, and verified it. Nothing is lost.

Fix: **Last update** names the step and the reason, and
`journalctl -u luma-update.service` shows the whole run. The server does not
try that release again by itself. Fix the cause, then retry once at a terminal:

```sh
~/.local/share/luma/operators/current/luma update production
```

</details>

<details>
<summary>Automatic updates are off on my existing server</summary>

Cause: a server set up before automatic updates existed keeps them off
until you choose.

Fix: run:

```sh
~/.local/share/luma/operators/current/luma setup production --auto-updates on
```

It may answer that the timers start once the server runs a release in
`~/.local/share/luma/operators`. That means the server was installed from the
five release files, and the timers arrive with its first
`./luma update production` ([Update Luma](update.md#update-now)).

</details>

<details>
<summary><code>doctor production</code> says <code>the timers do not match LUMA_AUTO_UPDATES</code></summary>

Cause: the systemd timers are missing or disagree with your saved choice,
usually because setup could not use `sudo`.

Fix: rerun the command doctor names from
`~/.local/share/luma/operators/current`, as a user who can use `sudo`:

```sh
./luma setup production --auto-updates on
```

Use `off` instead of `on` if that is your choice. You can also run the commands
it prints as root.

</details>

## Connecting the Pin from the browser

<details>
<summary>Center shows <b>This browser can’t reach your Pin</b> or "WebUSB is not supported in this browser"</summary>

Cause: you are using Safari, Firefox, a mobile browser, or a non-HTTPS
address.

Fix: open Center in desktop Chrome, Chromium, or Edge, at its `https://`
address.

</details>

<details>
<summary>The browser shows no USB chooser after <b>Connect over USB</b></summary>

Cause: the Pin is locked, still booting, or the cable carries power only.

Fix:

1. Unlock the Pin.
2. Wait a few minutes after switching it on.
3. Use a known-good USB-C data cable in a direct port (no hub).
4. On Linux, set up the udev rules
   ([Prepare Linux USB permissions](../docs/connect-a-pin.md#prepare-linux-usb-permissions)).

</details>

<details>
<summary>The chooser is empty on Windows</summary>

Cause: Windows needs a compatible Android/WinUSB driver before a browser
can claim the device.

Fix: install the Android USB driver, replug the Pin, and try again.

</details>

<details>
<summary><code>Unable to claim interface</code></summary>

Cause: another program owns the Pin's USB ADB interface.

Fix: close Android Studio, scrcpy, and phone-management tools. If you have
ADB installed, run:

```sh
adb kill-server
```

Unplug the Pin, reconnect it, and choose **Connect over USB** again.

</details>

<details>
<summary>Center says <code>cmd: Can't find service: package</code></summary>

Cause: Android on the Pin has not finished starting.

Fix: unlock the Pin, reboot it once, wait for the stock screen to settle,
and choose **Check again**. Center makes no changes while this service is
unavailable.

</details>

<details>
<summary><b>Checking your Pin…</b> never finishes, and the Pin shows a prompt</summary>

Cause: the Pin is asking whether to allow this computer.

Fix: look at the Pin's Laser Ink display and accept the prompt.

</details>

<details>
<summary>Center shows <b>Couldn’t connect to your Pin</b> after you choose it in the USB chooser</summary>

Cause: the Pin locked, went to sleep, or lost contact on the interposer while
the browser connected.

Fix:

1. Unlock the Pin and keep it awake.
2. Check that the Pin sits flat on the interposer, lined up with its outline.
3. Unplug the cable, plug it back in, and choose **Connect over USB** again.

</details>

<details>
<summary>Guided setup says <b>A device is attached, but it does not identify as an Ai Pin.</b></summary>

Cause: you chose another USB device in the chooser, such as a phone or a
tablet.

Fix: disconnect the other device, choose **Connect over USB** again, and pick
the Pin in the chooser.

</details>

<details>
<summary>Center says the Pin reconnected as a different device</summary>

Cause: another Android device is plugged in, or a different Pin.

Fix: stop. Disconnect other Android hardware and restart the step with the
original Pin. Center never switches serials on its own.

</details>

<details>
<summary>USB is connected but Center says "Luma isn't responding yet"</summary>

Cause: Device Services on the Pin has not started, or the install did not
finish.

Fix: keep the Pin unlocked and connected. Center keeps trying. Use **Check
connection** to retry now. If it stays, open **Software & updates**, which
offers **Repair**.

</details>

<details>
<summary>After the install the Pin shows its lock screen and Center waits</summary>

Cause: the Pin restarted and is locked. Center continues only on an
unlocked Pin.

Fix: unlock the Pin with the passcode it had before Luma. A Pin that never
finished Humane's setup has no passcode yet and shows no lock screen. Keep it
on the cable and let Center continue.

</details>

<details>
<summary>Guided setup says <b>Your server has no Pin release to install yet.</b>, or the installer says <b>No Pin release to install</b></summary>

Cause: the server runs without the `pin` feature, or setup never staged the
Pin apps. This happens when you answered `none` (or left out `pin`) at the
features question.

Fix: on the server, run setup again. Keep the answers it offers, include
`pin` in the features, and give the Pin archive. Then deploy:

```sh
./luma setup production --guided --pin-release-archive ~/luma/luma-pin-*.tar.gz
./luma deploy production --confirm
```

Back in Center, choose **Check again**.

</details>

<details>
<summary>The install stops with <b>The install didn’t finish</b> and <b>Your Pin stopped answering partway through.</b></summary>

Cause: the Pin lost its USB connection during the install. It moved on the
interposer, the computer went to sleep, or the cable is loose.

Fix: keep the Pin on the interposer and the computer awake. Reconnect over
USB and choose **Check again**. Center reads what is installed and offers
**Install** or **Repair** again.

</details>

<details>
<summary>Center says <b>Your Pin is newer than your server</b></summary>

Cause: you updated the Pin from a newer release than the server runs.

Fix: update the server to the matching release
([Update Luma](update.md)). Reinstalling here would downgrade the Pin.

</details>

<details>
<summary>Guided setup shows <b>Set your Pin passcode</b> at stage 5 or 6</summary>

Cause: this Pin has not finished its own first setup, and no passcode is
set in Center yet.

Fix: open **Settings → Passcode & password** and choose four digits. Then
return to Guided setup and enter the same digits under **Pin passcode**.

</details>

<details>
<summary>Center says <b>Your Pin couldn’t join “NAME”. Check the password and try again.</b></summary>

Cause: the Wi-Fi password is wrong, or the security type does not match the
network.

Fix: type the password again. It is case-sensitive, and WPA2 and WPA3
passwords have 8 to 63 characters. For a hidden network under **Other
network**, check the exact name and security type in your router's settings.

</details>

<details>
<summary>Center says <b>Your Pin joined “NAME”, but that network doesn’t reach the internet.</b></summary>

Cause: the network needs a sign-in page in a browser (hotel, office, or
guest Wi-Fi), or the router has no internet right now.

Fix: choose a home network or a phone hotspot without a sign-in page.
Guided setup has no way to fill in a Wi-Fi sign-in page for the Pin.

</details>

<details>
<summary>The Wi-Fi list shows <b>Needs a username · not supported</b>, or says <b>Your Pin can’t see any Wi-Fi networks.</b></summary>

Cause: networks that need a username and password (WPA2-Enterprise, common at
work and universities) are not supported. An empty list means the Pin sees no
network from where it is.

Fix: use a network with a single password, or a phone hotspot. For an empty
list, move the Pin and the computer closer to the router and choose the scan
again.

</details>

<details>
<summary>Guided setup says <b>This Pin is online, but its clock is ...</b>, or <b>The Pin’s clock is still wrong after Center set it.</b></summary>

Cause: a Pin that sat unused often has a clock months in the past. With the
wrong date, every certificate looks invalid to it, and it cannot reach your
server.

Fix: choose **Set the Pin’s clock**. If Center says the clock is still wrong,
restart the Pin, keep it online, and choose **Check again**. Android usually
corrects the clock by itself within a minute of going online.

</details>

<details>
<summary>Guided setup says <b>The Pin points at ADDRESS, not at your server (ADDRESS).</b></summary>

Cause: the Pin was connected to another server before, or the server's
public IPv4 changed after you connected the Pin.

Fix: open **Provisioning** and choose **Connect this Pin to Cosmos**. If the
second address is not your server's public IPv4, correct it on the server
first, then deploy:

```sh
./luma setup production --public-ip auto
./luma deploy production --confirm
```

</details>

<details>
<summary>Connect your Pin says <b>This Pin is connected to another Luma server (edge IPv4 ADDRESS).</b></summary>

Cause: the Pin is active with a different Luma server, not this one.

Fix: choose **Switch this Pin to this server** on the same page. Switching
disconnects the Pin from that server — the Pin restores the settings its
connection there replaced — and connects it to this one.

</details>

<details>
<summary>Guided setup says <b>The Pin didn’t finish its own setup within 30 seconds.</b></summary>

Cause: the Pin's own setup did not finish. The passcode you entered differs
from the one in Center, the Pin lost its network, or the Pin's setup screen
is not running at all, so nothing on the Pin takes the passcode.

Fix: look at the Pin's Laser Ink display. If it shows a setup message, check
that the four digits match **Settings → Passcode & password**, keep the Pin
connected and online, and choose the step again. If it shows no setup screen,
the Pin has not received this server's credential yet: follow the next entry.

</details>

<details>
<summary>The Pin is connected but every request fails, and the edge log shows <code>CERTIFICATE_VERIFY_FAILED</code></summary>

Symptoms: the Pin answers "having trouble communicating with the server",
Guided setup stage 6 times out or stage 7 fails with certificate errors, and
Provisioning still says **Connected to Cosmos**. The edge log shows TLS
failures for `api.cosmos.humane.cloud` with `CERTIFICATE_VERIFY_FAILED` while
Cosmos logs nothing.

Cause: the Pin still presents the DeviceUser certificate Humane issued it.
This server never issued its own, because only the Pin's original setup
ceremony asks for one, and that ceremony does not run again on its own once a
Pin has finished Humane's setup. Provisioning names the same cause: "This
server hasn't issued this Pin its credential yet." (**DeviceUser CA ready** on
that page means the server can issue one, not that the Pin has it.)

Fix: open **Provisioning**, connect over USB, choose **Connect this Pin to
Cosmos**, and then **Run its original setup** when it appears. Center
re-arms the Pin's original setup ceremony, reconnects it, and opens its setup
screen on the Pin. Follow the prompts on the Pin, and finish Guided setup
stage 6 with the same four digits when Center asks for them. The Pin keeps the
passcode it already unlocks with.

</details>

<details>
<summary>The installer says <b>Another project's apps are on this Pin</b></summary>

Cause: the Pin runs the current generation of PenumbraOS. Its apps
(`com.penumbraos.server`, `com.penumbraos.hook`,
`com.penumbraos.hook.injector`, `com.penumbraos.systeminjector`) use Luma's
package ids but are signed by a different key.

Fix: choose **Replace and install**. Recovery removes those apps with their
app data and installs Luma's signed apps. The confirmation says so before you
confirm, because it erases the other project's app data.

</details>

<details>
<summary>The installer says <b>The Setup Helper is present unexpectedly.</b></summary>

Cause: an interrupted first install left Luma's Setup Helper
(`com.penumbraos.systeminjector.exploit`) on the Pin. It no longer blocks
anything.

Fix: open **Software & updates** and choose **Repair**, the button the page
offers. It removes the helper and continues.

</details>

## Ask for help

`./luma support-bundle` writes a redacted diagnostic file, readable only by
you. It collects from a fixed list that leaves out secrets, serials, and wearer
data, and prints `Created redacted support bundle: PATH`. Attach that file
instead of logs when you report a problem.
