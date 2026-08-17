const DEBUG_STORAGE_KEY = "pin-center:debug";

export interface LogMeta {
  [key: string]: unknown;
}

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /(?:api.?key|subscription.?key|access.?token|refresh.?token|token|secret|password|authorization|credential|activation.?code|iccid|eid|imei)/i;
const PRIVATE_CONTENT_KEY =
  /(?:^|[_-])(?:barcode|bssid|cell_id|content|coordinates?|destination|device_local_id|food|history|image|latitude|location|login_id|longitude|mac|messages|narration|photo|prompt|query|request_uuid|transcription|user_code|utterance|verification_url)(?:$|[_-])/i;

function normalizedKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function shouldRedactKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return SENSITIVE_KEY.test(normalized) || PRIVATE_CONTENT_KEY.test(normalized);
}

function redactString(value: string): string {
  return value
    .replace(/(bearer\s+)[!-~]+/gi, `$1${REDACTED}`)
    .replace(
      /((?:api[_-]?key|subscription[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|credential|activation[_-]?code|iccid|eid|imei)["']?\s*[:=]\s*)(?:(["'])(?:\\.|(?!\2)[^\\\r\n])*\2(?=$|[\s,;}&)\]])|[!-~]+)/gi,
      `$1$2${REDACTED}$2`,
    )
    .replace(/LPA:1\$[^\s"']+/gi, REDACTED);
}

/**
 * Return a detached, console-safe copy of a logging value.
 *
 * Redaction is centralized here so a future settings field cannot leak just
 * because a caller passes a request object to a log helper. The original value
 * is never mutated.
 */
export function redactForLogging(value: unknown): unknown {
  const seen = new WeakSet<object>();

  function visit(current: unknown): unknown {
    if (typeof current === "string") {
      return redactString(current);
    }
    if (
      current === null ||
      typeof current === "number" ||
      typeof current === "boolean" ||
      typeof current === "undefined" ||
      typeof current === "bigint"
    ) {
      return current;
    }
    if (typeof current === "function" || typeof current === "symbol") {
      return String(current);
    }
    if (current instanceof Error) {
      if (current.name === "PinApiError") {
        const status = (current as Error & { status?: unknown }).status;
        return {
          name: current.name,
          ...(typeof status === "number" ? { status } : {}),
          message:
            typeof status === "number"
              ? `Pin API ${status}: ${REDACTED}`
              : `Pin API error: ${REDACTED}`,
        };
      }
      return {
        name: current.name,
        message: redactString(current.message),
        stack: current.stack ? redactString(current.stack) : undefined,
      };
    }
    if (current instanceof URL) {
      const safe = new URL(current.toString());
      for (const key of safe.searchParams.keys()) {
        if (shouldRedactKey(key)) {
          safe.searchParams.set(key, REDACTED);
        }
      }
      return safe.toString();
    }
    if (typeof current !== "object") {
      return redactString(String(current));
    }
    if (seen.has(current)) {
      return "[Circular]";
    }
    seen.add(current);

    if (Array.isArray(current)) {
      return current.map(visit);
    }

    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(current)) {
      redacted[key] = shouldRedactKey(key) ? REDACTED : visit(entry);
    }
    return redacted;
  }

  return visit(value);
}

function shouldDebugLog(): boolean {
  if (process.env.NODE_ENV !== "production") {
    return true;
  }

  try {
    return localStorage.getItem(DEBUG_STORAGE_KEY) === "1";
  } catch {
    // `localStorage` is absent on the server and can throw in a partitioned
    // browser context; debug logging is opt-in, so absence means "off".
    return false;
  }
}

function formatScope(scope: string): string {
  return `[pin-center:${scope}]`;
}

export function logDebug(scope: string, message: string, meta?: LogMeta) {
  if (!shouldDebugLog()) {
    return;
  }

  if (meta !== undefined) {
    console.debug(formatScope(scope), message, redactForLogging(meta));
  } else {
    console.debug(formatScope(scope), message);
  }
}

export function logInfo(scope: string, message: string, meta?: LogMeta) {
  if (meta !== undefined) {
    console.info(formatScope(scope), message, redactForLogging(meta));
  } else {
    console.info(formatScope(scope), message);
  }
}

export function logWarn(scope: string, message: string, meta?: LogMeta) {
  if (meta !== undefined) {
    console.warn(formatScope(scope), message, redactForLogging(meta));
  } else {
    console.warn(formatScope(scope), message);
  }
}

export function logError(
  scope: string,
  message: string,
  errorOrMeta?: unknown,
  meta?: LogMeta,
) {
  if (errorOrMeta instanceof Error) {
    if (meta !== undefined) {
      console.error(
        formatScope(scope),
        message,
        redactForLogging(errorOrMeta),
        redactForLogging(meta),
      );
    } else {
      console.error(formatScope(scope), message, redactForLogging(errorOrMeta));
    }
    return;
  }

  if (meta !== undefined) {
    console.error(formatScope(scope), message, {
      error: redactForLogging(errorOrMeta),
      ...(redactForLogging(meta) as LogMeta),
    });
    return;
  }

  if (errorOrMeta !== undefined) {
    console.error(formatScope(scope), message, redactForLogging(errorOrMeta));
  } else {
    console.error(formatScope(scope), message);
  }
}

export function setDebugLoggingEnabled(enabled: boolean) {
  try {
    if (enabled) {
      localStorage.setItem(DEBUG_STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(DEBUG_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
}

export function isDebugLoggingEnabled(): boolean {
  return shouldDebugLog();
}
