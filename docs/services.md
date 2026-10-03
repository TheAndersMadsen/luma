# Configure services in Center

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


Settings opens with your Pin's connection and battery. Below that, controls are
grouped into **Your Pin**, **Connections**, **Everyday**, and **Account &
privacy**. Search finds settings by their everyday names and by technical
terms. **Advanced** holds software updates, connection settings, experiments,
and diagnostics. Expand it when you need those controls. **Music** has its own
page for your linked accounts and playback provider.

If you still need an account, API key, or provider app, start with the
[provider setup guides](../guides/providers/README.md). They give the current
provider-side steps, costs and limits, privacy details, and a check that the
finished connection works. This page is the reference for how those services
behave inside Luma.

To set up the Pin's cloud services, sign in as the operator and open
**Settings → Assistant & voice**. Every cloud service the Pin uses is
configured here. Each service opens on its own, and required services that
still need setup start expanded. Choose **Save changes** to apply a draft.
Testing a service also saves any pending changes first. Center warns you before
you leave a page with an unsaved draft.

- **Assistant:** choose an OpenAI-compatible API or a Codex subscription.
  OpenAI-compatible covers OpenRouter, OpenAI, a compatible gateway, and a
  self-hosted endpoint. Enter its base URL, API key, exact model ID, reasoning
  effort, and response limit. For Codex, select **Codex subscription**, choose
  **Connect Codex**, and finish the device-code sign-in on the linked browser
  page. Cosmos runs the official Codex app server and refreshes that session.
  A separate **Speed** selector can switch supported Codex models to Fast mode.
  Fast is about 1.5 times faster than Standard and uses more ChatGPT credits.
- **Search & maps:** add SearXNG or SerpAPI for web results, plus any optional
  Perplexity, Google Maps, Pirate Weather, or Wolfram credentials. The bundled
  SearXNG includes Brave-backed ResultHunter. Cosmos searches SearXNG first. It
  uses a configured SerpAPI key when SearXNG fails or none of its broad web
  engines answers. A direct Brave API subscription is not a production Cosmos
  integration.
  Each service's **Test** checks only that provider. A successful test says
  nothing about other providers or about audio playback on the Pin.
  In Google Cloud, enable Places API (New), Routes API, Geocoding API, and
  Geolocation API for the Maps key. **Test** tries a place search and a route,
  and names either of those APIs when Google refuses it. The
  [Google Maps guide](../guides/providers/google-maps.md) has separate Pin
  checks for geocoding and radio-based location. Pirate Weather also answers
  forecasts such as "what will the weather be tomorrow?".
- **Voice:** add the Azure Speech key, region, and voice.
- **Food & nutrition:** you can connect and test an Open Food Facts account.
  Cosmos keeps both credentials private and sends them only in the provider's
  POST login body. Nutrition lookups need no key, as the Open Food Facts API
  requires, and use its dedicated search and product endpoints.
- **OS3 (Rabbit):** optional and off by default. See
  [OS3 (Rabbit)](#os3-rabbit) below.

Center never sends secret fields back to the browser. A field that is set says
it is configured. Leave it blank to keep the stored value, or choose **Remove**
to clear it. A save applies to new Cosmos requests right away. You do not need
to restart or re-provision the Pin. **Configured** means the settings are
saved. The Assistant and Food & nutrition cards say **Connected** instead. Use
**Test** to check the provider itself.

Center sends your settings to Cosmos over the private operator API. Cosmos
stores them in its owner-only state volume. Center keeps no second copy, and
the Pin receives none of them.

> [!NOTE]
> On a headless bootstrap, provider values set with
> `./luma config set NAME --stdin` seed Cosmos only until the first save in
> Center. After that, Center is the one place to change them.

### OS3 (Rabbit)

OS3 is Rabbit's agent. It can see your other computers, devices, and files.
With OS3 connected, you can ask the Pin something like "ask OS3 what is on my
Mac's desktop". You can also hand it work, such as "tell OS3 to start the build
on my Mac and report back". A plain question about that kind of work, like
"what's on my MacBook?", can reach OS3 too when the assistant chooses it.

Luma passes the request to your OS3 agent. Rabbit still applies its own agent
capabilities, permissions, and confirmations. Luma works fine without OS3: Pin
setup and server readiness never wait on it.

Only the operator sees the OS3 card. Other signed-in wearers see a services
overview that lists OS3 as **Optional**. It changes to **Ready** once its last
contact went through.

To connect OS3 as the operator, open
**Settings → Assistant & voice → OS3 (Rabbit)** and follow these steps:

1. On a computer, sign in at os3.rabbit.tech in Chrome, Edge, or Firefox.
2. Open the developer tools (F12, or Option-Command-I on a Mac). Choose
   **Network**, reload the page, and select any request to os3.rabbit.tech.
3. Under **Request Headers**, copy the whole value of **Cookie**.
4. Paste it into **OS3 session cookie**, turn on **Use OS3**, and choose
   **Test**.

OS3 also needs a [working model](https://www.rabbit.tech/support/article/dlam-byok).
To let it use a computer, connect that computer in
**OS3 Settings → Rabbit agents** and keep it awake and online. Rabbit's
[computer setup guide](https://www.rabbit.tech/support/article/rabbit-agent)
has the steps. **Test** checks your sign-in and the conversation connection. It
does not check the model or the computer. To check that the computer responds,
ask "Ask OS3 for my Mac's battery level".

The card says **Connected as** followed by your OS3 agent's name only when the
last test or question went through. It also shows when the assistant last
asked OS3. Otherwise it names the step that failed:

| Card status | What happened | What to do |
| --- | --- | --- |
| **Sign-in expired** | Rabbit no longer accepts the cookie. | Paste a fresh cookie and test again. |
| **Blocked** | Rabbit's network refused the connection before OS3 checked the sign-in, so the cookie is fine. | Test again later. |
| **No instance** or **Refused** | OS3's conversation socket answered as missing or refused the connection. | Test again in a moment. |
| **Unreachable** or **Timed out** | Rabbit's sign-in, its session directory, or the conversation socket could not be reached, gave an unreadable answer, or did not respond in time. | Test again in a moment. |
| **Dropped** | The connection dropped during a question. | Test again in a moment. |

When Rabbit's directory names no instance for your account, Luma uses OS3's
default host instead. A delegation does not fail for that reason alone.

Like every secret field, the cookie is write-only. While **Save changes** or
**Test** is running, the service editor pauses so your draft cannot change
halfway through. A failed save keeps the draft. A successful save clears the
cookie field and keeps the cookie stored privately. Replacing the cookie clears
the previous connection result, even across a server restart. Choose **Test**
to check the new sign-in.

#### Asking OS3 and following up

While OS3 works, the Pin shows and says "Checking with OS3", as it does for
other lookups. Within one voice turn, Luma stays in the same OS3 conversation
and reads OS3's answer aloud through the Pin's normal speech. It finishes as
soon as OS3 reports a confirmed outcome for the requested work. The exchange
can take up to 60 seconds, cut shorter by the turn's remaining budget so there
is still time to speak. Longer work stays with Rabbit.

Say "what did OS3 find?" to check the saved task. This works after a server
restart too. Luma reconnects to that conversation and checks its history and
task status. It does not send another task or ask Rabbit to repeat the work. A
status check waits up to 10 seconds within the voice turn's remaining time.

Short follow-ups such as "any update?", "is it done?", and "I approved it,
check again" check the same work when both of these are true:

- Your account has a saved task.
- Your last conversation turn was not about something else. It was about OS3,
  or there is no earlier turn to go by. Center's assistant sends no history, so
  it always counts as having no earlier turn.

A "yes" permission reminder keeps that context, but a newer local action takes
its place. Naming OS3 outright, as in "what did OS3 find?", still checks its
saved task after another topic.

<details>
<summary>What happens when a connection drops or a request is unclear</summary>

If the connection drops after OS3 took the question, the assistant says so,
and a later question checks the saved work. If it drops before OS3 confirmed it
received the question, Luma never sends that question again. The next OS3
request checks on it first.

A status question such as "what did OS3 find?" hears one of these: the result,
that the work is still running or waiting for your input, or that OS3 never
received it. If OS3 never received the earlier question, your new words are
sent to OS3. If it did receive it, the assistant gives the earlier result and
says the new request was not sent, so ask again.

If Luma cannot check, because the cookie changed or the question is more than a
day old, the assistant says it could not confirm the earlier request. You can
check that request in the OS3 app. The new request is then sent.

When OS3 cannot continue, or sends a reply too large to read, the assistant
says so at once instead of waiting.

A task that reaches a Rabbit permission, confirmation, or input card pauses
there. Complete the card in OS3, then ask the Pin for an update. Saying "yes"
to Luma does not approve an OS3 card. Luma reminds you to answer it in OS3. A
tool error does not by itself mean the whole task has stopped. Luma keeps that
error separate from the task state OS3 reports.

OS3 can reply before it reports the work behind that reply. Luma keeps ordinary
requests open until the deadline, even when Rabbit supplies no task marker. So
a short reply to a new request may take the full 60 seconds. Checking saved
work uses the shorter status window. If completion is still unconfirmed, Luma
reads the actual reply, says that the work is not confirmed, and keeps the
accepted request available for a later update. This waiting and retention
policy is a Luma extension, not stock behaviour. A newly discovered worker with
no verified link to the earlier task is not counted as part of it.

Task markers and worker updates may arrive before the echo of your question.
Luma holds those updates, up to a limit, until it can match them. This includes
task markers restored from message history.

</details>

#### Stop a task

Say "Cancel OS3" or "Stop the OS3 task" to stop its saved task, even after
another topic. "Cancel it" or "stop the task" also works while OS3 has a saved
task and your last conversation turn was not about something else.

This sends a stop request in your retained Luma conversation. Luma first ends
its own local wait so the stop request can reach Rabbit quickly, including on
the stock legacy transport. It keeps the accepted task's checkpoint and never
resubmits the task. An exact stop command uses the same ordinary text protocol.
A dedicated remote cancel packet has not been verified. Rabbit interprets the
request, so check OS3 if it has other work running.

Luma says "OS3 stopped your task" only when the workers it already linked to
the task report `canceled`. Until then, an acknowledgement is just "Stop
requested". This check waits up to 15 seconds within the existing turn
deadline. A task that already completed or failed reports its actual outcome
instead.

Luma does not send a stop to Rabbit when there is no retained task, when the
sign-in was replaced, or when the earlier request cannot be resolved. If it is
unclear whether a stop arrived, Luma checks it in its original session without
sending it again. Once Rabbit has confirmed receipt, a later explicit stop
command counts as a new request.

> [!NOTE]
> Double-tapping the Pin stops its narration. It does not stop work on your
> Mac. Use the spoken stop command or stop the task in OS3.

A permission or form still needs your response in OS3. Luma keeps the current
conversation and task references between turns, but each voice turn stays
bounded. It does not keep the microphone open indefinitely or poll after the
wearer leaves. Center's assistant can continue the same task when you sign in
with the same account. Closing Center's assistant or turning **Voice off**
stops its narration and pending speech. It does not cancel Rabbit's work.

Before a waiting request starts, Luma checks **Use OS3** and the saved cookie
again. If either changed, it says the request was not sent. Check the card and
ask again. Work OS3 already accepted stays available for follow-up. Rabbit's
sign-in and directory replies are capped at 64 KiB before Luma opens a
conversation, so an oversized reply cannot hold up the Pin.

Spoken replies drop formatting and tidy whitespace but keep OS3's message. The
Pin reads up to 600 characters of each OS3 message and 1,500 characters in
total. Longer text ends with an ellipsis. A completed result can appear next to
work that is still running, so it does not mean all Rabbit work has finished.

#### Check OS3 after a release

To check the read-and-follow-up flow after deploying a release, run:

```sh
./luma eval assistant production --case os3-task-result --repeat 2
```

To require the complete result in the first voice turn, use
`--case os3-task-same-turn --repeat 2` instead.

<details>
<summary>What these checks ask and what counts as a pass</summary>

Each round asks for a harmless battery-percentage read, the exact filename
`monthly_report_final.csv`, and the arithmetic `2*3 + 4*5` quoted without
change, plus a fresh marker. To pass, the follow-up must keep those words and
symbols, return that marker and an actual percentage, and match OS3's canonical
spoken reply. It must take only `ask_os3` then `Respond`, with no model call.
Missing or changed symbols, a pending-only reply, an old marker, or a rewritten
answer fails.

To check a natural follow-up, use `--case os3-contextual-status --repeat 2`.
Each round first starts a harmless OS3 read. It then asks "Any update?" only if
Luma confirms that a saved task exists. Without that saved task, the trial is
blocked. A truthful pending reply proves only that status routing works, and
the report labels it `contextual_status_only`. A completed read must contain
the same fresh marker, percentage, filename, and arithmetic, and is labeled
`completed_requested_read`. That proves the requested content came back. It
does not prove that every worker has stopped. Retained task state is reported
separately. Both outcomes require the exact canonical spoken reply and
`ask_os3` then `Respond`, with no model call. This status check does not
replace the stricter completion checks above.

</details>

#### Privacy

> [!WARNING]
> The cookie is your full Rabbit web sign-in. Treat it like a password.

Cosmos keeps the cookie private, never logs it, and never sends it to the Pin.
Your requests and OS3's replies go through Rabbit's OS3 service and appear in
your OS3 conversation. Anyone who can use this deployment's assistant reaches
this OS3 account.

So that follow-ups survive a restart, Cosmos keeps the OS3 conversation ID and
any work OS3 has not finished, sealed in the account that asked. Deleting that
account removes them. They belong to the cookie they were made with. After you
paste a different cookie, which may be a different OS3 account, the next
question starts a fresh OS3 conversation.

#### Limits

- OS3 handles questions and tasks for your other devices. Saying "ask OS3",
  "tell OS3", or "use OS3 to" sends the request to OS3 without a model step. A
  request about that kind of work that does not name OS3, such as a question
  about your Mac or a build or cleanup to run there, can also reach OS3 when
  the assistant chooses it. Name OS3 when you want to be sure. The assistant
  never answers an OS3 permission, confirmation, or form for you. Handle those
  in OS3 itself.
- OS3 never runs while the Pin is locked. OS3 hears only the request the wearer
  spoke, with whitespace normalized for OS3's text protocol and cut to 2,000
  characters. It is sent only as the request's first step, so text that another
  tool returned never becomes an OS3 question.
- OS3 replies are untrusted data. They cannot tell Luma to take another action,
  and they do not count as proof that pending work finished.
- OS3 is text only, with one request at a time per server. A second request
  waits for the first to finish. It hears that OS3 is busy only when too little
  of its own time remains. A stop command from the same account cuts the
  earlier wait short instead. Use the OS3 app to attach or download files and
  to submit forms. Luma reads supported card text, file names, and a limited
  number of table rows. It never submits a card answer. The supplied WebSocket
  reference confirms a plain-text form round trip. Secure forms, confirmation
  choices, and successful file retrieval are still unspecified.
- OS3's protocol is not a published API. A change on Rabbit's side can stop it
  working until Luma is updated.
- Rabbit's network turns away clients that do not look like a web browser, so
  Cosmos's OS3 client identifies itself with a desktop browser's User-Agent. No
  other Cosmos client does this. The Wikipedia, Open Food Facts, MusicBrainz,
  and Azure Speech clients identify as `luma-cosmos`, and the rest send no
  User-Agent. Rabbit approved this for the maintainer's integration on
  2026-09-23. If Rabbit publishes an identity for clients like Luma, Luma will
  switch to it.

### Music

Music playback needs the `spotify` optional feature. In **Settings → Music**,
link your accounts and choose the provider the Pin plays from.

You can link YouTube Music and TIDAL before you connect a Pin. Choosing and
saving the playback provider needs your paired Pin, because Center applies the
choice to it. Linking an account does not switch playback by itself.

- **Spotify:** you need Spotify Premium. Select Spotify, acknowledge personal
  testing, enable it, and choose **Save**. Choose **Start pairing** (or
  **Pair again** after an error). Then open Spotify on your phone and select
  the Ai Pin shown in Spotify Connect within two minutes. **Search** checks
  that the catalog is ready. Finish by playing something on the Pin.
- **YouTube Music:** choose **Connect YouTube Music**, open the Google
  activation page shown, and enter the code yourself. Wait for Center to show
  **Connected**. Once the Pin is paired, choose YouTube Music and **Save**. You
  can retry a failed sign-in. While a code is pending, the button reads
  **Waiting for sign-in…**, and another connect request shares the same
  pending sign-in. More details follow this list.
- **TIDAL:** the operator first configures a TIDAL developer client and
  registers `https://YOUR_DOMAIN/api/settings/services/music/tidal/callback`
  as its redirect (see the commands below). Choose **Connect TIDAL** and
  approve access yourself. After pairing the Pin, choose TIDAL and **Save**.
  Reconnect an existing account to grant the `search.read` scope, which
  catalog lookup now requires.

> [!WARNING]
> TIDAL's full-track API requires partner playback access that TIDAL approves.
> An ordinary developer client may link and search but still be refused
> playback. This requirement is in TIDAL's
> [published API schema](https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json).

#### YouTube Music details

Playback finds public tracks through the Pin without sending Google account
credentials to it. Linking does not give this playback path access to private,
uploaded, age-restricted, or subscription-only tracks. YouTube.js limits
device-code OAuth to its TV client. See its
[authentication guide](https://ytjs.dev/guide/authentication).

- Saving a song uses that signed-in client.
- Listing YouTube Music favorites does not work with this sign-in flow. Luma
  reports the limitation instead of returning an empty library. Use search or a
  public playlist instead.
- Genre and featured requests browse a public playlist found by relevance.
  These are Luma's own mappings, not YouTube editorial rankings.
- Queue tracks must have a verified identity and a duration between one second
  and 30 minutes. A cancelled lookup never starts the next track or collection
  request.
- **Disconnect** appears once the account is connected. A pending sign-in that
  is never finished lapses when Google's code expires, and Center offers
  Connect again.

#### Set up the TIDAL developer client

For the TIDAL operator step, run these commands from the current operator
release on the server. Type the client ID at the hidden prompt. Set the secret
only if your developer client requires one:

```sh
./luma config set TIDAL_CLIENT_ID --stdin
./luma config set TIDAL_CLIENT_SECRET --stdin
./luma config check
./luma deploy production --confirm
```

The deploy applies those settings to Center. Leave `TIDAL_SCOPES` unset to use
the supported default scopes, then reconnect TIDAL in Center.

#### Where music runs and what is stored

Spotify plays natively on the Pin. Center runs the YouTube Music and TIDAL
catalog and playback logic. Cosmos keeps the linked YouTube Music, TIDAL, and
Apple Music accounts (sealed) and the provider the Pin plays from. Center keeps
none of them, and the Pin receives none. YouTube player requests and the audio
from both providers go out through the Pin's active Wi-Fi or LTE connection.
They feed the stock Music player through an opaque loopback stream.

You can link Apple Music in Center: choose it in the provider list and press
**Connect Apple Music**. You can retry a failed sign-in script. Apple Music
cannot be saved as the playback provider until Apple's official Android
playback runtime is available. Luma does not fall back to previews or web
players.

YouTube ad filtering is always on in Luma's gateway. It removes `playerAds`,
`adPlacements`, `adSlots`, and `adBreakHeartbeatParams` from JSON responses,
blocks advertising hosts, and refuses redirects. Center picks only playable,
non-DRM audio that belongs to the requested video. The Pin receives that single
stream, not YouTube's web player or an advertising playlist. Malformed or
oversized player responses fail instead of skipping the filter. This does not
guarantee against future changes to how YouTube delivers streams or ads.

#### Check playback on the Pin

After you link and save each provider, test real playback on the Pin:

1. Play several songs, including a longer track.
2. Pause and resume, seek near the end, skip, and play the next queued track.
   For YouTube Music, use public songs.
3. Save a song.
4. Repeat on Wi-Fi and LTE if you use both.
5. Check that playback resumes after a long pause.

These checks exercise the stock player and the Pin's network connection, which
server tests cannot prove. For the ad check, use your own free account and
listen through track changes. Synthetic provider tests cannot show that a live
session is ad-free. Only the owner signs in and does this listening check.

#### If the Pin plays from the wrong provider

The Pin keeps its own copy of your provider choice. In three cases the Pin is
on Spotify while your account still names the provider you chose: after Device
Services is reinstalled without keeping its data, after the Pin is reset, and
on a newly paired Pin. The Music card then says which provider the Pin is set
to, and **Save** sends your choice to the Pin again.

#### Music accounts from releases before 0.3.0

Releases before 0.3.0 kept music accounts in Center, and Luma does not carry
them over. Link each provider again and choose the active one. The old sign-ins
still work and stay in Center's `center-data` volume under
`/data/music-sessions`. Delete that directory, and remove the old access in
your Google and TIDAL account settings.

#### Music limits and timeouts

<details>
<summary>Sandboxing, ticket lifetimes, and request deadlines</summary>

Center runs on Bun. YouTube player transformations run in a throwaway process
using QuickJS, with a 32 MiB interpreter limit and a one-second process
deadline. Only the player script and its small string inputs go into it. It
receives no account credentials or host API objects. This is Luma's own
behaviour, not stock.

YouTube's content-proof interpreter runs in a separate process with a
20-second deadline, which includes its public requests through the Pin.
Cancelling ends that process and frees the next request. It inherits no account
credentials. Its browser emulation uses JSDOM, which is not a security sandbox.
The minter can be reused for up to five minutes, but each proof is tied to the
requested video. These are Luma's own limits.

The latest YouTube Music or TIDAL playback ticket stays usable after a long
pause while Device Services keeps running. It lasts until another track is
issued or the Pin's playback provider changes. Older tickets expire after 45
minutes, and Luma keeps at most eight. This lifetime policy is Luma's own. It
lets the stock player resume its saved URI without a new voice request. It
does not keep playback going through a runtime restart.

Assistant catalog requests get one five-second Center budget, including the
request body, for Spotify and the other providers. Spotify searches pass that
cancellation through Pin ownership checks and the adapter. Native catalog
queries on the Pin have a 20-second total budget. Each Spotify Web API request
has a 15-second deadline and a 2 MiB JSON limit. These limits are Luma's own,
and they bound foreground queries, including pagination and retries. Spotify's
session recovery has its own lifecycle and can finish after a query expires.

Center's Spotify controls share one adapter deadline across ownership checks,
the operation, and its status follow-up. Closing the browser cancels pending
control and provider-search requests. Switching providers clears and cancels
the previous provider's search. A successful TIDAL re-sign-in cancels older
credential lookups, so a stale country response cannot change the new
account's region. Opening or abandoning sign-in keeps the existing connection.
Stock-generated playlists with no track descriptors use their album or artist
hint to find a collection, matching the stock app's fallback.

</details>

`LUMA_SPOTIFY_ADAPTER_TIMEOUT_MS` remains the general control-route timeout
and defaults to 10 seconds. The YouTube Music Pin-egress playback path uses a
separate route-specific ladder: 25 seconds for the Pin provider request, 30 for
Iroh, 35 for adapter egress, 40 for Center resolution, 50 for the Pin music
gateway, and a 60-second Android read-idle timeout. The Android value limits how
long a response-body read may stay idle; it is not a strict total request
deadline. Raising the general timeout does not extend playback. Do not raise it
to hide a provider or Pin connectivity problem.
