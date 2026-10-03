# Use TIDAL on your Ai Pin

TIDAL has two separate setup roles:

1. The **server operator** registers one TIDAL developer client and configures
   its credentials on the Luma server.
2. Each **wearer** signs in to their own TIDAL account in Center and chooses
   TIDAL for their Pin.

Do not send the client secret to a wearer, and do not ask the operator for the
wearer's TIDAL password.

> Provider requirements, policies, and prices were checked in October 2026.
> TIDAL can change them; check the linked official pages before paying or
> requesting approval.

## What this enables

- Search TIDAL's catalog from Center.
- Ask the Pin to play TIDAL tracks, albums, artists, and playlists **after
  TIDAL grants the developer client the required playback access**.
- Save the currently playing track to the wearer's TIDAL collection.
- Pause, resume, seek, skip, and continue a queue in the Pin's stock music
  player.

Linking and catalog search are not evidence that full-track playback is
approved. An ordinary developer client can reach those steps and still be
refused when Luma requests audio.

## Before you start

### Server operator

- [ ] The server has the `pin` and `spotify` optional features. The feature is
  named `spotify`, but it enables the whole Luma music stack.
- [ ] You can sign in to the
  [TIDAL Developer portal](https://developer.tidal.com/) and create or manage
  an app.
- [ ] You know the public HTTPS origin of Center, for example
  `https://center.example.com`.
- [ ] TIDAL has granted the app the playback access required for full tracks.
- [ ] TIDAL has given express written approval for the intended voice-control
  use. TIDAL's published
  [Developer Guidelines](https://developer.tidal.com/documentation/guidelines-developer-guidelines-2_0)
  list voice-control or voice-recognition functionality as prohibited without
  that approval.

### Wearer

- [ ] You have a TIDAL account and an active subscription suitable for
  full-track playback.
- [ ] You can approve TIDAL's official authorization screen yourself.
- [ ] The Ai Pin is paired with Center and online before you select TIDAL for
  playback. You may link the account before pairing it.

## Operator setup: register and configure the client

Only the operator performs this section.

1. Sign in to the [TIDAL Developer portal](https://developer.tidal.com/) and
   open **Dashboard**.
2. Create an app, or open the app TIDAL approved for this Luma installation.
   Use a recognizable name such as `Luma personal music`.

   **You see:** the app's client ID, its redirect-URI settings, and—depending on
   the client type—a client secret. TIDAL's
   [authorization documentation](https://developer.tidal.com/documentation/api-sdk/api-sdk-authorization)
   identifies these as the app credentials used by its OAuth 2.1 authorization
   code flow.

3. Register this exact redirect URI, replacing only `YOUR_DOMAIN`:

   ```text
   https://YOUR_DOMAIN/api/settings/services/music/tidal/callback
   ```

   It must use the same public Center origin configured during Luma setup. Do
   not add a trailing slash.

4. Request or confirm the permissions and provider approval needed by the app.
   Luma's default OAuth scope request is:

   ```text
   user.read collection.read collection.write search.read playback
   ```

   Leave `TIDAL_SCOPES` unset unless TIDAL explicitly gives this client a
   different supported scope set. Reconnect every wearer after scopes change.

5. On the server, change to the current operator release and store the client
   ID. The prompt hides what you type:

   ```sh
   ./luma config set TIDAL_CLIENT_ID --stdin
   ```

6. If the developer portal issued a client secret for this client, store it at
   the next hidden prompt. Skip this command for a public client with no secret:

   ```sh
   ./luma config set TIDAL_CLIENT_SECRET --stdin
   ```

7. Validate and apply the configuration:

   ```sh
   ./luma config check
   ./luma deploy production --confirm
   ./luma verify production
   ```

   **You see:** the configuration check passes, deployment completes, and live
   verification reports the intended release. In Center, **Connect TIDAL** is
   now enabled instead of `Configure a TIDAL developer client first.`

`TIDAL_COUNTRY_CODE` is normally left unset: Luma uses the country on the
wearer's grant or reads it from TIDAL. An operator may set an ISO 3166-1
two-letter override such as `DK` only when TIDAL requires a fixed catalog
country for this client:

```sh
./luma config set TIDAL_COUNTRY_CODE DK
```

Run the same check, deploy, and verify commands afterward.

## Wearer setup: connect the account

1. Sign in to Center as the wearer.
2. Open **Settings → Music**, or go directly to
   `/settings/account/music` on your Center.
3. In **Play music from** (or **Provider account** before a Pin is paired),
   choose **TIDAL**.

   **You see:** the TIDAL panel and an enabled **Connect TIDAL** button. If it
   is disabled, the operator setup above is incomplete.

4. Choose **Connect TIDAL**.

   **You see:** TIDAL's official sign-in and consent page. Center created a
   ten-minute, PKCE-protected authorization attempt and sent the browser there.

5. Sign in to TIDAL yourself, review the app name and requested access, and
   approve it. TIDAL returns the browser to Center's registered callback.

   **You see in Center:** **Connected** and either `TIDAL connected to Center.`
   or `TIDAL connected. Press Save to play from it on your Pin.`

6. If the Pin is not paired yet, pair it now and return to **Settings →
   Music**. Linking alone does not switch playback.
7. Choose **TIDAL** under **Play music from**, then choose **Save**.

   **You see:** `Your Pin will now play music from TIDAL.`

If this account was linked before Luma required `search.read`, reconnect it now
so the new grant includes that scope.

## Verify it

1. Under **Find a song**, enter a song or artist and choose **Search**.

   **You see:** matching TIDAL tracks. This proves authorization and catalog
   access, but not partner playback access.

2. Ask the Pin, “Play *song title* by *artist*.” Confirm a full track plays,
   not a preview or a spoken success followed by silence.
3. Pause and resume, seek near the end, skip, and let the next queued track
   start.
4. Ask the Pin to save the track, then confirm it in TIDAL.
5. Repeat once on Wi-Fi and LTE if you use both, and resume after a long pause.

Only step 2 proves that TIDAL has granted the client working full-track
playback access.

## Cost, approval, and limits

Checked October 2026:

- The public developer pages do not publish a fee for registering a developer
  client. They do not promise full-track playback to every client either.
- TIDAL's US list price was USD 11.99/month for Individual, USD 19.99/month
  for Family, and USD 6.99/month for eligible students. Prices, taxes, trials,
  and availability vary by location; see TIDAL's current
  [Subscription Types](https://support.tidal.com/hc/en-us/articles/115003662825-Subscription-Types).
- TIDAL's published API schema exposes playback behind provider-controlled
  authorization. Luma does not fall back to a preview when full-track playback
  is refused. Review the current
  [TIDAL API schema](https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json)
  and obtain partner playback access before relying on this provider.
- TIDAL's Developer Guidelines require express written approval for voice
  control, restrict playback to official SDK/player paths, and impose other
  content and branding rules. The operator is responsible for obtaining and
  following TIDAL's approval; self-hosting and personal use do not waive it.
- TIDAL Connect hardware integration is separate and is currently limited to
  device partners according to TIDAL's
  [Connect documentation](https://developer.tidal.com/documentation/connect).
  Luma's flow is OAuth plus its provider gateway, not TIDAL Connect pairing.
- Provider requests have a 15-second deadline and bounded responses. A token
  rejected by TIDAL requires reconnecting the account in Center.

## What Luma sends

- The browser is sent to TIDAL with the operator's client ID, the exact Center
  callback URI, requested scopes, a random state value, and an S256 PKCE
  challenge. The client secret, when present, stays server-side.
- TIDAL returns an authorization code to Center. Center exchanges it for access
  and refresh credentials, then stores them through Cosmos, sealed under a
  per-wearer key. The browser cannot read them, Center keeps no wearer
  database, and the Pin never receives them.
- Catalog search sends the query, requested resource types, account grant, and
  country code to TIDAL. Saving sends the selected track identifier under the
  wearer's grant.
- Center resolves TIDAL playback for the authenticated wearer. Provider
  requests and audio use the Pin's active network path, and the Pin receives an
  opaque local stream rather than the OAuth credentials.
- Cosmos stores the active-provider choice separately; **Save** also sends that
  choice and a gateway credential to the paired Pin.

<details>
<summary>Troubleshooting</summary>

### Connect TIDAL is disabled

The Center process has no valid `TIDAL_CLIENT_ID`. Ask the operator to perform
the configuration, deploy, and verification steps above. Do not paste a client
secret into Center's browser UI.

### TIDAL rejects the redirect URI

Compare the developer-dashboard entry character for character with:

```text
https://YOUR_DOMAIN/api/settings/services/music/tidal/callback
```

Use Center's public HTTPS domain, no query string, and no trailing slash. Then
start a new connection; an old authorization URL still contains the old
redirect.

### Center says the sign-in did not finish

The wearer may have cancelled, the ten-minute attempt may have expired, or the
Center sign-in may have lapsed while the browser was at TIDAL. Sign back in to
Center if asked, choose **Connect TIDAL**, and complete one new attempt. Center
abandons the failed pending state rather than leaving the account stuck on
**Connecting**.

### Search is refused

Reconnect the wearer so the grant includes `search.read`. Leave
`TIDAL_SCOPES` unset to use Luma's supported defaults unless TIDAL instructed
the operator otherwise. A previously issued token does not gain a newly
requested scope by itself.

### Search works but playback is refused

This is the expected boundary for an ordinary developer client. Ask TIDAL to
confirm partner playback access and written approval for the voice-control use;
changing the redirect URI, subscription, or Luma scope string cannot grant
provider-side approval. Do not configure a preview fallback.

### The wrong catalog or unavailable tracks appear

Normally Luma reads the account country from TIDAL. If TIDAL instructed the
operator to pin a market, validate `TIDAL_COUNTRY_CODE` as a two-letter code,
redeploy, and reconnect. Availability still depends on TIDAL's catalog rights
for that market.

### The Pin still uses another provider

Connecting TIDAL does not switch playback. Return to **Settings → Music**,
choose **TIDAL**, and choose **Save**. If Center says the Pin is set to another
provider, **Save** is the intended repair.

</details>

## Disconnect or remove TIDAL

### Wearer

1. If TIDAL is current and you want music to keep working, connect another
   provider, select it, and choose **Save** first.
2. Select **TIDAL** and choose **Disconnect**.

**You see:** `TIDAL disconnected.` Luma removes this wearer's pending sign-in,
access token, refresh token, and related TIDAL account data from the sealed
Cosmos record. It does not cancel the TIDAL subscription or delete the account.

For provider-side revocation too, sign in at
[account.tidal.com](https://account.tidal.com/), open **Third-Party Apps**, and
remove the developer app's permission. TIDAL documents that control in
[Manage your TIDAL Account](https://support.tidal.com/hc/en-us/articles/28548632499601-Manage-your-Tidal-Account).

### Server operator

Deleting or disabling the app in TIDAL's developer dashboard affects every
wearer on this Center. To remove Luma's local operator configuration as well,
run each command and press Enter at its hidden prompt to store an empty value,
then deploy and verify:

```sh
./luma config set TIDAL_CLIENT_ID --stdin
./luma config set TIDAL_CLIENT_SECRET --stdin
./luma config check
./luma deploy production --confirm
./luma verify production
```

This disables new TIDAL sign-ins. Each wearer should still use **Disconnect**
first so their sealed grants are removed from Cosmos.
