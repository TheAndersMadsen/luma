import assert from "node:assert/strict";
import test from "node:test";

const QUERY = "?pin-device-error-presentation-test";
const { deviceErrorMessage } = await import(
  `../src/app/settings/pin/_lib/deviceErrorPresentation.ts${QUERY}`
);
const { PinApiError } = await import(`../src/lib/pin-device/index.ts${QUERY}`);

test("device errors never expose raw API responses", () => {
  const raw = new PinApiError(
    503,
    JSON.stringify({
      error: "Sign-in is required for remote Pin access.",
      reason: "sign_in_required",
      debug: "internal route and request id",
    }),
  );
  const message = deviceErrorMessage(raw, "Couldn’t load these settings.");

  assert.equal(
    message,
    "Sign in to use your paired Pin, or connect it with a cable.",
  );
  assert.doesNotMatch(message, /503|Pin API|\{|debug|remote Pin access/i);
});
