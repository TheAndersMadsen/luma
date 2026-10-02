export interface BrowserSupportResult {
  readonly supported: boolean;
  readonly reasons: readonly string[];
  readonly details: {
    readonly secureContext: boolean;
    readonly webUsb: boolean;
  };
}

export function getBrowserSupport(): BrowserSupportResult {
  const secureContext = globalThis.isSecureContext;
  const webUsb = typeof navigator !== "undefined" && "usb" in navigator;

  const reasons: string[] = [];

  if (!secureContext) {
    reasons.push("The installer requires a secure context (HTTPS or localhost).");
  }

  if (!webUsb) {
    reasons.push("WebUSB is not available in this browser.");
  }

  return {
    supported: reasons.length === 0,
    reasons,
    details: {
      secureContext,
      webUsb,
    },
  };
}
