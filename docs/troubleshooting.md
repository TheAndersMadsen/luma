# Troubleshooting

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


Symptom first, then the fix. The
[long troubleshooting guide](../guides/troubleshooting.md) has the same entries
with more context.

- **`permission denied while trying to connect to the Docker daemon socket`:**
  `bootstrap --tools-only` added you to the `docker` group, but this SSH
  session predates it. Disconnect, reconnect over SSH, and rerun the command.
- **`doctor production` or `verify production` cannot reach the domain, but
  DNS is right:** the provider's own firewall is closed. Allow inbound TCP 80
  and 443 in the Hetzner Cloud **Firewalls** page, the DigitalOcean **Cloud
  Firewalls** page, or the Linode **Cloud Firewall** (and any `ufw` on the
  host), then rerun `./luma doctor production`.
- **The server has no public IPv4 (IPv6-only, or a home connection behind
  CGNAT):** the Pin connects to the server's IPv4 directly, so it cannot use
  this server. Add a primary IPv4 at the provider (Hetzner sells one per
  server) or choose a server that includes one; a tunnel does not help.
- **The Pin cannot connect, but Center works in the browser (Cloudflare
  proxy on):** the domain's record shows Cloudflare's orange cloud, so the
  Pin reaches Cloudflare instead of your server, and Cloudflare Tunnel does
  not carry the Pin's gRPC either. Set the record to **DNS only** (grey
  cloud), wait for it to propagate, and reconnect the Pin.
- **`ghcr.io` says `unauthorized` or `denied` (private fork only):** public
  images pull with no login, so this affects only a private fork, usually one
  whose token expired. Its token must be a classic token with `repo` and
  `read:packages` that can read the fork's packages. Create a new one, run
  `./luma registry login --username YOUR_GITHUB_USER`, and paste it at
  Docker's `Password:` prompt; Luma saves the new one for updates too.
- **Traefik logs `too many certificates already issued` or `rateLimited`:**
  Let's Encrypt allows five certificates per exact hostname per week, and
  repeated fresh installs on the same name use them up. Do not delete the
  `traefik-acme` volume between retries; wait for the week to pass, or use a
  new hostname (`center2.example.com`) and rerun setup with `--domain` before
  the first deploy.
- **Safari or Firefox shows no "Connect over USB" prompt:** neither browser
  has WebUSB. Open Center in current desktop Chrome, Chromium, or Edge on a
  computer, not a phone or tablet.
- **`./luma` says `Luma requires Bun 1.4.2`, or doctor says `Docker Compose
  2.34.0 or newer is required`:** install Bun 1.4.2 and Docker's Compose
  plugin as in [Prepare the server](install.md#1-prepare-the-server). On a server that
  already runs Ubuntu's `docker.io`, check what else uses it before replacing
  it with Docker's packages.
- **`sha256sum --check` reports `FAILED` or a missing file:** the copy is
  incomplete or damaged. Copy the release folder again; never install from
  files that fail the check.
- **An update was rolled back** (Software updates says **The update to
  Luma … failed and your previous version … was restored**): a step of the
  nightly update failed after the new release was set up, so the server
  restored the backup it took just before, started the previous release
  again, and verified it. Nothing is lost. **Last update** names the step
  and the reason, and `journalctl -u luma-update.service` shows the whole
  run. The server does not try that release again by itself. Fix the cause,
  then retry once at a terminal:
  `~/.local/share/luma/operators/current/luma update production`.
- **Automatic updates are off on my existing server:** a server set up before
  automatic updates existed keeps them off until you choose. Run
  `~/.local/share/luma/operators/current/luma setup production --auto-updates on`.
  If it answers that the timers start once the server runs a release in
  `~/.local/share/luma/operators`, the server was installed from the five
  release files; the timers arrive with its first
  `./luma update production`.
- **`doctor production` says `the timers do not match LUMA_AUTO_UPDATES`:**
  the systemd timers are missing or disagree with your saved choice, usually
  because setup could not use `sudo`. Rerun the command doctor names,
  `./luma setup production --auto-updates on` (or `off`), from
  `~/.local/share/luma/operators/current` as a user who can use `sudo`, or
  run the commands it prints as root.
- **Setup says the matching Pin release acquisition failed:** pass the
  release's Pin archive with `--pin-release-archive` (guided setup takes it
  too: `setup production --guided --pin-release-archive FILE`). Without it,
  setup downloads the archive only from a GitHub release whose `SHA256SUMS`
  the maintainer's key signed, so the archive of a release published without
  that signature must be given with the flag. "does not match operator
  release Pin" means the server already has newer Pin apps than this
  release; use the newest operator release.
- **The one-line installer stops at "Authenticate the latest stable
  release":** the latest GitHub release carries no `SHA256SUMS.sigstore.json`
  from the maintainer's key (the installer says it `was published without the
  maintainer's signature`), or the installer you fetched carries no release
  signing key and says so; either way it installs nothing from that release.
  Bun and Docker stay installed; continue from the release files as in
  [Install the release](install.md#2-install-the-release).
- **`verify production` (or the end of `deploy production --confirm`) reports
  fetch failed:** the check could not reach `https://YOUR_DOMAIN` and prints
  which of three causes it saw: the domain's DNS does not point at this server
  yet, ports 80 and 443 are closed in the server's or provider's firewall, or
  Let's Encrypt is still issuing the certificate. A confirmed deploy waits up
  to 120 seconds for the first answer; fix the named cause, then run
  `./luma verify production` again.
- **Production preflight reports ports 80 or 443 in use:** stop or reconfigure
  the named Nginx, Apache, Caddy, or other Compose service, then run
  `./luma doctor production`. Luma never stops an unrelated
  listener automatically.
- **Production preflight reports that the domain does not resolve:** create or
  correct the domain's public A or AAAA record, wait for DNS propagation, and
  rerun `./luma doctor production`. Keep public ports 80 and 443 open so
  Traefik can obtain and renew the certificate.
- **Production preflight says a release defines data volumes differently:**
  Docker Compose would delete and recreate those volumes empty, so Luma stops
  before changing anything. Keep your current release running, take a backup
  with `./luma backup production`, and report the release; a release must
  never change how a data volume is defined.
- **Deployment or verification stops:** first run `./luma verify production`.
  It names each service that is not running; `docker compose -p luma logs
  --tail 100 SERVICE` shows why one stopped. Fix the cause and rerun
  `./luma deploy production --confirm`; existing configuration and
  successfully started containers are preserved.
- **The browser has no USB chooser:** use current desktop Chrome, Chromium, or
  Edge over HTTPS; unlock the Pin; try a known-good data cable and a direct USB
  port; then recheck [Linux USB permissions](connect-a-pin.md#prepare-linux-usb-permissions).
- **`Unable to claim interface`:** another program owns USB ADB. Close Android
  Studio, scrcpy, and Android management tools, run `adb kill-server`, unplug
  the Pin, reconnect it, and select **Connect** again.
- **`cmd: Can't find service: package`:** unlock the Pin, reboot it once, wait
  for the stock UI to settle, and require `adb shell cmd package path android`
  to print an absolute `package:/...` path before retrying. The installer makes
  no package changes while this service is unavailable.
- **The Pin reconnects as a different device:** stop. Disconnect other Android
  hardware and restart the plan against the original serial; installation and
  activation never switch serials implicitly.
- **Center shows an old release or unknown environment:** run
  `./luma verify production`, then inspect `https://YOUR_DOMAIN/api/version`.
  A production deployment must return `environment: "production"` and the
  release revision you deployed.
- **Center keeps asking you to sign in again:** Cosmos refused the identity
  your session carries. `docker logs luma-ai-bus-1 2>&1 | grep "rejected a web
  Bearer"` names the check that failed, never the token. "token has no sub
  claim" means the realm predates this release's policy: run
  `./luma deploy production --confirm`, which repairs it, then sign in again.
- **Sign-in says it is unavailable, or to wait:** "unavailable" means Keycloak
  did not answer; check `docker logs luma-keycloak-1`. "Wait" means too many
  wrong passwords; wait the time it names, or
  [reset the password](operations.md#reset-a-lost-password).
- **Assistant, search, maps, or speech is unavailable:** open **Settings →
  Assistant & voice**, complete the field marked **Needs setup**, save, and
  retry. If the whole card is unavailable, run `./luma verify production`;
  changing these providers never requires a Pin reinstall or activation.
- **A command is unclear:** use `./luma COMMAND --help`, in a release folder or
  a checkout. Help is read-only and states whether a command changes only this
  machine, what production runs or a published release, or a device.
- **Reporting a problem:** `./luma support-bundle` writes a redacted
  diagnostic file, readable only by you, from a fixed list that leaves out
  secrets; attach it instead of logs, with the release ID from
  `https://YOUR_DOMAIN/api/version`, to a
  [bug report](https://github.com/TheAndersMadsen/luma/issues/new/choose).

