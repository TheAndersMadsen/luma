// The channel module imports extensionless TypeScript siblings.
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const {
  channelKey,
  channelKeyForSealed,
  resetChannelKey,
  setChannelRpcCallForTests,
} = await import("../src/server/channel.ts");
const { encodeEnvelope } = await import("../src/server/envelope.ts");
const { setLogSinkForTests } = await import("../src/server/log.ts");

test("channel establishment confirms a visible rename before retrying Cosmos or succeeding", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "revival-channel-establish-"));
  const file = path.join(directory, "channel-key.json");
  const previousFile = process.env.COSMOS_CHANNEL_KEY_FILE;
  const previousPrincipal = process.env.COSMOS_PRINCIPAL;
  process.env.COSMOS_CHANNEL_KEY_FILE = file;
  process.env.COSMOS_PRINCIPAL = "U:42364959-05da-423c-8c30-731fd7a7490e";

  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const originalFsync = fs.fsyncSync;
  let fsyncCalls = 0;
  let firstDirectorySyncFailed = false;
  let retryDirectoryConfirmed = false;
  let importCalls = 0;
  fs.fsyncSync = (descriptor) => {
    fsyncCalls += 1;
    if (fsyncCalls === 2) {
      firstDirectorySyncFailed = true;
      const error = new Error("injected establishment directory fsync failure");
      error.code = "EIO";
      throw error;
    }
    const result = originalFsync(descriptor);
    if (firstDirectorySyncFailed) retryDirectoryConfirmed = true;
    return result;
  };
  setChannelRpcCallForTests(async (_service, method) => {
    if (firstDirectorySyncFailed) {
      assert.equal(
        retryDirectoryConfirmed,
        true,
        `Cosmos ${method} ran before the renamed store's parent directory was synced`,
      );
    }
    if (method === "EstablishWrappingKeys") {
      return { clearKey: { jcaEncoded: publicDer } };
    }
    if (method === "ImportKeys") {
      importCalls += 1;
      return { results: [{ status: "KEY_IMPORTED" }] };
    }
    throw new Error(`unexpected channel RPC ${method}`);
  });
  setLogSinkForTests(() => {});
  resetChannelKey();

  t.after(async () => {
    fs.fsyncSync = originalFsync;
    setChannelRpcCallForTests(null);
    setLogSinkForTests(null);
    resetChannelKey();
    if (previousFile === undefined) delete process.env.COSMOS_CHANNEL_KEY_FILE;
    else process.env.COSMOS_CHANNEL_KEY_FILE = previousFile;
    if (previousPrincipal === undefined) delete process.env.COSMOS_PRINCIPAL;
    else process.env.COSMOS_PRINCIPAL = previousPrincipal;
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(channelKey(), /Channel key storage is unavailable/u);
  assert.equal(importCalls, 1, "the first Cosmos import completed before local durability failed");
  assert.equal(firstDirectorySyncFailed, true);
  const renamed = JSON.parse(await readFile(file, "utf8"));
  assert.equal(typeof renamed.key, "string", "the failed fsync happened after rename visibility");

  const recovered = await channelKey();
  assert.equal(recovered.kid, `${process.env.COSMOS_PRINCIPAL}/center/ephemeral`);
  assert.equal(importCalls, 2, "the retry re-established only after confirming local durability");
  assert.equal(retryDirectoryConfirmed, true);
});

test("restart open confirms store durability before returning a key named by an envelope", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "revival-channel-restart-"));
  const file = path.join(directory, "channel-key.json");
  const previousFile = process.env.COSMOS_CHANNEL_KEY_FILE;
  const previousPrincipal = process.env.COSMOS_PRINCIPAL;
  const principal = "U:42364959-05da-423c-8c30-731fd7a7490e";
  const kid = `${principal}/center/ephemeral`;
  const key = Buffer.alloc(16, 0x55);
  process.env.COSMOS_CHANNEL_KEY_FILE = file;
  process.env.COSMOS_PRINCIPAL = principal;
  fs.writeFileSync(file, JSON.stringify({
    kid,
    key: key.toString("base64"),
    keys: { [kid]: key.toString("base64") },
  }), { mode: 0o600 });

  const sealed = encodeEnvelope({
    kid,
    aad: Buffer.alloc(0),
    iv: Buffer.alloc(12),
    authTag: Buffer.alloc(16),
    ciphertext: Buffer.from("not opened by this lookup"),
  });
  const originalFsync = fs.fsyncSync;
  let attempts = 0;
  fs.fsyncSync = (descriptor) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("injected restart directory fsync failure");
      error.code = "EIO";
      throw error;
    }
    return originalFsync(descriptor);
  };
  let rpcCalls = 0;
  setChannelRpcCallForTests(async () => {
    rpcCalls += 1;
    throw new Error("stored envelope lookup must not contact Cosmos");
  });
  resetChannelKey();

  t.after(async () => {
    fs.fsyncSync = originalFsync;
    setChannelRpcCallForTests(null);
    resetChannelKey();
    if (previousFile === undefined) delete process.env.COSMOS_CHANNEL_KEY_FILE;
    else process.env.COSMOS_CHANNEL_KEY_FILE = previousFile;
    if (previousPrincipal === undefined) delete process.env.COSMOS_PRINCIPAL;
    else process.env.COSMOS_PRINCIPAL = previousPrincipal;
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(channelKeyForSealed(sealed), /Channel key storage is unavailable/u);
  const recovered = await channelKeyForSealed(sealed);
  assert.equal(recovered.kid, kid);
  assert.deepEqual(recovered.key, key);
  assert.equal(rpcCalls, 0);
  assert.equal(attempts, 2, "the next first use did not retry parent-directory fsync");
});

test("accepted current and legacy principals persist in the exact grammar a restart reads", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "revival-channel-identities-"));
  const previousFile = process.env.COSMOS_CHANNEL_KEY_FILE;
  const previousPrincipal = process.env.COSMOS_PRINCIPAL;
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  setChannelRpcCallForTests(async (_service, method) => {
    if (method === "EstablishWrappingKeys") return { clearKey: { jcaEncoded: publicDer } };
    if (method === "ImportKeys") return { results: [{ status: "KEY_IMPORTED" }] };
    throw new Error(`unexpected channel RPC ${method}`);
  });
  t.after(async () => {
    setChannelRpcCallForTests(null);
    resetChannelKey();
    if (previousFile === undefined) delete process.env.COSMOS_CHANNEL_KEY_FILE;
    else process.env.COSMOS_CHANNEL_KEY_FILE = previousFile;
    if (previousPrincipal === undefined) delete process.env.COSMOS_PRINCIPAL;
    else process.env.COSMOS_PRINCIPAL = previousPrincipal;
    await rm(directory, { recursive: true, force: true });
  });

  for (const [index, principal] of [
    "U:current-subject",
    "V:01:D:web-demo:U:legacy-subject",
  ].entries()) {
    process.env.COSMOS_CHANNEL_KEY_FILE = path.join(directory, `store-${index}.json`);
    process.env.COSMOS_PRINCIPAL = principal;
    resetChannelKey();
    const first = await channelKey();
    const bytes = await readFile(process.env.COSMOS_CHANNEL_KEY_FILE);
    resetChannelKey();
    const restarted = await channelKey();
    assert.equal(restarted.kid, first.kid);
    assert.deepEqual(restarted.key, first.key);
    assert.deepEqual(await readFile(process.env.COSMOS_CHANNEL_KEY_FILE), bytes);
  }
});

test("invalid current or legacy principals perform no RPC and create no store", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "revival-channel-invalid-identity-"));
  const file = path.join(directory, "channel-key.json");
  const previousFile = process.env.COSMOS_CHANNEL_KEY_FILE;
  const previousPrincipal = process.env.COSMOS_PRINCIPAL;
  process.env.COSMOS_CHANNEL_KEY_FILE = file;
  let rpcCalls = 0;
  setChannelRpcCallForTests(async () => {
    rpcCalls += 1;
    throw new Error("invalid identity must not call Cosmos");
  });
  t.after(async () => {
    setChannelRpcCallForTests(null);
    resetChannelKey();
    if (previousFile === undefined) delete process.env.COSMOS_CHANNEL_KEY_FILE;
    else process.env.COSMOS_CHANNEL_KEY_FILE = previousFile;
    if (previousPrincipal === undefined) delete process.env.COSMOS_PRINCIPAL;
    else process.env.COSMOS_PRINCIPAL = previousPrincipal;
    await rm(directory, { recursive: true, force: true });
  });

  for (const principal of [
    "U:subject:extra",
    "U:",
    "U:subject\u0085",
    "V:01:D:web-demo:U:subject:extra",
    "V:1:D:web-demo:U:subject",
    "V:01:D:web/demo:U:subject",
  ]) {
    process.env.COSMOS_PRINCIPAL = principal;
    resetChannelKey();
    await assert.rejects(channelKey(), /current wearer identity is invalid/u, principal);
  }
  assert.equal(rpcCalls, 0);
  assert.deepEqual(fs.readdirSync(directory), [], "invalid identities wrote durable state");
});
