import {
  PinReleaseError,
  fetchPinReleaseManifest,
  type FetchPinReleaseManifestOptions,
  type PinReleaseArtifact,
  type PinReleaseArtifactRole,
} from "./manifest";

export const LEGACY_APK_FILENAME_PATTERNS: Readonly<
  Record<PinReleaseArtifactRole, RegExp>
> = Object.freeze({
  installer: /^PenumbraOS-SystemInjector-Installer-.+\.apk$/,
  bootstrap: /^PenumbraOS-SystemInjector-Exploit-.+\.apk$/,
  hook: /^PenumbraOS-HumaneHooks-.+\.apk$/,
  server: /^PenumbraOS-Server-.+\.apk$/,
  "hook-injector": /^PenumbraOS-HumaneHookInjector-.+\.apk$/,
});

/** Compatibility parser for operator-supplied legacy filenames only. */
export function recognizeLegacyApkFilename(
  filename: string,
): PinReleaseArtifactRole | null {
  for (const [role, pattern] of Object.entries(
    LEGACY_APK_FILENAME_PATTERNS,
  ) as [PinReleaseArtifactRole, RegExp][]) {
    if (pattern.test(filename)) {
      return role;
    }
  }
  return null;
}

export interface ResolvedInstallTarget {
  /** implemented: true only after strict same-origin manifest validation. */
  readonly manifestVerified: true;
  readonly inspectedAt: string;
  readonly manifestUrl: string;
  readonly releaseId: string;
  readonly version: string;
  readonly versionCode: number;
  readonly artifacts: Readonly<{
    installerApk: PinReleaseArtifact;
    exploitApk: PinReleaseArtifact;
    hookApk: PinReleaseArtifact;
    serverApk: PinReleaseArtifact;
    injectorApk: PinReleaseArtifact;
  }>;
}

export type DownloadedInstallAssetRole = keyof ResolvedInstallTarget["artifacts"];

export interface DownloadedInstallTargetAssets {
  readonly target: ResolvedInstallTarget;
  readonly installerApk?: Blob;
  readonly exploitApk?: Blob;
  readonly hookApk?: Blob;
  readonly serverApk?: Blob;
  readonly injectorApk?: Blob;
}

export interface AssetDownloadProgressEvent {
  readonly assetName: string;
  readonly assetIndex: number;
  readonly assetCount: number;
  readonly bytesLoaded: number;
  readonly bytesTotal: number;
}

export interface AssetFetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url?: string;
  readonly body?: ReadableStream<Uint8Array> | null;
  readonly headers?: Pick<Headers, "get">;
  blob(): Promise<Blob>;
}

export type AssetFetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<AssetFetchResponseLike>;

export interface DownloadInstallTargetAssetsOptions {
  readonly fetchImpl?: AssetFetchLike;
  readonly assetRoles?: readonly DownloadedInstallAssetRole[];
  readonly onAssetProgress?: (event: AssetDownloadProgressEvent) => void;
}

function artifactByRole(
  artifacts: readonly PinReleaseArtifact[],
  role: PinReleaseArtifactRole,
): PinReleaseArtifact {
  const artifact = artifacts.find((candidate) => candidate.role === role);
  if (!artifact) {
    throw new PinReleaseError({
      code: "release-manifest-invalid",
      message: `The validated release is missing its ${role} artifact.`,
      role,
    });
  }
  return artifact;
}

export async function resolveInstallTarget(
  options: FetchPinReleaseManifestOptions = {},
): Promise<ResolvedInstallTarget> {
  const { manifest, manifestUrl } = await fetchPinReleaseManifest(options);
  const artifacts = Object.freeze({
    installerApk: artifactByRole(manifest.artifacts, "installer"),
    exploitApk: artifactByRole(manifest.artifacts, "bootstrap"),
    hookApk: artifactByRole(manifest.artifacts, "hook"),
    serverApk: artifactByRole(manifest.artifacts, "server"),
    injectorApk: artifactByRole(manifest.artifacts, "hook-injector"),
  });

  return Object.freeze({
    manifestVerified: true,
    inspectedAt: new Date().toISOString(),
    manifestUrl,
    releaseId: manifest.releaseId,
    version: manifest.version,
    versionCode: artifacts.installerApk.versionCode,
    artifacts,
  });
}

function readContentLength(response: AssetFetchResponseLike): number | null {
  const raw = response.headers?.get("content-length");
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function integrityError(asset: PinReleaseArtifact, message: string): PinReleaseError {
  return new PinReleaseError({
    code: "release-asset-integrity-failed",
    message,
    role: asset.role,
    assetName: asset.name,
  });
}

async function readBlobWithProgress(
  response: AssetFetchResponseLike,
  asset: PinReleaseArtifact,
  reportProgress?: (loaded: number, total: number) => void,
): Promise<Blob> {
  const contentLength = readContentLength(response);
  if (contentLength !== null && contentLength !== asset.size) {
    throw integrityError(
      asset,
      `Downloaded size header for ${asset.name} did not match its release manifest.`,
    );
  }

  const body = response.body;
  if (!body) {
    const blob = await response.blob();
    reportProgress?.(blob.size, asset.size);
    return blob;
  }

  const reader = body.getReader();
  const chunks: ArrayBuffer[] = [];
  let loaded = 0;
  reportProgress?.(0, asset.size);

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      loaded += value.byteLength;
      if (loaded > asset.size) {
        await reader.cancel().catch(() => undefined);
        throw integrityError(
          asset,
          `Downloaded ${asset.name} exceeded its declared size.`,
        );
      }
      const chunk = new ArrayBuffer(value.byteLength);
      new Uint8Array(chunk).set(value);
      chunks.push(chunk);
      reportProgress?.(loaded, asset.size);
    }
  }

  reportProgress?.(loaded, asset.size);
  return new Blob(chunks, { type: "application/vnd.android.package-archive" });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyAssetBlob(
  asset: PinReleaseArtifact,
  blob: Blob,
): Promise<Blob> {
  if (blob.size !== asset.size) {
    throw integrityError(
      asset,
      `Downloaded size for ${asset.name} did not match its release manifest.`,
    );
  }
  if (!globalThis.crypto?.subtle) {
    throw integrityError(
      asset,
      `SHA-256 verification is unavailable for ${asset.name}.`,
    );
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  if (bytesToHex(new Uint8Array(digest)) !== asset.sha256) {
    throw integrityError(
      asset,
      `Downloaded SHA-256 for ${asset.name} did not match its release manifest.`,
    );
  }
  return new Blob([blob], { type: "application/vnd.android.package-archive" });
}

async function downloadAsset(
  asset: PinReleaseArtifact,
  fetchImpl: AssetFetchLike,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Blob> {
  let response: AssetFetchResponseLike;
  try {
    response = await fetchImpl(asset.url, {
      method: "GET",
      headers: { Accept: "application/vnd.android.package-archive" },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    throw new PinReleaseError({
      code: "release-asset-download-failed",
      message: `Could not download ${asset.name}.`,
      role: asset.role,
      assetName: asset.name,
      statusText: error instanceof Error ? error.message : String(error),
    });
  }

  if (!response.ok) {
    throw new PinReleaseError({
      code: "release-asset-download-failed",
      message: `Release service failed while downloading ${asset.name} (${response.status} ${response.statusText}).`,
      role: asset.role,
      assetName: asset.name,
      status: response.status,
      statusText: response.statusText,
    });
  }

  if (response.url && new URL(response.url).origin !== new URL(asset.url).origin) {
    throw new PinReleaseError({
      code: "release-asset-download-failed",
      message: `The ${asset.name} response crossed an origin boundary.`,
      role: asset.role,
      assetName: asset.name,
    });
  }

  return verifyAssetBlob(
    asset,
    await readBlobWithProgress(response, asset, onProgress),
  );
}

function getDefaultAssetFetch(): AssetFetchLike {
  return (input, init) =>
    globalThis.fetch(input, init) as Promise<AssetFetchResponseLike>;
}

export async function downloadInstallTargetAssets(
  target: ResolvedInstallTarget,
  options: DownloadInstallTargetAssetsOptions = {},
): Promise<DownloadedInstallTargetAssets> {
  const fetchImpl = options.fetchImpl ?? getDefaultAssetFetch();
  const allAssetEntries = Object.entries(target.artifacts) as [
    DownloadedInstallAssetRole,
    PinReleaseArtifact,
  ][];
  const selectedRoles = options.assetRoles ? new Set(options.assetRoles) : null;
  const assetEntries = selectedRoles
    ? allAssetEntries.filter(([role]) => selectedRoles.has(role))
    : allAssetEntries;

  const blobs = await Promise.all(
    assetEntries.map(([role, asset], index) =>
      downloadAsset(asset, fetchImpl, (bytesLoaded, bytesTotal) => {
        options.onAssetProgress?.({
          assetName: asset.name,
          assetIndex: index,
          assetCount: assetEntries.length,
          bytesLoaded,
          bytesTotal,
        });
      }).then((blob) => [role, blob] as const),
    ),
  );

  return Object.freeze(
    blobs.reduce<DownloadedInstallTargetAssets>(
      (downloadedAssets, [role, blob]) => ({
        ...downloadedAssets,
        [role]: blob,
      }),
      { target },
    ),
  );
}
