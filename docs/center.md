# What your Center does

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


Center is your humane.center. Your captures, notes, activity, contacts, and
account settings all come from Cosmos. Where the stock Pin and humane.center
had a feature, Cosmos follows how they did it.

## Captures

Captures live in Cosmos. Center pages through the whole library. It lists
captures still waiting on the Pin (the newest 1,000), plays and downloads
videos, and keeps the wearer's favorites and tags. Food logs are not part of
the capture library. When the Pin deletes a food-log capture, Cosmos also
removes that meal from the food log.

Cosmos mints every share link in the stock form:

```text
https://<your domain>/humane.center/share/capture/<id>?expiry=…&signature=…
```

You make links in Center. The Pin's own **Photo sharing** stays locked off
until Humane's remote share backend is restored, so the Pin does not ask for
one. Anyone holding the link sees that capture's best frame for seven days.
Center's public share page reads the frame from Cosmos over the internal
network and holds no share key. If `COSMOS_CAPTURE_SHARE_BASE_URL` and
`COSMOS_SHARE_TOKEN_SECRET` are not set, Center says sharing is not set up.
During a Cosmos outage it says the link could not be created right now.

Cosmos sends uploaded photo thumbnails to the assistant provider you select.
This lets Center find visible subjects such as “cat” across the full capture
library. The resulting captions and tags stay inside Cosmos, and the capture
API never returns them. Older photos are indexed in the background the first
time you search.

## Notes

Notes live in Cosmos in the wearer's own words. Center pages, searches, writes,
edits, and deletes them through Cosmos's `capture` web API, and it holds no
note key. A voice note nobody titled is shown under its first sentence, cut to
eight words, until the wearer types a title. A short one-sentence note is its
own heading.

Notes from the Pin's notes quick action keep the wearer's wording, time zone,
and location. The wearer can save, recall, change, or forget a note by voice.
While the Pin is locked, recalling, changing, and forgetting are off, as on
stock. Saving still works.

In Center, a note draft stays on the page when a save fails. If you follow a
link away from an unsaved draft or cancel an edit, Center asks before it
discards the draft. Closing or reloading the tab brings up the browser's
unsaved-changes warning. Center does not intercept the browser's Back button,
and it does not store drafts locally. Contacts, personal details, and food
preferences also warn before they discard an unsaved edit. Fields pause while
a save is in progress.

Long titles, URLs, and tags wrap inside notes, captures, and My Data, so they
stay readable on small screens. Capture selection keeps **Select all** and
**Deselect all** on mobile too. Note and capture actions are dimmed until they
are available.

## My Data and activity

Cosmos filters and counts My Data and the Memories dashboard.

Ai Mic lists every answer the Pin spoke, including Central's narrated answers.
It also lists the chats typed in Center, marked **Typed in Center**. Search and
Forget reach them like any other answer. A Pin that restores its history gets
the answers Pins spoke, never the chats typed in Center.

Calls lists one row per call. Forget on a row erases the whole call.

Translation, calls, music, Ai Mic votes, and Forget all go through Cosmos.
Sometimes Cosmos cannot open an event yet. It stores the event sealed and
acknowledges it, so nothing is lost when the Pin's 14-day cleanup runs. My Data
shows the event as encrypted until its key arrives.

Ai Mic and Music have a search field. Humane made only these two searchable.
Cosmos searches every answer and track the Pin recorded and pages the matches.

Successful one-off translations on the Pin or in Center also appear in
**My Data → Translation**. For example, `translate "hello" to Polish` works in
Center without a connected Pin. Each row shows the source and target language.
A request that names no source language shows as **Auto-detected**. A Pin
request that sends an empty source shows as **unspecified language**. The row
does not keep the original or translated text. Recording one-off translations
is a Luma extension. Stock recorded language pairs for live translation
sessions. A failed translation or a failed history save returns an error.

## Contacts

Cosmos opens contacts created on the Pin, including ones added by voice, and
keeps them as ordinary contacts that Center can edit. A Center edit keeps every
field the editor does not show, and the change reaches the Pin at its next
contact sync. Sometimes the Pin syncs contacts under a key this server has not
received yet. Cosmos keeps them, and **Settings → Contacts** says how many
there are until the key arrives.

## Account settings

The wearer's account lives in Cosmos as well. The table lists the account
pages. Longer notes on some of them follow.

| Page | What it does |
| --- | --- |
| **Settings → Name & profile** | Edits the preferred name and pronunciation the Pin reads. |
| **Settings → Food & nutrition** | Keeps daily intake goals, allergies, and other restrictions, and shows today's totals. |
| **Settings → My Ai Pin** | Lists the account's Pins from Cosmos and can mark one as lost. |
| **Settings → Privacy & data** | Saves the account's privacy preferences in Cosmos. Also holds **Delete account**. |
| **Settings → Passcode & password** | Sets the four-digit passcode a Pin asks for during setup. |
| **Settings → Pin features** | Turns supported stock features on or off for your own Pins. |

### Name and food

The Pin names itself `<name>’s Ai Pin` over Bluetooth once, at setup. For that
reason, pairing a Pin fills an empty preferred name with the sign-in first
name.

The assistant measures food answers against the daily intake goals. Cosmos
stores allergies and other restrictions sealed. For today's totals, Cosmos adds
up the food log the Pin reads. It multiplies each food's per-serving figures by
its servings and compares the sum with the goals. Stock showed no such totals,
so this view is Luma's own.

### Lost Pins and pairing

When you mark a Pin as lost, Cosmos answers every call from that Pin with the
stock block-mode signal. The Pin locks and tells whoever holds it to visit
`/devices`. Only device onboarding stays open, so the Pin can still re-onboard.
It works again once block mode is off.

Pairing and removing a Pin use the wearer's own sign-in, never the operator's
token. A Pin paired to another account must be removed from that account
first. When that account cannot do it, the operator releases the pairing at
`/admin/pairings`. **Settings → Advanced → Connect to your server** links to
that page, and it shows which Pins are in block mode. Releasing a Pin in block
mode, or one whose block mode Cosmos cannot read, needs the operator's explicit
confirmation. Once released, another account could pair that Pin and set it up
without block mode.

### Privacy and data

Luma applies server-side checks to new requests at once. Changes to the Pin's
key sharing take effect when the Pin fetches preferences during its privacy
sync. Each control does one thing:

| Control | What it does |
| --- | --- |
| Save activity location | Includes location with new activity events when Location access is also on. |
| Save last location | Keeps the latest sealed location your Pin sends with a location-based request. Center shows the place, time, and freshness. This is not live tracking. Requires Location access. |
| Location access | Lets Luma use automatic Pin location for nearby places, weather, and directions. When off, Luma removes it from assistant context, refuses GPS requests, and leaves it out of new notes, captures, and events. You can still name a city or place. |
| Location in shared photos | Keeps embedded location in photos shared by link when Location access is also on. When off, Luma removes JPEG metadata from the shared copy. The original stays sealed. |
| Save diagnostics | Keeps the latest assistant route, transport, outcome, and timing on your server. Center shows it for troubleshooting. Your words, answers, and account identifiers are left out. An interrupted or expired turn may not leave a new result. |
| Standard data sync | Allows the Pin's durable data keys to sync to Cosmos. Other privacy choices you turn on can allow particular kinds of data on their own. Ephemeral keys needed for communication stay available. |

> [!WARNING]
> Keep Standard data sync on for normal use. Turning it off can stop photos,
> notes, and other activity from saving. After the Pin syncs, stock privacy
> logic can revoke uploaded keys that no enabled choice allows. That makes
> existing sealed data unreadable. Luma does not delete those history rows.

The other switches affect new requests or shared copies. They do not erase
existing history. Unknown future preferences are read-only until Luma supports
them.

Location access is a Luma consent control, not an Android sensor switch. Local
stock features, including fitness tracking, can still use the Pin's sensors.
The last-location and diagnostics views, the server-side location checks, and
shared-photo metadata filtering are Luma extensions. The stock privacy wire
keys and key-sharing rules are unchanged.

### Passcode and deleting the account

The four digits you set become the Pin's lock code after setup. Each account
has its own. Cosmos turns the passcode into an OPAQUE password file for that
account and stores only that file, so the passcode is never kept or shown. A
Pin paired to an account with no passcode says to set one at Center. A new
passcode works for the next setup at once. A Pin that is already set up keeps
its current lock code until it is reset, as on stock.

**Settings → Privacy & data → Delete account** asks you to type `DELETE`. It
then removes everything Cosmos holds for the account: notes, captures and their
files, events, contacts, account settings, escrowed keys, Pin pairings, and the
passcode. After that it signs you out. The sign-in account itself stays in
Keycloak. While one of the account's Pins is marked as lost, Cosmos refuses
and deletes nothing, because deleting the account would unlock that Pin. Unmark
the Pin first.

### Pin features

As on humane.center, each account has its own choices. Cosmos keeps them with
the account and serves them only to that account's Pins. Center asks for a
settings update, and the Pin fetches it when it is reachable or at its daily
flag sync. A saved choice does not prove the device has fetched it. Some
choices take effect only after a restart. **Restore default** restores the
server's flag value. It does not erase your saved gestures, Vision rules, or
fitness files. Flags the server decides for itself, such as remote speech and
the assistant transport, are not on the page. They follow the server's own
settings.

| Feature | What to expect |
| --- | --- |
| Touchcode | Always available. The stock firmware has no working cloud on/off control, so Center shows its status instead of a switch that would do nothing. Restore default clears an old saved choice. |
| Touchcode timeout | Seconds allowed between Touchcode gestures. Each gesture restarts the timer. Zero ends entry immediately. |
| Custom gestures | Turns on the stock tap-then-hold camera gesture. It is not a gesture editor. |
| Quick Actions | Lets you remap the two-finger hold action in Pin settings or by voice. Restart to refresh cached action choices. |
| Music announcements | Announces a selection when playback starts. Stock narration can skip names in non-Latin scripts. Requires working music playback. |
| The Tickle | Turns on the stock hidden Tickle phrases and experience. |
| Catch Me Up | Brings in eligible notifications from a paired iPhone through its Bluetooth accessory connection. Finish phone pairing and restart. Saying "catch me up" for the Pin's own notification summary works without it. |
| Catch Me Up chime | Plays the stock chime for eligible, summarized notifications, subject to its relevance and cooldown rules. Requires Catch Me Up. |
| Detailed fitness data | Adds raw motion, step, and location detail to the next supported fitness session. Requires Fitness tracking. Ordinary tracking already records a location trace. |
| eSIM QR scanner | Shows the carrier QR scanner in the Pin's cellular settings. You still need a compatible carrier and eSIM. |
| Network reset | Shows the reset option after you reopen About on the Pin. Turning it on does not reset anything. The reset has its own confirmation. |
| Vision actions | Includes your saved if/then rules with camera analysis. A configured vision provider matches conditions in one bounded call. Luma then gives your original matching rules to the assistant as untrusted context. Consequential actions still need confirmation. Restart to refresh voice choices. Turning this off does not disable ordinary camera requests. |
| Fitness tracking | Allows new supported tracking sessions. Restart to refresh voice choices. Turning it off does not stop an active session. Ask the Pin to stop tracking. |

Tickle stays closed during Pin setup. Once setup finishes, open it normally.
As a Luma safeguard, launches blocked during setup are discarded, not resumed
later.

Fitness records stay on the Pin, and you can review them in its device
settings. Luma suppresses the stock automatic fitness bug-report uploads.
Camera analysis removes image metadata before it sends pixels to the
configured provider. Vision rules do not turn on unattended automation. These
are Luma extensions. The final speaker, gesture, paired-phone, eSIM, and sensor
checks need the physical Pin.

## Pin settings in Center

Center's Pin settings reach only what the Pin itself holds. That includes
fitness sessions, experimental features, Pin server settings, setup, eSIM, and
the Spotify engine.

**Settings → Advanced → Experimental features** gives each control a short
explanation. Fixed photo settings show as status values. Unused clock and Catch
Me Up settings are under **Technical details**. Device keys and full technical
notes are in **More details**. The Root access warning stays visible. If an
older locked setting needs recovery, **Restore safe default** stays visible
until you save it.

Captures, contacts, and assistant history come from Cosmos. The old Pin pages
for them open **Captures**, **Settings → Contacts**, and **My Data** instead.
Each contact's **Trusted** setting decides who may call the Pin. Center holds
no wearer key.

For an existing Pin, the Settings home offers **Software & updates** and
**Help & diagnostics**, even when the Pin is asleep or offline. An account
without a paired Pin gets the setup shortcut instead. Center shows it only
after it has read both the Pin's status and the account's pairings. If either
read fails, the home keeps the Software & updates and Help & diagnostics links.

Short notes are centered in their detail view. Longer notes stay scrollable.
