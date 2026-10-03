# Configure services in Center

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


Settings starts with your Pin’s connection and battery, then groups controls
into **Your Pin**, **Connections**, **Everyday**, and **Account & privacy**.
Search finds both everyday names and technical terms. **Advanced** holds
software updates, connection settings, experiments and diagnostics; expand it
when you need those controls. **Music** has its own page for your linked
accounts and playback provider.

Sign in as the operator, then open **Settings → Assistant & voice**. This is the
normal configuration path for every Pin-facing cloud capability. Each service
opens separately; required services that need setup start expanded. Choose
**Save changes** to apply a draft; testing a service also saves pending
changes first. Center warns before leaving an unsaved draft:

- **Assistant:** choose an OpenAI-compatible API or a Codex subscription.
  OpenAI-compatible covers OpenRouter, OpenAI, a compatible gateway, and a
  self-hosted endpoint; enter its base URL, API key, exact model ID, reasoning
  effort, and response limit. For Codex, select **Codex subscription**, choose
  **Connect Codex**, and finish the device-code sign-in in the linked browser
  page. Cosmos runs the official Codex app server and refreshes that session.
  Its separate **Speed** selector can opt supported Codex models into Fast mode;
  Fast is about 1.5 times faster and uses more ChatGPT credits than Standard.
- **Search & maps:** add SearXNG or SerpAPI for web results and any
  optional Perplexity, Google Maps, Pirate Weather, or Wolfram credentials.
  The bundled SearXNG includes Brave-backed ResultHunter. Cosmos searches
  SearXNG first and uses a configured SerpAPI key when SearXNG fails or none of
  its broad web engines answers; a direct Brave API subscription is not a
  production Cosmos integration.
  Each service's **Test** checks that exact provider; a successful test does
  not prove the health of other providers or audio playback on the Pin.
  In Google Cloud, enable Places API (New), Geocoding API, and Routes API for
  the Maps key; **Test** tries a place search and a route and names the API
  Google refuses. Pirate Weather also answers forecasts such as "what will the
  weather be tomorrow?".
- **Voice:** add the Azure Speech key, region, and voice.
- **Food & nutrition:** optionally connect and test an Open Food Facts account.
  Cosmos keeps both credentials private and sends them only in the provider's
  POST login body. Nutrition reads remain keyless, as required by the Open Food
  Facts API, and use its dedicated search and product endpoints.
- **OS3 (Rabbit):** optional and off by default; see
  [OS3 (Rabbit)](#os3-rabbit) below.

Secret fields are never returned to the browser. A configured field says so;
leave it blank to keep the stored value or choose **Remove** to clear it. Saving
takes effect for new Cosmos requests without restarting or re-provisioning the
Pin. **Configured** (**Connected** on the Assistant and Food & nutrition
cards) means the settings are saved; use **Test** to check that provider.

Center sends settings over the private operator API to Cosmos. Cosmos stores
them in its owner-only state volume; Center does not retain a second copy and
the Pin receives none of them. For a headless bootstrap, provider values set
with `./luma config set NAME --stdin` seed Cosmos only until the first save in
Center; from then on Center is the one place to change them.

### OS3 (Rabbit)

OS3 is Rabbit's agent, which can see your other computers, devices, and files.
With it connected, you can ask the Pin something like "ask OS3 what is on my
Mac's desktop", or explicitly delegate work such as "tell OS3 to start the
build on my Mac and report back". A plain question about that companion work,
"what's on my MacBook?", reaches OS3 too, through the assistant's own choice
of it. Luma passes that request to your OS3 agent;
Rabbit still applies its own agent capabilities, permissions, and
confirmations. Luma never needs OS3: Pin setup and server readiness never wait
on it. The OS3 card is shown only to the operator; other signed-in wearers see
a services overview that lists OS3 as **Optional** until its last contact went
through, then **Ready**.

To connect it as the operator, open **Settings → Assistant & voice → OS3 (Rabbit)**:

1. On a computer, sign in at os3.rabbit.tech in Chrome, Edge, or Firefox.
2. Open developer tools (F12, or Option-Command-I on a Mac), choose
   **Network**, reload the page, and select any request to os3.rabbit.tech.
3. Under **Request Headers**, copy the whole value of **Cookie**.
4. Paste it into **OS3 session cookie**, turn on **Use OS3**, and choose
   **Test**.

OS3 also needs a [working model](https://www.rabbit.tech/support/article/dlam-byok).
To use a computer, connect it in **OS3 Settings → Rabbit agents** and keep it
awake and online; Rabbit's [computer setup guide](https://www.rabbit.tech/support/article/rabbit-agent)
has the steps. **Test** checks your sign-in and conversation connection, not
the model or computer. Ask "Ask OS3 for my Mac's battery level" to check that
the computer can respond.

The card says **Connected as** your OS3 agent's name only when the last test
or question went through, and when the assistant last asked OS3. Otherwise it
names the step that failed:

- **Sign-in expired:** Rabbit no longer accepts the cookie. Paste a fresh one
  and test again.
- **Blocked:** Rabbit's network refused the connection before OS3 checked the
  sign-in, so the cookie is fine. Test again later.
- **No instance** or **Refused:** OS3's conversation socket answered as
  missing or refused the connection. Test again in a moment.
- **Unreachable** or **Timed out:** Rabbit's sign-in, its session directory,
  or the conversation socket could not be reached, gave an unreadable answer,
  or did not respond in time. Test again in a moment.
- **Dropped:** the connection dropped during a question. Test again in a
  moment.

When Rabbit's directory names no instance for your account, Luma uses OS3's
default host instead, so a delegation does not fail for that alone.

Like every secret field, the cookie is write-only.

While **Save changes** or **Test** is running, the service editor pauses so
your draft cannot change halfway through. A failed save keeps the draft;
a successful save clears the cookie field while retaining it privately.
Replacing the cookie clears the previous connection result, including after
a server restart. Choose **Test** to check the new sign-in.

While OS3 works, the Pin shows and says "Checking with OS3", as it does for
other lookups. Luma stays in the same OS3 conversation within the voice turn
and reads what OS3 returns through the Pin's normal speech. It finishes promptly
when OS3 reports a confirmed outcome for the requested work. The exchange can
use up to 60 seconds, shortened by the turn's remaining budget so there is
still time to speak. Longer work stays
with Rabbit. Say "what did OS3 find?" to check the saved task, also after the
server restarts. Luma reconnects to that conversation and checks its history
and task status; it does not send another task or ask Rabbit to repeat the work.
A status check waits up to 10 seconds within the voice turn's remaining time.
While your account has a saved task and your last conversation turn was not
about something else (it was about OS3, or there is no earlier turn to go by,
as in Center's assistant, which sends no history), "any update?", "is it
done?", and "I approved it, check again" check the same work. A "yes"
permission reminder keeps that context, but a newer local action takes its
place. Explicitly naming OS3, as in "what did OS3 find?",
still checks its saved task after another topic. If the connection drops after
OS3 took the question, the assistant says so and a later question checks the
saved work. If it drops before OS3 confirmed it received the question, Luma
never sends that question again; the next OS3 request checks on it first. A
status question such as "what did OS3 find?" hears the result, that work is
still running or waiting for your input, or that OS3 never received it. New words
are sent to OS3 when it never received the earlier question; when it did, the
assistant gives the earlier result and says the new
request was not sent, so ask again. If Luma cannot check (the cookie changed,
or the question is more than a day old), the assistant says it could not
confirm the earlier request, which you can check in the OS3 app, and sends the
new one. When OS3 cannot continue or sends a reply too large to read, the
assistant says so at once instead of waiting. A task that reaches a Rabbit
permission, confirmation, or input card pauses there: complete it in OS3, then
ask the Pin for an update. Saying "yes" to Luma does not approve an OS3 card;
Luma reminds you to answer it in OS3. A tool error does not by itself mean the
whole task has stopped: Luma distinguishes that error from the reported task
state.

OS3 can reply before reporting the work behind it. Luma keeps ordinary requests
open within that deadline, including when Rabbit supplies no task marker.
A short reply to a new request may therefore take the full 60 seconds; checking
saved work uses the shorter status window. If completion is still unconfirmed,
Luma reads the actual reply,
says so, and keeps the accepted request available for a later update.
This waiting and retention policy is a Luma extension. A newly
discovered worker with no verified link to the earlier task is not attributed
to it.
Task markers and worker updates may arrive before the question's echo. Luma
keeps those bounded updates until it can match them, including task markers
restored in message history.

**Stop a task.** Say "Cancel OS3" or "Stop the OS3 task" to target its saved task,
even after another topic. While OS3 has a saved task and your last
conversation turn was not about something else, "cancel it" or "stop the task"
also works. This requests a stop in your retained
Luma conversation. Luma first ends your own local wait so the
stop request can reach Rabbit promptly, including on the stock legacy
transport. It keeps the accepted task's checkpoint and never resubmits it.
An exact stop command uses the same ordinary text protocol; a dedicated remote
cancel packet has not been verified. Rabbit interprets the request,
so check OS3 if it has other work running. Luma says "OS3 stopped your task"
only when the previously correlated workers report `canceled`; an
acknowledgement is just "Stop requested" until confirmed. This check waits up
to 15 seconds within the existing turn deadline. An already completed or failed
task gets its actual outcome instead. With no retained task, a replaced
sign-in, or an unresolvable earlier request, Luma does not send a stop
to Rabbit. A stop whose delivery is uncertain is checked in its original
session without resending it. Once Rabbit has confirmed receipt, a later
explicit stop command is a new request.

Double-tapping the Pin stops its narration. It does not stop work on your Mac;
use the spoken stop command or stop the task in OS3. A permission or form still
needs your response in OS3. Luma keeps the current conversation and task
references between turns, while each voice turn remains bounded; it does not
keep an unlimited microphone session or poll after the wearer leaves.
Center's assistant can continue the same task when you sign in with the same
account. Closing Center's assistant or turning **Voice off** stops its narration
and pending speech, without canceling Rabbit's work.

Luma checks **Use OS3** and the saved cookie again before a waiting request
starts. If either changed, it says the request was not sent; check the card
and ask again. Already accepted work remains available for follow-up. Rabbit's
sign-in and directory replies are bounded at 64 KiB before Luma opens a
conversation, so an oversized reply cannot hold up the Pin.

Spoken replies remove formatting and normalize whitespace while preserving
OS3's message, up to 600 characters of each OS3 message and 1,500 characters
in all; longer text ends with an ellipsis. A completed result can appear
alongside separately running work; that does not mean all Rabbit work has
finished. To check the read-and-follow-up
flow after deploying a release, run
`./luma eval assistant production --case os3-task-result --repeat 2`.
Use `--case os3-task-same-turn --repeat 2` to require the complete result in
the initial voice turn.
Each round asks for a harmless battery-percentage read, the exact filename
`monthly_report_final.csv` and arithmetic `2*3 + 4*5` quoted without changing
them, and a fresh marker. The follow-up must preserve those useful words and
symbols, return that marker and an actual percentage, match OS3's canonical
spoken reply, and take only `ask_os3` then `Respond` without a model call.
Missing or changed symbols, a pending-only reply, an old marker, or a rewritten
answer fails.

To check a natural follow-up, use
`--case os3-contextual-status --repeat 2`. Each round first starts a harmless
OS3 read, then asks "Any update?" only if Luma confirms a saved task exists.
Without that prerequisite the trial is blocked. A truthful pending reply proves
only status routing; the report labels it `contextual_status_only`. A completed
read must contain the same fresh marker, percentage, filename and arithmetic
and is labeled `completed_requested_read`. That proves the requested content
was returned, not that every worker has stopped; retained task state is reported
separately. Both require the exact canonical
spoken reply and `ask_os3` then `Respond` with no model call. This status check
does not replace the stricter completion checks above.

**Privacy.** The cookie is your full Rabbit web sign-in, so treat it like a
password. Cosmos keeps it private, never logs it, and never sends it to the
Pin. Your requests and OS3's replies go through Rabbit's OS3 service and
appear in your OS3 conversation, and anyone who can use this deployment's
assistant reaches this OS3 account. So that follow-ups survive a restart,
Cosmos keeps the OS3 conversation ID and the work OS3 has not finished, sealed
in the asking account; deleting that account removes them. They belong to the
cookie they were made with: after you paste a different cookie, which may be
another OS3 account, the next question starts a fresh OS3 conversation.

**Limits.**

- Questions and tasks for your other devices. Saying "ask OS3", "tell OS3", or
  "use OS3 to" sends the request to OS3 without a model step. A request about
  that companion work that does not name OS3, such as a question about your
  Mac or a build or cleanup to run there, can also reach OS3 when the
  assistant chooses it; name OS3 when you want to be sure. The assistant never
  answers an OS3 permission, confirmation, or form for you; handle it in OS3
  itself.
- Never while the Pin is locked. OS3 hears the wearer-authored request, with
  whitespace normalized for OS3's text protocol and cut to 2,000 characters,
  and only as the request's first step, so text another tool returned never
  becomes an OS3 question.
- OS3 replies are untrusted data. They cannot instruct Luma to take another
  action or count as proof that pending work finished.
- Text only, and one request at a time per server. A second request waits for
  the first to finish and hears that OS3 is busy only when too little of its
  own time remains (a stop command from the same account cuts the earlier
  wait short instead). Use the OS3 app to attach or download files and submit
  forms. Luma reads supported card text, file names and bounded table rows;
  it never submits a card answer. The supplied WebSocket reference verifies a
  plain-text form round trip, but secure forms, confirmation choices and
  successful file retrieval remain unspecified.
- OS3's protocol is not a published API, so a change on Rabbit's side can stop
  it working until Luma is updated.
- Rabbit's network turns away clients that do not look like a web browser, so
  Cosmos's OS3 client identifies itself with a desktop browser's User-Agent.
  No other Cosmos client does: the Wikipedia, Open Food Facts, MusicBrainz, and
  Azure Speech clients say they are `luma-cosmos`, and the rest send no
  User-Agent. Rabbit approved this for
  the maintainer's integration on 2026-09-23. If Rabbit publishes an identity
  for clients like Luma, Luma switches to it.

### Music

Center runs on Bun. YouTube player transformations run in a disposable process
using QuickJS with a 32 MiB interpreter limit and a one-second process deadline.
Only the player script and its small string inputs enter it; it receives no
account credentials or host API objects. This is Luma-owned behavior.

YouTube's content-proof interpreter runs in a separate process with a
20-second deadline, including its public requests through the Pin. Cancellation
terminates that process and frees the next request. It inherits no account
credentials; its browser emulation uses JSDOM, which is not a security sandbox.
The minter can be reused for up to five minutes, but each proof is bound to the
requested video. These are Luma-owned limits.

Music playback needs the `spotify` optional feature. In **Settings → Music**,
link your accounts and choose the provider the Pin plays from.

You can link YouTube Music and TIDAL before connecting a Pin. Selecting and
saving the playback provider requires your paired Pin so Center can apply the
choice to it. A linked account alone does not switch playback.

- **Spotify:** use Spotify Premium. Select Spotify, acknowledge personal
  testing, enable it, and **Save**. Choose **Start pairing** (**Pair again**
  after an error), then open Spotify on your phone and select the displayed Ai
  Pin from Spotify Connect within two minutes. **Search** checks catalog
  readiness; finish with actual playback on the Pin.
- **YouTube Music:** choose **Connect YouTube Music**, open the displayed
  Google activation page, and enter the code yourself. Wait for Center to show
  **Connected**. Once the Pin is paired, choose YouTube Music and **Save**. A
  failed sign-in can be retried. While a code is pending the button reads
  **Waiting for sign-in…**, and a repeated connect request shares the same
  pending sign-in.
  Playback resolves public tracks through the Pin without sending Google account
  credentials to it. Linking does not grant this playback path access to private,
  uploaded, age-restricted, or subscription-only tracks. YouTube.js limits device-code
  OAuth to its TV client; see its [authentication guide](https://ytjs.dev/guide/authentication).
  Saving a song uses that authenticated client. Listing YouTube Music favorites
  is unavailable with this sign-in flow; Luma reports the limitation rather than
  returning an empty library. Use search or a public playlist instead.
  Genre and featured requests browse a public playlist found by relevance;
  they are Luma-owned mappings, not YouTube editorial rankings.
  Queue tracks must have verified identity and duration between one second and
  30 minutes. A cancelled lookup never starts the next track or collection request.
  **Disconnect** appears once the account is connected; a pending sign-in that
  is never finished lapses when Google's code expires, and Connect is offered
  again.
- **TIDAL:** the operator first configures a TIDAL developer client and
  registers `https://YOUR_DOMAIN/api/settings/services/music/tidal/callback`
  as its redirect. Choose **Connect TIDAL**, approve access yourself, and,
  after pairing the Pin, choose TIDAL and **Save**. Reconnect an existing
  account to grant the `search.read` scope now required for catalog lookup.
  TIDAL's full-track API requires provider-approved partner playback access;
  an ordinary developer client may link and search yet be refused playback.
  This requirement is in TIDAL's
  [published API schema](https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json).

For that TIDAL operator step, run these from the current operator release on
the server. Type the client ID at the hidden prompt; set the secret only if
your developer client requires one:

```sh
./luma config set TIDAL_CLIENT_ID --stdin
./luma config set TIDAL_CLIENT_SECRET --stdin
./luma config check
./luma deploy production --confirm
```

The deploy applies those settings to Center. Keep `TIDAL_SCOPES` unset to use
the supported default scopes, then reconnect TIDAL in Center.
Spotify plays natively on the Pin, while Center runs the YouTube Music and
TIDAL catalog and playback logic. Cosmos keeps the linked YouTube Music, TIDAL
and Apple Music accounts, sealed, and the provider the Pin plays from; Center
keeps none of them, and the Pin receives none. YouTube player requests and
both providers' audio bytes leave through the Pin's active Wi-Fi or LTE
connection and feed the stock Music player through an opaque loopback stream.
Apple Music can be linked in Center: choose it in the provider list and press
**Connect Apple Music**. A failed sign-in script can be retried. It cannot be
saved as the playback provider until Apple's official Android playback runtime
is available; previews and web players are not used as a fallback.

YouTube ad filtering is always enabled in Luma's gateway. It removes
`playerAds`, `adPlacements`, `adSlots`, and `adBreakHeartbeatParams` from JSON
responses, blocks advertising hosts, and refuses redirects. Center selects only
playable, non-DRM audio belonging to the requested video; the Pin receives that
single stream, not YouTube's web player or an advertising playlist. Malformed or
oversized player responses fail instead of bypassing filtering. This is not a
guarantee against future changes to YouTube's stream or ad delivery.

After linking and saving each provider, check actual playback on the Pin:
play several songs, including a longer track, then pause/resume, seek near the
end, skip, and play the next queued track. For YouTube Music, use public songs.
Check saving a song too. Repeat on Wi-Fi and LTE if you use both, and check
resuming after a long pause. These checks exercise the stock player and the
Pin's network connection, which server tests cannot prove.
For the ad check, use your own free account and listen through track transitions;
synthetic provider tests cannot establish that a live session is ad-free. Only
the owner signs in and performs this listening check.

The latest YouTube Music or TIDAL playback ticket remains usable after a long
pause while Device Services keeps running, until another track is issued or
the Pin's playback provider is changed. Older tickets expire after 45 minutes,
and at most eight are retained. This Luma-owned lifetime policy
lets the stock player resume its saved URI without requiring a new voice request;
it does not preserve playback through a runtime restart.

Assistant catalog requests have one five-second Center budget, including the
request body, for Spotify and the other providers. Spotify searches pass that
cancellation through Pin ownership checks and the adapter. Native catalog
queries on the Pin have a 20-second total budget; each Spotify Web API request
has a 15-second deadline and a 2 MiB JSON limit. These Luma-owned limits
bound foreground queries, including pagination and retries. Spotify's
session recovery keeps its own lifecycle and can finish after a query expires.

Center's Spotify controls share one adapter deadline across ownership checks,
the operation and its status follow-up. Closing the browser cancels pending
control and provider-search requests. Switching providers clears and cancels
the previous provider's search. A successful TIDAL re-sign-in cancels older
credential lookups, so a stale country response cannot change the new
account's region; opening or abandoning sign-in keeps the existing connection.
Stock-generated playlists with no track descriptors use their album or artist
hint to find a collection, matching the stock app's fallback.

The Pin keeps its own copy of that choice. After Device Services is reinstalled
without keeping its data or the Pin is reset, and on a newly paired Pin, the Pin
is on Spotify while your account still names the provider you chose. The
Music card then says which provider the Pin is set to, and **Save** sends your
choice to the Pin again.

Releases before 0.3.0 kept music accounts in Center, and they are not carried
over: link each provider again and choose the active one. The old sign-ins
still work and stay in Center's `center-data` volume under
`/data/music-sessions`; delete that directory and remove the old access in
your Google and TIDAL account settings.

`LUMA_SPOTIFY_ADAPTER_TIMEOUT_MS` remains the general control-route timeout
and defaults to 10 seconds. The YouTube Music Pin-egress playback path uses a
separate route-specific ladder: 25 seconds for the Pin provider request, 30 for
Iroh, 35 for adapter egress, 40 for Center resolution, 50 for the Pin music
gateway, and a 60-second Android read-idle timeout. The Android value limits how
long a response-body read may stay idle; it is not a strict total request
deadline. Raising the general timeout does not extend playback and should not
be used to mask a provider or Pin connectivity problem.

