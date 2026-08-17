import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * A surface may only say what it has evidence for.
 *
 * Every route in this BFF answers 200 on a failed read — deliberately, so the
 * client can choose the sentence — and puts the verdict in `state` (a header, or
 * the body where the pane reads the body). The recurring defect is not on the
 * emitter side. It is a page that branches on whether DATA came back instead of
 * on what the read actually did, and then states the absence as a fact about the
 * wearer:
 *
 *   "Note not found — It may have been deleted."   for a note sitting intact on
 *                                                  a backend that went quiet
 *   "No personal details have been added yet."     for an account workload that
 *                                                  never answered
 *   "Pair a Pin below to see its status here."     beside "1 Pin paired", from a
 *                                                  second route, on one screen
 *   "No matching captures"                         for a search that never ran
 *   "200 notes"                                    for a wearer who has 340
 *
 * Each assertion below fails on the code as it was before these were fixed. They
 * are structural because these are client components: what matters is which
 * branch a file takes, and the branch is the thing that was missing.
 */

const SRC = new URL("../src/", import.meta.url);
const source = (path) => readFile(new URL(path, SRC), "utf8");

test("the note detail page reads the list's state before it claims a note is gone", async () => {
  const page = await source("app/notes/[id]/page.tsx");

  // The claim itself has to come AFTER the state check, or the check is dead.
  const stateCheck = page.indexOf('data.state !== "live"');
  const notFound = page.indexOf('title="Note not found"');
  assert.ok(stateCheck > 0, "the note detail page never reads the notes list's state");
  assert.ok(notFound > 0, "the not-found arm is gone — this test is asserting nothing");
  assert.ok(
    stateCheck < notFound,
    "the not-found arm still runs before the state is consulted, so a degraded read is reported as a deleted note",
  );

  // Degraded and absent are different sentences, and the expiry is the one the
  // wearer can clear — which matters more here than anywhere, because this page
  // renders <Shell showNav={false}> and so suppresses <SourceBadge> entirely.
  assert.match(page, /data\.reauthenticate/);
  assert.match(page, /Connect your Pin to open this note/);
  assert.match(page, /showNav=\{false\}/);
});

test("the account details pane reads the state its own route puts in the body", async () => {
  const [pane, route] = await Promise.all([
    source("app/settings/account/details/DetailsView.tsx"),
    source("app/api/account/details/route.ts"),
  ]);

  // The route promises the field; without a consumer the promise is decoration.
  assert.match(route, /state: account\.state/);
  assert.match(route, /reauthenticate: account\.reauthenticate/);

  assert.match(pane, /data\.state === "degraded"/);
  assert.match(pane, /data\.state === "absent"/);
  assert.match(pane, /data\.reauthenticate/);

  // "Not set" is only true when a live read said so.
  const emptyClaim = pane.indexOf("No personal details have been added yet.");
  const degradedBranch = pane.indexOf('const degraded = data.state === "degraded"');
  assert.ok(emptyClaim > 0 && degradedBranch > 0);
  assert.ok(
    degradedBranch < emptyClaim,
    "the pane still reaches its empty sentence without consulting the state",
  );
});

test("absent is never rendered as an outage with a retry that cannot work", async () => {
  const paths = [
    "app/page.tsx",
    "app/notes/page.tsx",
    "app/notes/search/page.tsx",
    "app/notes/[id]/page.tsx",
    "app/captures/page.tsx",
    "app/my-data/page.tsx",
    "app/my-data/DomainView.tsx",
    "app/settings/account/details/DetailsView.tsx",
  ];

  for (const path of paths) {
    const text = await source(path);
    const visible = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.match(text, /state === "degraded"/, `${path} does not distinguish an outage`);
    assert.match(text, /Connect your Pin/, `${path} does not explain the unconfigured state`);
    assert.doesNotMatch(
      visible,
      /No (?:account |Pin )?backend is configured|\.Center/,
      `${path} exposes deployment jargon`,
    );
  }
});

test("the devices pane reports an unreadable status as unread, not as unpaired", async () => {
  const [page, route, contract] = await Promise.all([
    source("app/settings/account/devices/page.tsx"),
    source("app/api/devices/status/route.ts"),
    source("lib/contracts/deviceStatus.ts"),
  ]);

  // The route has counted this for a while, for exactly this sentence.
  assert.match(route, /unread > 0 \? \{ unread \} : \{\}/);
  assert.match(contract, /unread\?: number/);
  assert.match(page, /statusUnread/);

  const unreadable = page.indexOf("const statusUnreadable =");
  const pairPrompt = page.indexOf("Pair a Pin below to see its status here.");
  assert.ok(unreadable > 0 && pairPrompt > 0);
  // The device-absent arm of the identity section itself, not merely a mention
  // of the flag somewhere above it.
  const guarded = page.indexOf(") : statusUnreadable ? (");
  assert.ok(
    guarded > 0 && guarded < pairPrompt,
    "the pane still falls through to the pair-a-Pin sentence when the status read failed, contradicting the pairing section beside it",
  );

  // And the per-Pin chip must stop blaming hardware for an unread admin call.
  assert.match(page, /Status unread/);
  assert.match(page, /Center couldn’t read this Pin’s status just now/);
});

test("the dashboard names the part that failed, using the provenance it already receives", async () => {
  const [page, server] = await Promise.all([
    source("app/page.tsx"),
    source("server/domain/dashboard.ts"),
  ]);

  // The BFF computes this per part and ships it on every five-second poll.
  assert.match(server, /provenance/);
  assert.match(page, /partsInState\(data\.data\.provenance, "degraded"\)/);
  assert.match(page, /partsInState\(data\.data\.provenance, "absent"\)/);
  assert.match(page, /degradedParts\.length > 0/);
  // All five independently-failing parts have to be nameable, or the banner is
  // only accidentally specific.
  for (const part of ["captures", "notes", "aiMic", "music", "calls"]) {
    assert.match(page, new RegExp(`${part}:`), `the dashboard cannot name ${part}`);
  }
});

test("capture search says so when it is not searching, and recovers when the backend does", async () => {
  const page = await source("app/captures/page.tsx");

  // src/server/headers.ts: `x-data-state` is the one to branch on. `carry` is
  // only accidentally equivalent to `live`.
  assert.match(page, /x-data-state/);
  assert.doesNotMatch(
    page,
    /headers\.get\("x-data-source"\)/,
    "capture search still branches on the legacy source alias",
  );

  // The sticky flag had no path back to false, so one blip disabled the server
  // search for the life of the page — including long after carry recovered.
  assert.doesNotMatch(
    page,
    /setSearchUnavailable/,
    "the one-way search-unavailable latch is back",
  );
  assert.match(page, /searchFallback/);

  // And the fallback has to be visible: the local filter matches uuid and a
  // formatted date only, while the server also matches memoryType, so "photo"
  // silently returned nothing with the wearer's photos one line above.
  assert.match(page, /Showing matches by date and ID only/);
  const suppressed = page.indexOf("searching && searchFallback ? null");
  const noMatches = page.indexOf('title="No matching captures"');
  assert.ok(suppressed > 0 && noMatches > 0);
  assert.ok(
    suppressed < noMatches,
    "the empty state still claims nothing matched a search that never ran",
  );
});

test("a capped page is never reported as the whole of the wearer's data", async () => {
  const [queries, notes, notesSearch, captures, capturesRoute, server] = await Promise.all([
    source("lib/queries.ts"),
    source("app/notes/page.tsx"),
    source("app/notes/search/page.tsx"),
    source("app/captures/page.tsx"),
    source("app/api/capture/captures/route.ts"),
    source("server/domain/captures.ts"),
  ]);

  // Cosmos clamps every list to 200 and nothing here asks for a second page, so
  // the backend's own count is the only thing that knows the wearer has more.
  assert.match(server, /total: page\.totalElements/);
  assert.match(capturesRoute, /total: result\.total/);
  assert.match(queries, /total: page\.data\.totalElements/);
  assert.match(queries, /total: res\.data\.total/);

  // …and a surface has to actually say it.
  assert.match(notes, /data\.total > notes\.length/);
  assert.match(notes, /of \$\{data\.total\} notes/);
  assert.match(notesSearch, /were searched/);
  assert.match(captures, /most recent captures of/);
});

test("an event with no timestamp is not dated today", async () => {
  const [provenance, events] = await Promise.all([
    source("server/domain/provenance.ts"),
    source("server/domain/events.ts"),
  ]);
  const server = `${provenance}\n${events}`;
  // Center was the only layer that invented a value here; the proto, the store
  // columns and the sort comparator all treat the absence as real.
  assert.doesNotMatch(
    server,
    /if \(!ts\?\.seconds\) return new Date\(\)\.toISOString\(\)/,
    "tsToIso is substituting the current time for a missing creation_time again",
  );
  assert.match(server, /if \(!ts\?\.seconds\) return "";/);
  assert.match(server, /Number\.isNaN\(when\.getTime\(\)\)/);

  const { formatTimestamp } = await import("../src/lib/format.ts");
  assert.equal(formatTimestamp(""), "Time unknown");
  assert.equal(formatTimestamp("not a date"), "Time unknown");
  // The ordinary case is untouched.
  assert.match(formatTimestamp("2026-02-11T22:57:00.000Z"), /Feb 11, 2026$/);
});

test("the notes search box does not rewrite what the wearer is typing", async () => {
  const page = await source("app/notes/search/page.tsx");
  // The URL sync writes the TRIMMED query back, and `initial` is read straight
  // out of that URL, so an unguarded `setQ(initial)` deleted the space between
  // two words 250ms after it was typed — and "shoppinglist" matches nothing.
  assert.doesNotMatch(
    page,
    /useEffect\(\(\) => setQ\(initial\), \[initial\]\)/,
    "the URL round-trip is overwriting the input again",
  );
  assert.match(page, /current\.trim\(\) === initial \? current : initial/);
});

test("consumer surfaces do not expose reconstruction provenance", async () => {
  const paths = [
    "app/settings/SettingsNav.tsx",
    "app/settings/account/devices/page.tsx",
    "app/settings/account/services/SpotifyServiceCard.tsx",
    "app/settings/contacts/page.tsx",
    "app/settings/page.tsx",
  ];
  for (const path of paths) {
    const text = await source(path);
    assert.doesNotMatch(text, />\s*(?:Added|Addition)\s*</, `${path} exposes build provenance`);
  }
});

test("the privacy pane labels each switch once, in the wearer's words", async () => {
  const [page, css] = await Promise.all([
    source("app/settings/privacy/page.tsx"),
    source("app/settings/privacy/privacy.module.css"),
  ]);
  // The raw backend key under every toggle ("Traces" over `traces`) is developer
  // detail on the one pane where being clear about what is shared matters most.
  // The sibling Features pane already made this call the other way.
  assert.doesNotMatch(page, /styles\.toggleName/);
  assert.doesNotMatch(css, /^\.toggleName \{/m);
  assert.match(page, /humanize\(s\.name\)/);
});

test("a Pin whose server stopped answering says so on every pane", async () => {
  const [shell, layout, provider] = await Promise.all([
    source("app/settings/pin/_lib/PaneShell.tsx"),
    source("app/settings/pin/layout.tsx"),
    source("app/settings/pin/PinDeviceProvider.tsx"),
  ]);

  // The health monitor downgrades the SERVICE and keeps the USB session, which
  // is why `client` stays non-null — and why nine panes, which render the
  // message only inside a `!client` branch, could never reach it.
  assert.match(provider, /setServiceStatus\("offline"\)/);
  assert.match(provider, /setLocalError\(PIN_SERVICE_LOST_MESSAGE\)/);

  assert.match(shell, /export function PinServiceLostBanner/);
  assert.match(shell, /serviceStatus !== "offline"/);
  // In the layout, so it covers every pane the session outlives — and as a
  // banner, because `serviceStatus` only returns to "online" via the Connect
  // pane and a pane that replaced itself would stay replaced.
  assert.match(layout, /<PinServiceLostBanner \/>/);
});

test("ordinary Pin settings prefer USB and otherwise connect through the paired Iroh route", async () => {
  const [provider, connectPage, remoteRoute, adapter, bridge] = await Promise.all([
    source("app/settings/pin/PinDeviceProvider.tsx"),
    source("app/settings/pin/page.tsx"),
    source("app/api/pin/remote/[...path]/route.ts"),
    readFile(new URL("../adapters/spotify/src/adapter.mjs", import.meta.url), "utf8"),
    source("server/spotifyBridge.ts"),
  ]);

  assert.match(provider, /RemoteFetchPinTransport/);
  assert.match(provider, /new PinClient\(new RemoteFetchPinTransport\("\/api\/pin\/remote"\)\)/);
  assert.match(provider, /connectionMode/);
  assert.match(provider, /activeClient\.mode !== "usb"/);
  assert.match(provider, /invalidateQueries\(\{ queryKey: \[PIN_QUERY_KEY\] \}\)/);
  assert.match(connectPage, /Connected remotely/);
  assert.match(connectPage, /USB for maintenance/);

  assert.match(remoteRoute, /requireWearerRequest\(\)/);
  assert.match(remoteRoute, /requireOwnedPairedPin\(session\)/);
  assert.match(remoteRoute, /request\.method !== "GET" && !isSameOriginRequest\(request\)/);
  assert.match(remoteRoute, /authorization: `Bearer \$\{token\}`/);
  assert.match(remoteRoute, /USB_ONLY_NAMESPACES/);
  assert.doesNotMatch(remoteRoute, /request\.headers\.get\("authorization"\)/);

  assert.match(adapter, /PIN_REMOTE_PREFIX = "\/api\/pin-remote"/);
  assert.match(adapter, /\/api\/settings", new Set\(\["GET", "PUT"\]\)/);
  assert.doesNotMatch(adapter, /\["\/api\/events"/);
  assert.match(bridge, /export async function adapterToken/);
  assert.match(bridge, /ownedDeviceIds\.length !== 1/);
});
