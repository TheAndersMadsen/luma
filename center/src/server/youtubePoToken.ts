import { BotGuardClient, getChallenge } from "bgutils-js/botguard";
import type { WebPoSignalOutput } from "bgutils-js/shared-types";
import { buildURL, getHeaders, USER_AGENT } from "bgutils-js/utils";
import { JSDOM } from "jsdom";

// This is YouTube's public BotGuard request identifier, not a credential.
const PUBLIC_REQUEST_KEY = "O43z0dpjhgX20SCx4KAo"; // gitleaks:allow
const MAX_INTEGRITY_RESPONSE_BYTES = 64 * 1024;
const MAX_MINTER_CACHE_SECONDS = 5 * 60;
const MIN_PROOF_TOKEN_CHARACTERS = 80;
const MAX_PROOF_TOKEN_CHARACTERS = 512;

type MintCallback = (contentBinding: Uint8Array) => Promise<ArrayBufferView | undefined>;

type ProofSession = {
  dom: JSDOM;
  expiresAt: number;
  fetch: typeof fetch;
  mint: MintCallback;
};

let cachedSession: ProofSession | null = null;
let operationQueue: Promise<void> = Promise.resolve();

function waitForSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function fetchUsingSignal(fetchImpl: typeof fetch, operationSignal: AbortSignal): typeof fetch {
  return (input, init) => {
    const signals = [
      operationSignal,
      init?.signal,
      input instanceof Request ? input.signal : undefined,
    ]
      .filter((signal): signal is AbortSignal => signal !== undefined && signal !== null)
      .filter((signal, index, all) => all.indexOf(signal) === index);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    return fetchImpl(input, { ...init, signal });
  };
}

function serialized<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const run = () => {
    signal?.throwIfAborted();
    return operation();
  };
  const result = operationQueue.then(run, run);
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return waitForSignal(result, signal);
}

function integrityTuple(value: unknown): {
  integrityToken: string;
  estimatedTtlSecs: number;
  mintRefreshThreshold: number;
  websafeFallbackToken: string;
} {
  if (
    !Array.isArray(value) ||
    (value.length !== 3 && value.length !== 4) ||
    typeof value[0] !== "string" ||
    value[0].length < 32 ||
    value[0].length > 16 * 1024 ||
    typeof value[1] !== "number" ||
    !Number.isFinite(value[1]) ||
    value[1] <= 0 ||
    typeof value[2] !== "number" ||
    !Number.isFinite(value[2]) ||
    value[2] < 0 ||
    (value[3] !== undefined && typeof value[3] !== "string") ||
    (typeof value[3] === "string" && value[3].length > 16 * 1024)
  ) {
    throw new Error("YouTube integrity response was invalid");
  }
  return {
    integrityToken: value[0],
    estimatedTtlSecs: value[1],
    mintRefreshThreshold: value[2],
    websafeFallbackToken: value[3] ?? "",
  };
}

export async function readYoutubeIntegrityResponse(
  response: Response,
  signal?: AbortSignal,
) {
  if (signal?.aborted) {
    await response.body?.cancel(signal.reason).catch(() => undefined);
    signal.throwIfAborted();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("YouTube integrity request failed");
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_INTEGRITY_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("YouTube integrity response was oversized");
  }
  if (!response.body) {
    throw new Error("YouTube integrity response was invalid");
  }

  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_INTEGRITY_RESPONSE_BYTES);
  let length = 0;
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_INTEGRITY_RESPONSE_BYTES - length) {
        await reader.cancel().catch(() => undefined);
        throw new Error("YouTube integrity response was oversized");
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  if (length === 0) {
    throw new Error("YouTube integrity response was invalid");
  }
  try {
    return integrityTuple(JSON.parse(new TextDecoder().decode(bytes.subarray(0, length))));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("YouTube integrity response was invalid");
    }
    throw error;
  }
}

async function createProofSession(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ProofSession> {
  const scopedFetch = signal ? fetchUsingSignal(fetchImpl, signal) : fetchImpl;
  const challenge = await getChallenge({
    fetchFunction: scopedFetch,
    requestKey: PUBLIC_REQUEST_KEY,
  });
  signal?.throwIfAborted();
  const interpreter =
    challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!interpreter || interpreter.length > 4 * 1024 * 1024) {
    throw new Error("YouTube integrity challenge was invalid");
  }

  const dom = new JSDOM(
    "<!DOCTYPE html><html lang=\"en\"><head><title></title></head><body></body></html>",
    {
      url: "https://www.youtube.com/",
      referrer: "https://www.youtube.com/",
      runScripts: "outside-only",
    },
  );
  try {
    Object.defineProperty(dom.window.navigator, "userAgent", {
      configurable: true,
      value: USER_AGENT,
    });
    dom.window.eval(interpreter);
    signal?.throwIfAborted();
    const botGuard = await BotGuardClient.create({
      program: challenge.program,
      globalName: challenge.globalName,
      globalObject: dom.window,
    });
    signal?.throwIfAborted();
    const webPoSignalOutput: WebPoSignalOutput = [];
    const snapshot = await botGuard.snapshot({ webPoSignalOutput });
    signal?.throwIfAborted();
    const integrity = await readYoutubeIntegrityResponse(
      await scopedFetch(buildURL("GenerateIT", true), {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify([PUBLIC_REQUEST_KEY, snapshot]),
      }),
      signal,
    );
    signal?.throwIfAborted();
    const factory = webPoSignalOutput[0];
    if (typeof factory !== "function") {
      throw new Error("YouTube proof minter was unavailable");
    }
    const mint = await factory(
      new Uint8Array(Buffer.from(integrity.integrityToken, "base64")),
    );
    signal?.throwIfAborted();
    if (typeof mint !== "function") {
      throw new Error("YouTube proof minter was unavailable");
    }
    const safeLifetimeSeconds = Math.max(
      1,
      Math.min(
        MAX_MINTER_CACHE_SECONDS,
        integrity.estimatedTtlSecs - integrity.mintRefreshThreshold,
      ),
    );
    return {
      dom,
      expiresAt: Date.now() + safeLifetimeSeconds * 1_000,
      fetch: fetchImpl,
      mint,
    };
  } catch (error) {
    dom.window.close();
    throw error;
  }
}

async function proofSession(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<ProofSession> {
  if (
    cachedSession &&
    cachedSession.fetch === fetchImpl &&
    cachedSession.expiresAt > Date.now()
  ) {
    return cachedSession;
  }
  cachedSession?.dom.window.close();
  cachedSession = null;
  cachedSession = await createProofSession(fetchImpl, signal);
  return cachedSession;
}

export async function youtubeContentProofToken(
  videoId: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) {
    throw new Error("YouTube proof content binding was invalid");
  }
  return serialized(async () => {
    const session = await proofSession(fetchImpl, signal);
    const result = await session.mint(new TextEncoder().encode(videoId));
    signal?.throwIfAborted();
    if (!ArrayBuffer.isView(result) || result.byteLength === 0) {
      throw new Error("YouTube proof token was invalid");
    }
    const token = Buffer.from(
      result.buffer,
      result.byteOffset,
      result.byteLength,
    ).toString("base64url");
    if (
      token.length < MIN_PROOF_TOKEN_CHARACTERS ||
      token.length > MAX_PROOF_TOKEN_CHARACTERS ||
      !/^[A-Za-z0-9_-]+$/u.test(token)
    ) {
      throw new Error("YouTube proof token was invalid");
    }
    return token;
  }, signal);
}
