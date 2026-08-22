import "./tsResolve.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const {
  CHANNEL_KEY_STORE_DEGRADED,
  ChannelKeyUnavailableError,
  storedKeysFor,
} = await import("../src/server/channelStore.ts");
const { sourceHeaders } = await import("../src/server/headers.ts");

test("x-data-degraded exposes one stable path-free channel-store sentinel", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "secret-channel-store-path-"));
  const previous = process.env.COSMOS_CHANNEL_KEY_FILE;
  process.env.COSMOS_CHANNEL_KEY_FILE = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.COSMOS_CHANNEL_KEY_FILE;
    else process.env.COSMOS_CHANNEL_KEY_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });

  let failure;
  try {
    storedKeysFor("U:wearer/center/ephemeral");
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof ChannelKeyUnavailableError);
  const headers = sourceHeaders({
    source: "fixtures",
    state: "degraded",
    fallback: "empty",
    degraded: failure.message,
  });
  assert.equal(headers["x-data-degraded"], CHANNEL_KEY_STORE_DEGRADED);
  assert.doesNotMatch(headers["x-data-degraded"], /secret-channel-store-path|\/tmp|E[A-Z]+/u);
});
