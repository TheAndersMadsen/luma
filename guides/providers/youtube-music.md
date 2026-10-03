# Use YouTube Music on your Ai Pin

YouTube Music uses a Google device-code sign-in in Center. Luma supplies the
sign-in client: neither the server operator nor the wearer creates a Google
Cloud project, OAuth client, client secret, or redirect URI.

> Provider requirements and availability were checked in October 2026. Google
> can change them; check the linked official pages before subscribing.

## What this enables

- Ask the Pin to play public YouTube Music tracks, albums, artists, and public
  playlists.
- Search the YouTube Music catalog from Center without starting playback.
- Save the currently playing song to the signed-in account.
- Pause, resume, seek, skip, and continue a queue in the Pin's stock music
  player.

Center handles account and catalog operations. Player requests and audio leave
through the Pin's current Wi-Fi or LTE connection, then feed the stock player
through a local stream.

## Before you start

- [ ] Your Luma server was installed with both the `pin` and `spotify`
  optional features. The feature is named `spotify`, but it enables Luma's
  whole music stack, including YouTube Music.
- [ ] You can sign in to Center as the wearer who will use the account.
- [ ] You have a Google account that can use YouTube Music in your region.
- [ ] You can open Google's activation page on a phone or computer and approve
  access yourself.
- [ ] To choose YouTube Music as the Pin's playback provider, the Pin is paired
  with Center and online. You may link the Google account before pairing it.

YouTube Music has an ad-supported tier, so Luma does not require a paid
membership. Google describes the free and Premium differences in
[What is YouTube Music?](https://support.google.com/youtubemusic/answer/6313529?hl=en).

## Connect the Google account

1. Sign in to Center as the wearer.
2. Open **Settings → Music**, or go directly to
   `/settings/account/music` on your Center.
3. In **Play music from** (or **Provider account** when no Pin is paired),
   choose **YouTube Music**.

   **You see:** the YouTube Music panel and a **Connect YouTube Music** button.

4. Choose **Connect YouTube Music**.

   **You see:** a Google verification URL, a short device code, its remaining
   lifetime, and **Waiting for sign-in…**. A second click or another open
   Center tab shares this pending sign-in rather than creating a different one.

5. Open the displayed verification URL on your phone or computer. Enter the
   displayed code, choose the Google account, review the request, and approve
   it. Do not give the Google password to Center or the operator.
6. Return to Center and wait for its automatic status check.

   **You see:** **Connected** and either `YouTube Music connected to Center.`
   or `YouTube Music connected. Press Save to play from it on your Pin.`

7. If the Pin is not paired yet, pair it now and return to **Settings →
   Music**. Account linking itself does not select a playback provider.
8. Choose **YouTube Music** under **Play music from**, then choose **Save**.

   **You see:** `Your Pin will now play music from YouTube Music.`

## Verify it

1. Under **Find a song**, search for a public song and choose **Search**.

   **You see:** matching tracks. This checks Center's linked catalog session;
   it does not start playback.

2. Ask the Pin, “Play *song title* by *artist*.” Use a public song for this
   test.
3. Pause and resume, seek near the end, skip, and let the next queued track
   start.
4. Ask the Pin to save the song.
5. Repeat once on Wi-Fi and LTE if you use both, and resume after a long pause.

## Cost, availability, and limits

Checked October 2026:

- A free Google account can use ad-supported YouTube Music; Luma does not
  require YouTube Music Premium. Premium is a paid, optional membership whose
  official benefits include ad-free music, background play, audio-only mode,
  and downloads in supported YouTube experiences. See Google's
  [membership explanation](https://support.google.com/youtubemusic/answer/6305537?hl=en).
- Membership prices vary by country and purchase channel. Check the price shown
  by Google for your own account rather than relying on a price in this guide.
- YouTube Music and paid memberships are not available everywhere. Google
  maintains the current
  [country and travel list](https://support.google.com/youtube/answer/6307365?hl=en).
- Luma's playback path can play public tracks. Linking does not make private,
  uploaded, age-restricted, or subscription-only tracks available to that
  path.
- Listing YouTube Music favorites is not supported by this sign-in flow. Use
  search or a public playlist. Saving the current song does use the signed-in
  account.
- Genre and featured requests are mapped to a relevant public playlist by
  Luma; they are not YouTube editorial rankings.
- A queued track must have a verified identity and last from one second to 30
  minutes.
- Luma filters YouTube advertising response fields and advertising hosts on
  this gateway path. That is Luma behavior, not a guarantee from Google; a
  YouTube delivery change can break playback or filtering until Luma is
  updated.

## What Luma sends

- Center asks Google's YouTube TV client for a device code. The wearer sends
  that code and their approval to Google on Google's page; Luma never receives
  the Google password.
- Google returns OAuth access and refresh credentials to Center's sign-in
  client. Center stores them through Cosmos, sealed under a per-wearer key.
  The browser cannot read them, Center keeps no wearer database, and the Pin
  never receives them.
- Signed-in catalog queries and save requests go from Center to YouTube. Search
  text, requested track or collection IDs, and the signed-in account grant are
  therefore visible to Google.
- Public player-resolution requests and the selected audio stream leave through
  the Pin's active network without the Google account credentials. Luma sends
  the resulting opaque local stream to the stock player.
- Cosmos stores the selected provider separately so Center knows the wearer's
  preference; **Save** also sends that choice and a gateway credential to the
  paired Pin.

<details>
<summary>Troubleshooting</summary>

### The code expired

Wait for Center to stop showing **Waiting for sign-in…**, then choose **Connect
YouTube Music** again. Use only the newest code. A pending sign-in naturally
expires when Google's code expires.

### Center says the sign-in did not finish

Choose **Retry**, then start a fresh connection. Complete Google's page before
the countdown ends and approve with the intended Google account. If Google
shows a supervised-account or regional restriction, use an eligible account;
Google notes that some YouTube Music features are unavailable to supervised
accounts.

### Search works but a track will not play

Test a public, ordinary-length song. Private uploads, age-restricted media,
subscription-only media, and tracks longer than 30 minutes are outside Luma's
playback contract. Also confirm the Pin is online: catalog search runs in
Center, while player resolution and audio use the Pin's connection.

### The Pin still uses Spotify or TIDAL

Linking the Google account does not switch the Pin. Return to **Settings →
Music**, choose **YouTube Music**, and choose **Save**. If Center warns that the
Pin's local provider is different, **Save** is the intended repair.

### Favorites are empty or unavailable

This sign-in flow cannot list the YouTube Music favorites library. That is a
known limitation, not proof that the account lost its library. Search for a
song or use a public playlist instead.

</details>

## Disconnect or remove YouTube Music

1. If YouTube Music is the current provider and you want music to keep working,
   connect another provider, select it, and choose **Save** first.
2. Select **YouTube Music** and choose **Disconnect**.

**You see:** `YouTube Music disconnected.` Luma signs out its active client,
cancels any pending device-code sign-in, removes the sealed Google credentials
from Cosmos, and leaves the Google account itself intact.

For account-side revocation too, open
[Google Account permissions](https://myaccount.google.com/permissions), select
**YouTube on TV**, and choose **Remove Access**. Google documents that exact
remote-removal path in
[Sign out or remove an account from YouTube on TV](https://support.google.com/youtube/answer/7612539?hl=en).
Removing access signs the account out of every client using that shared
YouTube-on-TV grant, not only this Luma server.
