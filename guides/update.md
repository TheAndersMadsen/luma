# Update Luma on your server and Pin

Your server keeps itself up to date, and Center tells you when your Pin has
new apps to install. This guide shows what that looks like, how to update
right away, and how to update the Pin. It also covers updating a server by
hand, as a fallback. [Update Luma](../docs/operations.md#update-luma) and
[Back up and restore](../docs/operations.md#back-up-and-restore) in the docs
stay the reference. Unfamiliar terms are in the [glossary](glossary.md).

## Your server updates itself at night

Every hour your server asks its [update source](glossary.md), the Luma Center
you installed it from, whether a newer Luma release exists. When one does,
you see a banner at the top of Center. Only the owner who runs the server sees
it.

With automatic updates on (the default for a new server), the banner says
**Luma NEW is available** and **It installs itself tonight; your Center may
pause for a minute.**

Between 03:00 and 05:00 server time, the server downloads the release, checks
the maintainer's signature on it, and takes a backup. Then it sets up and
deploys the new release and checks that it works. Center pauses briefly while
it restarts. You do nothing. No GitHub token is needed, because Luma's
releases are public. (A private fork's server downloads with the token that
`./luma registry login` saved.)

With automatic updates off, the banner shows the one command to run instead,
`./luma update production` (see [Update now](#update-now)).

To see where things stand, open **Settings → Advanced → Software updates**.
It shows:

- the release your server runs
- the newest release and its notes (**What's new**)
- the update source
- whether automatic updates are on
- what the last update did

**Check now** asks the update source again.

### If an update fails

The server puts itself back. It restores the backup it took just before the
update, starts your previous release again, and checks it. Nothing is lost.
**Last update** then says
**The update to Luma … failed and your previous version … was restored**,
with the step that failed. The server does not try that release again on its
own. Fix the cause and run [Update now](#update-now) once.

### Turn automatic updates on or off

A server set up before automatic updates existed has them off. To turn them
on, run this on the server:

```sh
~/.local/share/luma/operators/current/luma setup production --auto-updates on
```

You see: `Automatic updates are on: this server installs newer releases
between 03:00 and 05:00.`

To turn them off, use `--auto-updates off`. Center still tells you about new
releases.

> **If it says `the timers start once this server runs a release in ...`:**
> the server was installed from the five release files, so its release lives
> in `~/luma-VERSION`. The timers arrive with its first update. Run
> [Update now](#update-now) from that release's operator folder
> (`./luma update production`).
>
> **If it says installing the systemd timers needs root:** run the commands
> it prints as root (`sudo -i`), once.

## Update now

Sign in to the server over SSH and run:

```sh
~/.local/share/luma/operators/current/luma update production
```

You see: `Luma NEW is available (this server runs OLD).`, the release notes,
and `Install Luma NEW now (you have OLD)? This backs up the server first, then
deploys the new release; Center pauses for a few minutes. [y/N]`.

Type `y`. It ends with `Luma NEW is installed and passed production
verification (backup: ...)` and a line saying whether the Pin apps changed.

To only look, add `--check`. It prints whether a newer release exists and
changes nothing.

> **On a private fork:** the download needs the token that
> `./luma registry login --username YOUR_GITHUB_USER` saved (a classic token
> with `repo` and `read:packages`). Run that once if none is saved.
>
> **If it stops with `Update stopped` and `this is the Luma ... operator in
> ..., but this server's operator is ...`:** you ran an older copy. Use the
> command on its `Safe retry:` line.
>
> **If a step fails:** the message names the step, the state of the server,
> the backup it took, and a `Safe retry:` line. Unlike the nightly update, an
> update you started does not put the old release back on its own. The
> `Safe retry:` line gives both ways forward. You can fix the cause and deploy
> again, or run the exact commands it lists to stop Luma, restore that backup,
> and start the previous release again.

## Update your Pin

When a release carries newer Pin apps, the banner says **New Pin apps are
ready**. It shows only once this browser has read your Pin over USB before.

You need the interposer, a USB-C data cable, and desktop Chrome or Edge
([Connect your Pin](connect-your-pin.md)). Choose **Update your Pin** in the
banner, or open **Settings → Advanced → Software & updates**. On
**Settings → My Ai Pin** it is the **Check for updates** link. The page shows
three steps:

1. **Place your Pin on the interposer and plug it into this computer.**

2. **Connect over USB**, then choose your Pin in the list your browser shows.

   You see: step 2 says **Connected.**, and step 3 names the release, such as
   **Update to 2026-09-29.2**. If it says **Your Pin is up to date**, you are
   done.

3. Choose **Update to …**.

   You see: **Update this Pin?**, naming the release and the serial.

   **Decision:** confirm only if the serial is your Pin's. A progress bar
   runs for a few minutes and the Pin restarts. Keep the tab open, the Pin
   unlocked, and the cable connected until the page says **Your Pin is up to
   date**.

> **If step 3 says Unlock your Pin:** enter your passcode on the Pin, leave
> it on the cable, and choose **Check again**.
>
> **If the install did not finish:** the page offers **Repair**. Run it from
> the same page with the same Pin.

Then open **Settings → Set up a Pin** (Guided setup) and make one voice
request. A new release asks for the final **Confirm microphone, speaker &
gesture** once more, because that confirmation is tied to the installed
release.

## Update the server by hand

Use this when the server has no update source, runs a release from before
`update production` existed, or you prefer to install the files yourself.

**What you need**

- [ ] The new release's five files from the maintainer (see
      [Get the release files](server-from-nothing.md#get-the-release-files)).
- [ ] SSH access to the server.

It takes about 20 minutes. Center is briefly unavailable while the containers
restart.

Below, `NEW` stands for the new version, the one in the release's
`luma-NEW.release.json` file name (for example `0.3.17`). `OLD` stands for the
one your server runs.

### Part A: Put the new release on the server

1. On your own computer, copy the new folder to the server:

   ```sh
   scp -r luma-NEW root@SERVER_IP:
   ```

   You see: five files copied to 100%.

2. On the server, check and unpack it, then enter its operator folder:

   ```sh
   cd ~/luma-NEW
   sha256sum --check SHA256SUMS
   tar -xzf luma-operator-*-linux.tar.gz
   cd luma-operator-*/
   ```

   You see: `OK` after every file, and a prompt ending in
   `luma-operator-NEW#`. Every `./luma` command from now on runs from this
   newest folder. The old folder stays on disk and is never used again.

   <details>
   <summary>Optional: check the maintainer's signature with cosign</summary>

   If `cosign` is installed, run this from `~/luma-NEW`:

   ```sh
   cosign verify-blob --key luma-operator-*/platform/distribution/release-signing.pub --bundle SHA256SUMS.sigstore.json --insecure-ignore-tlog SHA256SUMS
   ```

   It prints `Verified OK`, which proves the maintainer signed the checksums.

   </details>

> **If any file is `FAILED`:** copy the folder again. Never continue from a
> failed check.

### Part B: Back up first

1. Take a backup with the **new** release's command. It backs up the release
   your server still runs:

   ```sh
   ./luma backup production
   ```

   You see: services pause for seconds, then
   `Backed up the server running release ... with Luma NEW (release ...) to
   /root/.local/share/luma/backups/luma-backup-...`. After that come the list
   of what the backup holds, `It holds every key and secret of this server and
   is readable only by you.`, and an `scp -r ...` line to run on your own
   computer.

2. On your own computer, run that printed `scp -r` line to copy the backup
   off the server.

   You see: a folder named `luma-backup-...` on your computer. Keep it as
   private as a password.

### Part C: Update the server

1. Stage the new release's Pin archive and carry your settings over:

   ```sh
   ./luma setup production --pin-release-archive ../luma-pin-*.tar.gz
   ```

   You see: `Production configuration is ready for https://YOUR_DOMAIN
   (optional profiles: ...)`, then `NEXT ./luma doctor production`. Setup
   reuses your domain, emails, features, and secrets. It asks nothing.

> **If it says the Pin release `does not match operator release Pin`:** the
> server already has newer Pin apps than this release. Use the newest
> release.
>
> **If it says this operator is older than what the server runs:** you are in
> an old folder. `cd` into the newest release's operator folder.

2. Deploy:

   ```sh
   ./luma deploy production --confirm
   ```

   You see: Docker pulls the new images and the containers restart (Center is
   unavailable for a moment). Any sign-in policy changes are printed one per
   line. It ends with `Luma release ... is deployed and passed production
   verification.`

> **If Docker cannot pull the images:** Luma's images are public, so check the
> server's network first. On a private fork, the GitHub token has probably
> expired. Create a new classic token with `read:packages`, run
> `./luma registry login --username YOUR_GITHUB_USER`, paste it at
> `Password:`, and run the deploy again.
>
> **If the deploy stops for another reason:** run `./luma verify production`.
> It names the service that is not running, and
> `docker compose -p luma logs --tail 100 SERVICE` shows why. Fix it and run
> the deploy again. The configuration and the containers that started are
> kept.

3. Verify:

   ```sh
   ./luma verify production
   ```

   You see: `Verified healthy services, Center identity and public discovery,
   ...`. In a browser, `https://YOUR_DOMAIN/api/version` shows the new
   release and `"environment":"production"`.

> **If Center still shows the old release:** reload the page without cache,
> then check `/api/version`. If that still names `OLD`, run
> `./luma deploy production --confirm` again from the new folder.

The server is updated. If the release notes name newer Pin apps,
[update your Pin](#update-your-pin).

## Roll back: restore the backup

If the new release does not work for you, put the server back exactly as it
was, from the backup of Part B.

A backup restores only with the release that made it. Part B made it with the
**new** release's command, so the restore runs from the new folder
(`~/luma-NEW`). The backup holds the configuration from before the new setup
ran. The old release's folder, still unpacked in `~/luma-OLD`, then deploys
it.

1. Stop Luma:

   ```sh
   docker stop $(docker ps --quiet --filter label=com.docker.compose.project=luma)
   ```

2. From the new release's operator folder, preview the restore:

   ```sh
   cd ~/luma-NEW/luma-operator-*/
   ./luma restore production --from ~/.local/share/luma/backups/luma-backup-NEW-...
   ```

   You see: what it will create or replace, ending with `Then: nothing is
   deployed. The configuration is ...`. Then comes `Nothing was changed. To
   restore, run:` and the same command with `--confirm`.

3. Run it with `--confirm`:

   ```sh
   ./luma restore production --from ~/.local/share/luma/backups/luma-backup-NEW-... --confirm
   ```

   You see: `Restored the configuration, keys, and secrets.`, `Restored the
   volumes.`, and `Restored the database. Nothing was deployed: ...`. Then
   comes `To start the server as it was, run from the folder of ...:` and a
   `./luma deploy production --confirm` line.

4. Start the old release from its own folder:

   ```sh
   cd ~/luma-OLD/luma-operator-*/
   ./luma deploy production --confirm
   ```

   You see: `Luma release ... is deployed and passed production
   verification.`, naming the old release.

The Pin keeps working after a restore without reinstalling, because its keys
and account come back with the backup. If you also updated the Pin to the
newer apps, Center shows **Your Pin is newer than your server** until you
update the server again.
