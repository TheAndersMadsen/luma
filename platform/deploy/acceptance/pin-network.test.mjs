import assert from "node:assert/strict";
import test from "node:test";

import {
  PinNetworkError,
  classifyWifiStatus,
  inspectPinNetwork,
  main,
  parseNetworkArgs,
  wifiPageUrl,
} from "../pin/network.mjs";

const SERIAL = "1H4MPA42230112";
const PRIVATE_SSID = "Do-not-print-this-private-network";

function fakeRuntime({ reportedSerial = SERIAL, wifiOutput = "Wifi is enabled\nWifi is connected to fixture" } = {}) {
  const calls = [];
  const output = [];
  const runtime = {
    environment: { ADB: "adb-fixture", LUMA_PUBLIC_ORIGIN: "https://center.example.test" },
    platform: "darwin",
    out: (text) => output.push(String(text)),
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === "open") return { status: 0, stdout: "", stderr: "" };
      if (args.at(-1) === "get-serialno") return { status: 0, stdout: `${reportedSerial}\n`, stderr: "" };
      if (args.slice(-3).join(" ") === "cmd wifi status") {
        return { status: 0, stdout: wifiOutput, stderr: "" };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
  };
  return { runtime, calls, output, text: () => output.join("") };
}

test("network grammar has no credential-bearing flags", () => {
  assert.deepEqual(parseNetworkArgs(["--serial", SERIAL]), { command: "status", serial: SERIAL });
  assert.deepEqual(parseNetworkArgs(["qr"]), { command: "qr", open: false });
  assert.deepEqual(parseNetworkArgs(["qr", "--open"]), { command: "qr", open: true });
  for (const args of [
    ["--serial", SERIAL, "--ssid", "private"],
    ["--serial", SERIAL, "--password", "private"],
    ["qr", "--psk", "private"],
  ]) {
    assert.throws(() => parseNetworkArgs(args), /usage:/);
  }
  assert.throws(() => parseNetworkArgs([]), /--serial SERIAL/);
});

test("Wi-Fi status classification returns only state, never identifiers", () => {
  assert.deepEqual(classifyWifiStatus(
    `Wifi is enabled\nWifi is connected to ${PRIVATE_SSID}\nBSSID: 00:11:22:33:44:55`,
  ), { enabled: true, connected: true });
  assert.deepEqual(classifyWifiStatus("Wifi is disabled\nnot connected"), {
    enabled: false,
    connected: false,
  });
  assert.deepEqual(classifyWifiStatus("Wifi is enabled\nWifi is not connected to a network"), {
    enabled: true,
    connected: false,
  });
  assert.deepEqual(classifyWifiStatus("unsupported output"), { enabled: null, connected: null });
});

test("network status targets one exact serial and performs read-only adb calls", () => {
  const fake = fakeRuntime({
    wifiOutput: `Wifi is enabled\nWifi is connected to ${PRIVATE_SSID}\n`,
  });
  const status = main(["--serial", SERIAL], fake.runtime);
  assert.deepEqual(status, { serial: SERIAL, enabled: true, connected: true });
  assert.equal(fake.calls[0].args.slice(0, 2).join(" "), `-s ${SERIAL}`);
  assert.equal(fake.calls.every((call) => !call.args.some((arg) => /^(?:set|connect|forget|add-network)$/u.test(arg))), true);
  assert.equal(fake.calls.every((call) => !call.args.includes("settings")), true);
  assert.doesNotMatch(fake.text(), new RegExp(PRIVATE_SSID, "u"));
  assert.match(fake.text(), /No Wi-Fi setting was changed/);
});

test("an exact serial mismatch fails before Wi-Fi inspection", () => {
  const fake = fakeRuntime({ reportedSerial: "some-other-device" });
  assert.throws(
    () => inspectPinNetwork(SERIAL, fake.runtime),
    (error) => error instanceof PinNetworkError && error.code === "serial-mismatch",
  );
  assert.equal(fake.calls.length, 1);
});

test("QR guidance uses a browser-local page and --open launches only that URL", () => {
  const fake = fakeRuntime();
  const result = main(["qr", "--open"], fake.runtime);
  assert.deepEqual(result, { url: "https://center.example.test/wifi", opened: true });
  assert.deepEqual(fake.calls, [{ command: "open", args: ["https://center.example.test/wifi"] }]);
  assert.match(fake.text(), /accepts no network name or passcode/);
});

test("Wi-Fi page origin is bounded to a credential-free HTTP(S) origin", () => {
  assert.equal(wifiPageUrl({}), "http://127.0.0.1:4000/wifi");
  assert.equal(
    wifiPageUrl({ LUMA_PUBLIC_ORIGIN: "https://center.example.test/" }),
    "https://center.example.test/wifi",
  );
  for (const origin of [
    "file:///private/page",
    "https://user:pass@center.example.test",
    "https://center.example.test/admin",
    "https://center.example.test/?token=secret",
  ]) {
    assert.throws(() => wifiPageUrl({ LUMA_PUBLIC_ORIGIN: origin }), /HTTP\(S\) origin/);
  }
});
