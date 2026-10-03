# What your Center does

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


Center is your humane.center. Your captures, notes, activity, contacts, and
account settings all come from Cosmos, which follows the stock Pin and
humane.center wherever they had the feature.

Captures live in Cosmos. Center pages through the whole library, lists
captures still waiting on the Pin (the newest 1,000), plays and downloads
videos, and keeps the wearer's favorites and tags. Food logs are not part of
the capture library; when the Pin deletes a food-log capture, Cosmos also
removes that meal from the food log. Cosmos mints every share link in the stock
form
`https://<your domain>/humane.center/share/capture/<id>?expiry=…&signature=…`.
Links are made in Center: the Pin's own **Photo sharing** stays locked off
until Humane's remote share backend is restored, so the Pin does not ask for
one. Anyone holding the link sees that capture's best frame for seven days.
Center's public share page reads the frame from Cosmos over the internal
network and holds no share key. Without `COSMOS_CAPTURE_SHARE_BASE_URL` and
`COSMOS_SHARE_TOKEN_SECRET`, Center says sharing is not set up; during a Cosmos
outage it says the link could not be created right now.

Cosmos sends uploaded photo thumbnails to the assistant provider you select so
Center can find visible subjects such as “cat” across the full capture library.
The resulting captions and tags stay inside Cosmos and are never returned by
the capture API; older photos are indexed in the background on first search.

Notes live in Cosmos in the wearer's own words. Center pages, searches, writes,
edits, and deletes them through Cosmos's `capture` web API and holds no note
key. A voice note nobody titled is shown under its first sentence, cut to
eight words, until the wearer types a title; a short one-sentence note is its
own heading. Notes from the Pin's notes quick action keep the wearer's wording,
time zone, and location, and the wearer can save, recall, change, or forget a
note by voice; recalling, changing, and forgetting are off while the Pin is
locked, as on stock, and saving still works.

In Center, a note draft stays on the page when a save fails. Following a link
away from an unsaved draft or cancelling an edit asks before discarding it;
closing or reloading the tab uses the browser's unsaved-changes warning. The
browser's Back button is not intercepted, and drafts are not stored locally.
Contacts, personal details, and food preferences also warn before an unsaved
edit is discarded. Fields pause while a save is in progress.

Long titles, URLs, and tags wrap inside notes, captures, and My Data so their
contents stay readable on small screens. Capture selection keeps **Select all**
and **Deselect all** available on mobile too. Disabled note and capture actions
are dimmed until they are available.

My Data and the Memories dashboard are filtered and counted by Cosmos. Ai Mic
lists every answer the Pin spoke, including Central's narrated answers, and the
chats typed in Center, marked **Typed in Center**; search and Forget reach them
like any answer, and a Pin restoring its history gets the answers Pins spoke,
never the chats typed in Center.
Calls lists one row per call, and Forget on it erases the whole call.
Translation, calls, music, Ai Mic votes, and Forget all go through Cosmos. An
event Cosmos cannot open yet is stored sealed and acknowledged, so nothing is
lost when the Pin's 14-day cleanup runs, and My Data shows it as encrypted until
its key arrives. Ai Mic and Music have a search field: Cosmos searches every
answer and track the Pin recorded (Humane made only these two searchable) and
pages the matches.

Successful one-off translations on the Pin or in Center also appear in
**My Data → Translation**. For example, `translate "hello" to Polish` works in
Center without a connected Pin. Each row shows the source and target language;
a request that names no source language is shown as **Auto-detected**, and a
Pin request that sends an empty source as **unspecified language**. The row
does not keep the original or translated text. Recording one-off translations is a Luma
extension; stock recorded language pairs for live translation
sessions. A failed translation or failed history save returns an error.

Contacts created on the Pin, including by voice, are opened by Cosmos and kept
as ordinary contacts that Center can edit. A Center edit keeps every field the
editor does not show and reaches the Pin at its next contact sync. Contacts the
Pin synced under a key this server has not received yet are kept, and
**Settings → Contacts** says how many until the key arrives.

The wearer's account lives in Cosmos as well. **Settings → Name & profile** edits the
preferred name and pronunciation the Pin reads; the Pin names itself "<name>’s
Ai Pin" over Bluetooth once, at setup, so pairing a Pin fills an empty preferred
name with the sign-in first name. **Settings → Food & nutrition** keeps the
daily intake goals the assistant measures food answers against, and allergies
and other restrictions, which Cosmos stores sealed. It also shows today's
totals: Cosmos adds up the food log the Pin reads, each food's per-serving
figures times its servings, and compares them with the goals. Stock showed no
such totals, so this view is Luma's own. **Settings → My Ai Pin**
lists the account's Pins from Cosmos and can mark one as lost. Cosmos then
answers every call from that Pin with the stock block-mode signal, so it locks
and tells whoever holds it to visit `/devices`; only device onboarding stays
open, so the Pin can still re-onboard. It works again once block mode is off.
Pairing and removing a Pin use the wearer's own sign-in, never the operator's
token; a Pin paired to another account must be removed from that
account first. When that account cannot, the operator releases the pairing at
`/admin/pairings`, linked from **Settings → Advanced → Connect to your server**. That
page shows which Pins are in block mode. Releasing one of those, or a Pin
whose block mode Cosmos cannot read, needs the operator's explicit
confirmation, because once released another account could pair it and set it
up without block mode.

**Settings → Privacy & data** saves your account's preferences in Cosmos. Luma
applies server-side checks to new requests at once; changes to the Pin's key
sharing take effect when it fetches preferences during its privacy sync.
Each control has a specific purpose:

| Control | What it does |
| --- | --- |
| Save activity location | Includes location with new activity events when Location access is also on. |
| Save last location | Keeps the latest sealed location your Pin sends with a location-based request. Center shows the place, time and freshness; this is not live tracking. Requires Location access. |
| Location access | Lets Luma use automatic Pin location for nearby places, weather and directions. When off, Luma removes it from assistant context, refuses GPS requests and omits it from new notes, captures and events. You can still name a city or place. |
| Location in shared photos | Keeps embedded location in photos shared by link when Location access is also on. When off, Luma removes JPEG metadata from the shared copy; the original stays sealed. |
| Save diagnostics | Keeps the latest assistant route, transport, outcome and timing on your server. Center shows it for troubleshooting. Your words, answers and account identifiers are excluded. An interrupted or expired turn may not leave a new result. |
| Standard data sync | Allows the Pin's durable data keys to sync to Cosmos. Other enabled privacy choices can allow particular kinds of data independently. Ephemeral keys needed for communication remain available. |

**Keep Standard data sync on for normal use.** Turning it off can stop photos,
notes and other activity from saving. After the Pin syncs, stock privacy logic
can revoke previously uploaded keys that no enabled choice allows, making
existing sealed data unreadable. Luma does not delete those history rows.
Other switches affect new requests or shared copies; they do not erase
existing history. Unknown future preferences are read-only until supported.

Location access is a Luma consent control, not an Android sensor switch. Local
stock features, including fitness tracking, can still use the Pin's sensors.
The last-location and diagnostic views, server-side location checks and shared
photo metadata filtering are Luma extensions. The stock privacy
wire keys and key-sharing rules are unchanged.

**Settings → Passcode & password** sets the four digits a Pin asks for during its
setup, which then become its lock code. Each account has its own. Cosmos turns
the passcode into an OPAQUE password file for that account and stores only
that file, so the passcode is never kept or shown. A Pin paired to an account
with no passcode says to set one at Center. A new passcode works for the next
setup at once, and a Pin that is already set up keeps its current lock code
until it is reset, as on stock. **Settings → Privacy & data → Delete account**, once
you type `DELETE`, removes everything Cosmos holds for the account: notes,
captures and their files, events, contacts, account settings, escrowed keys,
Pin pairings and the passcode. It then signs you out. The sign-in account
itself stays in Keycloak. While one of the account's Pins is marked as lost,
Cosmos refuses and deletes nothing, because deleting the account would unlock
that Pin; unmark it first.

**Settings → Pin features** controls supported stock features for your own Pins.
As on humane.center,
each account has its own choices: Cosmos keeps them with the account and
serves them only to that account's Pins. Center requests a settings update;
the Pin fetches it when reachable or at its daily flag sync. A saved choice
does not prove the device has fetched it. Some take effect after a restart.
**Restore default** restores the server's flag value; it does not erase your
saved gestures, Vision rules or fitness files.
Flags the server decides for itself, such as remote speech and the assistant
transport, are not on the page; they follow the server's own settings.

| Feature | What to expect |
| --- | --- |
| Touchcode | Always available. The stock firmware has no working cloud on/off control, so Center shows its status rather than an ineffective switch. An old saved choice can be cleared with Restore default. |
| Touchcode timeout | Seconds allowed between Touchcode gestures. Each gesture restarts the timer. Zero ends entry immediately. |
| Custom gestures | Enables the stock tap-then-hold camera gesture. It is not a gesture editor. |
| Quick Actions | Enables remapping the two-finger hold action in Pin settings or by voice. Restart to refresh cached action choices. |
| Music announcements | Announces a selection when playback starts. Stock narration can skip names in non-Latin scripts. Requires working music playback. |
| The Tickle | Enables the stock hidden Tickle phrases and experience. |
| Catch Me Up | Enables eligible notifications from a paired iPhone through its Bluetooth accessory connection. Complete phone pairing and restart. Saying "catch me up" for the Pin's own notification summary works without it. |
| Catch Me Up chime | Plays the stock chime for eligible, summarized notifications, subject to its relevance and cooldown rules. Requires Catch Me Up. |
| Detailed fitness data | Adds raw motion, step and location detail to the next supported fitness session. Requires Fitness tracking; ordinary tracking already records a location trace. |
| eSIM QR scanner | Shows the carrier QR scanner in the Pin's cellular settings. A compatible carrier and eSIM are still required. |
| Network reset | Shows the reset option after you reopen About on the Pin. Turning it on does not reset anything; the reset has its own confirmation. |
| Vision actions | Includes your saved if/then rules with camera analysis. A configured vision provider matches conditions in one bounded call; Luma then supplies your original matching rules as untrusted context to the assistant. Consequential actions still need confirmation. Restart to refresh voice choices. Turning this off does not disable ordinary camera requests. |
| Fitness tracking | Allows new supported tracking sessions. Restart to refresh voice choices. Turning it off does not stop an active session: ask the Pin to stop tracking. |

Tickle stays closed during Pin setup. Once setup finishes, open it normally.
Luma discards launches blocked during setup instead of resuming them later
(a Luma safeguard).

Fitness records stay on the Pin and can be reviewed in its device settings.
Stock automatic fitness bug-report uploads are suppressed by Luma. Camera
analysis removes image metadata before sending pixels to the configured
provider; Vision rules do not enable unattended automation. These are Luma
extensions. Final speaker, gesture, paired-phone, eSIM and sensor
checks require the physical Pin.

Center's Pin settings reach only what the Pin itself holds, such as fitness
sessions, experimental features, Pin server settings, setup, eSIM,
and the Spotify engine. **Settings → Advanced → Experimental features** gives
each control a short explanation. Fixed photo settings are shown as status
values, and unused clock and Catch Me Up settings are under **Technical
details**. Device keys and full technical notes are available in **More
details**; the Root access warning stays visible. If an older locked setting
needs recovery, **Restore safe default** remains visible until it is saved.
Captures, contacts, and assistant history come from
Cosmos, so the old Pin pages for them open **Captures**, **Settings →
Contacts**, and **My Data**. Who may call the Pin is each contact's **Trusted**
setting. Center holds no wearer key.

For an existing Pin, the Settings home offers **Software & updates** and
**Help & diagnostics**, including when the Pin is asleep or offline. An account
without a paired Pin gets the setup shortcut instead, once Center has read both
the Pin's status and the account's pairings; if either read fails, the home
keeps the Software & updates and Help & diagnostics links. Short notes are
centered in their detail view; longer notes remain scrollable.

