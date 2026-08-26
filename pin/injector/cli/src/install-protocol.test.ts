import assert from "node:assert/strict";
import test from "node:test";
import {
  installWithSafeUpdates,
  parseProviderInstallResponse,
  runUpdatedPackageActivation,
} from "./install-protocol.js";

const TRANSACTION_TOKEN = "a".repeat(32);

test("updated packages repair Hook policy and inject targets only after activation", async () => {
  const calls: string[] = [];

  await runUpdatedPackageActivation({
    waitForStagingProviderReady: async () => {
      calls.push("wait_for_staging_provider");
    },
    activateUpdates: async () => {
      calls.push("activate_updates");
    },
    repairHookRuntimePolicy: async () => {
      calls.push("repair_hook_runtime_policy");
    },
    injectConfiguredTargets: async () => {
      calls.push("inject_configured_targets");
    },
  });

  assert.deepEqual(calls, [
    "wait_for_staging_provider",
    "activate_updates",
    "repair_hook_runtime_policy",
    "inject_configured_targets",
  ]);
});

function duplicateTransaction(...packageNames: string[]): string {
  return (
    "Result: Bundle[{message=DUPLICATE_TRANSACTION:" +
    `${TRANSACTION_TOKEN};PACKAGES:${packageNames.join(",")}}]`
  );
}

test("parses exact OK and duplicate-list provider responses", () => {
  assert.deepEqual(
    parseProviderInstallResponse("Result: Bundle[{message=OK}]"),
    { kind: "ok", packageNames: null }
  );
  assert.deepEqual(
    parseProviderInstallResponse(
      "Result: Bundle[{message=ACCEPTED_PACKAGES:com.example.one,com.example.two;REPLACEMENTS:com.example.two}]"
    ),
    {
      kind: "accepted",
      packageNames: ["com.example.one", "com.example.two"],
      replacementPackages: ["com.example.two"],
    }
  );
  assert.deepEqual(
    parseProviderInstallResponse(duplicateTransaction("com.example.app")),
    {
      kind: "duplicates",
      packageNames: ["com.example.app"],
      transactionToken: TRANSACTION_TOKEN,
    }
  );
  assert.deepEqual(
    parseProviderInstallResponse(duplicateTransaction("com.example.one", "com.example.two")),
    {
      kind: "duplicates",
      packageNames: ["com.example.one", "com.example.two"],
      transactionToken: TRANSACTION_TOKEN,
    }
  );
  assert.deepEqual(
    parseProviderInstallResponse(
      "Result: Bundle[{message=DUPLICATE_BATCH_PACKAGE:com.example.same}]"
    ),
    { kind: "duplicate-batch", packageName: "com.example.same" }
  );
});

test("rejects ambiguous, malformed, and substring-OK responses", () => {
  assert.equal(parseProviderInstallResponse("Result: Bundle[{message=NOT_OK}]").kind, "invalid");
  assert.equal(
    parseProviderInstallResponse(
      `Result: Bundle[{message=DUPLICATE_TRANSACTION:${TRANSACTION_TOKEN};PACKAGES:com.example.app;rm}]`
    ).kind,
    "invalid"
  );
  assert.equal(
    parseProviderInstallResponse(
      duplicateTransaction("com.example.app", "com.example.app")
    ).kind,
    "invalid"
  );
  assert.equal(parseProviderInstallResponse("Result: Bundle[{}]").kind, "invalid");
  assert.equal(parseProviderInstallResponse("garbage message=OK").kind, "invalid");
  assert.equal(
    parseProviderInstallResponse("Result: Bundle[{evil=1,message=OK}]").kind,
    "invalid"
  );
  assert.equal(
    parseProviderInstallResponse("Result: Bundle[{message=OK}] trailing junk").kind,
    "invalid"
  );
  assert.equal(
    parseProviderInstallResponse(
      `garbage message=DUPLICATE_TRANSACTION:${TRANSACTION_TOKEN};PACKAGES:com.example.app`
    ).kind,
    "invalid"
  );
  assert.equal(
    parseProviderInstallResponse(
      "Result: Bundle[{message=DUPLICATE_PACKAGE:com.example.app}]"
    ).kind,
    "invalid"
  );
  assert.equal(
    parseProviderInstallResponse(
      "Result: Bundle[{message=ACCEPTED_PACKAGES:com.example.one;REPLACEMENTS:com.example.two}]"
    ).kind,
    "invalid"
  );
});

test("parses a non-system duplicate as ineligible without authorizing an uninstall", () => {
  assert.deepEqual(
    parseProviderInstallResponse(
      "Result: Bundle[{message=UPDATE_NOT_ELIGIBLE:com.example.app:uid=10123}]"
    ),
    { kind: "update-not-eligible", packageName: "com.example.app", uid: 10123 }
  );
});

test("requires an accepted package list before waiting for fresh-install completion", async () => {
  await assert.rejects(
    installWithSafeUpdates(
      {
        async callProvider() {
          return "Result: Bundle[{message=OK}]";
        },
        async uninstallKeepData() {
          assert.fail("unexpected uninstall");
        },
      },
      "com.penumbraos.systeminjector"
    ),
    /exact accepted package list/
  );
});

test("returns the accepted package list for post-reboot fresh-install verification", async () => {
  const result = await installWithSafeUpdates(
    {
      async callProvider() {
        return "Result: Bundle[{message=ACCEPTED_PACKAGES:com.example.fresh;REPLACEMENTS:}]";
      },
      async uninstallKeepData() {
        assert.fail("unexpected uninstall");
      },
    },
    "com.penumbraos.systeminjector"
  );
  assert.deepEqual(result, {
    updatedPackages: [],
    installedPackages: ["com.example.fresh"],
  });
});

test("preserves provider replacement metadata on an approval-recovery invocation", async () => {
  const result = await installWithSafeUpdates(
    {
      async callProvider() {
        return "Result: Bundle[{message=ACCEPTED_PACKAGES:com.example.recovery;REPLACEMENTS:com.example.recovery}]";
      },
      async uninstallKeepData() {
        assert.fail("retained package should not be uninstalled again");
      },
    },
    "com.penumbraos.systeminjector"
  );
  assert.deepEqual(result.updatedPackages, ["com.example.recovery"]);
});

test("ineligible duplicate aborts before uninstall", async () => {
  const uninstalls: string[] = [];
  await assert.rejects(
    installWithSafeUpdates(
      {
        async callProvider() {
          return "Result: Bundle[{message=UPDATE_NOT_ELIGIBLE:com.example.app:uid=10123}]";
        },
        async uninstallKeepData(packageName) {
          uninstalls.push(packageName);
        },
      },
      "com.penumbraos.systeminjector"
    ),
    /not injector-managed/
  );
  assert.deepEqual(uninstalls, []);
});

test("multi-user preflight failure aborts before every uninstall", async () => {
  const uninstalls: string[] = [];
  const cancelledTransactions: string[] = [];
  await assert.rejects(
    installWithSafeUpdates(
      {
        async callProvider() {
          return duplicateTransaction("com.example.app");
        },
        async validateBeforeUninstalls() {
          throw new Error("also installed for Android user 10");
        },
        async cancelProviderTransaction(transactionToken) {
          cancelledTransactions.push(transactionToken);
        },
        async uninstallKeepData(packageName) {
          uninstalls.push(packageName);
        },
      },
      "com.penumbraos.systeminjector"
    ),
    /Android user 10/
  );
  assert.deepEqual(uninstalls, []);
  assert.deepEqual(cancelledTransactions, [TRANSACTION_TOKEN]);
});

test("uninstalls each parsed duplicate with keep-data operation and retries once", async () => {
  const providerResponses = [
    duplicateTransaction("com.example.one", "com.example.two"),
    "Result: Bundle[{message=ACCEPTED_PACKAGES:com.example.one,com.example.two;REPLACEMENTS:com.example.one,com.example.two}]",
  ];
  const events: string[] = [];

  const result = await installWithSafeUpdates(
    {
      async callProvider(transactionToken) {
        events.push("call");
        if (events.filter((event) => event === "call").length === 2) {
          assert.equal(transactionToken, TRANSACTION_TOKEN);
        }
        return providerResponses.shift()!;
      },
      async uninstallKeepData(packageName) {
        events.push(`uninstall:${packageName}`);
      },
      onBeforeRetry() {
        events.push("retry");
      },
    },
    "com.penumbraos.systeminjector"
  );

  assert.deepEqual(result.updatedPackages, ["com.example.one", "com.example.two"]);
  assert.deepEqual(result.installedPackages, ["com.example.one", "com.example.two"]);
  assert.deepEqual(events, [
    "call",
    "uninstall:com.example.one",
    "uninstall:com.example.two",
    "retry",
    "call",
  ]);
});

test("rejects injector self-update before any package mutation", async () => {
  const uninstalls: string[] = [];

  await assert.rejects(
    installWithSafeUpdates(
      {
        async callProvider() {
          return duplicateTransaction(
            "com.example.other",
            "com.penumbraos.systeminjector"
          );
        },
        async uninstallKeepData(packageName) {
          uninstalls.push(packageName);
        },
      },
      "com.penumbraos.systeminjector"
    ),
    /Self-update requires bootstrap/
  );

  assert.deepEqual(uninstalls, []);
});

test("fails closed and restores user 0 when retry is not exact acceptance", async () => {
  let calls = 0;
  const uninstalls: string[] = [];
  const restored: string[] = [];

  await assert.rejects(
    installWithSafeUpdates(
      {
        async callProvider() {
          calls += 1;
          return calls === 1
            ? duplicateTransaction("com.example.app")
            : duplicateTransaction("com.example.app");
        },
        async uninstallKeepData(packageName) {
          uninstalls.push(packageName);
        },
        async restoreAfterFailedUpdate(packageName) {
          restored.push(packageName);
        },
      },
      "com.penumbraos.systeminjector"
    ),
    /No further uninstalls will be attempted/
  );

  assert.equal(calls, 2);
  assert.deepEqual(uninstalls, ["com.example.app"]);
  assert.deepEqual(restored, ["com.example.app"]);
});

test("restores the current and earlier packages when an uninstall attempt fails", async () => {
  const restored: string[] = [];
  await assert.rejects(
    installWithSafeUpdates(
      {
        async callProvider() {
          return duplicateTransaction("com.example.one", "com.example.two");
        },
        async uninstallKeepData(packageName) {
          if (packageName === "com.example.two") throw new Error("second uninstall failed");
        },
        async restoreAfterFailedUpdate(packageName) {
          restored.push(packageName);
        },
      },
      "com.penumbraos.systeminjector"
    ),
    /second uninstall failed/
  );
  assert.deepEqual(restored, ["com.example.two", "com.example.one"]);
});

test("does not retry when keep-data uninstall fails", async () => {
  let calls = 0;

  await assert.rejects(
    installWithSafeUpdates(
      {
        async callProvider() {
          calls += 1;
          return duplicateTransaction("com.example.app");
        },
        async uninstallKeepData() {
          throw new Error("pm uninstall failed");
        },
      },
      "com.penumbraos.systeminjector"
    ),
    /pm uninstall failed/
  );

  assert.equal(calls, 1);
});
