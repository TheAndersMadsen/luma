
import assert from "node:assert/strict";
import test from "node:test";

import { OK, fakeDevice } from "./fixtures/fake-pin-device.mjs";

/*
 * Secret handling on the Wi-Fi join path, driven against the fake Pin the
 * installer suites use: the network key travels on standard input only, never
 * in a command string, an error, or a repeated sentence.
 */

const {
  JOIN_WIFI_COMMAND,
  PinNetworkError,
  joinWifiNetwork,
  readPinNetwork,
  validateJoinRequest,
} = await import("../src/lib/pin-setup/network.ts");

const WIFI_ON = OK(
  "Wifi is enabled\nWifi scanning is only available when wifi is enabled\n==== Primary ClientModeManager instance ====\nWifi is not connected\n",
);
const onWifi = (ssid) =>
  OK(
    `Wifi is enabled\n==== Primary ClientModeManager instance ====\nWifi is connected to "${ssid}"\nWifiInfo: SSID: "${ssid}", Security type: 2, Supplicant state: COMPLETED, RSSI: -57\n`,
  );
const NO_NETWORKS = { stdout: "", stderr: "", exitCode: 1 };
const WIFI_VALIDATED = OK(
  "  NetworkAgentInfo{network{100}  handle{432902426637}  ni{WIFI CONNECTED extra: } Score(60 ; KeepConnected : 0 ; Policies : TRANSPORT_PRIMARY&EVER_VALIDATED&EVER_USER_SELECTED&IS_VALIDATED)  everValidated lastValidated explicitlySelected  lp{{InterfaceName: wlan0}}\n",
);

const STATUS = "cmd wifi status";
const CONNECTIVITY = "dumpsys connectivity | grep NetworkAgentInfo";

/** Time that moves only when the code under test sleeps. */
function fakeTiming(start = Date.UTC(2026, 8, 23, 12, 0)) {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  };
}

/** The fixture device plus standard input, recorded so tests can see it. */
function deviceWithInput(handlers) {
  const device = fakeDevice(handlers);
  device.inputs = [];
  device.shellWithInput = async function shellWithInput(command, input) {
    this.inputs.push(await input.text());
    return this.shell(command);
  };
  return device;
}

test("joining sends the password only on standard input, then waits for a validated network", async () => {
  const password = "correct horse battery";
  const device = deviceWithInput({
    [JOIN_WIFI_COMMAND]: OK("Connection initiated \n"),
    [STATUS]: [WIFI_ON, onWifi("Home")],
    [CONNECTIVITY]: [NO_NETWORKS, WIFI_VALIDATED],
  });

  const reading = await joinWifiNetwork(
    device,
    { ssid: "Home", security: "wpa2", password, hidden: false },
    fakeTiming(),
  );

  assert.deepEqual(reading, { wifiEnabled: true, wifiNetwork: "Home", online: true, transport: "wifi" });
  assert.deepEqual(device.inputs, [`Home\nwpa2\nno\n${password}\n`]);
  assert.equal(device.commands[0], JOIN_WIFI_COMMAND);
  for (const command of device.commands) {
    assert.doesNotMatch(command, /correct horse|Home/u, "nothing typed may reach a command string");
  }
  assert.match(JOIN_WIFI_COMMAND, /exec cmd wifi connect-network "\$ssid" "\$security" "\$psk" "\$@"/u);
});

test("a wrong password ends in a plain sentence that never repeats it", async () => {
  const password = "not-the-password";
  const device = deviceWithInput({
    [JOIN_WIFI_COMMAND]: OK("Connection initiated \n"),
    [STATUS]: WIFI_ON,
    [CONNECTIVITY]: NO_NETWORKS,
  });
  await assert.rejects(
    joinWifiNetwork(device, { ssid: "Home", security: "wpa2", password, hidden: false }, fakeTiming()),
    (error) => {
      assert.ok(error instanceof PinNetworkError);
      assert.equal(error.message, "Your Pin couldn’t join “Home”. Check the password and try again.");
      assert.doesNotMatch(error.message, /not-the-password/u);
      return true;
    },
  );
});

test("a refused connection request and a lost cable are plain errors without command text", async () => {
  const refused = deviceWithInput({ [JOIN_WIFI_COMMAND]: OK("Connection failed\n") });
  await assert.rejects(
    joinWifiNetwork(refused, { ssid: "Home", security: "wpa2", password: "12345678", hidden: false }, fakeTiming()),
    /couldn’t start joining “Home”/u,
  );

  const lost = {
    async shell() {
      throw new Error("Timed out after 60000ms during device step: shell sh -c 'secret'.");
    },
    async shellWithInput() {
      throw new Error("Timed out after 60000ms during device step: shellWithInput secret.");
    },
  };
  await assert.rejects(
    joinWifiNetwork(lost, { ssid: "Home", security: "wpa2", password: "secret-password", hidden: false }, fakeTiming()),
    (error) => {
      assert.ok(error instanceof PinNetworkError);
      assert.doesNotMatch(error.message, /secret|Timed out|shell/u);
      return true;
    },
  );
  await assert.rejects(readPinNetwork(lost), (error) => {
    assert.ok(error instanceof PinNetworkError);
    assert.doesNotMatch(error.message, /secret|sh -c/u);
    return true;
  });
});

test("names and passwords the Pin cannot take are refused before anything is sent", () => {
  assert.deepEqual(validateJoinRequest({ ssid: " ", security: "open", password: "", hidden: false }), {
    ssid: "Enter a network name.",
  });
  assert.deepEqual(
    validateJoinRequest({ ssid: "Home\nwpa2", security: "wpa2", password: "short", hidden: false }),
    { ssid: "Remove line breaks and control characters.", password: "Use at least 8 characters." },
  );
  assert.deepEqual(
    validateJoinRequest({ ssid: "x".repeat(33), security: "wpa3", password: "", hidden: false }),
    { ssid: "Use 32 characters or fewer.", password: "Enter the Wi-Fi password." },
  );
  assert.deepEqual(validateJoinRequest({ ssid: "Cafe", security: "open", password: "", hidden: false }), {});
});
