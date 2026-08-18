/*
 * A fake Ai Pin, described as a table of shell commands.
 *
 * Everything in `src/lib/pin-install` reaches hardware through exactly one
 * method, `transport.shell(…)`, so a command → result table is a whole Pin for
 * test purposes and the real inspection and the real device steps can both be
 * driven without a device. Nothing else on the transport interface is
 * implemented: a call to one would fail loudly rather than be quietly answered
 * by a stub.
 *
 * This lives in fixtures/ rather than in one of the suites that use it because
 * a second copy would drift. verify/pin-install-domain.test.mjs decides what a
 * healthy device looks like, and verify/pin-install-shared-ops.test.mjs asserts
 * what the device steps do when a device stops looking healthy; if the two
 * disagreed about the baseline, a guard could pass in one file against a device
 * the other file considers impossible.
 */

/** Split a command string into words the way a POSIX shell would. */
function splitShellWords(source) {
  const words = [];
  let word = null;
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === "'") quoted = false;
      else word += char;
      continue;
    }
    if (char === "'") {
      quoted = true;
      word ??= "";
      continue;
    }
    if (char === "\\") {
      index += 1;
      word = (word ?? "") + (source[index] ?? "");
      continue;
    }
    if (char === " ") {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    word = (word ?? "") + char;
  }

  if (word !== null) words.push(word);
  return words;
}

/*
 * The command the device would actually run.
 *
 * ADB has no argv form — the transport joins the array with spaces and the
 * device's shell parses the result — so the device layer wraps every command
 * that interpolates a package name as `sh -c '<quoted argv>'`
 * (src/lib/pin-device/adb/shellQuote.ts, pinned by verify/adb-shell-quoting.test.mjs).
 * Undoing that here, exactly as the device's shell would, keeps the handler
 * tables below written in plain device commands rather than in quoting.
 */
function deviceCommand(command) {
  const words = splitShellWords(
    typeof command === "string" ? command : [...command].join(" "),
  );
  const argv =
    words.length === 3 && words[0] === "sh" && words[1] === "-c"
      ? splitShellWords(words[2])
      : words;
  return argv.join(" ");
}

export const OK = (stdout) => ({ stdout, stderr: "", exitCode: 0 });

/** The signer identity the fixture device reports for every managed package. */
export const DEVICE_SIGNER_IDENTITY = "dd07f452";

/**
 * A `dumpsys package <pkg>` dump for a managed package the system injector owns.
 *
 * `userId` and `codePath` are here because they are on the real device and they
 * decide something: the installer on the Pin will only keep a package's data
 * across an update while it runs from `/data/app/<pkg>-injected/base.apk` under
 * app id 1000 (pin/injector/.../StagingSafety.kt:26-34). A fixture that omitted
 * them would describe a device whose packages could not be updated in place,
 * which is not what the rest of this fixture claims to be.
 */
export function packageDump(packageName, version, signer = DEVICE_SIGNER_IDENTITY) {
  return OK(
    [
      `Package [${packageName}] (1a2b3c4):`,
      `    userId=1000`,
      `    pkg=Package{5d6e7f8 ${packageName}}`,
      `    codePath=/data/app/${packageName}-injected`,
      `    versionName=${version}`,
      `    PackageSignatures{a signatures:[${signer}]}`,
      `    User 0: ceDataInode=1 installed=true hidden=false`,
      "",
    ].join("\n"),
  );
}

/** A healthy Pin containing exactly the fixture target's version of everything. */
export function deviceShell(overrides = {}) {
  const dump = (version, packageName) => packageDump(packageName, version);

  return {
    "getprop ro.product.manufacturer": OK("Humane\n"),
    "getprop ro.product.model": OK("Ai Pin\n"),
    "getprop ro.product.device": OK("mako\n"),
    "getprop ro.build.fingerprint": OK("humane/fingerprint\n"),
    "getprop sys.user.0.ce_available": OK("1\n"),
    "pm list packages": OK(
      [
        "package:com.penumbraos.systeminjector",
        "package:com.penumbraos.hook",
        "package:com.penumbraos.server",
        "package:com.penumbraos.hook.injector",
      ].join("\n"),
    ),
    "pm list packages com.penumbraos.systeminjector": OK(
      "package:com.penumbraos.systeminjector\n",
    ),
    "pm list packages com.penumbraos.hook": OK("package:com.penumbraos.hook\n"),
    "pm list packages com.penumbraos.server": OK("package:com.penumbraos.server\n"),
    "pm list packages com.penumbraos.hook.injector": OK(
      "package:com.penumbraos.hook.injector\n",
    ),
    "pm list packages com.penumbraos.systeminjector.exploit": OK(""),
    "dumpsys package com.penumbraos.systeminjector": dump(
      "2026-04-29.1",
      "com.penumbraos.systeminjector",
    ),
    "dumpsys package com.penumbraos.hook": dump("2026-04-29.1", "com.penumbraos.hook"),
    "dumpsys package com.penumbraos.server": dump("2026-04-29.1", "com.penumbraos.server"),
    "dumpsys package com.penumbraos.hook.injector": dump(
      "2026-04-29.1",
      "com.penumbraos.hook.injector",
    ),
    ...overrides,
  };
}

/**
 * A device built from a handler table.
 *
 * A handler is normally one result, returned to every call. It may instead be a
 * list of results, consumed one call at a time with the last entry repeating
 * afterwards — that is how a device whose answer CHANGES partway through one
 * operation is described, and several of the post-install assertions can only
 * be reached that way: `verifyInstalledManagedState` waits for each managed
 * package to report readable metadata before it inspects anything, so a device
 * that is broken from the first command never gets as far as the assertion
 * under test.
 *
 * `commands` records every command in order, which is what makes the ordering
 * of a destructive sequence assertable rather than merely its effects.
 */
export function fakeDevice(handlers) {
  const queues = new Map();

  return {
    connectionInfo: { serial: "serial-1", name: "Fake Device" },
    commands: [],
    async shell(command) {
      const key = deviceCommand(command);
      this.commands.push(key);

      const handler = handlers[key];
      if (!handler) throw new Error(`Unexpected shell command: ${key}`);
      if (!Array.isArray(handler)) return handler;

      const remaining = queues.get(key) ?? [...handler];
      const result = remaining.length > 1 ? remaining.shift() : remaining[0];
      queues.set(key, remaining);
      return result;
    },
  };
}

/* ── the same fake Pin, one layer up: its REST API ────────────────────────── */

/**
 * A `PinTransport` described as a table of HTTP requests.
 *
 * The device above is the ADB layer, which is where `src/lib/pin-install` talks
 * to hardware. `PinClient` talks to the Revival server ON that hardware, over a
 * tunnel through the same socket, so it reaches nothing this fixture's `shell`
 * can answer — a command table cannot serve `GET /api/activity/notes`. Rather
 * than a second fixture with its own conventions, it is the same idea against
 * the other interface: a table keyed by what was asked, an unknown key that
 * fails loudly instead of being stubbed, an array for a device whose answer
 * changes between calls, and a recorded call log so ORDER is assertable.
 *
 * Handlers are keyed `"<METHOD> <path>"` including the query string, because
 * for these routes the query IS the request — a `before` cursor the client
 * dropped would otherwise look identical to one it sent. A handler is either a
 * body (JSON-encoded, 200) or `{ status, body }` for a failure — so a 200 body
 * may not contain a top-level `status` field. None of the Pin's envelopes do;
 * `status` on a music row is inside `items`, where this never looks.
 *
 * Only what `PinClient.request` touches is implemented: `ok`, `status`, and
 * `text()`. Anything else on PinResponseLike is absent on purpose, so a client
 * method that starts streaming or reading blobs fails here rather than being
 * quietly answered by a stub that proves nothing.
 */
export function fakePinHttp(handlers) {
  const queues = new Map();
  const calls = [];

  return {
    calls,
    transport: {
      mode: "usb",
      baseUrl: null,
      assetUrl: () => null,
      async request(path, options) {
        const method = options?.method ?? "GET";
        const key = `${method} ${path}`;
        calls.push({ key, method, path, headers: new Headers(options?.headers) });

        const handler = handlers[key];
        if (handler === undefined) throw new Error(`Unexpected request: ${key}`);

        let result = handler;
        if (Array.isArray(handler)) {
          const remaining = queues.get(key) ?? [...handler];
          result = remaining.length > 1 ? remaining.shift() : remaining[0];
          queues.set(key, remaining);
        }

        const status = result?.status ?? 200;
        const body =
          result?.status === undefined ? result : (result.body ?? "");
        const text = typeof body === "string" ? body : JSON.stringify(body);

        return {
          ok: status >= 200 && status < 300,
          status,
          statusText: "",
          async text() {
            return text;
          },
          async json() {
            return JSON.parse(text);
          },
          body: null,
        };
      },
    },
  };
}
