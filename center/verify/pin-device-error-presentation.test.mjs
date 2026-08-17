import "./tsResolve.mjs";
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

test("device errors map common transport failures to concise actions", () => {
  assert.equal(
    deviceErrorMessage(new PinApiError(409, '{"error":"USB required"}'), "Fallback"),
    "Connect your Pin with a cable to do that.",
  );
  assert.equal(
    deviceErrorMessage(new PinApiError(429, "busy"), "Fallback"),
    "Your Pin is busy. Try again shortly.",
  );
  assert.equal(
    deviceErrorMessage(new TypeError("fetch failed"), "Fallback"),
    "Couldn’t reach your Pin. Check its connection and try again.",
  );
  assert.equal(
    deviceErrorMessage(new Error("private upstream detail"), "Couldn’t save."),
    "Couldn’t save.",
  );
});
