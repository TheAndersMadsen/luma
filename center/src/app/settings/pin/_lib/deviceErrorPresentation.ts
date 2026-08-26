import {
  AdminTokenRotationUncertainError,
  LanAdminAuthNotEnforcedError,
  PinApiError,
} from "@/lib/pin-device";

/*
 * Turn device and transport failures into copy that belongs in the wearer UI.
 *
 * PinApiError retains the response body for classification and logging, but
 * that body is not presentation copy: it may be JSON, an implementation
 * detail, or text written for an operator. Pin settings panes use this helper
 * instead of echoing Error.message.
 */

function isTimeout(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error && /timed out|timeout/i.test(error.message))
  );
}

function pinApiDetail(error: PinApiError): string {
  try {
    const parsed = JSON.parse(error.body) as { error?: unknown; message?: unknown };
    const value = parsed.error ?? parsed.message;
    return typeof value === "string" ? value : "";
  } catch {
    return error.body;
  }
}

export function deviceErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AdminTokenRotationUncertainError) return error.message;
  if (error instanceof LanAdminAuthNotEnforcedError) return error.message;

  if (error instanceof PinApiError) {
    const detail = pinApiDetail(error);

    if (/sign-in is required|session expired/i.test(detail)) {
      return "Sign in to use your paired Pin, or connect it with a cable.";
    }
    if (error.status === 0) {
      return "Couldn’t reach your Pin. Check its connection and try again.";
    }
    // The remote link carries a reviewed set of routes, so a refusal there is
    // not the Pin declining anything; saying "reconnect" sends the wearer to
    // fix a connection that is already healthy.
    if (error.status === 403 && /bridge policy/i.test(detail)) {
      return "Connect your Pin with a cable to see this. The remote link carries only setup and playback controls.";
    }
    if (error.status === 401 || error.status === 403) {
      return "Your Pin didn’t accept that request. Reconnect it and try again.";
    }
    if (error.status === 404 || error.status === 405 || error.status === 501) {
      return "This feature isn’t available on this Pin.";
    }
    if (error.status === 409 && /usb|cable/i.test(detail)) {
      return "Connect your Pin with a cable to do that.";
    }
    if (error.status === 429) {
      return "Your Pin is busy. Try again shortly.";
    }
    if (error.status >= 500) {
      return "Your Pin is unavailable. Try again or connect it with a cable.";
    }
    return fallback;
  }

  if (isTimeout(error)) return "The request took too long. Try again.";
  if (
    error instanceof TypeError &&
    /fetch|network|failed to fetch/i.test(error.message)
  ) {
    return "Couldn’t reach your Pin. Check its connection and try again.";
  }

  return fallback;
}
