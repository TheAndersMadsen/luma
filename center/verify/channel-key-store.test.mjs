// The store module imports its own extensionless sibling (`./log`).
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const {
  CHANNEL_KEY_STORE_DEGRADED,
  ChannelKeyUnavailableError,
  channelKeyFile,
  namesSameWearer,
  parseCenterKid,
  parseCenterPrincipal,
  saveKey,
  storedKeysFor,
} = await import("../src/server/channelStore.ts");
const { setLogSinkForTests } = await import("../src/server/log.ts");

/*
 * The wearer's channel key is irreplaceable. Nothing else in this deployment
 * can be re-derived from a backup of something else: lose it and every note and
 * every capture frame sealed under it is permanently "sealed", with no error
 * anywhere that says why.
 *
 * Three ways it was reachable, all of them silent:
 *
 *   1. the derived kid changed shape (`V:01:D:web-demo:U:<sub>/…` became
 *      `U:<sub>/…` for the same person), so the wearer's own established key
 *      stopped matching and a second one was minted over it;
 *   2. `readStore` returned `{}` for an unreadable file, so an EACCES on /data
 *      was indistinguishable from a first run — and a first run mints a key;
 *   3. the write truncated in place, so an interrupted write left an empty file
 *      where the key had been.
 *
 * Every test here writes a real file and reads it back. The kid used throughout
 * is the shape the live deployment actually holds.
 */

const SUB = "42364959-05da-423c-8c30-731fd7a7490e";
const STORED_KID = `V:01:D:web-demo:U:${SUB}/center/ephemeral`;
const DERIVED_KID = `U:${SUB}/center/ephemeral`;
const OTHER_KID = "U:9f1d0c33-1111-2222-3333-444455556666/center/ephemeral";

/** Distinct, canonical, 16-byte AES-128 material, as the store holds it. */
const STORED_KEY = Buffer.alloc(16, 0x11).toString("base64");
const FRESH_KEY = Buffer.alloc(16, 0x22);
const OTHER_KEY = Buffer.alloc(16, 0x33).toString("base64");

/** Point the module at a scratch store for one test, and put it back after. */
async function withStore(context, contents) {
  const directory = await mkdtemp(path.join(tmpdir(), "revival-channel-key-"));
  const file = path.join(directory, "channel-key.json");
  const previous = process.env.COSMOS_CHANNEL_KEY_FILE;
  process.env.COSMOS_CHANNEL_KEY_FILE = file;
  context.after(async () => {
    if (previous === undefined) delete process.env.COSMOS_CHANNEL_KEY_FILE;
    else process.env.COSMOS_CHANNEL_KEY_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  if (contents !== undefined) {
    await writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents), {
      mode: 0o600,
    });
  }
  return { directory, file };
}

const read = async (file) => JSON.parse(await readFile(file, "utf8"));

function preserveChannelFileEnvironment(context) {
  const cosmos = process.env.COSMOS_CHANNEL_KEY_FILE;
  context.after(() => {
    if (cosmos === undefined) delete process.env.COSMOS_CHANNEL_KEY_FILE;
    else process.env.COSMOS_CHANNEL_KEY_FILE = cosmos;
  });
}

async function withDefaultStoreDirectory(context) {
  preserveChannelFileEnvironment(context);
  delete process.env.COSMOS_CHANNEL_KEY_FILE;
  const directory = await mkdtemp(path.join(tmpdir(), "revival-channel-default-"));
  const previousWorkingDirectory = process.cwd();
  process.chdir(directory);
  context.after(async () => {
    process.chdir(previousWorkingDirectory);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    cosmos: path.join(directory, ".cosmos-channel-key.json"),
  };
}

test("the unconfigured local default uses the Cosmos filename", async (t) => {
  const defaults = await withDefaultStoreDirectory(t);
  assert.equal(channelKeyFile(), defaults.cosmos);

  await writeFile(defaults.cosmos, "cosmos", { mode: 0o600 });
  assert.equal(channelKeyFile(), defaults.cosmos);
});

test("Git and Docker ignore the local channel-key file and temporary siblings", async () => {
  const center = new URL("../", import.meta.url);
  for (const name of [".gitignore", ".dockerignore"]) {
    const lines = new Set((await readFile(new URL(name, center), "utf8")).split(/\r?\n/u));
    assert.equal(
      lines.has(".cosmos-channel-key.json*"),
      true,
      `${name} exposes Cosmos key files`,
    );
  }
});

test("a wearer keeps their key when the kid we derive for them changes shape", async (t) => {
  // Exercise the earlier single-key store shape: a COSMOS_PRINCIPAL kid with no map.
  await withStore(t, { kid: STORED_KID, key: STORED_KEY });

  const found = storedKeysFor(DERIVED_KID);
  assert.equal(found.length, 1, "the established key was abandoned by the new derivation");
  // Returned under its OWN kid, because that is the name its envelopes use.
  assert.equal(found[0].kid, STORED_KID);
  assert.equal(found[0].key.toString("base64"), STORED_KEY);
});

test("a key stored under another wearer's kid is never returned", async (t) => {
  await withStore(t, { kid: OTHER_KID, key: OTHER_KEY, keys: { [OTHER_KID]: OTHER_KEY } });
  assert.deepEqual(storedKeysFor(DERIVED_KID), []);

  // Both supported kid forms are parsed to one exact wearer subject.
  assert.equal(namesSameWearer(STORED_KID, DERIVED_KID), true);
  assert.equal(namesSameWearer(DERIVED_KID, STORED_KID), true);
  assert.equal(namesSameWearer(OTHER_KID, DERIVED_KID), false);
  // No suffix, path, or delimiter trick may manufacture the same subject.
  assert.equal(namesSameWearer("U:cab/center/ephemeral", "U:ab/center/ephemeral"), false);
  for (const forged of [
    `prefix:${DERIVED_KID}`,
    `${DERIVED_KID}/copy`,
    `U:${SUB}:other/center/ephemeral`,
    `U:${SUB}/center/ephemeral/../ephemeral`,
    `V:01:D:web-demo:U:other:U:${SUB}/center/ephemeral`,
    `V:1:D:web-demo:U:${SUB}/center/ephemeral`,
    `V:01:D:web/demo:U:${SUB}/center/ephemeral`,
    `U:${SUB}:extra/center/ephemeral`,
    `U:${SUB}\u0085/center/ephemeral`,
  ]) {
    assert.equal(namesSameWearer(forged, DERIVED_KID), false, forged);
    assert.equal(namesSameWearer(DERIVED_KID, forged), false, forged);
  }
  assert.deepEqual(parseCenterPrincipal(`U:${SUB}`), { principal: `U:${SUB}`, subject: SUB });
  assert.deepEqual(parseCenterKid(STORED_KID), {
    principal: `V:01:D:web-demo:U:${SUB}`,
    subject: SUB,
    kid: STORED_KID,
  });
});

test("the exact kid is offered before an inherited one", async (t) => {
  // The map is written legacy-kid-FIRST on purpose. In insertion order the
  // inherited kid therefore comes out in front, so the ordering below is only
  // satisfied by the sort in storedKeysFor and not by the shape of the fixture.
  // With the derived kid listed first this test passed with the sort deleted.
  await withStore(t, {
    kid: STORED_KID,
    key: STORED_KEY,
    keys: {
      [STORED_KID]: STORED_KEY,
      [DERIVED_KID]: FRESH_KEY.toString("base64"),
    },
  });

  const found = storedKeysFor(DERIVED_KID);
  assert.deepEqual(
    found.map((candidate) => candidate.kid),
    [DERIVED_KID, STORED_KID],
  );
  // The one we seal under really is the one the exact kid names.
  assert.equal(found[0].key.toString("base64"), FRESH_KEY.toString("base64"));
});

test("persisting a key migrates the legacy pair into the map instead of orphaning it", async (t) => {
  const { file, directory } = await withStore(t, { kid: STORED_KID, key: STORED_KEY });

  saveKey({ kid: DERIVED_KID, key: FRESH_KEY });
  const document = await read(file);

  // The restore-compatible mirror is untouched: it is the shape a restored
  // deployment carries forward and the shape the staging smoke asserts.
  assert.equal(document.kid, STORED_KID);
  assert.equal(document.key, STORED_KEY);
  // …and the key it names is now reachable through the map as well, so a reader
  // resolving an envelope by its kid finds it.
  assert.deepEqual(document.keys, {
    [STORED_KID]: STORED_KEY,
    [DERIVED_KID]: FRESH_KEY.toString("base64"),
  });

  // The deploy's channel-key contract (platform/deploy/vps/remote/common.sh,
  // validate_center_channel_key_json) accepts exactly these fields and holds
  // every map entry to the rules the pair is held to. Backup, cutover AND
  // restore all run it, so a document this writer produces that the validator
  // rejects closes the recovery path out of the release that produced it.
  assert.deepEqual(Object.keys(document).sort(), ["key", "keys", "kid"]);
  for (const [kid, encoded] of [["kid", document.key], ...Object.entries(document.keys)]) {
    const bytes = Buffer.from(encoded, "base64");
    assert.equal(bytes.length, 16, `${kid} is not 16 AES-128 bytes`);
    assert.equal(bytes.toString("base64"), encoded, `${kid} is not canonical base64`);
  }

  // Wearer key material, and only where it is meant to be.
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ["channel-key.json"]);
});

test("the store is replaced by rename, never truncated in place", async (t) => {
  /*
   * The third property this module claims — "A WRITE CAN BE HALF DONE" — was the
   * only one nothing here proved. Replacing writeStore's whole body with the
   * pre-fix `fs.writeFileSync(file, …)` left all eight tests green, so the
   * atomic write could have been undone without a single failure: exactly the
   * silent-regression shape the rest of this file exists to prevent.
   *
   * A rename produces a NEW inode; an in-place write keeps the old one. That is
   * the observable difference between "a reader sees either the whole old file
   * or the whole new one" and "a reader can see a truncated file", and it is
   * checkable without racing a crash.
   */
  const { file } = await withStore(t, { kid: STORED_KID, key: STORED_KEY });
  const before = await stat(file);

  saveKey({ kid: DERIVED_KID, key: FRESH_KEY });

  const after = await stat(file);
  assert.notEqual(
    after.ino,
    before.ino,
    "the key file kept its inode, so it was truncated and rewritten in place rather than replaced by rename - an interrupted write leaves nothing where the wearer's only key was",
  );
  // …and the replacement is complete, not a half-written sibling left behind.
  assert.deepEqual(await readdir(path.dirname(file)), ["channel-key.json"]);
  assert.equal((await read(file)).keys[DERIVED_KID], FRESH_KEY.toString("base64"));
});

test("a second wearer establishing does not erase the first", async (t) => {
  const { file } = await withStore(t, { kid: STORED_KID, key: STORED_KEY });

  saveKey({ kid: DERIVED_KID, key: FRESH_KEY });
  saveKey({ kid: OTHER_KID, key: Buffer.from(OTHER_KEY, "base64") });

  const document = await read(file);
  assert.deepEqual(Object.keys(document.keys).sort(), [STORED_KID, OTHER_KID, DERIVED_KID].sort());
  assert.equal(document.keys[DERIVED_KID], FRESH_KEY.toString("base64"));
  assert.equal(document.kid, STORED_KID);
});

test("an unreadable store is reported, never mistaken for a first run", async (t) => {
  // A directory where the file should be reproduces the shape of the failure
  // that matters (EACCES on /data for uid 1000) without needing to drop
  // privileges: readFileSync fails with something that is not ENOENT.
  const directory = await mkdtemp(path.join(tmpdir(), "revival-channel-key-"));
  const previous = process.env.COSMOS_CHANNEL_KEY_FILE;
  process.env.COSMOS_CHANNEL_KEY_FILE = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.COSMOS_CHANNEL_KEY_FILE;
    else process.env.COSMOS_CHANNEL_KEY_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });

  assert.throws(() => storedKeysFor(DERIVED_KID), ChannelKeyUnavailableError);
  assert.throws(() => storedKeysFor(DERIVED_KID), new RegExp(CHANNEL_KEY_STORE_DEGRADED));

  // And the writer refuses rather than replacing what it could not read — the
  // bytes underneath may be the only copy of somebody's key — but says so.
  const warnings = [];
  setLogSinkForTests((level, line) => warnings.push(`${level} ${line.trimEnd()}`));
  try {
    assert.throws(
      () => saveKey({ kid: DERIVED_KID, key: FRESH_KEY }),
      ChannelKeyUnavailableError,
    );
  } finally {
    setLogSinkForTests(null);
  }
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /^warn /);
  assert.match(warnings[0], /refusing unsafe channel-key store/);
  // The key itself is never in the sentence.
  assert.doesNotMatch(warnings[0], new RegExp(FRESH_KEY.toString("base64")));
  assert.deepEqual(await readdir(directory), [], "an unreadable store must not be written over");
});

test("a parent-directory fsync failure is propagated and a retry completes durability", async (t) => {
  const { file } = await withStore(t, { kid: STORED_KID, key: STORED_KEY });
  const originalFsync = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = (descriptor) => {
    calls += 1;
    // Existing-store confirmation, temporary-file sync, then replacement-dir
    // sync. Fail only that final durability boundary, after rename is visible.
    if (calls === 3) {
      const error = new Error("injected directory fsync failure");
      error.code = "EIO";
      throw error;
    }
    return originalFsync(descriptor);
  };
  t.after(() => {
    fs.fsyncSync = originalFsync;
    setLogSinkForTests(null);
  });

  const warnings = [];
  setLogSinkForTests((level, line) => warnings.push(`${level} ${line.trimEnd()}`));
  assert.throws(
    () => saveKey({ kid: DERIVED_KID, key: FRESH_KEY }),
    new RegExp(CHANNEL_KEY_STORE_DEGRADED),
    "a renamed-but-unsynced key must not be acknowledged",
  );
  assert.equal(warnings.length, 1);

  // The rename may already be visible even though it was not safe to
  // acknowledge. Repeating the idempotent save rewrites and syncs both the file
  // and its directory before returning success.
  saveKey({ kid: DERIVED_KID, key: FRESH_KEY });
  assert.equal((await read(file)).keys[DERIVED_KID], FRESH_KEY.toString("base64"));
  assert.deepEqual(await readdir(path.dirname(file)), ["channel-key.json"]);
});

test("an existing store must be exactly 0600 and remains byte-identical when refused", async (t) => {
  const { file } = await withStore(t, { kid: DERIVED_KID, key: STORED_KEY });
  for (const mode of [0o640, 0o400, 0o666]) {
    await chmod(file, mode);
    const before = await readFile(file);
    assert.throws(() => storedKeysFor(DERIVED_KID), new RegExp(CHANNEL_KEY_STORE_DEGRADED));
    assert.throws(
      () => saveKey({ kid: DERIVED_KID, key: FRESH_KEY }),
      new RegExp(CHANNEL_KEY_STORE_DEGRADED),
    );
    assert.deepEqual(await readFile(file), before, `mode ${mode.toString(8)} was rewritten`);
  }
});

test("the store is opened no-follow and read from that same bounded descriptor", async (t) => {
  const { file } = await withStore(t, { kid: DERIVED_KID, key: STORED_KEY });
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  let openedDescriptor = null;
  let readDescriptor = null;
  fs.openSync = (candidate, flags, ...rest) => {
    const descriptor = originalOpen(candidate, flags, ...rest);
    if (candidate === file) {
      assert.notEqual(flags & fs.constants.O_NOFOLLOW, 0, "store open omitted O_NOFOLLOW");
      openedDescriptor = descriptor;
    }
    return descriptor;
  };
  fs.readSync = (descriptor, ...args) => {
    readDescriptor ??= descriptor;
    return originalRead(descriptor, ...args);
  };
  t.after(() => {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
  });

  assert.equal(storedKeysFor(DERIVED_KID).length, 1);
  assert.equal(readDescriptor, openedDescriptor, "path was reopened instead of reading the observed fd");
});

test("a post-open read failure is never reclassified as an absent first run", async (t) => {
  const { file } = await withStore(t, { kid: DERIVED_KID, key: STORED_KEY });
  const before = await readFile(file);
  const originalRead = fs.readSync;
  fs.readSync = () => {
    const error = new Error("injected disappearance after open");
    error.code = "ENOENT";
    throw error;
  };
  t.after(() => {
    fs.readSync = originalRead;
  });

  assert.throws(() => storedKeysFor(DERIVED_KID), ChannelKeyUnavailableError);
  assert.throws(
    () => saveKey({ kid: DERIVED_KID, key: FRESH_KEY }),
    ChannelKeyUnavailableError,
  );
  assert.deepEqual(await readFile(file), before);
});

test("a path replacement after descriptor observation fails closed", async (t) => {
  const { file } = await withStore(t, { kid: DERIVED_KID, key: STORED_KEY });
  const originalLstat = fs.lstatSync;
  const originalPath = `${file}.observed`;
  let swapped = false;
  fs.lstatSync = (candidate, ...args) => {
    if (candidate === file && !swapped) {
      swapped = true;
      fs.renameSync(file, originalPath);
      fs.symlinkSync(originalPath, file);
    }
    return originalLstat(candidate, ...args);
  };
  t.after(() => {
    fs.lstatSync = originalLstat;
  });

  assert.throws(() => storedKeysFor(DERIVED_KID), new RegExp(CHANNEL_KEY_STORE_DEGRADED));
  assert.deepEqual(
    await readFile(originalPath),
    Buffer.from(JSON.stringify({ kid: DERIVED_KID, key: STORED_KEY })),
  );
});

test("a corrupt store is reported, never mistaken for a first run", async (t) => {
  await withStore(t, "{ this is not json");
  assert.throws(() => storedKeysFor(DERIVED_KID), ChannelKeyUnavailableError);
  assert.throws(() => storedKeysFor(DERIVED_KID), new RegExp(CHANNEL_KEY_STORE_DEGRADED));
});

test("every malformed runtime schema is refused byte-identically before use or rewrite", async (t) => {
  const { file } = await withStore(t);
  const key = Buffer.alloc(16, 0x44).toString("base64");
  const tooMany = Object.fromEntries(
    Array.from({ length: 257 }, (_, index) => [`U:wearer-${index}/center/ephemeral`, key]),
  );
  const cases = new Map([
    ["non-object", "[]"],
    ["missing kid", JSON.stringify({ key })],
    ["partial pair", JSON.stringify({ kid: DERIVED_KID })],
    ["unknown field", JSON.stringify({ kid: DERIVED_KID, key, algorithm: "AES" })],
    ["duplicate field", `{"kid":"${DERIVED_KID}","kid":"again","key":"${key}"}`],
    ["empty kid", JSON.stringify({ kid: "", key })],
    ["control kid", JSON.stringify({ kid: "bad\u0001kid", key })],
    ["unpaired surrogate kid", `{"kid":"\\ud800","key":"${key}"}`],
    ["oversized kid", JSON.stringify({ kid: "x".repeat(1025), key })],
    ["short key", JSON.stringify({ kid: DERIVED_KID, key: Buffer.alloc(15).toString("base64") })],
    ["noncanonical key", JSON.stringify({ kid: DERIVED_KID, key: `${key}\n` })],
    ["null map", JSON.stringify({ kid: DERIVED_KID, key, keys: null })],
    ["array map", JSON.stringify({ kid: DERIVED_KID, key, keys: [] })],
    ["oversized map", JSON.stringify({ kid: DERIVED_KID, key, keys: tooMany })],
    ["empty mapped kid", JSON.stringify({ kid: DERIVED_KID, key, keys: { "": key } })],
    [
      "bad mapped key",
      JSON.stringify({ kid: DERIVED_KID, key, keys: { [OTHER_KID]: "AA==" } }),
    ],
    [
      "duplicate mapped kid",
      `{"kid":"${DERIVED_KID}","key":"${key}","keys":{"${OTHER_KID}":"${key}","${OTHER_KID}":"${key}"}}`,
    ],
  ]);

  const warnings = [];
  setLogSinkForTests((level, line) => warnings.push(`${level} ${line.trimEnd()}`));
  t.after(() => setLogSinkForTests(null));
  for (const [name, body] of cases) {
    await writeFile(file, body, { mode: 0o600 });
    const before = await readFile(file);
    assert.throws(
      () => storedKeysFor(DERIVED_KID),
      ChannelKeyUnavailableError,
      `${name} was usable`,
    );
    assert.throws(
      () => saveKey({ kid: DERIVED_KID, key: FRESH_KEY }),
      ChannelKeyUnavailableError,
      `${name} was rewritten`,
    );
    assert.deepEqual(await readFile(file), before, `${name} changed on disk`);
  }
  assert.equal(
    warnings.length,
    cases.size * 2,
    "each refused read and refused rewrite should leave one operator-only diagnostic",
  );
});

test("an absent store is the first run, and is not an error", async (t) => {
  const { file } = await withStore(t);
  assert.deepEqual(storedKeysFor(DERIVED_KID), []);

  saveKey({ kid: DERIVED_KID, key: FRESH_KEY });
  const document = await read(file);
  // With nothing to mirror, the key being established becomes the pair.
  assert.equal(document.kid, DERIVED_KID);
  assert.equal(document.key, FRESH_KEY.toString("base64"));
  assert.deepEqual(document.keys, { [DERIVED_KID]: FRESH_KEY.toString("base64") });
});

function exactBoundaryStore() {
  const key = Buffer.alloc(16, 0x66).toString("base64");
  const suffix = "/center/ephemeral";
  const subjects = Array.from({ length: 240 }, (_, index) => `wearer-${index}`);
  const make = () => ({
    kid: `U:boundary${suffix}`,
    key,
    keys: Object.fromEntries(subjects.map((subject) => [`U:${subject}${suffix}`, key])),
  });
  let remaining = 16_384 - Buffer.byteLength(JSON.stringify(make()), "utf8");
  for (let index = 0; remaining > 0 && index < subjects.length; index += 1) {
    const room = 126 - subjects[index].length;
    const add = Math.min(room, remaining);
    subjects[index] += "x".repeat(add);
    remaining -= add;
  }
  assert.equal(remaining, 0, "fixture could not reach the exact byte boundary");
  const body = JSON.stringify(make());
  assert.equal(Buffer.byteLength(body, "utf8"), 16_384);
  return body;
}

test("an exact 16384-byte store remains readable and the next insert preserves its bytes", async (t) => {
  const body = exactBoundaryStore();
  const { file, directory } = await withStore(t, body);
  const before = await readFile(file);
  assert.equal(storedKeysFor("U:boundary/center/ephemeral").length, 1);

  assert.throws(
    () => saveKey({ kid: "U:next/center/ephemeral", key: Buffer.alloc(16, 0x77) }),
    new RegExp(CHANNEL_KEY_STORE_DEGRADED),
  );
  assert.deepEqual(await readFile(file), before, "oversize insertion replaced the readable store");
  assert.deepEqual(await readdir(directory), ["channel-key.json"], "a temp file was created");
  assert.equal(storedKeysFor("U:boundary/center/ephemeral").length, 1);
});
