import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_DUMP_ADB_ARGS,
  MEDIA_VOLUME_GET_ADB_ARGS,
  buildMediaVolumeSetAdbArgs,
  captureStableMediaVolumeSnapshot,
  parseMediaVolumeCommandOutput,
  parseMediaVolumeSnapshot,
  parseMusicStreamMuteState,
  restoreMediaVolumeSnapshot,
} from "./media-volume-state-guard.mjs";

const VOLUME_OUTPUT = [
  "[V] will control stream=3 (MUSIC)",
  "[V] will get volume",
  "[V] Connecting to AudioService",
  "[V] volume is 7 in range [0..15]",
].join("\n");

function audioDump(muted = false) {
  return [
    "Audio service state:",
    "Stream volumes (device: index)",
    "- STREAM_VOICE_CALL:",
    "   Muted: false",
    "   Current: 2 (speaker): 3",
    "- STREAM_MUSIC:",
    `   Muted: ${String(muted)}`,
    "   Muted Internally: false",
    "   Min: 0",
    "   Max: 15",
    "   streamVolume:7",
    "   Current: 2 (speaker): 7",
    "   Devices: speaker",
    "- STREAM_ALARM:",
    "   Muted: false",
  ].join("\n");
}

function state(overrides = {}) {
  return { index: 7, minimum: 0, maximum: 15, muted: false, ...overrides };
}

test("volume guard commands are fixed to STREAM_MUSIC and a bounded index", () => {
  assert.deepEqual(MEDIA_VOLUME_GET_ADB_ARGS, [
    "shell", "cmd", "media_session", "volume", "--stream", "3", "--get",
  ]);
  assert.deepEqual(AUDIO_DUMP_ADB_ARGS, ["shell", "dumpsys", "audio"]);
  assert.deepEqual(buildMediaVolumeSetAdbArgs(7), [
    "shell", "cmd", "media_session", "volume", "--stream", "3", "--set", "7",
  ]);
  for (const value of [-1, 0, 101, 1.5, "7"]) {
    assert.throws(() => buildMediaVolumeSetAdbArgs(value), /invalid guarded/);
  }
});

test("bounded parsers retain only selected-route volume and the STREAM_MUSIC mute bit", () => {
  assert.deepEqual(parseMediaVolumeCommandOutput(VOLUME_OUTPUT), {
    index: 7,
    minimum: 0,
    maximum: 15,
  });
  assert.equal(parseMusicStreamMuteState(audioDump(false)), false);
  assert.equal(parseMusicStreamMuteState(audioDump(true)), true);
  assert.deepEqual(parseMediaVolumeSnapshot(VOLUME_OUTPUT, audioDump(false)), state());
});

test("volume parsers fail closed on ambiguity, malformed ranges, or oversized raw output", () => {
  for (const value of [
    "volume is 7 in range [0..15]\nvolume is 8 in range [0..15]",
    "volume is 16 in range [0..15]",
    "volume is 7 in range [15..0]",
    "PRIVATE_RAW_DUMPSYS",
    "x".repeat(4 * 1024 + 1),
  ]) {
    assert.throws(() => parseMediaVolumeCommandOutput(value), /unavailable/);
  }
  for (const value of [
    audioDump(false).replace("   Muted: false\n   Muted Internally", "   Muted Internally"),
    `${audioDump(false)}\n- STREAM_MUSIC:\n   Muted: false`,
    "x".repeat(2 * 1024 * 1024 + 1),
  ]) {
    assert.throws(() => parseMusicStreamMuteState(value), /unavailable/);
  }
});

test("capture requires two identical, non-muted, nonzero observations before any prompt", async () => {
  let reads = 0;
  const stable = {
    async readMediaVolumeState() {
      reads += 1;
      return state();
    },
  };
  assert.deepEqual(await captureStableMediaVolumeSnapshot(stable), state());
  assert.equal(reads, 2);

  for (const observations of [
    [state(), state({ index: 6 })],
    [state({ muted: true, index: 0 }), state({ muted: true, index: 0 })],
    [state({ index: 0 }), state({ index: 0 })],
  ]) {
    let index = 0;
    await assert.rejects(
      captureStableMediaVolumeSnapshot({
        async readMediaVolumeState() { return observations[index++]; },
      }),
      /guard was unavailable/,
    );
  }
});

test("restore verifies two exact post-set observations and never throws", async () => {
  let selected = null;
  const device = {
    async setMediaVolumeIndex(index) { selected = index; },
    async readMediaVolumeState() { return state(); },
  };
  assert.equal(await restoreMediaVolumeSnapshot(device, state()), true);
  assert.equal(selected, 7);

  assert.equal(
    await restoreMediaVolumeSnapshot({
      async setMediaVolumeIndex() {},
      async readMediaVolumeState() { return state({ index: 6 }); },
    }, state()),
    false,
  );
  assert.equal(
    await restoreMediaVolumeSnapshot({
      async setMediaVolumeIndex() { throw new Error("PRIVATE_FAILURE"); },
      async readMediaVolumeState() { throw new Error("PRIVATE_FAILURE"); },
    }, state()),
    false,
  );
});
