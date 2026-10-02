/**
 * Finish the stock Pin's own setup without sending its passcode to Center's server.
 *
 * The owner types the same four ASCII digits they already saved in Center. The
 * browser pipes that one-time copy over the existing USB session to a fixed,
 * write-only device URI. The digits never become a shell argument, URL, log, or
 * server request. Stock onboarding still performs the real OPAQUE login and
 * writes `DUC_PROVISIONED` only after it succeeds.
 *
 * Stock references:
 * - `humane.experience.onboarding.node.PincodeNode.didBecomeActive` consumes
 *   the staged ADB pincode and advances into the existing entry flow.
 * - `humane.experience.onboarding.node.PincodeNode.attemptUnlock` performs the
 *   real OPAQUE login. Luma must not replace it with a synthetic completion.
 * - `humane.experience.onboarding.node.WelcomeNode.launchHome` writes
 *   `DUC_PROVISIONED` after successful onboarding.
 */

import {
  AdbDeviceStepTimeoutError,
  withDeviceStepTimeout,
} from "@/lib/pin-device/adb/transport";
import type { PinShellWithInput } from "./network";

export const FINISH_ONBOARDING_COMMAND = [
  "content",
  "write",
  "--uri",
  "content://com.penumbraos.server.cosmosidentity/onboarding-pincode",
] as const;

export const STOCK_SETUP_COMPLETE_COMMAND = [
  "settings",
  "get",
  "global",
  "humane.settings.global.DUC_PROVISIONED",
] as const;

export interface OnboardingTiming {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const REAL_TIME: OnboardingTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
const MAX_ONBOARDING_WAIT_MS = 30_000;
const FINISH_ONBOARDING_OPERATION = "finish Pin onboarding";
const ONBOARDING_TIMEOUT_MESSAGE =
  "The Pin didn’t finish its own setup within 30 seconds. Keep it connected, check the Pin’s setup message, then try again.";

export class PinOnboardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinOnboardingError";
  }
}

export function isPinPasscode(value: string): boolean {
  return /^[0-9]{4}$/u.test(value);
}

async function stagePinOnboardingPasscode(
  device: PinShellWithInput,
  passcode: string,
) {
  let input: Blob | null = new Blob([passcode], { type: "text/plain;charset=utf-8" });
  passcode = "";
  try {
    return await device.shellWithInput(FINISH_ONBOARDING_COMMAND, input);
  } finally {
    // Drop the last browser-side binary reference before the bounded completion poll.
    input = null;
  }
}

function remainingOnboardingWaitMs(
  timing: OnboardingTiming,
  deadline: number,
): number {
  const remainingMs = deadline - timing.now();
  if (remainingMs <= 0) {
    throw new PinOnboardingError(ONBOARDING_TIMEOUT_MESSAGE);
  }
  return remainingMs;
}

function beforeOnboardingDeadline<T>(
  timing: OnboardingTiming,
  deadline: number,
  work: () => Promise<T>,
): Promise<T> {
  return withDeviceStepTimeout(
    FINISH_ONBOARDING_OPERATION,
    work,
    remainingOnboardingWaitMs(timing, deadline),
  );
}

function isOnboardingDeadline(error: unknown): boolean {
  return (
    error instanceof PinOnboardingError ||
    (error instanceof AdbDeviceStepTimeoutError &&
      error.operation === FINISH_ONBOARDING_OPERATION)
  );
}

/**
 * Hand the one-time passcode copy to the Pin, then wait for stock's authoritative
 * completion flag. The wait is bounded because a wrong passcode or network
 * failure is shown by stock onboarding and must never become an endless spinner.
 */
export async function finishPinOnboarding(
  device: PinShellWithInput,
  passcode: string,
  timing: OnboardingTiming = REAL_TIME,
  timeoutMs = MAX_ONBOARDING_WAIT_MS,
): Promise<void> {
  if (!isPinPasscode(passcode)) {
    throw new PinOnboardingError("A passcode is exactly four digits.");
  }

  const boundedTimeoutMs = Math.min(timeoutMs, MAX_ONBOARDING_WAIT_MS);
  const deadline = timing.now() + boundedTimeoutMs;
  try {
    await withDeviceStepTimeout(
      FINISH_ONBOARDING_OPERATION,
      async () => {
        let staged;
        try {
          const staging = beforeOnboardingDeadline(timing, deadline, () =>
            stagePinOnboardingPasscode(device, passcode),
          );
          passcode = "";
          staged = await staging;
        } catch (error) {
          passcode = "";
          if (isOnboardingDeadline(error)) throw error;
          throw new PinOnboardingError(
            "Center couldn’t hand the passcode to this Pin. Keep it connected and try again.",
          );
        }
        if (staged.exitCode !== 0) {
          throw new PinOnboardingError(
            "Center couldn’t hand the passcode to this Pin. Keep it connected and try again.",
          );
        }

        for (;;) {
          remainingOnboardingWaitMs(timing, deadline);
          let observed;
          try {
            observed = await beforeOnboardingDeadline(timing, deadline, () =>
              device.shell(STOCK_SETUP_COMPLETE_COMMAND),
            );
          } catch (error) {
            if (isOnboardingDeadline(error)) throw error;
            throw new PinOnboardingError(
              "Center lost contact with the Pin before setup finished. Check the cable and try again.",
            );
          }
          if (observed.exitCode !== 0) {
            throw new PinOnboardingError(
              "Center lost contact with the Pin before setup finished. Check the cable and try again.",
            );
          }
          if (observed.stdout.trim() === "1") return;
          if (timing.now() >= deadline) {
            throw new PinOnboardingError(ONBOARDING_TIMEOUT_MESSAGE);
          }
          await timing.sleep(
            Math.min(1_000, remainingOnboardingWaitMs(timing, deadline)),
          );
        }
      },
      boundedTimeoutMs,
    );
  } catch (error) {
    passcode = "";
    if (
      error instanceof AdbDeviceStepTimeoutError &&
      error.operation === FINISH_ONBOARDING_OPERATION
    ) {
      throw new PinOnboardingError(ONBOARDING_TIMEOUT_MESSAGE);
    }
    throw error;
  }
}
