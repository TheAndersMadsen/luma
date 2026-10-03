# Use Spotify on your Ai Pin

Spotify plays directly on the Pin. Center starts a short pairing window, but
the Spotify mobile app gives the Pin its account session and the Pin keeps that
session in its private credential vault.

This is **not** a Spotify developer integration. Do not create an app in the
Spotify Developer Dashboard, and do not look for a client ID, client secret, or
OAuth redirect URI. Luma uses Spotify Connect pairing instead.

> Provider requirements and prices were checked in October 2026. Spotify can
> change them; check the linked official pages before subscribing.

## What this enables

- Ask the Pin to play a song, artist, album, or playlist from Spotify.
- Search Spotify from Center without starting playback.
- Pause, resume, seek, skip, and continue a queue in the Pin's stock music
  player.
- Use the Spotify mobile app to select and control the Pin as a Spotify Connect
  device.

## Before you start

- [ ] Your Luma server was installed with both the `pin` and `spotify`
  optional features.
- [ ] Your Ai Pin is paired with Center, online, and running the current Luma
  release.
- [ ] Your phone and Pin are on the same Wi-Fi for the first pairing.
- [ ] The Spotify mobile app is installed and signed in to the account you want
  the Pin to use.
- [ ] That account has Spotify Premium. Luma's Pin player requires it.

Spotify's own [Spotify Connect instructions](https://support.spotify.com/us/article/spotify-connect/)
also require both devices to be on the same Wi-Fi for their first connection.

## Pair Spotify

1. Sign in to Center as the wearer who owns the paired Pin.
2. Open **Settings → Music**. You can also go directly to
   `/settings/account/music` on your Center.

   **You see:** a **Music** card and a **Play music from** menu. If the card
   instead says the Pin is unavailable, use **Pair My Ai Pin** first and then
   return here.

3. In **Play music from**, choose **Spotify**.
4. In **Device name**, enter the name that should appear in Spotify, such as
   `Ai Pin`. It must be 1–48 characters.
5. Check **I understand this is for personal testing and requires Spotify
   Premium**, turn on **Use Spotify**, and choose **Save**.

   **You see:** `Your Pin will now play music from Spotify.` Spotify is enabled,
   but it is not paired yet.

6. Choose **Start pairing**.

   **You see:** a two-minute countdown and **Finish in the Spotify app**. The
   Pin advertises the device name you entered only during this pairing window.

7. On your phone, open Spotify and play anything. Open **Connect device** (the
   device icon in Now Playing), then choose the Pin's device name. These are
   the same basic steps Spotify publishes for
   [Spotify Connect](https://support.spotify.com/us/article/spotify-connect/).

   **You see in Center:** **Connected** and `Spotify is ready on your Pin.` If
   it briefly says **Reconnecting**, wait for the player to finish establishing
   its session.

## Verify it

1. Under **Find a song**, enter a song or artist and choose **Search**.

   **You see:** one or more matching tracks. This is a live catalog query
   through the Pin; it does not start playback.

2. Ask the Pin, “Play *song title* by *artist*.”
3. Pause and resume, skip, seek near the end, and let the next queued track
   begin.
4. If you use both Wi-Fi and LTE, repeat once on each connection.

Center's **Connected** badge means the Pin has a saved Spotify session. The
search and playback checks prove that the session, Premium entitlement, Pin
network, and player actually work together.

## Cost, support, and limits

Checked October 2026:

- Spotify Premium is required. Spotify publishes current local plans and
  prices on its [Premium page](https://www.spotify.com/premium/); prices,
  taxes, trials, and availability vary by country. The US Individual price was
  USD 12.99/month when checked, but use the price shown for your account.
- Luma needs no Spotify developer app and incurs no Spotify developer-platform
  charge. Developer-dashboard limits do not apply to this pairing flow.
- Luma's Spotify engine uses the unsupported `librespot` client for personal
  testing. It is not an official Spotify integration, and a Spotify change can
  interrupt it until Luma is updated.
- Pairing stays open for two minutes. The device name is advertised only during
  that window.
- Spotify notes that a Connect device may need reconnection after playback has
  been paused for more than ten minutes. Luma also attempts its own saved-session
  recovery, but a fresh pairing may still be necessary.
- Music needs a live network connection. Luma does not download Spotify music
  for offline playback.

## What Luma sends

- During pairing, the Pin advertises the device name you chose on the local
  network. Spotify's app sends the resulting reusable Spotify session to the
  Pin; your Spotify password is not entered in Center.
- The Pin stores Spotify authentication in its app-private credential vault.
  Center and Cosmos do not store that Spotify credential, and Center's status
  response deliberately excludes it.
- Catalog searches, playback requests, track identifiers, and player activity
  go from the Pin to Spotify. Center can relay an authenticated status,
  settings, or diagnostic-search request to the paired Pin.
- The selected provider is also saved in Cosmos so Center knows your cloud
  preference; **Save** writes the same choice to the Pin.

<details>
<summary>Troubleshooting</summary>

### The Pin does not appear in Spotify

- Make sure the Center countdown is still running. If it expired, choose
  **Start pairing** again.
- Put the phone and Pin on the same Wi-Fi. Guest networks that isolate devices
  can block discovery.
- On iPhone, allow Spotify access to **Local Network**. Spotify lists this and
  further discovery checks in its
  [Connect troubleshooting](https://support.spotify.com/us/article/spotify-connect/).
- Restart the Spotify app, then start a new pairing window. Do not create a
  Spotify developer app; it cannot fix Connect discovery.

### Start pairing is disabled

Choose Spotify, check the personal-testing/Premium acknowledgement, turn on
**Use Spotify**, and choose **Save** first. The Pin must also be paired and
reachable.

### Center says Reconnecting or Needs attention

Wait briefly, then use **Find a song**. If the search fails, confirm the
account still has Premium and the Pin is online. Choose **Pair again** if Center
offers it. If it does not, disconnect and repeat the pairing steps.

### The Pin plays from another provider

Return to **Settings → Music**, choose **Spotify**, and choose **Save**. A Pin
reset, a Device Services reinstall without preserved data, or pairing a new Pin
can leave the cloud preference and the Pin's local choice out of step.

</details>

## Disconnect or remove Spotify

1. If you want music to keep working, first connect another provider, select
   it under **Play music from**, and choose **Save**.
2. Select **Spotify** again and choose **Disconnect**.
3. Confirm **Disconnect Spotify from this Ai Pin?**

**You see:** `Spotify disconnected.` Luma removes the saved Spotify session
from the Pin's private vault. It does not cancel your Spotify subscription or
delete the Spotify account.

For account-side cleanup, review Spotify's **Manage apps** page and remove any
device or app access you no longer recognize. Spotify explains that **Sign out
everywhere** does not include partner devices and directs users to **Remove
Access** for those devices in its
[official sign-out guidance](https://support.spotify.com/us/article/how-to-log-out/).
