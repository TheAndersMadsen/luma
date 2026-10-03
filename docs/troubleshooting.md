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
<summary><code>verify production</code> (or the end of <code>deploy production --confirm</code>) reports fetch failed</summary>

The check could not reach `https://YOUR_DOMAIN`. It prints which of three
causes it saw:

- the domain's DNS does not point at this server yet
- ports 80 and 443 are closed in the server's or provider's firewall
- Let's Encrypt is still issuing the certificate

A confirmed deploy waits up to 120 seconds for the first answer. Fix the named
cause, then run this again:

```sh
./luma verify production
```

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
