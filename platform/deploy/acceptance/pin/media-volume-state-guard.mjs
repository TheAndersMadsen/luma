const MAX_VOLUME_COMMAND_BYTES = 4 * 1024;
const MAX_AUDIO_DUMP_BYTES = 2 * 1024 * 1024;

export const MUSIC_STREAM = 3;
export const MEDIA_VOLUME_GET_ADB_ARGS = Object.freeze([
  "shell",
  "cmd",
  "media_session",
  "volume",
  "--stream",
  String(MUSIC_STREAM),
  "--get",
]);
export const AUDIO_DUMP_ADB_ARGS = Object.freeze([
  "shell",
  "dumpsys",
  "audio",
]);

export function buildMediaVolumeSetAdbArgs(index) {
  if (!Number.isSafeInteger(index) || index <= 0 || index > 100) {
    throw new Error("invalid guarded media volume index");
  }
  return [
    "shell",
    "cmd",
    "media_session",
    "volume",
    "--stream",
    String(MUSIC_STREAM),
    "--set",
    String(index),
  ];
}

function boundedText(value, maximumBytes) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  if (buffer.length === 0 || buffer.length > maximumBytes) {
    throw new Error("media volume state was unavailable");
  }
  return buffer.toString("utf8").replaceAll("\r\n", "\n");
}

export function parseMediaVolumeCommandOutput(value) {
  const text = boundedText(value, MAX_VOLUME_COMMAND_BYTES);
  const matches = [...text.matchAll(
    /^(?:\[V\]\s*)?volume is ([0-9]+) in range \[([0-9]+)\.\.([0-9]+)\]$/gm,
  )];
  if (matches.length !== 1) {
    throw new Error("media volume state was unavailable");
  }
  const index = Number(matches[0][1]);
  const minimum = Number(matches[0][2]);
  const maximum = Number(matches[0][3]);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum < 0 ||
    maximum <= minimum ||
    maximum > 100 ||
    index < minimum ||
    index > maximum
  ) {
    throw new Error("media volume state was unavailable");
  }
  return { index, minimum, maximum };
}

export function parseMusicStreamMuteState(value) {
  const text = boundedText(value, MAX_AUDIO_DUMP_BYTES);
  const headers = [...text.matchAll(/^- STREAM_MUSIC:\s*$/gm)];
  if (headers.length !== 1) {
    throw new Error("media mute state was unavailable");
  }
  const blockStart = headers[0].index + headers[0][0].length;
  const tail = text.slice(blockStart);
  const nextHeader = /^- STREAM_[A-Z0-9_]+:\s*$/m.exec(tail);
  const block = nextHeader === null ? tail : tail.slice(0, nextHeader.index);
  const muted = [...block.matchAll(/^\s+Muted: (true|false)\s*$/gm)];
  if (muted.length !== 1) {
    throw new Error("media mute state was unavailable");
  }
  return muted[0][1] === "true";
}

export function parseMediaVolumeSnapshot(volumeOutput, audioDump) {
  const volume = parseMediaVolumeCommandOutput(volumeOutput);
  return {
    ...volume,
    muted: parseMusicStreamMuteState(audioDump),
  };
}

export function mediaVolumeSnapshotsEqual(left, right) {
  return (
    left?.index === right?.index &&
    left?.minimum === right?.minimum &&
    left?.maximum === right?.maximum &&
    left?.muted === right?.muted
  );
}

function snapshotCanBeRestored(snapshot) {
  return (
    Number.isSafeInteger(snapshot?.index) &&
    Number.isSafeInteger(snapshot?.minimum) &&
    Number.isSafeInteger(snapshot?.maximum) &&
    snapshot.index > 0 &&
    snapshot.index >= snapshot.minimum &&
    snapshot.index <= snapshot.maximum &&
    snapshot.maximum <= 100 &&
    snapshot.muted === false
  );
}

export async function captureStableMediaVolumeSnapshot(device) {
  if (typeof device?.readMediaVolumeState !== "function") {
    throw new Error("media volume guard was unavailable");
  }
  const first = await device.readMediaVolumeState();
  const second = await device.readMediaVolumeState();
  if (!mediaVolumeSnapshotsEqual(first, second) || !snapshotCanBeRestored(first)) {
    throw new Error("media volume guard was unavailable");
  }
  return { ...first };
}

export async function restoreMediaVolumeSnapshot(device, snapshot) {
  if (
    !snapshotCanBeRestored(snapshot) ||
    typeof device?.setMediaVolumeIndex !== "function" ||
    typeof device?.readMediaVolumeState !== "function"
  ) {
    return false;
  }
  try {
    await device.setMediaVolumeIndex(snapshot.index);
    const first = await device.readMediaVolumeState();
    const second = await device.readMediaVolumeState();
    return (
      mediaVolumeSnapshotsEqual(first, snapshot) &&
      mediaVolumeSnapshotsEqual(second, snapshot)
    );
  } catch {
    return false;
  }
}
