# Fix a problem with your Luma server or Pin

Find your symptom in the left column. Every fix here matches the
short [troubleshooting reference](../docs/troubleshooting.md), which stays
authoritative; this page adds the hosting and browser problems people hit
while following the guides. Words in **bold** are Center buttons or pages;
unfamiliar terms are in the [glossary](glossary.md).

Run every `./luma` command on the server, from the newest release's
`luma-operator-VERSION` folder (or `~/.local/share/luma/operators/current`
if the one-line installer or an update installed it). When in doubt, start
with:

```sh
./luma verify production
```

## Installing the release

| Symptom | Cause | Fix |
| --- | --- | --- |
| `sha256sum --check` prints `FAILED` or a missing file | The copy to the server is incomplete or damaged. | Copy the release folder again with `scp -r`. Never install from files that fail the check. |
| `Production setup requires 64-bit Ubuntu 24.04. This server reports ...` | The server image is not Ubuntu 24.04. | Rebuild the server with the provider's plain Ubuntu 24.04 image (not a "Docker" or "app" image). |
| `At least 8 GiB of free disk space is required ...` | The disk is too small or full. | Choose a bigger plan or free space, then run `bash ./bootstrap --tools-only` again. |
| `run bootstrap as your normal user; it asks for sudo only when needed.` | You ran `sudo bash ./bootstrap`. | Run it without `sudo`: `bash ./bootstrap --tools-only`. Signing in directly as `root` is fine. |
| `/var/log/luma-install.log` says `still holds a REPLACE_ME value` or `still holds the template placeholder` | A `REPLACE_ME` value was left in the cloud-init file. | Fill in every `REPLACE_ME` value and create the server again; the token files were already removed. |
| `docker: permission denied while trying to connect to the Docker daemon socket` | The installer added you to Docker's group, but this SSH session started before that. | Sign out and back in over SSH, then rerun the command. (`bash ./bootstrap --tools-only` prints `Reconnect over SSH so this session picks up Docker group membership.` when this applies.) |
| `./luma` says `Luma requires Bun 1.4.2`, or `doctor` says `Docker Compose 2.34.0 or newer is required` | Bun 1.4.2 or Docker Compose 2.34+ is missing. | Run `bash ./bootstrap --tools-only` from the release folder. On a server that already runs Ubuntu's `docker.io`, the installer stops and names the conflicting package; use a fresh server or remove it after checking what else uses it. |
| `An incompatible Docker package is installed: ...` | Ubuntu's own Docker packages are installed. | Same as above: a fresh server is simplest. |
| Docker is denied access to `ghcr.io`, or `doctor` says `Docker could not read this release's application from ghcr.io` | Public images pull with no login, so this affects only a private fork, or a network that blocks `ghcr.io`. | Check your network. For a private fork, run `./luma registry login --username YOUR_GITHUB_USER` with a classic token that has `read:packages`, pasting it at Docker's `Password:` prompt. |
| (Private fork) Docker login worked last month but now fails; `deploy` cannot pull images | The GitHub token expired (classic tokens have an expiry you chose when creating it). Public images are unaffected. | Create a new classic token with the same scopes (`repo` and `read:packages`) and run `./luma registry login --username YOUR_GITHUB_USER` again. Docker keeps the new one for later deploys, and Luma saves it for updates. |
| The one-line installer stops at **Authenticate the latest stable release** | The latest GitHub release has no `SHA256SUMS.sigstore.json` from the maintainer's key (the installer says it `was published without the maintainer's signature`), or the installer carries no release signing key and says so. | Bun and Docker are installed; continue with the five-file path in [Set up a server from nothing](server-from-nothing.md#install-from-the-five-release-files). |
| Setup says the matching Pin release acquisition failed | Setup found no staged Pin archive, and could not download one: the GitHub release has no signed `SHA256SUMS`, or GitHub could not be reached. | Pass the release's Pin archive: `./luma setup production --guided --pin-release-archive ../luma-pin-*.tar.gz`. |
| Setup says `does not match operator release Pin` | The server already has newer Pin apps than this release. | Use the newest operator release. Setup never moves a server back to older Pin apps. |
| Setup refuses to change the domain or owner email | The server has already been deployed once; Keycloak now holds those values. | Changing the domain or owner of a deployed server is not supported. Before the first `deploy production --confirm`, rerun setup with the right `--domain` or `--operator-email`. |
| `./luma` says it found no configuration and names a path | You set the server up with `LUMA_CONFIG_DIR` and `LUMA_DATA_DIR`, and this shell does not have them. | Export the same values (setup printed the `export` line; put it in `~/.profile`). `./luma setup status` shows what this shell finds. |

## Domain, DNS, and certificates

| Symptom | Cause | Fix |
| --- | --- | --- |
| Setup says `DuckDNS refused to point NAME.duckdns.org at ...` (DuckDNS answered `KO`) | The token is wrong, or the subdomain is not one of your DuckDNS domains. | Sign in at <https://www.duckdns.org>, add the subdomain under **domains** if it is missing, copy the **token** shown at the top of the page, and rerun setup (guided, or `--duckdns-subdomain NAME --duckdns-token-stdin`). Nothing was written. |
| Setup says `Could not detect this server's public IPv4: ...` (guided) or `could not detect this server's public IPv4 ...; pass --public-ip IPV4 instead` | The server's own address and the address the internet sees disagree (NAT), or the HTTPS echo could not be reached. | Guided setup asks for the address without a default: type the public IPv4 that reaches this server. With flags, replace `--public-ip auto` with `--public-ip IPV4`. |
| Preflight (`doctor`) says `public DNS name ... does not resolve from this server` | The A record does not exist yet, points elsewhere, or has not propagated. | Create or correct the A record at your registrar or DuckDNS, wait a few minutes, rerun `./luma doctor production`. |
| `verify production` prints `fetch failed` and `... does not resolve from this server` | Same as above. | Same as above. |
| `verify production` prints `fetch failed` and `nothing answered at https://...; open ports 80 and 443 in the server provider's firewall` | The provider's firewall blocks the ports, or Traefik is not running. | Open inbound TCP 80 and 443 in the provider's firewall (Hetzner: **Firewalls** in the Cloud Console; DigitalOcean: **Networking → Firewalls**; Linode/Akamai: **Cloud Firewall**). Then rerun `./luma verify production`. |
| `verify production` prints `fetch failed` and `... presented a certificate that is not valid for it yet` | Right after the first deploy, Let's Encrypt is still issuing the certificate. If it stays, the domain does not point at this server or port 80 is closed. | Wait a few minutes and rerun `./luma verify production`. A confirmed deploy already waits up to 120 seconds for the first answer. |
| The certificate never appears and Traefik's log mentions `too many certificates already issued` or `rateLimited` | Let's Encrypt's rate limit: too many certificates were requested for this name recently (for example after repeated reinstalls or a domain shared by many hosts, such as a busy DuckDNS name). | Wait; the limit clears within a week. Do not redeploy in a loop. Check with `docker compose -p luma logs --tail 100 traefik`. |
| The site works in a browser but the Pin never connects, or `verify` fails on the Pin certificate checks | The domain is behind Cloudflare's proxy (orange cloud) or a Cloudflare Tunnel. | Turn the proxy off (grey cloud, "DNS only") and remove the tunnel. The Pin reaches your public IPv4 directly, so nothing may sit in between. Tailscale Funnel and ngrok do not work for the same reason. |
| The server has no public IPv4 (IPv6-only plan, or a home connection behind CGNAT) | Setup's `pin` profile needs a public IPv4 the Pin can reach. | Choose a plan with a public IPv4 (Hetzner adds one for a small monthly fee if you unticked it). A home server behind CGNAT cannot host the Pin edge. |
| Preflight reports ports 80 or 443 in use | Another web server (Nginx, Apache, Caddy, another Compose stack) is listening. | Stop or reconfigure it, then rerun `./luma doctor production`. Luma never stops an unrelated listener. To keep other sites, see [Serve other hostnames through Luma's Traefik](../docs/operations.md#serve-other-hostnames-through-lumas-traefik-optional). |

## Deploying and running

| Symptom | Cause | Fix |
| --- | --- | --- |
| Preflight says a release defines data volumes differently | Docker Compose would delete and recreate those volumes empty. Luma stops before changing anything. | Keep your current release running, take `./luma backup production`, and report the release. |
| Deployment or verification stops | A service did not start. | Run `./luma verify production`; it names each service that is not running. `docker compose -p luma logs --tail 100 SERVICE` shows why. Fix the cause and rerun `./luma deploy production --confirm`; existing configuration and started containers are preserved. |
| Center shows an old release, or `environment` is not `production` | The old containers are still running, or the browser cached the old page. | Run `./luma verify production`, then open `https://YOUR_DOMAIN/api/version`. It must show the release you deployed and `"environment":"production"`. If it shows the old one, rerun `./luma deploy production --confirm` from the new release's folder. |
| `onboard production` stopped with `Onboarding stopped during stage ...` | One of its five stages failed; the message names the reason and a `Recovery check` command. | Run the named recovery command, fix what it reports, then rerun the `Safe retry` command it printed. No Pin was contacted. |
| Center keeps asking you to sign in again | Cosmos refused the identity your session carries. | `docker logs luma-ai-bus-1 2>&1 \| grep "rejected a web Bearer"` names the check. `token has no sub claim` means the realm predates this release's policy: run `./luma deploy production --confirm`, then sign in again. |
| Sign-in says it is unavailable, or asks you to wait | "Unavailable": Keycloak did not answer. "Wait": too many wrong passwords. | Check `docker logs luma-keycloak-1`. For the wait, wait the time it names (at most 15 minutes) or reset the password with `./luma reset-password production --confirm` ([Reset a lost password](../docs/operations.md#reset-a-lost-password)). |
| You lost the owner password | No email reset is configured. | On the server: `./luma reset-password production --confirm`. The new one-time password goes to `~/.config/luma/production/first-login.txt`; show it once with `cat`, sign in, change it in **Settings → Passcode & password**, delete the file. |
| Assistant, search, maps, or speech is **Unavailable** or **Needs setup** | The provider is not configured, or its key is wrong. | Open **Settings → Assistant & voice**, complete the field marked **Needs setup**, choose **Test**, then **Save changes**. Changing providers never needs a Pin reinstall. |

## Updates

| Symptom | Cause | Fix |
| --- | --- | --- |
| An update was rolled back: **Settings → Advanced → Software updates** says **The update to Luma … failed and your previous version … was restored** | A step of the nightly update failed after the new release was set up. The server restored the backup it took just before, started the previous release again, and verified it. Nothing is lost. | **Last update** names the step and the reason; `journalctl -u luma-update.service` shows the whole run. The server does not try that release again by itself. Fix the cause, then retry once at a terminal: `~/.local/share/luma/operators/current/luma update production`. |
| Automatic updates are off on my existing server | A server set up before automatic updates existed keeps them off until you choose. | Run `~/.local/share/luma/operators/current/luma setup production --auto-updates on`. If it answers that the timers start once the server runs a release in `~/.local/share/luma/operators`, the server was installed from the five release files; the timers arrive with its first `./luma update production` ([Update Luma](update.md#update-now)). |
| `doctor production` says `the timers do not match LUMA_AUTO_UPDATES` | The systemd timers are missing or disagree with your saved choice, usually because setup could not use `sudo`. | Rerun the command doctor names, `./luma setup production --auto-updates on` (or `off`), from `~/.local/share/luma/operators/current` as a user who can use `sudo`, or run the commands it prints as root. |

## Connecting the Pin from the browser

| Symptom | Cause | Fix |
| --- | --- | --- |
| Center shows **This browser can't reach your Pin** or "WebUSB is not supported in this browser" | You are using Safari, Firefox, a mobile browser, or a non-HTTPS address. | Open Center in desktop Chrome, Chromium, or Edge, at its `https://` address. |
| The browser shows no USB chooser after **Connect over USB** | The Pin is locked, still booting, or the cable carries power only. | Unlock the Pin, wait a few minutes after switching it on, use a known-good USB-C **data** cable in a direct port (no hub). On Linux, set up the udev rules ([Prepare Linux USB permissions](../docs/connect-a-pin.md#prepare-linux-usb-permissions)). |
| The chooser is empty on Windows | Windows needs a compatible Android/WinUSB driver before a browser can claim the device. | Install the Android USB driver, replug the Pin, and try again. |
| `Unable to claim interface` | Another program owns the Pin's USB ADB interface. | Close Android Studio, scrcpy, and phone-management tools, run `adb kill-server` if you have ADB installed, unplug the Pin, reconnect it, and choose **Connect over USB** again. |
| Center says `cmd: Can't find service: package` | Android on the Pin has not finished starting. | Unlock the Pin, reboot it once, wait for the stock screen to settle, and choose **Check again**. Center makes no changes while this service is unavailable. |
| **Checking your Pin…** never finishes; the Pin shows a prompt | The Pin is asking whether to allow this computer. | Look at the Pin's Laser Ink display and accept the prompt. |
| Center says the Pin reconnected as a different device | Another Android device is plugged in, or a different Pin. | Stop. Disconnect other Android hardware and restart the step with the original Pin. Center never switches serials on its own. |
| USB is connected but Center says "Luma isn't responding yet" | Device Services on the Pin has not started, or the install did not finish. | Keep the Pin unlocked and connected; Center keeps trying. Use **Check connection** to retry now. If it stays, open **Software & updates**, which offers **Repair**. |
| After the install the Pin shows its lock screen and Center waits | The Pin restarted and is locked; Center continues only on an unlocked Pin. | Unlock the Pin with the passcode it had before Luma (a Pin that never finished Humane's setup has none yet and shows no lock screen), keep it on the cable, and let Center continue. |
| Center says **Your Pin is newer than your server** | You updated the Pin from a newer release than the server runs. | Update the server to the matching release ([Update Luma](update.md)). Reinstalling here would downgrade the Pin. |
| Guided setup shows **Set your Pin passcode** at stage 5 or 6 | This Pin has not finished its own first setup, and no passcode is set in Center yet. | Open **Settings → Passcode & password**, choose four digits, then return to Guided setup and enter the same digits under **Pin passcode**. |

## Ask for help

`./luma support-bundle` writes a redacted diagnostic file, readable only by
you, from a fixed list that leaves out secrets, serials, and wearer data. It
prints `Created redacted support bundle: PATH`. Attach that file instead of
logs when you report a problem.
