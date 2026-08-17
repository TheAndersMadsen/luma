/*
 * The device gallery, the memory detail and the device conversation log.
 *
 * The thing actually under test here is BLOB LIFETIME. Over USB the Pin's
 * transport has no addressable URL for a frame, so every thumbnail Center shows
 * is a `URL.createObjectURL` handle, and nothing revokes one on its own. A
 * gallery that leaks a handle per tile holds the decoded image for the rest of
 * the session; twenty tiles, a few refreshes and a couple of navigations is
 * already the whole capture history resident in the tab.
 *
 * So the assertions below are not "does the lease call release" — they run the
 * REAL `PinClient` against a scripted transport with `URL.createObjectURL`
 * counted, and check that after each scenario the number of live handles is
 * zero. The three scenarios are the three orders a React tree actually produces:
 * unmount after the frame is showing, unmount while the fetch is still in
 * flight, and a list re-fetch that repoints a mounted tile at a new revision.
 *
 * One case is subtler than a leak and is pinned separately: a FAILED acquire
 * must not be released. `PinClient` deletes its own map entry when a fetch
 * rejects, so a late release from the failed lease would decrement whatever a
 * LATER acquire of the same path had put in its place — revoking a URL a
 * different tile is still displaying. That is a blank tile in production and it
 * has no error attached to it, which is why it gets its own test.
 */

// Registers the resolve hook that lets these `src/` modules reach their own
// extensionless siblings and `@/lib/…` aliases under Node's type stripping.
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const QUERY = "?pin-device-media-test";
const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

const { PinClient } = await import(`../src/lib/pin-device/client.ts${QUERY}`);
const { DeviceAssetLease, createRequestGate } = await import(
  `../src/app/settings/pin/_lib/deviceAssets.ts${QUERY}`
);
const {
  classifyMemoryFile,
  isAddressableMemoryFilename,
  isCanonicalMemoryId,
  memoryAssetRevision,
  memoryDeleteQuestion,
  memoryHasThumbnail,
  memoryPrimaryFile,
  memoryStatusLabel,
  memoryTypeLabel,
} = await import(`../src/app/settings/pin/_lib/memoryPresentation.ts${QUERY}`);
const {
  EMPTY_CONVERSATION_LIST,
  appendConversationPage,
  conversationPreview,
  conversationRoleLabel,
  isDeclineMessage,
  parseConversationId,
} = await import(
  `../src/app/settings/pin/_lib/conversationPresentation.ts${QUERY}`
);
const { safeDownloadName, saveBlobAsFile } = await import(
  `../src/app/settings/pin/_lib/fileDownload.ts${QUERY}`
);

/* ── the scripted device ──────────────────────────────────────────────────── */

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : "";
    },
    async blob() {
      return new Blob([body ?? ""]);
    },
  };
}

/**
 * A Pin whose asset responses are held open until the test answers them.
 *
 * Deferring every request is the point: "released while the fetch is still in
 * flight" is the ordering that leaks, and it cannot be produced against a
 * transport that answers synchronously.
 */
function scriptedAssetTransport() {
  const waiting = new Map();

  return {
    mode: "usb",
    baseUrl: null,
    requests: [],
    assetUrl: () => null,
    request(path) {
      this.requests.push(path);
      return new Promise((resolve) => {
        const queue = waiting.get(path) ?? [];
        queue.push(resolve);
        waiting.set(path, queue);
      });
    },
    /** Answer the oldest outstanding request for `path`. */
    answer(path, status = 200, body = "bytes") {
      const queue = waiting.get(path);
      assert.ok(queue?.length, `no outstanding request for ${path}`);
      queue.shift()(response(status, body));
      if (queue.length === 0) waiting.delete(path);
    },
    get outstanding() {
      return [...waiting.values()].reduce((total, queue) => total + queue.length, 0);
    },
  };
}

/** Count every object URL the client mints, and which of them come back. */
function trackObjectUrls() {
  const created = [];
  const revoked = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let next = 0;

  URL.createObjectURL = () => {
    const url = `blob:pin-test/${next++}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };

  return {
    created,
    revoked,
    get live() {
      return created.filter((url) => !revoked.includes(url));
    },
    restore() {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
}

/** Let every already-queued microtask settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const THUMBNAIL = "/api/memories/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/thumbnail/0";

/* ── blob lifetime, against the real client ───────────────────────────────── */

test("a tile that shows a frame and then unmounts leaves no live blob URL", async () => {
  const urls = trackObjectUrls();
  try {
    const transport = scriptedAssetTransport();
    const client = new PinClient(transport);
    const lease = new DeviceAssetLease(client, THUMBNAIL, "complete:1:1");

    const opened = lease.open();
    transport.answer(THUMBNAIL);
    assert.equal(await opened, urls.created[0]);
    assert.deepEqual(urls.live, urls.created);

    // The effect cleanup.
    lease.release();
    assert.deepEqual(urls.live, []);
  } finally {
    urls.restore();
  }
});

test("a tile unmounted while its frame is still in flight leaves no live blob URL", async () => {
  const urls = trackObjectUrls();
  try {
    const transport = scriptedAssetTransport();
    const client = new PinClient(transport);
    const lease = new DeviceAssetLease(client, THUMBNAIL, "complete:1:1");

    const opened = lease.open();
    // Navigation, before the device has answered anything at all.
    lease.release();
    transport.answer(THUMBNAIL);

    // Nothing to render, and nothing left behind: the handle the client minted
    // for a caller that had already gone is revoked rather than orphaned.
    assert.equal(await opened, null);
    await flush();
    assert.deepEqual(urls.live, []);
  } finally {
    urls.restore();
  }
});

test("a list re-fetch that changes a record's revision releases the stale frame", async () => {
  const urls = trackObjectUrls();
  try {
    const transport = scriptedAssetTransport();
    const client = new PinClient(transport);

    // First render: the memory is still uploading, so the frame it has now is
    // not the frame it will have.
    const uploading = new DeviceAssetLease(client, THUMBNAIL, "uploading:1:0");
    const first = uploading.open();
    transport.answer(THUMBNAIL);
    await first;

    // The list re-fetched and the record moved on. React runs the cleanup for
    // the old dependency before acquiring the new one.
    uploading.release();
    const complete = new DeviceAssetLease(client, THUMBNAIL, "complete:1:1");
    const second = complete.open();
    transport.answer(THUMBNAIL);
    const secondUrl = await second;

    assert.equal(urls.created.length, 2, "a changed revision must re-read the frame");
    assert.deepEqual(urls.live, [secondUrl]);

    complete.release();
    assert.deepEqual(urls.live, []);
  } finally {
    urls.restore();
  }
});

test("two tiles sharing one path hold one blob URL until both let go", async () => {
  const urls = trackObjectUrls();
  try {
    const transport = scriptedAssetTransport();
    const client = new PinClient(transport);

    const left = new DeviceAssetLease(client, THUMBNAIL, "complete:1:1");
    const right = new DeviceAssetLease(client, THUMBNAIL, "complete:1:1");
    const both = Promise.all([left.open(), right.open()]);
    transport.answer(THUMBNAIL);
    const [leftUrl, rightUrl] = await both;

    assert.equal(leftUrl, rightUrl);
    assert.equal(transport.requests.length, 1, "one path, one device read");
    assert.equal(urls.created.length, 1);

    left.release();
    assert.deepEqual(urls.live, [leftUrl], "the surviving tile keeps its frame");
    right.release();
    assert.deepEqual(urls.live, []);
  } finally {
    urls.restore();
  }
});

test("a failed acquire is never released, so a later tile's frame survives", async () => {
  const urls = trackObjectUrls();
  try {
    const transport = scriptedAssetTransport();
    const client = new PinClient(transport);

    const failing = new DeviceAssetLease(client, THUMBNAIL, "complete:1:1");
    const rejected = failing.open();
    transport.answer(THUMBNAIL, 500, "device error");
    await assert.rejects(rejected);

    // The retry succeeds and a second tile is now showing that frame.
    const retry = new DeviceAssetLease(client, THUMBNAIL, "complete:1:1");
    const opened = retry.open();
    transport.answer(THUMBNAIL);
    const url = await opened;

    // The failed lease is cleaned up late — an unmount after the retry mounted.
    failing.release();
    assert.deepEqual(
      urls.live,
      [url],
      "releasing a failed lease must not revoke the entry that replaced it",
    );

    retry.release();
    assert.deepEqual(urls.live, []);
  } finally {
    urls.restore();
  }
});

test("release is idempotent and open refuses to run twice", async () => {
  const urls = trackObjectUrls();
  try {
    const transport = scriptedAssetTransport();
    const client = new PinClient(transport);
    const lease = new DeviceAssetLease(client, THUMBNAIL, null);

    const opened = lease.open();
    transport.answer(THUMBNAIL);
    await opened;

    lease.release();
    lease.release();
    lease.release();
    assert.equal(urls.revoked.length, 1, "one acquire, one revoke, whatever the caller does");
    assert.equal(lease.isReleased, true);

    await assert.rejects(() => lease.open(), /only be called once/);
  } finally {
    urls.restore();
  }
});

test("a lease released before it opens never asks the device for anything", async () => {
  const urls = trackObjectUrls();
  try {
    const transport = scriptedAssetTransport();
    const client = new PinClient(transport);
    const lease = new DeviceAssetLease(client, THUMBNAIL, null);

    lease.release();
    assert.equal(await lease.open(), null);
    assert.deepEqual(transport.requests, []);
    assert.deepEqual(urls.created, []);
  } finally {
    urls.restore();
  }
});

/* ── the concurrency limit ────────────────────────────────────────────────── */

test("the request gate never lets more than its limit reach the device at once", async () => {
  const urls = trackObjectUrls();
  try {
    const transport = scriptedAssetTransport();
    const client = new PinClient(transport);
    const gate = createRequestGate(2);

    const paths = [0, 1, 2, 3, 4].map((index) => `${THUMBNAIL}${index}`);
    const leases = paths.map((path) => new DeviceAssetLease(client, path, null));
    const opens = leases.map((lease) => lease.open(gate));

    await flush();
    assert.equal(
      transport.requests.length,
      2,
      "five tiles must not open five ADB sockets",
    );

    transport.answer(paths[0]);
    await flush();
    assert.equal(transport.requests.length, 3, "a finished read admits the next");

    for (const path of paths.slice(1)) {
      transport.answer(path);
      await flush();
    }
    await Promise.all(opens);
    assert.equal(transport.requests.length, 5);

    for (const lease of leases) lease.release();
    assert.deepEqual(urls.live, []);
  } finally {
    urls.restore();
  }
});

test("a queued lease released before it is admitted still frees its slot", async () => {
  const transport = scriptedAssetTransport();
  const client = new PinClient(transport);
  const gate = createRequestGate(1);

  const first = new DeviceAssetLease(client, `${THUMBNAIL}a`, null);
  const abandoned = new DeviceAssetLease(client, `${THUMBNAIL}b`, null);
  const third = new DeviceAssetLease(client, `${THUMBNAIL}c`, null);

  const opens = [first.open(gate), abandoned.open(gate), third.open(gate)];
  await flush();
  assert.deepEqual(transport.requests, [`${THUMBNAIL}a`]);

  // The middle tile scrolled away while it was still queued.
  abandoned.release();
  transport.answer(`${THUMBNAIL}a`);
  await flush();

  assert.equal(await opens[1], null, "an abandoned lease resolves to nothing");
  assert.deepEqual(
    transport.requests,
    [`${THUMBNAIL}a`, `${THUMBNAIL}c`],
    "the abandoned tile costs the device nothing but does not stall the queue",
  );

  transport.answer(`${THUMBNAIL}c`);
  await Promise.all(opens);
  first.release();
  third.release();
});

/* ── every acquire goes through a lease ───────────────────────────────────── */

test("no pane acquires a device asset URL outside the lease", async () => {
  const lease = await source("src/app/settings/pin/_lib/deviceAssets.ts");
  assert.match(lease, /acquireAssetUrl/);
  assert.match(lease, /releaseAssetUrl/);

  for (const path of [
    "src/app/settings/pin/gallery/page.tsx",
    "src/app/settings/pin/gallery/DeviceMedia.tsx",
    "src/app/settings/pin/gallery/[uuid]/MemoryDetailView.tsx",
    "src/app/settings/pin/_lib/useDeviceAsset.ts",
  ]) {
    const contents = await source(path);
    assert.doesNotMatch(
      contents,
      /\.acquireAssetUrl\(|\.releaseAssetUrl\(/,
      `${path} must acquire through DeviceAssetLease, not the client directly`,
    );
    // `clearAssetUrls()` revokes every handle on the client regardless of who
    // is still displaying one. It belongs to session teardown, never to a view.
    // Matched as a CALL, so the hook may still explain in prose why it is absent.
    assert.doesNotMatch(
      contents,
      /\.clearAssetUrls\(/,
      `${path} must not clear every shared asset handle`,
    );
  }

  const hook = await source("src/app/settings/pin/_lib/useDeviceAsset.ts");
  assert.match(hook, /return \(\) => \{[\s\S]{0,120}lease\.release\(\);/);

  /*
   * The dependency array is the other half of that cleanup, and the half no
   * cleanup assertion can see. React only runs the cleanup when a dependency
   * changes, so a list of deps missing `path` or `revision` produces a tile that
   * holds its FIRST lease for as long as it stays mounted: the frame never
   * updates when the record moves on, and the handle it is still holding is
   * never given back. Nothing in this file's lease scenarios would catch it,
   * because the lease would be behaving perfectly — it would simply never be
   * told to let go.
   */
  assert.match(
    hook,
    /\}, \[client, path, revision, scope\]\);/,
    "every input the lease is built from must be able to trigger the cleanup",
  );
});

/* ── the one destructive control on this surface ──────────────────────────── */

test("deleting a capture takes two presses, and the grid offers none", async () => {
  /*
   * `DELETE /api/memories/<uuid>` removes the memory's whole directory from the
   * device, and for a capture that never uploaded that directory is the only
   * copy anywhere. Two properties keep that safe, and both are one edit away
   * from being lost with no other test noticing:
   *
   *   The GRID has no delete at all. A field of near-identical squares is the
   *     worst place to put an irreversible action, because a mis-aimed click
   *     destroys something the wearer never looked at and cannot name.
   *
   *   The DETAIL pane's first press only arms. `ArmedClearControl` enforces
   *     that for its own unarmed button — asserted in pin-activity — but it
   *     cannot stop a caller from handing `onArm` the destructive function, and
   *     that wiring is invisible in review.
   */
  const [grid, tiles, detail] = await Promise.all([
    source("src/app/settings/pin/gallery/page.tsx"),
    source("src/app/settings/pin/gallery/DeviceMedia.tsx"),
    source("src/app/settings/pin/gallery/[uuid]/MemoryDetailView.tsx"),
  ]);

  for (const [name, contents] of [
    ["the gallery grid", grid],
    ["a gallery tile", tiles],
  ]) {
    assert.doesNotMatch(
      contents,
      /deleteMemory/,
      `${name} must not be able to destroy a capture`,
    );
  }

  assert.equal(
    (detail.match(/\.deleteMemory\(/g) ?? []).length,
    1,
    "the detail pane holds the single delete call site on this surface",
  );
  assert.match(detail, /<ArmedClearControl/);
  assert.match(
    detail,
    /onArm=\{\(\) => setArmed\(true\)\}/,
    "the first press may only arm",
  );
  assert.match(detail, /onConfirm=\{\(\) => void confirmDelete\(\)\}/);
  // Anything the arm handler could CALL is a first-press delete wearing the
  // gate's clothes, so the handler is pinned to being a state setter.
  assert.doesNotMatch(detail, /onArm=\{[^}]*(confirmDelete|deleteMemory)/);

  /*
   * Every device path this pane builds is built from the ROUTE parameter, which
   * it refused to render without checking, and never from the uuid the device
   * echoed back. `filePath` and `thumbnailPath` interpolate without encoding and
   * the USB transport writes the result into `GET <path> HTTP/1.1`, so the
   * checked value is the only one that may reach them.
   */
  assert.doesNotMatch(
    detail,
    /(filePath|thumbnailPath)\(\s*memory\.uuid/,
    "a device-supplied identifier must not be interpolated into a request line",
  );
  assert.match(detail, /client\.thumbnailPath\(uuid, 0\)/);

  // The route component stays mounted when the uuid changes — opening another
  // capture from a link is a param change, not an unmount — so without this the
  // control stays primed and its second press destroys a different capture from
  // the one the wearer armed it over.
  assert.match(
    detail,
    /useEffect\(\(\) => \{\s*setArmed\(false\);[\s\S]{0,160}?\}, \[client, uuid\]\);/,
    "a change of capture must disarm the delete",
  );
});

/* ── memory presentation ──────────────────────────────────────────────────── */

test("only a canonical device identifier is addressable", () => {
  assert.equal(isCanonicalMemoryId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), true);
  assert.equal(isCanonicalMemoryId("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"), false);
  assert.equal(isCanonicalMemoryId("../../etc/passwd"), false);
  assert.equal(isCanonicalMemoryId("aaaaaaaabbbb4ccc8dddeeeeeeeeeeee"), false);
  assert.equal(isCanonicalMemoryId(""), false);
});

test("a memory's asset revision moves when its stored media can have moved", () => {
  const uploading = {
    uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    memory_type: "photo",
    device_local_id: "local-1",
    created_at: "1770000000",
    status: "uploading",
    files: [],
    thumbnail_count: 0,
  };
  const complete = { ...uploading, status: "complete", files: ["a.jpg"], thumbnail_count: 1 };

  assert.notEqual(memoryAssetRevision(uploading), memoryAssetRevision(complete));
  assert.equal(memoryAssetRevision(complete), memoryAssetRevision({ ...complete }));
  assert.equal(memoryHasThumbnail(uploading), false);
  assert.equal(memoryHasThumbnail(complete), true);
  assert.equal(
    memoryHasThumbnail({ ...complete, uuid: "not-a-uuid" }),
    false,
    "an unaddressable record has no frame to ask for",
  );
});

test("stored filenames are classified by what they can be rendered as", () => {
  assert.equal(classifyMemoryFile("uuid_0_0.jpg"), "image");
  assert.equal(classifyMemoryFile("uuid_0_0.JPG"), "image");
  assert.equal(classifyMemoryFile("uuid_0_0.mp4"), "video");
  assert.equal(classifyMemoryFile("uuid_0_0_imu.bin"), "data");
  assert.equal(classifyMemoryFile("uuid_0_0_timing.bin"), "data");
  assert.equal(classifyMemoryFile("noextension"), "data");

  assert.equal(
    memoryPrimaryFile({ files: ["uuid_0_0_imu.bin", "uuid_0_0.mp4"] }),
    "uuid_0_0.mp4",
    "the sidecars must never be handed to the stage",
  );
  assert.equal(memoryPrimaryFile({ files: ["uuid_0_0_imu.bin"] }), null);
});

test("a filename that cannot survive a request line is never put in one", () => {
  // `PinClient.filePath` interpolates without encoding, and the USB transport
  // writes the result into `GET <path> HTTP/1.1` — so a space is a malformed
  // request and a slash addresses something else. The Pin's own generator never
  // produces either, which is exactly why this has to be checked rather than
  // assumed of whatever software is answering.
  assert.equal(isAddressableMemoryFilename("uuid_0_0.jpg"), true);
  assert.equal(isAddressableMemoryFilename("holiday photo.jpg"), false);
  assert.equal(isAddressableMemoryFilename("../../../etc/passwd"), false);
  assert.equal(isAddressableMemoryFilename("a?b.jpg"), false);
  assert.equal(isAddressableMemoryFilename("a#b.jpg"), false);
  assert.equal(isAddressableMemoryFilename("a%2fb.jpg"), false);
  assert.equal(isAddressableMemoryFilename(""), false);
  assert.equal(isAddressableMemoryFilename(".."), false);

  assert.equal(
    memoryPrimaryFile({ files: ["holiday photo.jpg", "uuid_0_0.jpg"] }),
    "uuid_0_0.jpg",
    "an unaddressable name must not become the stage's source",
  );
  assert.equal(memoryPrimaryFile({ files: ["holiday photo.jpg"] }), null);
});

test("an unknown device vocabulary is echoed rather than mapped to a default", () => {
  assert.equal(memoryTypeLabel("photo"), "Photo");
  assert.equal(memoryTypeLabel("food_log"), "Food log");
  assert.equal(memoryTypeLabel("hologram"), "hologram");
  assert.equal(memoryStatusLabel("complete"), "Synced");
  assert.equal(memoryStatusLabel("quarantined"), "quarantined");
});

test("the delete question names the loss before it happens", () => {
  const unsynced = memoryDeleteQuestion(
    {
      memory_type: "photo",
      status: "failed",
      files: ["a.jpg", "b.jpg"],
    },
    "12 Aug 2026, 10:14",
  );

  assert.match(unsynced, /photo/);
  assert.match(unsynced, /12 Aug 2026, 10:14/);
  assert.match(unsynced, /2 stored files/);
  assert.match(unsynced, /cannot be recovered/);
  assert.match(unsynced, /the only copy/);

  const synced = memoryDeleteQuestion(
    { memory_type: "video", status: "complete", files: ["a.mp4"] },
    "yesterday",
  );
  assert.match(synced, /1 stored file/);
  assert.match(synced, /that copy is not touched/);
  assert.doesNotMatch(synced, /the only copy/);
});

/* ── conversation paging ──────────────────────────────────────────────────── */

const turn = (id) => ({
  id,
  run_id: `run-${id}`,
  created_at: `${1_770_000_000 - id}`,
  utterance: `turn ${id}`,
  is_vision: false,
});

test("paging advances by rows received and keeps the first copy of a shifted row", () => {
  const firstPage = appendConversationPage(EMPTY_CONVERSATION_LIST, {
    conversations: [turn(9), turn(8), turn(7)],
    has_more: true,
  });
  assert.deepEqual(
    firstPage.items.map((item) => item.id),
    [9, 8, 7],
  );
  assert.equal(firstPage.offset, 3);
  assert.equal(firstPage.hasMore, true);

  // A turn was recorded between the two reads, so row 7 slid into page two.
  const secondPage = appendConversationPage(firstPage, {
    conversations: [turn(7), turn(6), turn(5)],
    has_more: true,
  });
  assert.deepEqual(
    secondPage.items.map((item) => item.id),
    [9, 8, 7, 6, 5],
    "an overlapping row must not be rendered twice",
  );
  assert.equal(
    secondPage.offset,
    6,
    "the window advances by rows RECEIVED, or the overlap is re-requested forever",
  );
});

test("an empty page ends the list whatever has_more claims", () => {
  const loaded = appendConversationPage(EMPTY_CONVERSATION_LIST, {
    conversations: [turn(2), turn(1)],
    has_more: true,
  });
  // The Pin reports has_more as "this page came back exactly full", so the page
  // after an exact multiple is empty and still flagged.
  const ended = appendConversationPage(loaded, { conversations: [], has_more: true });

  assert.equal(ended.hasMore, false);
  assert.equal(ended.items.length, 2);
  assert.equal(ended.items, loaded.items, "an empty page must not re-render the list");
});

test("a preview is one readable line, and a blank turn says so", () => {
  assert.equal(conversationPreview("  what   is   this  "), "what is this");
  assert.equal(conversationPreview("   "), "No transcript for this turn");
  assert.equal(conversationPreview("\n\t"), "No transcript for this turn");

  const long = conversationPreview("a".repeat(40) + " " + "b".repeat(200), 60);
  assert.ok(long.length <= 61, long);
  assert.match(long, /…$/);
});

test("a server-written failure notice is not shown as something the Pin said", () => {
  assert.equal(conversationRoleLabel("assistant"), "Ai Pin");
  assert.match(conversationRoleLabel("assistant_decline"), /could not answer/);
  assert.equal(conversationRoleLabel("tool"), "tool");
  assert.equal(isDeclineMessage({ role: "assistant_decline" }), true);
  assert.equal(isDeclineMessage({ role: "assistant" }), false);
});

test("only a device rowid reaches a conversation path", () => {
  assert.equal(parseConversationId("41"), 41);
  assert.equal(parseConversationId("0"), null);
  assert.equal(parseConversationId("-1"), null);
  assert.equal(parseConversationId("1.5"), null);
  assert.equal(parseConversationId("../settings"), null);
  assert.equal(parseConversationId(""), null);
});

/* ── the download path ────────────────────────────────────────────────────── */

test("a device filename cannot suggest a path to the browser downloader", () => {
  assert.equal(safeDownloadName("uuid_0_0.jpg", "fallback.bin"), "uuid_0_0.jpg");
  assert.equal(safeDownloadName("../../etc/passwd", "fallback.bin"), "passwd");
  assert.equal(safeDownloadName("a/b/c.mp4", "fallback.bin"), "c.mp4");
  assert.equal(safeDownloadName("   ", "fallback.bin"), "fallback.bin");
  assert.equal(safeDownloadName("..", "fallback.bin"), "fallback.bin");
  assert.equal(
    safeDownloadName(`bad${String.fromCharCode(10)}name.jpg`, "fallback.bin"),
    "badname.jpg",
  );
});

test("a saved download releases its temporary URL even when the click throws", () => {
  const revoked = [];
  const scheduled = [];
  const dependencies = {
    createObjectUrl: () => "blob:download/1",
    revokeObjectUrl: (url) => revoked.push(url),
    clickDownload: () => {
      throw new Error("popup blocked");
    },
    scheduleRevoke: (callback) => scheduled.push(callback),
  };

  assert.throws(() => saveBlobAsFile(new Blob(["x"]), "a.jpg", dependencies));
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  assert.deepEqual(revoked, ["blob:download/1"]);
});
