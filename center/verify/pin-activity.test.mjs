/*
 * Behavioural guards for the device-local Activity pane — /settings/pin/activity,
 * the Notes / Prompts / Music tabs that read three tables on the Pin itself.
 *
 * Three things here can lose a wearer's data with no way back, and each one is
 * pinned below:
 *
 *   The clear-all SENTENCE. `DELETE /api/activity/<kind>` wipes the whole table
 *     on the device, including rows this pane never paged in, and the pane only
 *     ever knows how many it loaded. So the confirmation may state an exact
 *     total ONLY when the device's cursor says there is nothing more; otherwise
 *     it has to say "at least". A sentence reading "Delete all 50 notes" in
 *     front of a device holding eight hundred is a false statement made at the
 *     one moment a wearer is relying on it, and nothing afterwards reveals it.
 *
 *   The optimistic DELETE pair. A single delete removes the row before the Pin
 *     has answered, because over ADB the round trip is long enough that a list
 *     which does not move reads as a dead button. `withActivityItemRestored` is
 *     what makes that honest: on a refusal the row goes back where it was, it
 *     is never duplicated if the list moved on underneath, and the index is
 *     clamped rather than throwing a hole in the order.
 *
 *   The path a row ID lands in. `deleteActivityItem` interpolates an id the
 *     DEVICE chose into a URL. The cases below hold `encodeURIComponent` in
 *     place, so a note id containing `/` or `..` addresses a note and not
 *     another endpoint.
 *
 * The client cases run the real `PinClient` against the HTTP half of the shared
 * fake Pin (verify/fixtures/fake-pin-device.mjs). The pane and hook are React
 * and are not rendered here; what is asserted about them is that the two-step
 * gate and the restore-on-failure are wired at all, which is source-level and
 * still the thing that would silently regress.
 */

// Registers the resolve hook that lets these `src/` modules reach their own
// extensionless siblings and `@/lib/…` aliases under Node's type stripping.
// Static, so it is evaluated before the dynamic imports below.
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fakePinHttp } from "./fixtures/fake-pin-device.mjs";

const QUERY = "?pin-activity-test";
const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

const {
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_TABS,
  activityMusicArtists,
  activityNoteLocation,
  activityTab,
  clearActivityConfirmation,
  clearActivityConfirmLabel,
  deleteActivityItemConfirmation,
  withActivityItemRestored,
  withoutActivityItemAt,
} = await import(
  `../src/app/settings/pin/_lib/activityPresentation.ts${QUERY}`
);
const { PinApiError, PinClient } = await import(
  `../src/lib/pin-device/index.ts${QUERY}`
);
const { InvalidActivityResponseError, normalizeActivityResponse } = await import(
  `../src/lib/pin-device/normalizers/activity.ts${QUERY}`
);

const KINDS = ["notes", "prompts", "music"];

/* ── the clear-all sentence ───────────────────────────────────────────────── */

test("a clear-all confirmation states an exact total only when the list is complete", () => {
  const complete = clearActivityConfirmation("notes", 3, false);
  assert.match(complete, /Delete all 3 notes/);
  assert.match(complete, /cannot be undone/);
  assert.doesNotMatch(complete, /at least/i);

  // The device says there are more. The pane has no idea how many, so the
  // sentence must not imply the loaded count is the total.
  const partial = clearActivityConfirmation("notes", 50, true);
  assert.match(partial, /At least 50 notes/);
  assert.match(partial, /older ones this page has not read/);
  assert.match(partial, /removes all of them/);
  assert.doesNotMatch(partial, /Delete all 50/);
});

test("every clear-all confirmation names its own category and the count", () => {
  for (const kind of KINDS) {
    const tab = activityTab(kind);
    for (const [count, hasMore] of [
      [1, false],
      [2, false],
      [ACTIVITY_PAGE_SIZE, true],
    ]) {
      const question = clearActivityConfirmation(kind, count, hasMore);
      assert.match(question, new RegExp(String(count)), `${kind}/${count}`);
      assert.match(question, new RegExp(tab.one), `${kind} names its category`);
      assert.match(question, /cannot be undone/, `${kind} says it is final`);
      assert.match(question, /only on this Pin/, `${kind} names the store`);

      // The button the wearer actually presses restates both facts, because it
      // is the thing under the pointer once the question has scrolled or been
      // skimmed past.
      const label = clearActivityConfirmLabel(kind, count, hasMore);
      assert.match(label, new RegExp(tab.one));
      if (!hasMore) assert.match(label, new RegExp(String(count)));
    }
  }
});

test("singular and plural nouns follow the count", () => {
  const one = clearActivityConfirmation("notes", 1, false);
  assert.match(one, /Delete all 1 note on this Pin\?/);
  assert.match(one, /It is stored only on this Pin/);

  const two = clearActivityConfirmation("notes", 2, false);
  assert.match(two, /Delete all 2 notes on this Pin\?/);
  assert.match(two, /They are stored only on this Pin/);

  assert.equal(clearActivityConfirmLabel("music", 1, false), "Delete all 1 played track");
  assert.equal(clearActivityConfirmLabel("music", 4, false), "Delete all 4 played tracks");
});

test("a single-row delete confirmation names the row and the store", () => {
  const question = deleteActivityItemConfirmation("this note from 3 May 2026, 14:02");
  assert.match(question, /this note from 3 May 2026, 14:02/);
  assert.match(question, /only on this Pin/);
  assert.match(question, /cannot be undone/);
});

/* ── which store the wearer is looking at ─────────────────────────────────── */

test("each tab names the distinct cloud-backed Center surface it is not", () => {
  // The whole reason this pane exists is that Center already ships /notes,
  // /my-data/ai-mic and /my-data/music from Carry. If a tab pointed at the
  // wrong one — or two tabs pointed at the same one — the disambiguation would
  // be worse than none.
  assert.deepEqual(
    ACTIVITY_TABS.map((tab) => [tab.kind, tab.cloudHref]),
    [
      ["notes", "/notes"],
      ["prompts", "/my-data/ai-mic"],
      ["music", "/my-data/music"],
    ],
  );

  for (const tab of ACTIVITY_TABS) {
    assert.match(tab.help, /device|Pin/, `${tab.kind} help must say where it reads from`);
    assert.match(tab.title, /this Pin/, `${tab.kind} heading must name the device`);
    assert.match(
      tab.cloudNote,
      /account|Carry/,
      `${tab.kind} must say the other store is the account's`,
    );
  }
});

test("the retired pane is absent from settings and redirects the wearer to Ai Mic", async () => {
  const [nav, layout, auth, page] = await Promise.all([
    source("src/app/settings/SettingsNav.tsx"),
    source("src/app/settings/layout.tsx"),
    source("src/server/auth.ts"),
    source("src/app/settings/pin/activity/page.tsx"),
  ]);

  assert.doesNotMatch(nav, /"\/settings\/pin\/activity"/);
  assert.doesNotMatch(layout, /"\/settings\/pin\/activity"/);
  assert.match(page, /redirect\("\/my-data\/ai-mic"\)/);
  assert.doesNotMatch(auth, /settings\/pin\/activity/);
});

/* ── the optimistic delete pair ───────────────────────────────────────────── */

const ROWS = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("removing a row and restoring it is an exact round trip at any position", () => {
  for (let index = 0; index < ROWS.length; index += 1) {
    const without = withoutActivityItemAt(ROWS, index);
    assert.equal(without.length, ROWS.length - 1);
    assert.deepEqual(
      withActivityItemRestored(without, index, ROWS[index]),
      ROWS,
      `position ${index}`,
    );
  }

  // Neither call mutates what it was given: the pane holds the pre-delete array
  // for the whole round trip so it can put the row back.
  assert.deepEqual(ROWS, [{ id: "a" }, { id: "b" }, { id: "c" }]);
});

test("an out-of-range removal changes nothing and still returns a new array", () => {
  for (const index of [-1, 3, 99]) {
    const result = withoutActivityItemAt(ROWS, index);
    assert.deepEqual(result, ROWS);
    assert.notEqual(result, ROWS);
  }
});

test("restoring never duplicates a row the list already holds", () => {
  /*
   * The failing delete and a reload can land in either order. If the reload won,
   * the row is already back from the device, and inserting the local copy too
   * would show the wearer two of a row the Pin has one of — then deleting "it"
   * would leave the phantom on screen.
   */
  assert.deepEqual(withActivityItemRestored(ROWS, 1, { id: "b" }), ROWS);
  assert.deepEqual(withActivityItemRestored(ROWS, 0, { id: "c", stale: true }), ROWS);
});

test("restoring clamps an index the list has since outgrown or shrunk past", () => {
  assert.deepEqual(withActivityItemRestored([{ id: "b" }], 7, { id: "a" }), [
    { id: "b" },
    { id: "a" },
  ]);
  assert.deepEqual(withActivityItemRestored([{ id: "b" }], -4, { id: "a" }), [
    { id: "a" },
    { id: "b" },
  ]);
  assert.deepEqual(withActivityItemRestored([], 3, { id: "a" }), [{ id: "a" }]);
});

/* ── row presentation ─────────────────────────────────────────────────────── */

test("a note's location prefers the most human form the device resolved", () => {
  const at = (location) => activityNoteLocation({ id: "n", created_at: "", text: "", location });

  assert.equal(at(undefined), null);
  assert.equal(at(null), null);
  assert.equal(
    at({ latitude: 1, longitude: 2, human_readable: "Nyhavn", full_address: "Nyhavn 1" }),
    "Nyhavn",
  );
  assert.equal(at({ latitude: 1, longitude: 2, full_address: "Nyhavn 1, 1051" }), "Nyhavn 1, 1051");
  // Whitespace is not a place name; fall through rather than render a blank.
  assert.equal(at({ latitude: 1, longitude: 2, human_readable: "   " }), "1.00000, 2.00000");
  // Coordinates are shown rather than dropped: a note carrying a location the
  // wearer cannot see is worse than one showing numbers.
  assert.equal(at({ latitude: 55.6761, longitude: 12.5683 }), "55.67610, 12.56830");
});

test("music artists collapse to null rather than to an empty separator", () => {
  const track = (artists) => activityMusicArtists({ id: 1, artists });
  assert.equal(track([]), null);
  assert.equal(track(["", "  "]), null);
  assert.equal(track(["Aphex Twin"]), "Aphex Twin");
  assert.equal(track([" Boards of Canada ", "Autechre"]), "Boards of Canada, Autechre");
});

/* ── the client, against the fake Pin's REST API ──────────────────────────── */

function clientFor(handlers) {
  const pin = fakePinHttp(handlers);
  return { pin, client: new PinClient(pin.transport) };
}

const NOTE = { id: "note-1", created_at: "1746273600", text: "Buy milk" };

test("listing an activity table sends the page size and the cursor it was given", async () => {
  const { pin, client } = clientFor({
    "GET /api/activity/notes?limit=50": { items: [NOTE], next_before: "cursor-1" },
    "GET /api/activity/notes?limit=50&before=cursor-1": { items: [] },
  });

  const first = await client.listActivity("notes", { limit: 50 });
  assert.deepEqual(first.items, [NOTE]);
  assert.equal(first.next_before, "cursor-1");

  const second = await client.listActivity("notes", { limit: 50, before: first.next_before });
  assert.deepEqual(second.items, []);
  // No cursor back means the pane has the whole table, which is the only state
  // in which its clear-all is allowed to state an exact total.
  assert.equal(second.next_before, undefined);

  assert.deepEqual(pin.calls.map((call) => call.key), [
    "GET /api/activity/notes?limit=50",
    "GET /api/activity/notes?limit=50&before=cursor-1",
  ]);
});

test("a device-chosen row id is encoded into the delete path, not concatenated", async () => {
  const { pin, client } = clientFor({
    "DELETE /api/activity/notes/..%2F..%2Fsettings": { status: 204 },
    "DELETE /api/activity/prompts/41": { status: 204 },
  });

  // The Pin picks these ids. Without encoding, this one addresses /api/settings.
  await client.deleteActivityItem("notes", "../../settings");
  await client.deleteActivityItem("prompts", 41);

  assert.deepEqual(pin.calls.map((call) => call.key), [
    "DELETE /api/activity/notes/..%2F..%2Fsettings",
    "DELETE /api/activity/prompts/41",
  ]);
});

test("clearing a table is a DELETE on the collection itself", async () => {
  const { pin, client } = clientFor({ "DELETE /api/activity/music": { status: 204 } });
  await client.clearActivity("music");
  assert.deepEqual(pin.calls, [
    { key: "DELETE /api/activity/music", method: "DELETE", path: "/api/activity/music", headers: new Headers() },
  ]);
});

test("a Pin with no activity routes is distinguishable from one that failed", async () => {
  /*
   * The pane branches on this: 404/405/501 means "this Pin's software does not
   * keep notes yet" with no retry offered, anything else means "could not load"
   * with one. Both arrive as PinApiError, so the STATUS has to survive.
   */
  const { client } = clientFor({
    "GET /api/activity/notes?limit=50": { status: 404, body: "no such route" },
    "DELETE /api/activity/notes": { status: 500, body: "sqlite is busy" },
  });

  await assert.rejects(
    () => client.listActivity("notes", { limit: 50 }),
    (error) => error instanceof PinApiError && error.status === 404,
  );
  await assert.rejects(
    () => client.clearActivity("notes"),
    (error) => error instanceof PinApiError && error.status === 500,
  );
});

test("a malformed row fails the whole page instead of rendering as a blank card", async () => {
  // The pane shows these rows as the wearer's own words. A row that arrives
  // without them must not become an empty card the wearer then deletes.
  assert.throws(
    () => normalizeActivityResponse("notes", { items: [{ id: "n", created_at: "0" }] }),
    InvalidActivityResponseError,
  );
  assert.throws(
    () => normalizeActivityResponse("prompts", { items: [{ ...NOTE, id: "not-an-int" }] }),
    InvalidActivityResponseError,
  );

  // The early bare-array contract still parses, because an older Pin serves it.
  assert.deepEqual(normalizeActivityResponse("notes", [NOTE]), { items: [NOTE] });
});

/* ── the wiring the React code above cannot be asked about here ───────────── */

test("the retired activity pane sends wearers to Ai Mic", async () => {
  const pane = await source("src/app/settings/pin/activity/page.tsx");

  assert.match(pane, /redirect\("\/my-data\/ai-mic"\)/);
  assert.doesNotMatch(pane, /globalThis\.confirm|ArmedClearControl|Refresh|On this Pin/);
});

test("the shared clear control requires a second press", async () => {

  const shell = await source("src/app/settings/pin/_lib/PaneShell.tsx");
  const control = shell.slice(
    shell.indexOf("export function ArmedClearControl"),
    shell.indexOf("export function FormRow"),
  );
  assert.match(
    control,
    /if \(!armed\) \{[\s\S]*?onClick=\{onArm\}/,
    "the unarmed control must only be able to arm",
  );

  /*
   * `disabled` gates the wipe in BOTH states, not just before arming. On this
   * pane it also carries "a page of older rows is in flight", and a control
   * armed a moment before that started would otherwise confirm into the race:
   * the clear empties the list, then the late page puts rows the device has
   * already deleted back on screen. Cancel is deliberately not gated by it —
   * backing out has to stay possible whatever else is running.
   */
  assert.match(control, /onClick=\{onConfirm\}\s*disabled=\{busy \|\| disabled\}/);
  assert.match(control, /onClick=\{onCancel\}\s*disabled=\{busy\}/);

  // Fitness is the fourth tab of the same surface, one route over. Its
  // clear-all goes through the same gate, or the console teaches two different
  // meanings for the same press.
  const fitness = await source("src/app/settings/pin/fitness/page.tsx");
  assert.match(fitness, /<ArmedClearControl/);
  assert.doesNotMatch(fitness, /confirm\([\s\S]{0,80}Delete all/);

  /*
   * The gate above only governs the button INSIDE the control. What it cannot
   * see is what its caller passed as `onArm` — and a caller that passes the
   * clear itself has a two-press control that wipes the table on press one,
   * with every other assertion here still green. So each caller's arm handler
   * is pinned to being a state setter and nothing else.
   */
  for (const [name, contents, clear] of [["fitness", fitness, "clearAll"]]) {
    assert.match(
      contents,
      /onArm=\{\(\) => setClearArmed\(true\)\}/,
      `${name}: the first press may only arm`,
    );
    assert.doesNotMatch(
      contents,
      new RegExp(`onArm=\\{[^}]*${clear}`),
      `${name}: arming must not be the clear`,
    );
    // An armed "Delete all 12 notes" left standing over a list that has since
    // become 60 is a button whose label is a lie, so any change disarms it.
    assert.match(
      contents,
      /useEffect\(\(\) => \{\s*setClearArmed\(false\);\s*\}, \[/,
      `${name}: the armed control must reset when the list moves under it`,
    );
  }
});

test("a rejected delete puts the row back and says so", async () => {
  const hook = await source("src/app/settings/pin/_lib/useDeviceActivity.ts");

  const remove = hook.slice(hook.indexOf("const remove ="), hook.indexOf("const clear ="));
  assert.match(remove, /withoutActivityItemAt/);
  const rejected = remove.slice(remove.indexOf("} catch"));
  assert.match(rejected, /withActivityItemRestored\(current, index, item\)/);
  assert.match(rejected, /setMessage\(/, "a silent restore leaves the wearer thinking it worked");

  // The clear is NOT optimistic: it removes rows this pane never read, so
  // nothing may leave the screen before the device has confirmed.
  const clear = hook.slice(hook.indexOf("const clear ="));
  assert.ok(
    clear.indexOf("setItems([])") > clear.indexOf("await client.clearActivity"),
    "the list must not be emptied before the Pin has accepted the clear",
  );
});
