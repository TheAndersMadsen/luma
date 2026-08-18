// The store module imports its own extensionless sibling (`./log`).
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const { ChannelKeyUnavailableError, namesSameWearer, saveKey, storedKeysFor } = await import(
  "../src/server/channelStore.ts"
);
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
const LEGACY_KID = `V:01:D:web-demo:U:${SUB}/center/ephemeral`;
const DERIVED_KID = `U:${SUB}/center/ephemeral`;
const OTHER_KID = "U:9f1d0c33-1111-2222-3333-444455556666/center/ephemeral";

/** Distinct, canonical, 16-byte AES-128 material, as the store holds it. */
const LEGACY_KEY = Buffer.alloc(16, 0x11).toString("base64");
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

test("a wearer keeps their key when the kid we derive for them changes shape", async (t) => {
  // Exactly what /home/anders/cosmos-center-data/channel-key.json holds today:
  // the pre-fix COSMOS_PRINCIPAL kid, no map.
  await withStore(t, { kid: LEGACY_KID, key: LEGACY_KEY });

  const found = storedKeysFor(DERIVED_KID);
  assert.equal(found.length, 1, "the established key was abandoned by the new derivation");
  // Returned under its OWN kid, because that is the name its envelopes use.
  assert.equal(found[0].kid, LEGACY_KID);
  assert.equal(found[0].key.toString("base64"), LEGACY_KEY);
});

test("a key stored under another wearer's kid is never returned", async (t) => {
  await withStore(t, { kid: OTHER_KID, key: OTHER_KEY, keys: { [OTHER_KID]: OTHER_KEY } });
  assert.deepEqual(storedKeysFor(DERIVED_KID), []);

  // The suffix rule matches on segment boundaries only, in both directions.
  assert.equal(namesSameWearer(LEGACY_KID, DERIVED_KID), true);
  assert.equal(namesSameWearer(DERIVED_KID, LEGACY_KID), true);
  assert.equal(namesSameWearer(OTHER_KID, DERIVED_KID), false);
  // `U:ab` must not be read as the tail of `U:cab`.
  assert.equal(namesSameWearer("U:cab/center/ephemeral", "U:ab/center/ephemeral"), false);
});

test("the exact kid is offered before an inherited one", async (t) => {
  // The map is written legacy-kid-FIRST on purpose. In insertion order the
  // inherited kid therefore comes out in front, so the ordering below is only
  // satisfied by the sort in storedKeysFor and not by the shape of the fixture.
  // With the derived kid listed first this test passed with the sort deleted.
  await withStore(t, {
    kid: LEGACY_KID,
    key: LEGACY_KEY,
    keys: {
      [LEGACY_KID]: LEGACY_KEY,
      [DERIVED_KID]: FRESH_KEY.toString("base64"),
    },
  });

  const found = storedKeysFor(DERIVED_KID);
  assert.deepEqual(
    found.map((candidate) => candidate.kid),
    [DERIVED_KID, LEGACY_KID],
  );
  // The one we seal under really is the one the exact kid names.
  assert.equal(found[0].key.toString("base64"), FRESH_KEY.toString("base64"));
});

test("persisting a key migrates the legacy pair into the map instead of orphaning it", async (t) => {
  const { file, directory } = await withStore(t, { kid: LEGACY_KID, key: LEGACY_KEY });

  saveKey({ kid: DERIVED_KID, key: FRESH_KEY });
  const document = await read(file);

  // The restore-compatible mirror is untouched: it is the shape a restored
  // deployment carries forward and the shape the staging smoke asserts.
  assert.equal(document.kid, LEGACY_KID);
  assert.equal(document.key, LEGACY_KEY);
  // …and the key it names is now reachable through the map as well, so a reader
  // resolving an envelope by its kid finds it.
  assert.deepEqual(document.keys, {
    [LEGACY_KID]: LEGACY_KEY,
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
  const { file } = await withStore(t, { kid: LEGACY_KID, key: LEGACY_KEY });
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
  const { file } = await withStore(t, { kid: LEGACY_KID, key: LEGACY_KEY });

  saveKey({ kid: DERIVED_KID, key: FRESH_KEY });
  saveKey({ kid: OTHER_KID, key: Buffer.from(OTHER_KEY, "base64") });

  const document = await read(file);
  assert.deepEqual(Object.keys(document.keys).sort(), [LEGACY_KID, OTHER_KID, DERIVED_KID].sort());
  assert.equal(document.keys[DERIVED_KID], FRESH_KEY.toString("base64"));
  assert.equal(document.kid, LEGACY_KID);
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
  assert.throws(() => storedKeysFor(DERIVED_KID), /could not be read/);

  // And the writer refuses rather than replacing what it could not read — the
  // bytes underneath may be the only copy of somebody's key — but says so.
  const warnings = [];
  setLogSinkForTests((level, line) => warnings.push(`${level} ${line.trimEnd()}`));
  try {
    saveKey({ kid: DERIVED_KID, key: FRESH_KEY });
  } finally {
    setLogSinkForTests(null);
  }
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /^warn /);
  assert.match(warnings[0], /could not be read before writing/);
  // The key itself is never in the sentence.
  assert.doesNotMatch(warnings[0], new RegExp(FRESH_KEY.toString("base64")));
  assert.deepEqual(await readdir(directory), [], "an unreadable store must not be written over");
});

test("a corrupt store is reported, never mistaken for a first run", async (t) => {
  await withStore(t, "{ this is not json");
  assert.throws(() => storedKeysFor(DERIVED_KID), ChannelKeyUnavailableError);
  assert.throws(() => storedKeysFor(DERIVED_KID), /not valid JSON/);
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
