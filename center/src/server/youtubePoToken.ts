import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { buildURL, getHeaders } from "bgutils-js/utils";

const MAX_INTEGRITY_RESPONSE_BYTES = 64 * 1024;
const MAX_CHALLENGE_RESPONSE_BYTES = 8 * 1024 * 1024;
const PROOF_OPERATION_TIMEOUT_MS = 20_000;
const MAX_WORKER_LIFETIME_MS = 5 * 60_000;
const MIN_PROOF_TOKEN_CHARACTERS = 80;
const MAX_PROOF_TOKEN_CHARACTERS = 512;

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

async function readProofResponseBody(
  response: Response,
  maxBytes: number,
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
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("YouTube integrity response was oversized");
  }
  if (!response.body) {
    throw new Error("YouTube integrity response was invalid");
  }

  const reader = response.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let length = 0;
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - length) {
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
  return new TextDecoder().decode(bytes.subarray(0, length));
}

export async function readYoutubeIntegrityResponse(response: Response, signal?: AbortSignal) {
  const text = await readProofResponseBody(response, MAX_INTEGRITY_RESPONSE_BYTES, signal);
  try {
    return integrityTuple(JSON.parse(text));
  } catch {
    throw new Error("YouTube integrity response was invalid");
  }
}

type ProofWorker = {
  child: ChildProcess;
  fetch: typeof fetch;
  expiresAt: number;
  request?: {
    id: number;
    signal: AbortSignal;
    resolve: (token: string) => void;
    reject: (error: unknown) => void;
    networkRequests: number;
    fetching: boolean;
  };
};
let cachedWorker: ProofWorker | null = null;
let nextRequest = 0;

function closeWorker(worker: ProofWorker, error: unknown): void {
  if (cachedWorker === worker) cachedWorker = null;
  const request = worker.request;
  worker.request = undefined;
  worker.child.kill("SIGKILL");
  request?.reject(error);
}

function proofWorker(fetchImpl: typeof fetch): ProofWorker {
  if (cachedWorker && cachedWorker.fetch === fetchImpl && cachedWorker.expiresAt > Date.now()) return cachedWorker;
  if (cachedWorker) closeWorker(cachedWorker, new Error("YouTube proof session expired"));
  const child = spawn(process.execPath, ["--no-env-file", join(process.cwd(), "runtime", "youtube-proof-worker.mjs")], {
    env: { NODE_ENV: "production", DO_NOT_TRACK: "1" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const worker: ProofWorker = { child, fetch: fetchImpl, expiresAt: Date.now() + MAX_WORKER_LIFETIME_MS };
  cachedWorker = worker;
  child.unref();
  const lifetime = setTimeout(() => {
    if (!worker.request) closeWorker(worker, new Error("YouTube proof session expired"));
  }, MAX_WORKER_LIFETIME_MS);
  lifetime.unref();
  child.on("exit", () => {
    clearTimeout(lifetime);
    closeWorker(worker, new Error("YouTube proof evaluation failed"));
  });
  child.on("error", () => closeWorker(worker, new Error("YouTube proof evaluator could not start")));
  const handleMessage = (message: unknown) => {
    const request = worker.request;
    if (!request || !message || typeof message !== "object") return;
    const data = message as Record<string, unknown>;
    if (data.type === "result" && data.id === request.id) {
      const token = data.token;
      if (request.fetching || (request.networkRequests !== 0 && request.networkRequests !== 2) ||
          typeof token !== "string" || token.length < MIN_PROOF_TOKEN_CHARACTERS || token.length > MAX_PROOF_TOKEN_CHARACTERS || !/^[A-Za-z0-9_-]+$/u.test(token)) {
        closeWorker(worker, new Error("YouTube proof token was invalid"));
        return;
      }
      request.resolve(token);
      return;
    }
    if (data.type === "error" && data.id === request.id) {
      closeWorker(worker, new Error("YouTube proof evaluation failed"));
      return;
    }
    // The interpreter receives no provider credentials or general fetch bridge.
    // Only the two existing public attestation endpoints are brokered through
    // this turn's configured fetch, retaining the Pin egress path.
    if (data.type !== "fetch" || data.operationId !== request.id || !Number.isSafeInteger(data.id) ||
        (data.url !== buildURL("Create", false) && data.url !== buildURL("GenerateIT", true)) ||
        typeof data.body !== "string" || data.body.length > 64 * 1024 || request.fetching ||
        request.networkRequests >= 2 ||
        data.url !== buildURL(request.networkRequests === 0 ? "Create" : "GenerateIT", request.networkRequests !== 0)) {
      closeWorker(worker, new Error("YouTube proof request was invalid"));
      return;
    }
    request.networkRequests += 1;
    request.fetching = true;
    void (async () => {
      const response = await waitForSignal(fetchImpl(data.url as string, {
        method: "POST",
        headers: getHeaders(),
        body: data.body as string,
        signal: request.signal,
      }), request.signal);
      let body: string;
      if (data.url === buildURL("GenerateIT", true)) {
        const integrity = await readYoutubeIntegrityResponse(response, request.signal);
        body = JSON.stringify([integrity.integrityToken, integrity.estimatedTtlSecs, integrity.mintRefreshThreshold, integrity.websafeFallbackToken]);
      } else {
        body = await readProofResponseBody(response, MAX_CHALLENGE_RESPONSE_BYTES, request.signal);
      }
      request.fetching = false;
      if (worker.request === request && !request.signal.aborted) child.stdin!.write(JSON.stringify({ type: "fetch-result", id: data.id, bodyBase64: Buffer.from(body).toString("base64") }) + "\n", (error) => {
        if (error && worker.request === request) closeWorker(worker, new Error("YouTube proof evaluator could not receive input"));
      });
    })().catch((error: unknown) => {
      if (worker.request === request) closeWorker(worker, error);
    });
  };
  let output = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    output += chunk;
    if (Buffer.byteLength(output) > 128 * 1024) {
      closeWorker(worker, new Error("YouTube proof response was oversized"));
      return;
    }
    for (;;) {
      const newline = output.indexOf("\n");
      if (newline < 0) break;
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      try { handleMessage(JSON.parse(line)); }
      catch { closeWorker(worker, new Error("YouTube proof response was invalid")); }
    }
  });
  child.stdin!.on("error", () => closeWorker(worker, new Error("YouTube proof evaluator could not receive input")));
  return worker;
}

export async function youtubeContentProofToken(videoId: string, fetchImpl: typeof fetch, callerSignal?: AbortSignal): Promise<string> {
  if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) throw new Error("YouTube proof content binding was invalid");
  const timeout = AbortSignal.timeout(PROOF_OPERATION_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  return serialized(() => {
    signal.throwIfAborted();
    const worker = proofWorker(fetchImpl);
    return new Promise<string>((resolve, reject) => {
      const id = ++nextRequest;
      const onAbort = () => closeWorker(worker, signal.reason);
      const finish = (operation: () => void) => {
        signal.removeEventListener("abort", onAbort);
        worker.request = undefined;
        if (worker.expiresAt <= Date.now()) closeWorker(worker, new Error("YouTube proof session expired"));
        operation();
      };
      worker.request = { id, signal, networkRequests: 0, fetching: false, resolve: (token) => finish(() => resolve(token)), reject: (error) => finish(() => reject(error)) };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        worker.child.stdin!.write(JSON.stringify({ type: "mint", id, videoId }) + "\n", (error) => {
          if (error && worker.request?.id === id) closeWorker(worker, new Error("YouTube proof evaluator could not receive input"));
        });
      } catch {
        closeWorker(worker, new Error("YouTube proof evaluator could not receive input"));
      }
    });
  }, signal);
}
