import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInstallExistingArguments,
  ensureInstalledForUserWithOperations,
  parseAdbDeviceRecords,
  parseAndroidUserIds,
  parseDumpsysPackageUserState,
  parsePackageUidOutput,
  parsePackagePathCommandResult,
  parseRegularPackageBaseApkPath,
  waitForPackageUnloadedWithOperations,
} from "./adb.js";

const PACKAGE_NAME = "com.penumbraos.server";

function packageDump(options?: {
  appId?: number;
  pkg?: string;
  codePath?: string;
  installed?: string;
  extraRecordLine?: string;
}): string {
  const appId = options?.appId ?? 1000;
  const pkg = options?.pkg ?? `Package{5eb6c97 ${PACKAGE_NAME}}`;
  const codePath = options?.codePath ?? `/data/app/${PACKAGE_NAME}-injected`;
  const installed = options?.installed ?? "true";
  return [
    "Packages:",
    `  Package [${PACKAGE_NAME}] (747409e):`,
    `    userId=${appId}`,
    "    sharedUser=SharedUserSetting{4caf00d android.uid.system/1000}",
    `    pkg=${pkg}`,
    `    codePath=${codePath}`,
    options?.extraRecordLine,
    `    User 0: ceDataInode=0 installed=${installed} hidden=false suspended=false stopped=false notLaunched=false enabled=0 instant=false virtual=false`,
    "Dexopt state:",
    `  [${PACKAGE_NAME}]`,
  ].filter((line): line is string => line !== undefined).join("\n");
}

const TEST_RESTORE_POLICY = {
  initialCheckTimeoutMs: 5,
  commandTimeoutMs: 5,
  verificationCheckTimeoutMs: 5,
  verificationAttempts: 3,
  verificationIntervalMs: 1,
};

test("parses all Android users from pm list users", () => {
  assert.deepEqual(
    parseAndroidUserIds(
      "Users:\n\tUserInfo{0:Owner:13} running\n\tUserInfo{10:Work profile:30}"
    ),
    [0, 10]
  );
});

test("rejects an unparseable Android user list", () => {
  assert.throws(() => parseAndroidUserIds("Users:"), /Unable to parse Android users/);
});

test("distinguishes physical USB from network ADB transports", () => {
  assert.deepEqual(
    parseAdbDeviceRecords(
      "List of devices attached\nPIN123 device usb:336592896X product:pin model:Pin transport_id:1\n" +
        "192.0.2.4:5555 device product:pin model:Pin transport_id:2\n"
    ),
    [
      {
        serial: "PIN123",
        state: "device",
        details: ["usb:336592896X", "product:pin", "model:Pin", "transport_id:1"],
      },
      {
        serial: "192.0.2.4:5555",
        state: "device",
        details: ["product:pin", "model:Pin", "transport_id:2"],
      },
    ]
  );
});

test("parses one exact package UID and rejects ambiguity", () => {
  assert.equal(
    parsePackageUidOutput(
      "package:com.penumbraos.systeminjector.exploit uid:10123\n",
      "com.penumbraos.systeminjector.exploit"
    ),
    10123
  );
  assert.throws(
    () => parsePackageUidOutput(
      "package:com.penumbraos.systeminjector.exploit uid:10123\n" +
        "package:com.penumbraos.systeminjector.exploit uid:10124\n",
      "com.penumbraos.systeminjector.exploit"
    ),
    /Expected one UID record/
  );
});

test("parses a normal helper base.apk path and rejects traversal", () => {
  const helperPath =
    "/data/app/~~token/com.penumbraos.systeminjector.exploit-random/base.apk";
  assert.equal(parseRegularPackageBaseApkPath(`package:${helperPath}\n`), helperPath);
  assert.throws(
    () => parseRegularPackageBaseApkPath("package:/data/app/pkg/../other/base.apk\n"),
    /Unsafe regular package/
  );
});

test("an empty exit-1 package path means the user-scoped APK is unloaded", () => {
  assert.equal(
    parsePackagePathCommandResult(
      { stdout: "", stderr: "", exitCode: 1 },
      PACKAGE_NAME
    ),
    false
  );
  assert.throws(
    () => parsePackagePathCommandResult(
      { stdout: "", stderr: "cmd: Can't find service: package", exitCode: 20 },
      PACKAGE_NAME
    ),
    /Can't find service: package/
  );
});

test("parses the exact loaded UID-1000 package and authoritative user-installed state", () => {
  assert.deepEqual(parseDumpsysPackageUserState(packageDump(), PACKAGE_NAME, 0), {
    installed: true,
    loaded: true,
    appId: 1000,
    codePath: `/data/app/${PACKAGE_NAME}-injected`,
  });
});

test("accepts a loaded package from Android's randomized package-bound codePath", () => {
  const codePath =
    `/data/app/~~KbdWg25D7Im5LfFCIGgoVw==/${PACKAGE_NAME}-YlA7YoI9r3RuH_dF88r8eA==`;
  assert.deepEqual(
    parseDumpsysPackageUserState(packageDump({ codePath }), PACKAGE_NAME, 0),
    {
      installed: true,
      loaded: true,
      appId: 1000,
      codePath,
    }
  );
});

test("accepts retained Hook and Server legacy paths without treating pkg=null as runnable", () => {
  for (const packageName of ["com.penumbraos.hook", PACKAGE_NAME]) {
    const output = packageDump({ pkg: "null" }).replaceAll(PACKAGE_NAME, packageName);
    assert.deepEqual(
      parseDumpsysPackageUserState(output, packageName, 0),
      {
        installed: false,
        loaded: false,
        appId: 1000,
        codePath: `/data/app/${packageName}-injected`,
      }
    );
  }
});

test("rejects package-boundary confusion in a randomized loaded codePath", () => {
  assert.throws(
    () => parseDumpsysPackageUserState(
      packageDump({
        codePath:
          `/data/app/~~KbdWg25D7Im5LfFCIGgoVw==/${PACKAGE_NAME}.helper-YlA7YoI9r3RuH_dF88r8eA==`,
      }),
      PACKAGE_NAME,
      0
    ),
    /Unexpected loaded codePath/
  );
});

test("rejects traversal and malformed randomized loaded codePaths", () => {
  for (const codePath of [
    `/data/app/~~KbdWg25D7Im5LfFCIGgoVw==/${PACKAGE_NAME}-token/../other`,
    `/data/app/~~bad+token/${PACKAGE_NAME}-package-token`,
    `/data/app/~~valid-token/${PACKAGE_NAME}-bad+token`,
  ]) {
    assert.throws(
      () => parseDumpsysPackageUserState(packageDump({ codePath }), PACKAGE_NAME, 0),
      /(?:Unsafe|Unexpected) loaded codePath/
    );
  }
});

test("rejects a randomized codePath for retained pkg=null metadata", () => {
  assert.throws(
    () => parseDumpsysPackageUserState(
      packageDump({
        pkg: "null",
        codePath:
          `/data/app/~~KbdWg25D7Im5LfFCIGgoVw==/${PACKAGE_NAME}-YlA7YoI9r3RuH_dF88r8eA==`,
      }),
      PACKAGE_NAME,
      0
    ),
    /Unexpected retained codePath/
  );
});

test("parses a loaded package with installed=false as not installed for that user", () => {
  assert.equal(
    parseDumpsysPackageUserState(
      packageDump({ installed: "false" }),
      PACKAGE_NAME,
      0
    )?.installed,
    false
  );
});

test("maps only the exact dumpsys missing-package response to no package", () => {
  assert.equal(
    parseDumpsysPackageUserState(
      `Unable to find package: ${PACKAGE_NAME}\n`,
      PACKAGE_NAME,
      0
    ),
    null
  );
  assert.throws(
    () => parseDumpsysPackageUserState("Unable to find package: com.other", PACKAGE_NAME, 0),
    /Expected one exact Package record/
  );
});

test("rejects ambiguous or mismatched dumpsys package records", () => {
  assert.throws(
    () => parseDumpsysPackageUserState(`${packageDump()}\n${packageDump()}`, PACKAGE_NAME, 0),
    /found 2/
  );
  assert.throws(
    () => parseDumpsysPackageUserState(
      packageDump({ pkg: "Package{5eb6c97 com.penumbraos.other}" }),
      PACKAGE_NAME,
      0
    ),
    /Unexpected pkg state/
  );
  assert.throws(
    () => parseDumpsysPackageUserState(
      packageDump({ appId: 10001 }),
      PACKAGE_NAME,
      0
    ),
    /system app ID 1000/
  );
  assert.throws(
    () => parseDumpsysPackageUserState(
      packageDump({ codePath: "/data/app/com.penumbraos.other-injected" }),
      PACKAGE_NAME,
      0
    ),
    /Unexpected loaded codePath/
  );
  assert.throws(
    () => parseDumpsysPackageUserState(
      packageDump({ extraRecordLine: `    codePath=/data/app/${PACKAGE_NAME}-injected` }),
      PACKAGE_NAME,
      0
    ),
    /found 2/
  );
});

test("rejects duplicate or malformed installed tokens in the exact user record", () => {
  const duplicate = packageDump().replace(
    "installed=true hidden=false",
    "installed=true installed=false hidden=false"
  );
  assert.throws(
    () => parseDumpsysPackageUserState(duplicate, PACKAGE_NAME, 0),
    /Expected one installed state/
  );
  assert.throws(
    () => parseDumpsysPackageUserState(
      packageDump({ installed: "yes" }),
      PACKAGE_NAME,
      0
    ),
    /Expected one installed state/
  );
});

test("builds the synchronous install-existing command without callback --wait", () => {
  const args = buildInstallExistingArguments(PACKAGE_NAME, 0);
  assert.deepEqual(args, [
    "shell",
    "cmd",
    "package",
    "install-existing",
    "--user",
    "0",
    PACKAGE_NAME,
  ]);
  assert.equal(args.includes("--wait"), false);
});

test("keep-data uninstall waits for a transient loaded APK to disappear", async () => {
  let checks = 0;
  await waitForPackageUnloadedWithOperations(
    PACKAGE_NAME,
    0,
    {
      async isLoaded() {
        checks += 1;
        return checks === 1;
      },
      async delay() {},
    },
    {
      checkTimeoutMs: 5,
      verificationAttempts: 3,
      verificationIntervalMs: 1,
    }
  );
  assert.equal(checks, 2);
});

test("restoration succeeds from verified post-state even if install-existing hangs", async () => {
  let checks = 0;
  await ensureInstalledForUserWithOperations(
    PACKAGE_NAME,
    0,
    {
      async isInstalled() {
        checks += 1;
        return checks > 1;
      },
      async installExisting() {
        return new Promise<void>(() => {});
      },
    },
    TEST_RESTORE_POLICY
  );
  assert.equal(checks, 2);
});

test("restoration fails closed before mutation when initial state cannot be read", async () => {
  let commandIssued = false;
  await assert.rejects(
    ensureInstalledForUserWithOperations(
      PACKAGE_NAME,
      0,
      {
        async isInstalled() {
          return new Promise<boolean>(() => {});
        },
        async installExisting() {
          commandIssued = true;
        },
      },
      TEST_RESTORE_POLICY
    ),
    /no restoration command was issued/
  );
  assert.equal(commandIssued, false);
});

test("restoration makes only the configured number of bounded verification attempts", async () => {
  let checks = 0;
  let commands = 0;
  await assert.rejects(
    ensureInstalledForUserWithOperations(
      PACKAGE_NAME,
      0,
      {
        async isInstalled() {
          checks += 1;
          return false;
        },
        async installExisting() {
          commands += 1;
        },
      },
      TEST_RESTORE_POLICY
    ),
    /not installed for user 0 after 3 bounded checks/
  );
  assert.equal(checks, 4);
  assert.equal(commands, 1);
});

test("restoration bounds every verification check even when PackageManager checks hang", async () => {
  let checks = 0;
  await assert.rejects(
    ensureInstalledForUserWithOperations(
      PACKAGE_NAME,
      0,
      {
        async isInstalled() {
          checks += 1;
          if (checks === 1) return false;
          return new Promise<boolean>(() => {});
        },
        async installExisting() {},
      },
      TEST_RESTORE_POLICY
    ),
    /last state check failed: PackageManager verification.*timed out/
  );
  assert.equal(checks, 4);
});
