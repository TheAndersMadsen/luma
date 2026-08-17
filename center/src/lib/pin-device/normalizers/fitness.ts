import type {
  FitnessSession,
  FitnessSessionFile,
  FitnessSessionFilename,
  FitnessSessionsResponse,
  FitnessSessionSummary,
} from "../types";

export const FITNESS_SESSION_FILENAMES = [
  "activity-tracking-summary.csv",
  "activity-tracking-location-data.gpx",
  "activity-tracking-sensor-data.csv",
] as const satisfies readonly FitnessSessionFilename[];

const FITNESS_FILENAME_SET = new Set<string>(FITNESS_SESSION_FILENAMES);
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class InvalidFitnessResponseError extends Error {
  constructor(message: string) {
    super(`Invalid fitness response: ${message}`);
    this.name = "InvalidFitnessResponseError";
  }
}

export class InvalidFitnessRequestError extends Error {
  constructor(message: string) {
    super(`Invalid fitness request: ${message}`);
    this.name = "InvalidFitnessRequestError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidFitnessResponseError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new InvalidFitnessResponseError(`${label} must be a string`);
  }
  return value;
}

function safeInteger(
  value: unknown,
  label: string,
  { positive = false }: { positive?: boolean } = {},
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (positive ? value <= 0 : value < 0)
  ) {
    throw new InvalidFitnessResponseError(
      `${label} must be a ${positive ? "positive" : "non-negative"} safe integer`,
    );
  }
  return value;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new InvalidFitnessResponseError(
      `${label} must be a non-negative finite number`,
    );
  }
  return value;
}

export function isCanonicalFitnessSessionId(value: string): boolean {
  return CANONICAL_UUID.test(value);
}

export function requireCanonicalFitnessSessionId(value: string): string {
  if (!isCanonicalFitnessSessionId(value)) {
    throw new InvalidFitnessRequestError(
      "session id must be a canonical lowercase UUID",
    );
  }
  return value;
}

export function requireFitnessSessionFilename(
  value: string,
): FitnessSessionFilename {
  if (!FITNESS_FILENAME_SET.has(value)) {
    throw new InvalidFitnessRequestError("filename is not allowlisted");
  }
  return value as FitnessSessionFilename;
}

function normalizeFile(value: unknown, index: number): FitnessSessionFile {
  const file = record(value, `session.files[${index}]`);
  const filename = requiredString(
    file.filename,
    `session.files[${index}].filename`,
  );
  if (!FITNESS_FILENAME_SET.has(filename)) {
    throw new InvalidFitnessResponseError(
      `session.files[${index}].filename is not allowlisted`,
    );
  }
  return {
    filename: filename as FitnessSessionFilename,
    size_bytes: safeInteger(
      file.size_bytes,
      `session.files[${index}].size_bytes`,
      { positive: true },
    ),
  };
}

function normalizeSummary(value: unknown): FitnessSessionSummary {
  const summary = record(value, "session.summary");
  return {
    splits: requiredString(summary.splits, "session.summary.splits"),
    pace: requiredString(summary.pace, "session.summary.pace"),
    elapsed_time: requiredString(
      summary.elapsed_time,
      "session.summary.elapsed_time",
    ),
    cumulative_distance_km: finiteNonNegative(
      summary.cumulative_distance_km,
      "session.summary.cumulative_distance_km",
    ),
    moving_time: requiredString(
      summary.moving_time,
      "session.summary.moving_time",
    ),
    motion_breakdown: requiredString(
      summary.motion_breakdown,
      "session.summary.motion_breakdown",
    ),
    step_count: safeInteger(
      summary.step_count,
      "session.summary.step_count",
    ),
  };
}

export function normalizeFitnessSession(input: unknown): FitnessSession {
  const session = record(input, "session");
  const sessionId = requiredString(session.session_id, "session.session_id");
  if (!isCanonicalFitnessSessionId(sessionId)) {
    throw new InvalidFitnessResponseError(
      "session.session_id must be a canonical lowercase UUID",
    );
  }

  const startedAt = safeInteger(
    session.started_at_ms,
    "session.started_at_ms",
    { positive: true },
  );
  const stoppedAt = safeInteger(
    session.stopped_at_ms,
    "session.stopped_at_ms",
    { positive: true },
  );
  const duration = safeInteger(session.duration_ms, "session.duration_ms");
  if (stoppedAt < startedAt || duration !== stoppedAt - startedAt) {
    throw new InvalidFitnessResponseError(
      "session timestamps and duration are inconsistent",
    );
  }

  if (!Array.isArray(session.files) || session.files.length < 2 || session.files.length > 3) {
    throw new InvalidFitnessResponseError(
      "session.files must contain two or three entries",
    );
  }
  const files = session.files.map(normalizeFile);
  const filenames = new Set(files.map((file) => file.filename));
  if (
    filenames.size !== files.length ||
    !filenames.has("activity-tracking-summary.csv") ||
    !filenames.has("activity-tracking-location-data.gpx")
  ) {
    throw new InvalidFitnessResponseError(
      "session.files must contain unique summary and location exports",
    );
  }

  return {
    session_id: sessionId,
    started_at_ms: startedAt,
    stopped_at_ms: stoppedAt,
    duration_ms: duration,
    files,
    ...(session.summary === undefined
      ? {}
      : { summary: normalizeSummary(session.summary) }),
  };
}

export function normalizeFitnessSessionsResponse(
  input: unknown,
): FitnessSessionsResponse {
  const envelope = record(input, "fitness sessions");
  if (!Array.isArray(envelope.sessions)) {
    throw new InvalidFitnessResponseError(
      "fitness sessions.sessions must be an array",
    );
  }
  return { sessions: envelope.sessions.map(normalizeFitnessSession) };
}
