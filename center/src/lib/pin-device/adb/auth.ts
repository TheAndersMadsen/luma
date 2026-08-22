import {
  AdbAuthType,
  AdbCommand,
  type AdbAuthenticator,
  type AdbCredentialStore,
  type AdbPacketData,
  type AdbPrivateKey,
} from "@yume-chan/adb";
import { logError, logInfo } from "../logging";

/**
 * Center's own same-origin signing endpoint.
 *
 * The Setup SPA posted the raw ADB auth token straight to a third-party
 * Cloudflare Worker (https://adb.penumbraos.workers.dev). Center proxies that
 * call server-side instead, for two reasons: `connect-src 'self'` in
 * center/next.config.mjs stays untouched, and browser JS running on the origin
 * that holds the `carry_tokens` session cookie never talks to a third party
 * that sees device auth material.
 *
 * The wire shape is unchanged: raw token bytes in, `{token, public_key}` out.
 */
export const DEFAULT_REMOTE_ADB_AUTH_URL = "/api/pin/adb/sign";
export const DEFAULT_REMOTE_ADB_AUTH_TIMEOUT_MS = 10000;

interface RemoteAuthResponse {
  token: string;
  public_key: string;
}

export interface RemoteAdbAuthClient {
  signToken(token: Uint8Array): Promise<{
    signature: Uint8Array;
    publicKey: Uint8Array;
  }>;
}

export interface AdbAuthStrategy {
  createAuthenticationBundle(device: {
    serial: string;
    name: string;
  }): Promise<{
    credentialStore: AdbCredentialStore;
    authenticators: readonly AdbAuthenticator[];
  }>;
}

class NoopCredentialStore implements AdbCredentialStore {
  generateKey(): AdbPrivateKey {
    throw new Error("Local key generation is disabled for remote ADB auth.");
  }

  iterateKeys(): Iterable<AdbPrivateKey> {
    return [];
  }
}

export const REMOTE_ADB_NOOP_CREDENTIAL_STORE: AdbCredentialStore = new NoopCredentialStore();

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function ensureNullTerminated(value: Uint8Array): Uint8Array {
  if (value.length === 0) {
    return new Uint8Array([0]);
  }

  if (value[value.length - 1] === 0) {
    return value;
  }

  const output = new Uint8Array(value.length + 1);
  output.set(value, 0);
  output[value.length] = 0;
  return output;
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value.trim());
  const output = new Uint8Array(decoded.length);

  for (let index = 0; index < decoded.length; index += 1) {
    output[index] = decoded.charCodeAt(index);
  }

  return output;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

function isRemoteAuthResponse(value: unknown): value is RemoteAuthResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.token === "string" && typeof record.public_key === "string";
}

function getDefaultFetch(): typeof fetch {
  return (...args) => globalThis.fetch(...args);
}

export class HttpRemoteAdbAuthClient implements RemoteAdbAuthClient {
  private readonly remoteAuthUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    remoteAuthUrl: string,
    options?: {
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.remoteAuthUrl = remoteAuthUrl;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_REMOTE_ADB_AUTH_TIMEOUT_MS;
    this.fetchImpl = options?.fetchImpl ?? getDefaultFetch();
  }

  async signToken(token: Uint8Array): Promise<{
    signature: Uint8Array;
    publicKey: Uint8Array;
  }> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    );

    logInfo("remote-adb-auth", "Requesting remote ADB signature", {
      remoteAuthUrl: this.remoteAuthUrl,
      tokenBytes: token.byteLength,
      timeoutMs: this.timeoutMs,
    });

    try {
      const response = await this.fetchImpl(this.remoteAuthUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: toArrayBuffer(token),
        signal: controller.signal,
        // The signing endpoint is session-gated, so the Center session cookie
        // must ride along. This is the browser default for same-origin
        // requests; stating it keeps the contract explicit.
        credentials: "same-origin",
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => "");
        throw new Error(
          responseText ||
            `Remote ADB auth failed with ${response.status} ${response.statusText}`,
        );
      }

      const body = (await response.json()) as unknown;
      if (!isRemoteAuthResponse(body)) {
        throw new Error("Remote ADB auth response was missing token or public_key.");
      }

      let signature: Uint8Array;
      try {
        signature = decodeBase64(body.token);
      } catch {
        throw new Error("Remote ADB auth signature was not valid base64.");
      }

      const publicKey = ensureNullTerminated(encodeUtf8(body.public_key));

      logInfo("remote-adb-auth", "Received remote ADB signature", {
        remoteAuthUrl: this.remoteAuthUrl,
        signatureBytes: signature.byteLength,
        publicKeyBytes: publicKey.byteLength,
      });

      return { signature, publicKey };
    } catch (error) {
      logError("remote-adb-auth", "Remote ADB auth request failed", error, {
        remoteAuthUrl: this.remoteAuthUrl,
      });
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
}

export function createRemoteAdbAuthenticator(client: RemoteAdbAuthClient): AdbAuthenticator {
  return async function* remoteAdbAuthenticator(
    _credentialStore: AdbCredentialStore,
    getNextRequest: () => Promise<AdbPacketData>,
  ): AsyncIterable<AdbPacketData> {
    const firstRequest = await getNextRequest();
    if (firstRequest.arg0 !== AdbAuthType.Token) {
      return;
    }

    const { signature, publicKey } = await client.signToken(firstRequest.payload);
    yield {
      command: AdbCommand.Auth,
      arg0: AdbAuthType.Signature,
      arg1: 0,
      payload: signature,
    };

    const secondRequest = await getNextRequest();
    if (secondRequest.arg0 !== AdbAuthType.Token) {
      return;
    }

    yield {
      command: AdbCommand.Auth,
      arg0: AdbAuthType.PublicKey,
      arg1: 0,
      payload: publicKey,
    };
  };
}

export class RemoteSignerAdbAuthStrategy implements AdbAuthStrategy {
  private readonly remoteAuthUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    remoteAuthUrl = DEFAULT_REMOTE_ADB_AUTH_URL,
    options?: {
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.remoteAuthUrl = remoteAuthUrl;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_REMOTE_ADB_AUTH_TIMEOUT_MS;
    this.fetchImpl = options?.fetchImpl ?? getDefaultFetch();
  }

  async createAuthenticationBundle(device: { serial: string; name: string }) {
    void device;
    const client = new HttpRemoteAdbAuthClient(this.remoteAuthUrl, {
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });

    return {
      credentialStore: REMOTE_ADB_NOOP_CREDENTIAL_STORE,
      authenticators: [createRemoteAdbAuthenticator(client)],
    };
  }
}
