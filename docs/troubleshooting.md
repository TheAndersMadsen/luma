# Troubleshooting

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


Find your symptom, then open it for the fix. The
[long troubleshooting guide](../guides/troubleshooting.md) has the same entries
with more context.

## Installing the release

<details>
<summary><code>permission denied while trying to connect to the Docker daemon socket</code></summary>

`bootstrap --tools-only` added you to the `docker` group, but this SSH session
started before that. Disconnect, reconnect over SSH, and rerun the command.

</details>

<details>
<summary><code>./luma</code> says <code>Luma requires Bun 1.4.2</code>, or doctor says <code>Docker Compose 2.34.0 or newer is required</code></summary>

Install Bun 1.4.2 and Docker's Compose plugin as in
[Prepare the server](install.md#1-prepare-the-server). If the server already
runs Ubuntu's `docker.io`, check what else uses it before you replace it with
Docker's packages.

</details>

<details>
<summary><code>sha256sum --check</code> reports <code>FAILED</code> or a missing file</summary>

The copy is incomplete or damaged. Copy the release folder again. Never install
from files that fail the check.

</details>

<details>
<summary><code>ghcr.io</code> says <code>unauthorized</code> or <code>denied</code> (private fork only)</summary>

Public images pull with no login, so this affects only a private fork. Usually
its token has expired. The token must be a classic token with `repo` and
`read:packages` that can read the fork's packages. Create a new one, then run
this and paste the token at Docker's `Password:` prompt:

```sh
./luma registry login --username YOUR_GITHUB_USER
```

Luma saves the new token for updates too.

</details>

<details>
<summary>The one-line installer stops at "Authenticate the latest stable release"</summary>

The latest GitHub release carries no `SHA256SUMS.sigstore.json` from the
maintainer's key (the installer says it `was published without the
maintainer's signature`). Or the installer you fetched carries no release
signing key, and it says so. Either way it installs nothing from that release.

Bun and Docker stay installed. Continue from the release files as in
[Install the release](install.md#2-install-the-release).

</details>

<details>
<summary>Setup says the matching Pin release acquisition failed</summary>

Pass the release's Pin archive with `--pin-release-archive`. Guided setup takes
it too:

```sh
./luma setup production --guided --pin-release-archive FILE
```

Without the flag, setup downloads the archive only from a GitHub release whose
`SHA256SUMS` the maintainer's key signed. For a release published without that
signature, you must give the archive with the flag.

"does not match operator release Pin" means the server already has newer Pin
apps than this release. Use the newest operator release.

</details>

<details>
<summary><code>Production setup supports only amd64/x86_64 and arm64/aarch64</code></summary>

The server is not 64-bit. Use a 64-bit Ubuntu 24.04 server. Intel/AMD and Arm
plans both work. `uname -m` shows what you have.

</details>

<details>
<summary><code>At least 8 GiB of free disk space is required</code>, or Docker says <code>no space left on device</code></summary>

The disk is too small or full. Check with `df -h /` and `docker system df`,
choose a bigger plan or free space, then rerun `bash ./bootstrap --tools-only`.

</details>

<details>
<summary><code>Could not get lock /var/lib/dpkg/lock-frontend</code> (<code>stopped with exit status 100</code>)</summary>

Ubuntu is installing its own updates in the background, which a new server
does for its first minutes. Wait five to ten minutes and run the same command
again. Finished steps are kept.

</details>

<details>
<summary><code>This account needs sudo access to install host tools.</code> or <code>Sudo access was not granted.</code></summary>

Sign in as `root` or as a user with `sudo` rights, and run the command again.
Check the password you type at the `sudo` prompt.

</details>

<details>
<summary><code>bootstrap requires an interactive terminal</code></summary>

The installer was piped into `bash` or run through `ssh HOST 'command'`. Sign
in over SSH and run it at the prompt. Run the one-line installer as
`bash <(curl -fsSL https://YOUR-CENTER/install.sh)`.

</details>

<details>
<summary><code>GitHub could not be reached securely.</code> or <code>GitHub could not confirm repository read access (HTTP 403)</code></summary>

The server cannot reach `api.github.com`, or GitHub refused the request.
Without a token, `HTTP 403` usually means GitHub's limit of 60 anonymous
requests per hour for each address. Wait an hour and retry, or install from
the release files as in [Install the release](install.md#2-install-the-release).

</details>

<details>
<summary><code>Docker is installed, but this user cannot reach it.</code></summary>

Docker is not running, or your user is not in the `docker` group yet. Run
`sudo systemctl start docker` and `getent group docker`. If your name is
missing, rerun `bash ./bootstrap --tools-only`, then reconnect over SSH.

</details>

<details>
<summary>A cloud-init server never shows Center</summary>

Sign in as `root` and read the install log:

```sh
cloud-init status --long
tail -n 40 /var/log/luma-install.log
```

If it ends with **Setup stopped**, its `What failed:` line names the problem
and `Safe retry:` the way back. `Set either LUMA_DOMAIN or
LUMA_DUCKDNS_SUBDOMAIN, not both.` means `install.env` must name exactly one
of the two. Fix the file and create the server again.

</details>

<details>
<summary><code>Pin release archive does not exist: ...</code></summary>

No file is at the `--pin-release-archive` path. A path that still contains `*`
matched nothing. Find the archive with `ls ~/luma/luma-pin-*.tar.gz`, or
download the release again, and rerun with the path `ls` prints.

</details>

<details>
<summary><code>setup production with the pin profile must run from an extracted operator release</code></summary>

You ran `./luma` from a source checkout. Run it from the unpacked
`luma-operator-VERSION` folder of a release.

</details>

<details>
<summary><code>--acme-email needs a real address: Let's Encrypt refuses example.com, example.net, and example.org</code></summary>

Guided setup accepts the address at the prompt, and setup refuses it after the
review. Nothing was written. Run setup again with an email address you really
use.

</details>

<details>
<summary><code>this is the Luma ... operator, but this server is configured for ...</code></summary>

You ran `./luma` from another release's folder. Run it from
`~/.local/share/luma/operators/current`, or from the newest
`luma-operator-VERSION` folder if you installed from the release files.

</details>

<details>
<summary><code>no production configuration at ...</code></summary>

Setup has not run yet, it stopped before writing, or you run `./luma` as a
different user (for example with `sudo`). Run it as the user who ran setup,
or run `./luma onboard production --pin-release-archive FILE`, which sets up
first. If you set the server up with `LUMA_CONFIG_DIR` and `LUMA_DATA_DIR`,
export the same values.

</details>

## Domain, DNS, and certificates

<details>
<summary><code>doctor production</code> or <code>verify production</code> cannot reach the domain, but DNS is right</summary>

The provider's own firewall is closed. Allow inbound TCP 80 and 443 in the
Hetzner Cloud **Firewalls** page, the DigitalOcean **Cloud Firewalls** page, or
the Linode **Cloud Firewall**. Do the same in `ufw` if the host runs it. Then
rerun:

```sh
./luma doctor production
```

</details>

<details>
<summary>The server has no public IPv4 (IPv6-only, or a home connection behind CGNAT)</summary>

The Pin connects to the server's IPv4 directly, so it cannot use this server.
Add a primary IPv4 at the provider (Hetzner sells one per server) or choose a
server that includes one. A tunnel does not help.

</details>

<details>
<summary>The Pin cannot connect, but Center works in the browser (Cloudflare proxy on)</summary>

The domain's record shows Cloudflare's orange cloud, so the Pin reaches
Cloudflare instead of your server. Cloudflare Tunnel does not carry the Pin's
gRPC either. Set the record to **DNS only** (grey cloud), wait for it to
propagate, and reconnect the Pin.

</details>

<details>
<summary>Traefik logs <code>too many certificates already issued</code> or <code>rateLimited</code></summary>

Let's Encrypt allows five certificates per exact hostname per week. Repeated
fresh installs on the same name use them up. Do not delete the `traefik-acme`
volume between retries. Either wait for the week to pass, or pick a new
hostname (`center2.example.com`) and rerun setup with `--domain` before the
first deploy.

</details>

<details>
<summary><code>verify production</code> (or the end of <code>deploy production --confirm</code>) reports <code>fetch failed</code></summary>

The check could not reach `https://YOUR_DOMAIN`. It prints which of three
causes it saw:

- the domain's DNS does not point at this server yet
- ports 80 and 443 are closed in the server's or provider's firewall
  (`fetch failed (TimeoutError: The operation timed out.)` usually means this)
- Let's Encrypt is still issuing the certificate

A confirmed deploy waits up to 120 seconds for the first answer. Fix the named
cause, then run this again:

```sh
./luma verify production
```

</details>

<details>
<summary>The certificate stays invalid, or Traefik logs <code>invalidContact</code></summary>

Preflight checks only that the domain resolves, not that it resolves to this
server. These two must print the same address:

```sh
dig +short YOUR_DOMAIN
curl -4 -s https://api.ipify.org; echo
```

If they differ, fix the A record and turn off Cloudflare's proxy.
`invalidContact` means Let's Encrypt refused the certificate email. Rerun
`./luma setup production --acme-email ADDRESS` with a real address, then
`./luma deploy production --confirm`.

</details>

<details>
<summary>Production preflight reports ports 80 or 443 in use</summary>

Stop or reconfigure the named Nginx, Apache, Caddy, or other Compose service,
then run:

```sh
./luma doctor production
```

Luma never stops an unrelated listener automatically.

</details>

<details>
<summary>Production preflight reports that the domain does not resolve</summary>

Create or correct the domain's public A or AAAA record, wait for DNS to
propagate, and rerun:

```sh
./luma doctor production
```

Keep public ports 80 and 443 open so Traefik can obtain and renew the
certificate.

</details>

## Deploying and running

<details>
<summary>Production preflight says a release defines data volumes differently</summary>

Docker Compose would delete those volumes and recreate them empty, so Luma
stops before it changes anything. Keep your current release running, take a
backup, and report the release:

```sh
./luma backup production
```

A release must never change how a data volume is defined.

</details>

<details>
<summary>Deployment or verification stops</summary>

First run:

```sh
./luma verify production
```

It names each service that is not running. This shows why one stopped:

```sh
docker compose -p luma logs --tail 100 SERVICE
```

Fix the cause and rerun the deploy. Existing configuration and containers that
started successfully are kept.

```sh
./luma deploy production --confirm
```

</details>

<details>
<summary><code>production container ... is state=... health=unhealthy</code></summary>

A service did not become healthy. On a server with under 4 GB of memory,
Linux often stops one. Check with `free -h` and
`sudo dmesg | grep -i -E 'out of memory|killed process'`. Resize to at least
4 GB if so, then rerun `./luma deploy production --confirm`. Otherwise read
`docker compose -p luma logs --tail 100 SERVICE`.

</details>

<details>
<summary><code>Onboarding stopped during ...</code> with <code>What failed: deploy.sh stopped with exit status 1</code></summary>

The reason names only the step. The real error is printed in the lines above
the block, and the one-line installer's `Onboarding did not finish.`
points at the same block. Fix that error, run the `Recovery check`, then the
`Safe retry` command.

</details>

<details>
<summary>Center shows an old release or unknown environment</summary>

Run `./luma verify production`, then open `https://YOUR_DOMAIN/api/version`. A
production deployment must return `environment: "production"` and the release
revision you deployed.

</details>

<details>
<summary>Center keeps asking you to sign in again</summary>

Cosmos refused the identity your session carries. This names the check that
failed, never the token:

```sh
docker logs luma-ai-bus-1 2>&1 | grep "rejected a web Bearer"
```

"token has no sub claim" means the realm predates this release's policy. Run
`./luma deploy production --confirm`, which repairs it, then sign in again.

</details>

<details>
<summary>Sign-in says it is unavailable, or to wait</summary>

"unavailable" means Keycloak did not answer. Check the Keycloak log:

```sh
docker logs luma-keycloak-1
```

"Wait" means too many wrong passwords. Wait the time it names, or
[reset the password](operations.md#reset-a-lost-password).

</details>

<details>
<summary>Assistant, search, maps, or speech is unavailable</summary>

Open **Settings → Assistant & voice**, complete the field marked
**Needs setup**, save, and retry. If the whole card is unavailable, run
`./luma verify production`. Changing these providers never requires a Pin
reinstall or activation.

</details>

## Updates

<details>
<summary>An update was rolled back</summary>

**Software updates** says **The update to Luma … failed and your previous
version … was restored**. A step of the nightly update failed after the new
release was set up. The server restored the backup it took just before,
started the previous release again, and verified it. Nothing is lost.

**Last update** names the step and the reason, and
`journalctl -u luma-update.service` shows the whole run. The server does not
try that release again by itself. Fix the cause, then retry once at a terminal:

```sh
~/.local/share/luma/operators/current/luma update production
```

</details>

<details>
<summary>Automatic updates are off on my existing server</summary>

A server set up before automatic updates existed keeps them off until you
choose. Run:

```sh
~/.local/share/luma/operators/current/luma setup production --auto-updates on
```

It may answer that the timers start once the server runs a release in
`~/.local/share/luma/operators`. That means the server was installed from the
five release files, and the timers arrive with its first
`./luma update production`.

</details>

<details>
<summary><code>doctor production</code> says <code>the timers do not match LUMA_AUTO_UPDATES</code></summary>

The systemd timers are missing or disagree with your saved choice, usually
because setup could not use `sudo`. Rerun the command doctor names from
`~/.local/share/luma/operators/current`, as a user who can use `sudo`:

```sh
./luma setup production --auto-updates on
```

Use `off` instead of `on` if that is your choice. You can also run the commands
it prints as root.

</details>

## Connecting the Pin from the browser

<details>
<summary>Safari or Firefox shows no "Connect over USB" prompt</summary>

Neither browser has WebUSB. Open Center in current desktop Chrome, Chromium, or
Edge on a computer, not a phone or tablet.

</details>

<details>
<summary>The browser has no USB chooser</summary>

Use current desktop Chrome, Chromium, or Edge over HTTPS. Unlock the Pin. Try a
known-good data cable and a direct USB port. Then recheck
[Linux USB permissions](connect-a-pin.md#prepare-linux-usb-permissions).

</details>

<details>
<summary><code>Unable to claim interface</code></summary>

Another program owns USB ADB. Close Android Studio, scrcpy, and Android
management tools, then run:

```sh
adb kill-server
```

Unplug the Pin, reconnect it, and select **Connect** again.

</details>

<details>
<summary><code>cmd: Can't find service: package</code></summary>

Unlock the Pin, reboot it once, and wait for the stock UI to settle. Before you
retry, this must print an absolute `package:/...` path:

```sh
adb shell cmd package path android
```

The installer makes no package changes while this service is unavailable.

</details>

<details>
<summary>The Pin reconnects as a different device</summary>

Stop. Disconnect other Android hardware and restart the plan against the
original serial. Installation and activation never switch serials on their
own.

</details>

<details>
<summary><b>Couldn’t connect to your Pin</b>, or <b>A device is attached, but it does not identify as an Ai Pin.</b></summary>

The Pin locked or moved on the interposer, or you chose another device in the
chooser. Unlock the Pin, line it up on the interposer, replug the cable, and
choose the Pin in the chooser.

</details>

<details>
<summary><b>Your server has no Pin release to install yet.</b> or <b>No Pin release to install</b></summary>

The server runs without the `pin` feature. Rerun setup with `pin` in the
features and the Pin archive, then deploy:

```sh
./luma setup production --guided --pin-release-archive FILE
./luma deploy production --confirm
```

</details>

<details>
<summary><b>Your Pin stopped answering partway through.</b></summary>

The USB connection dropped during the install. Keep the Pin on the
interposer and the computer awake, reconnect, and choose **Check again**.

</details>

<details>
<summary>Wi-Fi: <b>Your Pin couldn’t join “NAME”. Check the password and try again.</b> or <b>… that network doesn’t reach the internet.</b></summary>

Retype the password (8 to 63 characters, case-sensitive) and check the
security type. A network that needs a browser sign-in page, such as hotel or
guest Wi-Fi, does not work. Networks marked **Needs a username · not
supported** (WPA2-Enterprise) do not work either. Use a home network or a
phone hotspot.

</details>

<details>
<summary><b>This Pin is online, but its clock is ...</b> or <b>The Pin’s clock is still wrong after Center set it.</b></summary>

A wrong date makes every certificate look invalid. Choose **Set the Pin’s
clock**. If it stays wrong, restart the Pin, keep it online, and choose
**Check again**.

</details>

<details>
<summary><b>The Pin points at ADDRESS, not at your server (ADDRESS).</b></summary>

The Pin was connected to another server, or the server's public IPv4
changed. Open **Provisioning** and choose **Connect this Pin to Cosmos**. If
the server's own address is wrong, run
`./luma setup production --public-ip auto` and redeploy first.

</details>

<details>
<summary><b>This Pin is connected to another Luma server (edge IPv4 …).</b></summary>

The Pin is active with a different Luma server. Choose **Switch this Pin to
this server**: switching disconnects it from that server (the Pin restores
its previous settings) and connects it to this one.

</details>

<details>
<summary><b>The Pin didn’t finish its own setup within 30 seconds.</b></summary>

Read the setup message on the Pin's display. Check that the four digits
match **Settings → Passcode & password**, keep the Pin connected and online,
and try the step again.

</details>

<details>
<summary>Stage 6 times out with no setup screen, or the edge refuses the Pin with <code>CERTIFICATE_VERIFY_FAILED</code></summary>

The Pin finished Humane's original setup, so it still presents Humane's
DeviceUser certificate and this server never issued its own. In
**Provisioning**, open **Pin still can't reach your server?**, choose **Run
its original setup**, follow the
prompts on the Pin's own setup screen, and finish Guided setup stage 6 with
the same four digits. The Pin keeps its current passcode.

</details>

<details>
<summary>The installer says <b>Another project's apps are on this Pin</b></summary>

The Pin runs the current PenumbraOS: its apps use Luma's package ids
(`com.penumbraos.server`, `com.penumbraos.hook`,
`com.penumbraos.hook.injector`, `com.penumbraos.systeminjector`) under a
different signing key. Choose **Replace and install**; recovery removes
those apps with their app data and installs Luma's signed apps.

</details>

<details>
<summary><b>The Setup Helper is present unexpectedly.</b></summary>

An interrupted first install left the Setup Helper
(`com.penumbraos.systeminjector.exploit`) on the Pin. Nothing is blocked:
choose **Repair** on **Software & updates**; it removes the helper and
continues.

</details>

## Ask for help

<details>
<summary>A command is unclear</summary>

Use `./luma COMMAND --help`, in a release folder or a checkout. Help is
read-only. It states whether a command changes only this machine, what
production runs or a published release, or a device.

</details>

<details>
<summary>Reporting a problem</summary>

This writes a redacted diagnostic file, readable only by you, from a fixed list
that leaves out secrets:

```sh
./luma support-bundle
```

Attach it instead of logs to a
[bug report](https://github.com/TheAndersMadsen/luma/issues/new/choose),
together with the release ID from `https://YOUR_DOMAIN/api/version`.

</details>
