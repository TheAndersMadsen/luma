// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkForUpdate, readUpdateStatus, resetUpdateCheckCache, updateOverview, updateSettings } from "./updates";

/*
 * The update check asks one https origin for its `/api/version`, compares
 * `X.Y.Z` versions, caches the answer for an hour, and never throws: every
 * failure is a typed outcome the page and banner render.
 */

const SOURCE = "https://updates.example.test";
const ENV = {
  LUMA_RELEASE_ID: "abc123",
  LUMA_RELEASE_VERSION: "0.3.16",
  LUMA_UPDATE_SOURCE: `${SOURCE}/some/path`,
};

function manifest(version: string | null, extra: Record<string, unknown> = {}) {
  return {
    product: "Luma Center",
    release: "def456",
    environment: "production",
    version,
    tag: version ? `v${version}` : null,
    pin: { version: "2026-10-02.1", versionCode: 2026100201 },
    notes: "Calmer banner.",
    publishedAt: "2026-10-02T18:00:00Z",
    ...extra,
  };
}

function answering(body: unknown, init: ResponseInit = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    typeof body === "string" ? new Response(body, init) : Response.json(body, init),
  );
}

let clock = Date.parse("2026-10-03T02:00:00Z");
const now = () => clock;

beforeEach(() => {
  resetUpdateCheckCache();
  clock = Date.parse("2026-10-03T02:00:00Z");
});

describe("checkForUpdate", () => {
  it("fetches the source origin's manifest with a deadline and reports a newer release", async () => {
    const fetchImpl = answering(manifest("0.3.18"));
    const check = await checkForUpdate({ environment: ENV, fetchImpl: fetchImpl as typeof fetch, now });

    expect(check).toEqual({
      outcome: "update-available",
      checkedAt: "2026-10-03T02:00:00.000Z",
      latest: {
        version: "0.3.18",
        tag: "v0.3.18",
        pinVersion: "2026-10-02.1",
        notes: "Calmer banner.",
        publishedAt: "2026-10-02T18:00:00Z",
      },
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${SOURCE}/api/version`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("error");
  });

  it("compares numerically, not as text", async () => {
    const newer = await checkForUpdate({
      environment: { ...ENV, LUMA_RELEASE_VERSION: "0.3.9" },
      fetchImpl: answering(manifest("0.3.10")) as typeof fetch,
      now,
      force: true,
    });
    expect(newer.outcome).toBe("update-available");

    for (const [mine, theirs] of [["0.3.16", "0.3.16"], ["0.4.0", "0.3.99"]] as const) {
      const check = await checkForUpdate({
        environment: { ...ENV, LUMA_RELEASE_VERSION: mine },
        fetchImpl: answering(manifest(theirs)) as typeof fetch,
        now,
        force: true,
      });
      expect(check.outcome).toBe("up-to-date");
    }
  });

  it("compares against the source's latest advertisement before its own running version", async () => {
    const advertisement = {
      version: "0.3.20",
      tag: "v0.3.20",
      pin: { version: "2026-10-05.1", versionCode: null },
      notes: "Tool servers for everyone.",
      publishedAt: "2026-10-05T09:00:00Z",
    };
    // The source still runs 0.3.16; what it advertises decides.
    const available = await checkForUpdate({
      environment: ENV,
      fetchImpl: answering(manifest("0.3.16", { latest: advertisement })) as typeof fetch,
      now,
    });
    expect(available).toEqual({
      outcome: "update-available",
      checkedAt: "2026-10-03T02:00:00.000Z",
      latest: {
        version: "0.3.20",
        tag: "v0.3.20",
        pinVersion: "2026-10-05.1",
        notes: "Tool servers for everyone.",
        publishedAt: "2026-10-05T09:00:00Z",
      },
    });

    // Running exactly the advertised release is up to date even while the
    // source's identity field still names its older deployment.
    const current = await checkForUpdate({
      environment: { ...ENV, LUMA_RELEASE_VERSION: "0.3.20" },
      fetchImpl: answering(manifest("0.3.16", { latest: advertisement })) as typeof fetch,
      now,
      force: true,
    });
    expect(current.outcome).toBe("up-to-date");
  });

  it("says source-unknown without fetching when no https source is set", async () => {
    const fetchImpl = answering(manifest("0.3.18"));
    for (const source of [undefined, "", "http://plain.example.test", "not a url", "file:///etc/passwd"]) {
      const check = await checkForUpdate({
        environment: { ...ENV, LUMA_UPDATE_SOURCE: source },
        fetchImpl: fetchImpl as typeof fetch,
        now,
      });
      expect(check).toEqual({ outcome: "source-unknown" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says unknown-version when this Center has no release version to compare", async () => {
    const check = await checkForUpdate({
      environment: { ...ENV, LUMA_RELEASE_VERSION: undefined },
      fetchImpl: answering(manifest("0.3.18")) as typeof fetch,
      now,
    });
    expect(check.outcome).toBe("unknown-version");
    expect("latest" in check && check.latest.version).toBe("0.3.18");
  });

  it.each([
    ["a server error", () => answering({ error: "down" }, { status: 503 })],
    ["a network failure", () => vi.fn(async () => { throw new TypeError("fetch failed"); })],
    ["the deadline", () => vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); })],
    ["a non-JSON answer", () => answering("<html>hello</html>")],
    ["a manifest with no version", () => answering(manifest(null))],
    ["a manifest from an older Center", () => answering({ product: "Luma Center", release: "x", environment: "production" })],
    ["an oversized answer", () => answering(manifest("0.3.18", { padding: "x".repeat(20_000) }))],
    ["notes over the bound", () => answering(manifest("0.3.18", { notes: "x".repeat(2001) }))],
  ])("reports source-unreachable on %s", async (_label, make) => {
    const check = await checkForUpdate({ environment: ENV, fetchImpl: make() as typeof fetch, now });
    expect(check).toEqual({ outcome: "source-unreachable", checkedAt: "2026-10-03T02:00:00.000Z" });
  });

  it("caches an answer for an hour and a failure for five minutes; force skips the cache", async () => {
    const good = answering(manifest("0.3.18"));
    await checkForUpdate({ environment: ENV, fetchImpl: good as typeof fetch, now });
    clock += 59 * 60 * 1000;
    await checkForUpdate({ environment: ENV, fetchImpl: good as typeof fetch, now });
    expect(good).toHaveBeenCalledTimes(1);
    await checkForUpdate({ environment: ENV, fetchImpl: good as typeof fetch, now, force: true });
    expect(good).toHaveBeenCalledTimes(2);
    clock += 61 * 60 * 1000;
    await checkForUpdate({ environment: ENV, fetchImpl: good as typeof fetch, now });
    expect(good).toHaveBeenCalledTimes(3);

    resetUpdateCheckCache();
    const bad = answering({}, { status: 502 });
    await checkForUpdate({ environment: ENV, fetchImpl: bad as typeof fetch, now });
    clock += 4 * 60 * 1000;
    await checkForUpdate({ environment: ENV, fetchImpl: bad as typeof fetch, now });
    expect(bad).toHaveBeenCalledTimes(1);
    clock += 2 * 60 * 1000;
    await checkForUpdate({ environment: ENV, fetchImpl: bad as typeof fetch, now });
    expect(bad).toHaveBeenCalledTimes(2);
  });
});

describe("the status file", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "luma-update-status-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is read when present and tolerates omitted fields", async () => {
    const file = join(dir, "status.json");
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      checkedAt: "2026-10-03T02:00:00Z",
      autoUpdates: "on",
      lastUpdate: { outcome: "rolled-back", from: "0.3.16", to: "0.3.18", finishedAt: "2026-10-03T02:10:00Z" },
    }));
    const status = await readUpdateStatus({ LUMA_UPDATE_STATUS_FILE: file });
    expect(status?.autoUpdates).toBe("on");
    expect(status?.lastUpdate).toMatchObject({ outcome: "rolled-back", from: "0.3.16", to: "0.3.18" });
  });

  it.each([
    ["no variable", undefined, null],
    ["a missing file", "missing.json", null],
    ["broken JSON", "broken.json", "{"],
    ["another schema version", "v2.json", JSON.stringify({ schemaVersion: 2 })],
    ["an unknown outcome", "odd.json", JSON.stringify({ schemaVersion: 1, lastUpdate: { outcome: "exploded" } })],
  ])("reads as absent with %s", async (_label, name, contents) => {
    const file = name ? join(dir, name) : undefined;
    if (file && contents !== null) await writeFile(file, contents);
    expect(await readUpdateStatus({ LUMA_UPDATE_STATUS_FILE: file })).toBeNull();
  });

  it("feeds the overview, with the environment's auto-update setting winning", async () => {
    const file = join(dir, "status.json");
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      autoUpdates: "on",
      lastUpdate: { outcome: "updated", from: "0.3.15", to: "0.3.16" },
    }));
    const overview = await updateOverview({
      environment: { ...ENV, LUMA_UPDATE_STATUS_FILE: file, LUMA_PIN_RELEASE_VERSION: "2026-09-29.2" },
      fetchImpl: answering(manifest("0.3.16")) as typeof fetch,
      now,
    });
    expect(overview).toMatchObject({
      current: { version: "0.3.16", pinVersion: "2026-09-29.2" },
      source: SOURCE,
      autoUpdates: "on",
      check: { outcome: "up-to-date" },
      lastUpdate: { outcome: "updated", to: "0.3.16" },
    });

    const off = await updateOverview({
      environment: { ...ENV, LUMA_UPDATE_STATUS_FILE: file, LUMA_AUTO_UPDATES: "off" },
      fetchImpl: answering(manifest("0.3.16")) as typeof fetch,
      now,
    });
    expect(off.autoUpdates).toBe("off");
  });
});

describe("updateSettings", () => {
  it("answers unknown for an absent or unrecognised auto-update setting", () => {
    expect(updateSettings({}).autoUpdates).toBe("unknown");
    expect(updateSettings({ LUMA_AUTO_UPDATES: "sometimes" }).autoUpdates).toBe("unknown");
    expect(updateSettings({ LUMA_AUTO_UPDATES: " ON " }).autoUpdates).toBe("on");
  });
});
