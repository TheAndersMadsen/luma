import type { PinReleaseArtifact, PinReleaseArtifactRole } from "./manifest";
import type { ResolvedInstallTarget } from "./assets";

const FIXTURE_SHA256 = "a".repeat(64);

function artifact(
  role: PinReleaseArtifactRole,
  packageName: string,
  size: number,
  versionCode: number,
): PinReleaseArtifact {
  return Object.freeze({
    role,
    url: `https://center.example.test/api/pin/releases/${role}.apk`,
    name: `${role}.apk`,
    package: packageName,
    versionCode,
    size,
    sha256: FIXTURE_SHA256,
  });
}

export function createResolvedInstallTargetFixture(
  overrides: Partial<
    Pick<ResolvedInstallTarget, "releaseId" | "version" | "versionCode">
  > = {},
): ResolvedInstallTarget {
  const versionCode = overrides.versionCode ?? 202_608_090;
  return {
    manifestVerified: true,
    inspectedAt: "2026-08-09T12:00:00.000Z",
    manifestUrl: "https://center.example.test/api/pin/releases/current",
    releaseId: overrides.releaseId ?? "b".repeat(64),
    version: overrides.version ?? "2026-04-29.1",
    versionCode,
    artifacts: {
      installerApk: artifact(
        "installer",
        "com.penumbraos.systeminjector",
        101,
        versionCode,
      ),
      exploitApk: artifact(
        "bootstrap",
        "com.penumbraos.systeminjector.exploit",
        102,
        versionCode,
      ),
      hookApk: artifact(
        "hook",
        "com.penumbraos.hook",
        103,
        versionCode,
      ),
      serverApk: artifact(
        "server",
        "com.penumbraos.server",
        104,
        versionCode,
      ),
      injectorApk: artifact(
        "hook-injector",
        "com.penumbraos.hook.injector",
        105,
        versionCode,
      ),
    },
  };
}
