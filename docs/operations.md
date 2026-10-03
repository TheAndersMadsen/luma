# Run your server

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


Run the `./luma` commands on this page on the server, from the newest
release's `luma-operator-VERSION` folder. That is
`~/luma-VERSION/luma-operator-VERSION` ([Install the release](install.md#2-install-the-release)).
A release that the one-line installer or an update installed lives in
`~/.local/share/luma/operators/VERSION` instead, and
`~/.local/share/luma/operators/current` points at the one your server runs.

If you set the server up with `LUMA_CONFIG_DIR` and `LUMA_DATA_DIR`, export
them first ([Configuration](developers.md#configuration)). To see what this
shell finds and what to do next, run:

```sh
./luma setup status
```

### Update Luma

Your server looks after its own updates. Every hour it asks its **update
source** which release is newest. The update source is a Luma Center: the one
whose installer you used, or, for a server installed from the release files,
the one that release names, unless you chose another. Center asks it too, and
shows the answer to its operator in two places:

- A banner at the top of every page when something is new.
- **Settings → Advanced → Software updates**. It shows the release on your
  server, the newest one available and its notes, the update source, whether
  automatic updates are on, and what the last update did. **Check now** asks
  again.

With automatic updates on, the server installs a newer release by itself
between 03:00 and 05:00, server time. If the server was off that night, the
update runs at the next start. It:

1. Downloads the release from GitHub. Public releases need no token. A
   private fork's server sends the token that `registry login` saved in
   Luma's secrets directory.
2. Checks the maintainer's signature over its `SHA256SUMS` with the key of
   the release you run, and checks every file against `SHA256SUMS`.
3. Backs up the server ([Back up and restore](#back-up-and-restore)).
4. Sets the new release up with your saved values and its Pin apps.
5. Deploys it.
6. Verifies it the way `./luma verify production` does.

Center pauses briefly while the new release starts.

If a step fails after the configuration moved to the new release, the server
puts itself back. It stops Luma, restores the backup it took in step 3,
starts the previous release again, and verifies it. Nothing is lost. The
Software updates page says **The update … failed and your previous version …
was restored**. The server does not try that release again by itself, but it
installs the next newer release as usual. A failure before that point
changes nothing at all.

#### Update now

On the server, run:

```sh
~/.local/share/luma/operators/current/luma update production
```

It says whether a newer release exists, shows its notes, and asks
`Install Luma VERSION now (you have …)? … [y/N]` before the same six steps.
To only look and change nothing, add `--check`. No token is needed. A private
fork's server uses the one that `registry login` saved.

If a step fails here, nothing is put back on its own. The message names the
backup and both ways forward: fix the problem and deploy again, or return to
the previous release as in [Back up and restore](#back-up-and-restore).

`operators/current` points at the release your server is set up for. Every
setup moves it. `update production` refuses to run from any other release
folder and names the right command instead. With a custom `LUMA_DATA_DIR`,
`operators/` is in that folder. A server on a release from before
`update production` existed takes one update [by hand](#by-hand) first.

#### Turn automatic updates on or off

A new server has automatic updates on. A server set up before automatic
updates existed keeps waiting for you until you turn them on:

```sh
~/.local/share/luma/operators/current/luma setup production --auto-updates on
```

`--auto-updates off` turns them off again. The hourly check keeps running
either way, so Center still tells you what is new.

Setup installs two systemd timers: `luma-update.timer` (nightly) and
`luma-update-check.timer` (hourly). It asks for `sudo` when you are not root.
When it cannot, it prints the commands to run as root. `./luma doctor production`
shows both timers and when they run next.

The timers run only a release in `~/.local/share/luma/operators/`, where the
one-line installer and every update put it. A server installed from the five
release files in `~/luma-VERSION` gets the timers with its first update. Until
then, run the update command above yourself when Center says a release is
available.

#### Install new Pin apps

When a release carries newer Pin apps, the update's output names them. The
banner says **New Pin apps are ready** once this browser has read your Pin
over USB.

Install them from Center in desktop Chrome or Edge. Open **Settings →
Advanced → Software & updates**. On **Settings → My Ai Pin** it is **Check
for updates**, and the banner's **Update your Pin** opens it too. Then follow
its three steps:

1. **Place your Pin on the interposer and plug it into this computer.**
2. **Connect over USB**, and choose your Pin in the browser's list.
3. **Update to VERSION**: confirm it for the serial shown. Keep the tab open
   and the Pin unlocked on the cable while it restarts, and wait for
   **Your Pin is up to date**. If the Pin is locked, the step says
   **Unlock your Pin**. Enter the passcode and choose **Check again**.

#### By hand

Without the one-line installer or automatic updates, copy the new release to
its own folder on the server, as in
[Install the release](install.md#2-install-the-release). Then run these
commands, with `VERSION` set to the new release's version. The
[Update](../guides/update.md) guide walks through the same steps.

```sh
cd ~/luma-VERSION
sha256sum --check SHA256SUMS
tar -xzf luma-operator-*-linux.tar.gz
cd luma-operator-*/
./luma backup production
./luma setup production --pin-release-archive ../luma-pin-*.tar.gz
./luma deploy production --confirm
```

The confirmed deploy ends with the checks of `./luma verify production`. It
prints `passed production verification` when the new release is live. You can
run the same check again at any time:

```sh
./luma verify production
```

Take the backup with the new release. Its backup also covers the older
release your server still runs, including one that had no backup command.
Copy the backup off the server ([Back up and restore](#back-up-and-restore)).

Setup reuses your saved domain, addresses, owner, and profiles. It keeps your
secrets and data and stages the release's Pin archive. It refuses a release
whose Pin apps are older than the ones the server already has.

The release images are public, so the deploy needs no registry login. A
private fork whose token has expired runs this again:

```sh
./luma registry login --username YOUR_GITHUB_USER
```

A server-only release leaves the Pin as it is. When a release carries newer
Pin apps, update the Pin in the three steps above.

Keycloak reads the sign-in realm from setup's file only when it first creates
the realm. So every confirmed deploy, by hand or by an update, also brings the
running realm onto the release's policy. It does this through Keycloak's admin
CLI inside its container, and prints each change. The policy is:

- Center's access tokens carry the account ID (`sub`).
- First and last name are optional.
- Every account holds Keycloak's default roles. Its account page, where
  Center sends you to change your password, needs them.
- Repeated failed sign-ins lock an account for a while: up to 15 minutes,
  never permanently.
- Center stays signed in with the session policy below.
- **Forgot password** appears only when you have given Keycloak an SMTP
  server to send the email.

`./luma verify production` reads the realm without changing it. It fails when
Center's access tokens would carry no `sub` or when its session policy has
drifted. For contributors, `./luma up` applies the same policy to the local
development Keycloak once it is healthy.

#### Run your own update source

Any Luma Center is an update source. Its public `/api/version` names the
release it runs, with its Pin apps and notes. That is the manifest a server
following it compares with its own release. The server then downloads that
release from GitHub. It installs it only when the release comes from the same
GitHub repository and carries a signature from the same release signing key
as the release it runs.

To point a server at another Center, run this from `operators/current`
(guided setup asks too):

```sh
./luma setup production --update-source https://CENTER
```

Software updates shows the source in use.

A fork, or anyone publishing their own releases, does this:

1. Edit `platform/distribution/update-source.json` to
   `{"origin": "https://CENTER"}`, and change the matching
   `LUMA_UPDATE_SOURCE_DEFAULT` line in `bootstrap`.
2. Make its own signing key with `./luma release keygen`.
3. Run `bun platform/setup/generate.mjs --write`. It checks that the two
   origins agree.
4. Commit the result.

A fork in another GitHub repository also names that repository in
`REPOSITORY` in `bootstrap`. In `platform/distribution/release-proof.mjs` it
names it in `repository` and in the release asset URL pattern of
`allowedAssetDeliveryUrl`.

To publish, the fork runs the command below
([Publish a release](developers.md#publish-a-release)), creates the GitHub
release, and deploys the release to its own Center. From then on, every
server following that Center sees it within the hour.

```sh
./luma release publish --version X.Y.Z --notes FILE --confirm
```

Servers installed from that Center's `/install.sh` or `/cloud-init.yaml`
follow it automatically, because the Center writes its own address into the
installer it serves.

### Stay signed in to Center

Center saves your sign-in on this browser and renews it quietly when you
return. This works after you close the browser or restart the server, too.

This is Luma's own behavior. Keycloak keeps ordinary, revocable sessions for
ten years, because its normal session timeouts cannot be set to infinity.
Center's browser cookies are encrypted and HTTP-only. They last up to 400 days
and renew on use. Browsers may remove them sooner when you clear browsing data
or use private browsing.

Access tokens and Center's authorization check still last only 15 minutes.
Signing out ends the Keycloak session. An operator password reset ends all of
the account's sessions. Revoked access stops working within 15 minutes.

If you do need to sign in again, choose **Reconnect**. Sign-in opens over your
current page, so unfinished edits stay in place. After signing in, review your
edit and save it yourself. Center never repeats a failed write automatically.
A temporary sign-in service outage offers **Try again** and keeps your saved
sign-in. The first visit after upgrading an already expired session may need
one fresh sign-in, because an expired Keycloak grant cannot be restored.

### Back up and restore

A backup holds everything Luma cannot recreate:

- The database, with every account, note, contact, and setting.
- The Cosmos state, with its key material and capture files.
- Center's data.
- The Pin bridge identity.
- The production configuration, with its CA roots and keys.
- `runtime.env`, with every secret, including the seed behind Pin passcodes.
- The verified Pin release.

Without the roots and the seed, every Pin would have to be connected again
over USB.

Run the backup from the newest release's folder. It backs up the release your
server runs, even an older one this release is about to replace:

```sh
./luma backup production
```

Luma's services pause while it copies. This usually takes seconds, or longer
with many captures. Nothing restarts, and Traefik keeps serving your other
hostnames.

The backup is a new folder under `~/.local/share/luma/backups/`, or where
`--output DIR` says, readable only by you. Its `manifest.json` names the
release that made it, the release the server ran, and the SHA-256 of every
file. The command prints no secret.

> [!WARNING]
> The backup folder holds every key and secret of the server. Keep it as
> private as a password.

Every [update](#update-luma) takes its own backup first, named
`luma-update-OLD-to-NEW-TIME`, in the same folder. After a successful update,
Luma keeps the three newest of those and deletes older `luma-update-*`
folders. Backups you take yourself are never deleted.

A backup on the server's own disk is lost with the server, so copy it off. The
backup prints the exact command to run on your own computer, such as:

```sh
scp -r you@203.0.113.10:/home/you/.local/share/luma/backups/luma-backup-0.3.0-20260923T101500Z .
```

It names the server by the public IPv4 set for the Pin, because a domain
behind a proxy such as Cloudflare does not carry SSH. Without that address it
prints `<your-server>`. Put in the address you use for SSH.

To restore onto the same server or a new one, use the release the backup names
(`0.3.0` above):

1. On the same server, stop Luma first:

   ```sh
   docker stop $(docker ps --quiet --filter label=com.docker.compose.project=luma)
   ```

   On a new server, point the domain at it and
   [prepare the server](install.md#1-prepare-the-server). Then copy, check,
   and unpack that exact release as in
   [Install the release](install.md#2-install-the-release). A private fork
   also runs `./luma registry login --username YOUR_GITHUB_USER`.
2. Copy the backup folder onto the server. For example, from your computer:

   ```sh
   scp -r luma-backup-0.3.0-20260923T101500Z you@203.0.113.10:
   ```

3. Run these from the release folder:

   ```sh
   ./luma restore production --from ~/luma-backup-0.3.0-20260923T101500Z
   ./luma restore production --from ~/luma-backup-0.3.0-20260923T101500Z --confirm
   ```

The first command changes nothing. It checks every file's SHA-256, the
release, and that no Luma is running. Then it prints what it will create or
replace. `--confirm` puts back the configuration, volumes, and database, then
runs `./luma deploy production --confirm`.

Restore refuses a running Luma and a server set up for another release.
Restore with the backup's release, then [update](#update-luma). A backup taken
before the new release's setup ran holds the older release's configuration.
Restoring it puts the server back as it ran without deploying, and prints the
command that starts it from the older release's folder.

Pins keep working after a restore without reinstalling, because their CA roots,
keys, and accounts come back with it. A Pin reaches the server at the public
IPv4 address saved in the backup. If the new server has another address, run:

```sh
./luma setup production --public-ip NEW_IPV4
./luma deploy production --confirm
```

Then connect each Pin to Cosmos again in **Settings → Advanced → Connect to
your server**.

### Reset a lost password

Center's sign-in has no email reset unless Keycloak has an SMTP server. If you
lose the owner password, run this on the server:

```sh
./luma reset-password production            # shows what it will do
./luma reset-password production --confirm
```

It gives the first operator a new random password, clears any lockout from
failed sign-ins, and signs that account out everywhere. The new password goes
to `~/.config/luma/production/first-login.txt`, readable only by you, like the
first one. It is never printed. Show it once with `cat`, sign in, change it in
**Settings → Passcode & password**, then delete the file.

Center allows 5 failed sign-ins per account and 20 per network address in 15
minutes. After that it answers with how long to wait, and Keycloak adds its
own temporary lockout. The reset clears Keycloak's lockout but not Center's
wait. If Center already asked you to wait, sign in once the wait has passed
(at most 15 minutes).

### Serve other hostnames through Luma's Traefik (optional)

Luma's Traefik owns ports 80 and 443. To keep serving other HTTPS hostnames
from the same server, write their routes to
`~/.config/luma/production/traefik-extra.json` (mode 0644, no secrets). The
file is Traefik dynamic configuration in plain JSON. Traefik refuses
backslash escapes and empty sections, so leave them out. The file may contain
only these:

| Key | Rules |
| --- | --- |
| `http.routers` | Named `extra-…`. Each has `"entryPoints": ["websecure"]`, a `rule` of one or more ``Host(`name`)`` joined by `\|\|`, a `service` from the same file, an optional `priority` from 1 to 1000, and `tls` set to `{}` or `{"certResolver": "letsencrypt"}`. |
| `http.services` | Named `extra-…`. Each is `{"loadBalancer": {"servers": [{"url": "h2c://app:9100"}]}}` with 1 to 8 `http://`, `https://`, or `h2c://` URLs without a path, and an optional `passHostHeader`. |
| `tls.certificates` | Entries whose `certFile` and `keyFile` are under `/etc/traefik/extra-certs/`. |

A router cannot claim Luma's domain or the Pin's hostnames. A service cannot
point at one of Luma's own services: `center`, `keycloak`, `ai-bus`,
`postgres`, any other service in Luma's Compose files, or a `cosmos-…` or
`luma-…` name. Luma routes those itself.

If Traefik cannot load the file, it drops every route, Center and the Pin
included. So `doctor` and `deploy` check the file before they render or
restart anything. They and `config check` name the file and key of every
problem. Setup never writes this file, so rerunning setup fixes nothing.
Correct the file, then apply it:

```sh
./luma deploy production --confirm
```

To reach containers of another Compose stack, name its existing Docker
networks, comma-separated, and Traefik joins them:

```sh
./luma config set LUMA_TRAEFIK_EXTRA_NETWORKS NETWORK
```

`doctor` fails when one of these networks is missing. It also fails when a
container on one answers to a name Luma's Traefik uses for its own services
(`center`, `keycloak`, `ai-bus`, `connectivity`, `edge`), because Docker would
send Luma's traffic to that container.

For certificates from files, place them in
`~/.config/luma/production/traefik-extra-certs/` (directories 0755, files 0444,
no symbolic links). Traefik sees that directory read-only at
`/etc/traefik/extra-certs`. After a renewal, replace the files and run:

```sh
docker kill --signal HUP luma-traefik-1
```

Traefik reloads its file configuration, certificates included, without
restarting.

### Public verification and agent discovery

Center publishes a small set of URLs that need no sign-in. They contain no
wearer data. Release checks, search engines, and setup agents use them:

| URL | Purpose |
| --- | --- |
| `/api/version` | Product, immutable release ID, and runtime environment |
| `/api/pin/releases/current` | Current verified five-APK release manifest, when active |
| `/openapi.json` | Typed OpenAPI 3.1 contract for public read operations |
| `/llms.txt` | Concise when-to-use instructions and canonical links |
| `/sitemap.xml` and `/robots.txt` | Public page discovery and crawler policy |

There are no public content pages. `/` is the app itself: the dashboard for a
signed-in session, and sign-in for everyone else. Unknown paths return HTTP 404
rather than the app shell, in Markdown when requested with
`Accept: text/markdown`. Public API responses include `RateLimit-Policy` and
`RateLimit`. A 429 also includes `Retry-After`.

Cosmos itself answers only two public HTTPS routes:

- The Pin's capture upload, `PUT /capture/<capability>`. The single-use
  capability in the path authorizes it.
- The signed device status report.

Capture reads stay on the internal network behind a verified wearer session.
The edge removes `X-Forwarded-Client-Cert`, `X-Cosmos-Edge-Token`, and
`X-Cosmos-Web-Projection-Token` from every public request. Cosmos believes an
asserted device identity only beside the private edge proof. It never treats
that identity as a signed-in wearer, and it refuses an unidentified capture
read with 401. The loopback `development-insecure` profile is the one
exception: it believes the asserted identity and serves an unidentified read
from a demo account.

`./luma verify production` checks that a forged upload capability is refused
and that a public capture read naming a wearer is not answered.
