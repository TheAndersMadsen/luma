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
 * what the device steps do when a device stops looking healthy. If the two
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
 * ADB has no argv form, the transport joins the array with spaces and the
 * device's shell parses the result, so the device layer wraps every command
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
 * A `dumpsys package <pkg>` dump for a package the Device Installer manages.
 *
 * `userId` and `codePath` are here because they are on the real device and they
 * decide something: the installer on the Pin will only keep a package's data
 * across an update while it runs from `/data/app/<pkg>-injected/base.apk` under
 * app id 1000 (pin/device-installer/.../StagingSafety.kt:26-34). A fixture that omitted
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
    "cmd package path android": OK(
      "package:/system/framework/framework-res.apk\n",
    ),
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
 * afterwards, that is how a device whose answer CHANGES partway through one
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
