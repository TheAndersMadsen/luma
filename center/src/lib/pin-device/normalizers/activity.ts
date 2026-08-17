import type {
  ActivityItemByKind,
  ActivityKind,
  ActivityMusic,
  ActivityNote,
  ActivityPage,
  ActivityPrompt,
  Location,
} from "../types";

export class InvalidActivityResponseError extends Error {
  constructor(message: string) {
    super(`Invalid activity response: ${message}`);
    this.name = "InvalidActivityResponseError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidActivityResponseError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(
  value: unknown,
  label: string,
  { optional = false }: { optional?: boolean } = {},
): string | undefined {
  if (optional && (value === undefined || value === null)) return undefined;
  if (typeof value !== "string") {
    throw new InvalidActivityResponseError(`${label} must be a string`);
  }
  return value;
}

function numericId(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new InvalidActivityResponseError(`${label} must be an integer`);
  }
  return value;
}

function optionalLocation(value: unknown): Location | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const location = record(value, "note.location");
  if (
    typeof location.latitude !== "number" ||
    !Number.isFinite(location.latitude) ||
    typeof location.longitude !== "number" ||
    !Number.isFinite(location.longitude)
  ) {
    throw new InvalidActivityResponseError(
      "note.location coordinates must be finite numbers",
    );
  }
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    ...(typeof location.accuracy === "number" &&
    Number.isFinite(location.accuracy)
      ? { accuracy: location.accuracy }
      : {}),
    ...(typeof location.human_readable === "string"
      ? { human_readable: location.human_readable }
      : {}),
    ...(typeof location.full_address === "string"
      ? { full_address: location.full_address }
      : {}),
  };
}

function normalizeNote(value: unknown): ActivityNote {
  const item = record(value, "note");
  return {
    id: stringValue(item.id, "note.id") ?? "",
    created_at: stringValue(item.created_at, "note.created_at") ?? "",
    text: stringValue(item.text, "note.text") ?? "",
    ...("location" in item
      ? { location: optionalLocation(item.location) }
      : {}),
  };
}

function normalizePrompt(value: unknown): ActivityPrompt {
  const item = record(value, "prompt");
  if (typeof item.is_vision !== "boolean") {
    throw new InvalidActivityResponseError(
      "prompt.is_vision must be a boolean",
    );
  }
  return {
    id: numericId(item.id, "prompt.id"),
    run_id: stringValue(item.run_id, "prompt.run_id") ?? "",
    prompt: stringValue(item.prompt, "prompt.prompt") ?? "",
    ...(item.response === null
      ? { response: null }
      : {
          response: stringValue(item.response, "prompt.response", {
            optional: true,
          }),
        }),
    is_vision: item.is_vision,
    created_at: stringValue(item.created_at, "prompt.created_at") ?? "",
  };
}

function normalizeMusic(value: unknown): ActivityMusic {
  const item = record(value, "music item");
  if (
    !Array.isArray(item.artists) ||
    !item.artists.every((artist) => typeof artist === "string")
  ) {
    throw new InvalidActivityResponseError(
      "music item.artists must be an array of strings",
    );
  }
  return {
    id: numericId(item.id, "music item.id"),
    track_id: stringValue(item.track_id, "music item.track_id") ?? "",
    title: stringValue(item.title, "music item.title") ?? "",
    artists: item.artists,
    ...(item.album === null
      ? { album: null }
      : {
          album: stringValue(item.album, "music item.album", {
            optional: true,
          }),
        }),
    status: stringValue(item.status, "music item.status") ?? "",
    started_at:
      stringValue(item.started_at, "music item.started_at") ?? "",
    ...(item.ended_at === null
      ? { ended_at: null }
      : {
          ended_at: stringValue(item.ended_at, "music item.ended_at", {
            optional: true,
          }),
        }),
  };
}

function normalizeItem<K extends ActivityKind>(
  kind: K,
  value: unknown,
): ActivityItemByKind[K] {
  const item =
    kind === "notes"
      ? normalizeNote(value)
      : kind === "prompts"
        ? normalizePrompt(value)
        : normalizeMusic(value);
  return item as ActivityItemByKind[K];
}

/** Accept the current paginated response plus the early bare-array contract. */
export function normalizeActivityResponse<K extends ActivityKind>(
  kind: K,
  input: unknown,
): ActivityPage<K> {
  const envelope = Array.isArray(input) ? { items: input } : record(input, kind);
  if (!Array.isArray(envelope.items)) {
    throw new InvalidActivityResponseError(`${kind}.items must be an array`);
  }
  const nextBefore = stringValue(
    envelope.next_before,
    `${kind}.next_before`,
    { optional: true },
  );
  return {
    items: envelope.items.map((item) => normalizeItem(kind, item)),
    ...(nextBefore ? { next_before: nextBefore } : {}),
  };
}
