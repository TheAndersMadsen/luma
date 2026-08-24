const ADB_SERIAL_PATTERN = /^[0-9A-Za-z._:-]+$/;
const MAX_ADB_SERIAL_BYTES = 128;

export const EXPECTED_PIN_SERIAL_ENV = "PENUMBRA_EXPECTED_PIN_SERIAL";
export const EXPECTED_PIXEL_SERIAL_ENV = "PENUMBRA_EXPECTED_PIXEL_SERIAL";

export function validateDeviceSerial(value, label = "device serial") {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_ADB_SERIAL_BYTES ||
    !ADB_SERIAL_PATTERN.test(value)
  ) {
    throw new Error(`a valid ${label} is required`);
  }
  return value;
}

export function resolveExpectedDeviceSerial({
  cliValue = null,
  environment = process.env,
  environmentName,
  label,
}) {
  const environmentValue = environment?.[environmentName];
  const cliSerial = cliValue === null ? null : validateDeviceSerial(cliValue, label);
  const environmentSerial = environmentValue === undefined
    ? null
    : validateDeviceSerial(environmentValue, label);

  if (cliSerial !== null && environmentSerial !== null && cliSerial !== environmentSerial) {
    throw new Error(`conflicting expected ${label} values`);
  }
  const expectedSerial = cliSerial ?? environmentSerial;
  if (expectedSerial === null) {
    throw new Error(`an operator-supplied expected ${label} is required`);
  }
  return expectedSerial;
}

export function exactDeviceTargetMatches(serial, expectedSerial) {
  try {
    return validateDeviceSerial(serial) === validateDeviceSerial(expectedSerial, "expected device serial");
  } catch {
    return false;
  }
}
