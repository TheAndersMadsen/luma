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
<summary><code>At least 8 GiB of free disk space is required ...</code></summary>

Cause: the disk is too small or full.

Fix: choose a bigger plan or free some space, then run this again:

```sh
bash ./bootstrap --tools-only
```

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

Fix: pass the release's Pin archive:

```sh
./luma setup production --guided --pin-release-archive ../luma-pin-*.tar.gz
```

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
<summary><code>./luma</code> says it found no configuration and names a path</summary>

Cause: you set the server up with `LUMA_CONFIG_DIR` and `LUMA_DATA_DIR`,
and this shell does not have them.

Fix: export the same values. Setup printed the `export` line, so put it in
`~/.profile`. To see what this shell finds, run:

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

Cause: the A record does not exist yet, points elsewhere, or has not
propagated.

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
<summary><code>verify production</code> prints <code>fetch failed</code> and <code>nothing answered at https://...; open ports 80 and 443 in the server provider's firewall</code></summary>

Cause: the provider's firewall blocks the ports, or Traefik is not running.

Fix: open inbound TCP 80 and 443 in the provider's firewall:

- Hetzner: **Firewalls** in the Cloud Console
- DigitalOcean: **Networking → Firewalls**
- Linode/Akamai: **Cloud Firewall**

Then rerun:

```sh
./luma verify production
```

</details>

<details>
<summary><code>verify production</code> prints <code>fetch failed</code> and <code>... presented a certificate that is not valid for it yet</code></summary>

Cause: right after the first deploy, Let's Encrypt is still issuing the
certificate. If it stays this way, the domain does not point at this server or
port 80 is closed.

Fix: wait a few minutes and rerun `./luma verify production`. A confirmed
deploy already waits up to 120 seconds for the first answer.

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
<summary>Deployment or verification stops</summary>

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
<summary>Center shows an old release, or <code>environment</code> is not <code>production</code></summary>

Cause: the old containers are still running, or the browser cached the old
page.

Fix: run `./luma verify production`, then open
`https://YOUR_DOMAIN/api/version`. It must show the release you deployed and
`"environment":"production"`. If it shows the old one, rerun
`./luma deploy production --confirm` from the new release's folder.

</details>

<details>
<summary><code>onboard production</code> stopped with <code>Onboarding stopped during stage ...</code></summary>

Cause: one of its five stages failed. The message names the reason and a
`Recovery check` command.

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
<summary>Center shows <b>This browser can't reach your Pin</b> or "WebUSB is not supported in this browser"</summary>

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

## Ask for help

`./luma support-bundle` writes a redacted diagnostic file, readable only by
you. It collects from a fixed list that leaves out secrets, serials, and wearer
data, and prints `Created redacted support bundle: PATH`. Attach that file
instead of logs when you report a problem.
