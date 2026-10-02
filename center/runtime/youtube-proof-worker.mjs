// INFERRED: disposable process for the existing bgutils-js attestation flow.
// The parent brokers bounded public requests and terminates this process on
// cancellation/deadline. JSDOM is a browser emulation, not a security sandbox.
import { BotGuardClient, getChallenge } from "bgutils-js/botguard";
import { buildURL, USER_AGENT } from "bgutils-js/utils";
import { JSDOM, VirtualConsole } from "jsdom";

const PUBLIC_REQUEST_KEY = "O43z0dpjhgX20SCx4KAo"; // Public identifier. gitleaks:allow
let session = null;
let operationId = null;
let nextFetch = 0;
const pendingFetches = new Map();

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n", (error) => { if (error) process.exit(1); });
}

function brokeredFetch(input, init) {
  return new Promise((resolve, reject) => {
    const id = ++nextFetch;
    pendingFetches.set(id, { resolve, reject });
    send({ type: "fetch", operationId, id, url: String(input), body: init?.body });
  });
}

async function proofSession() {
  if (session?.expiresAt > Date.now()) return session;
  session?.dom.window.close();
  session = null;
  const challenge = await getChallenge({ fetchFunction: brokeredFetch, requestKey: PUBLIC_REQUEST_KEY });
  const interpreter = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (typeof interpreter !== "string" || !interpreter || Buffer.byteLength(interpreter) > 4 * 1024 * 1024) throw new Error();
  const dom = new JSDOM("<!DOCTYPE html><html lang=\"en\"><head><title></title></head><body></body></html>", {
    url: "https://www.youtube.com/", referrer: "https://www.youtube.com/", runScripts: "outside-only",
    // stdout is the framed parent protocol, never the browser's console.
    virtualConsole: new VirtualConsole(),
  });
  try {
    Object.defineProperty(dom.window.navigator, "userAgent", { configurable: true, value: USER_AGENT });
    dom.window.eval(interpreter);
    const botGuard = await BotGuardClient.create({ program: challenge.program, globalName: challenge.globalName, globalObject: dom.window });
    const webPoSignalOutput = [];
    const snapshot = await botGuard.snapshot({ webPoSignalOutput });
    if (typeof snapshot !== "string" || snapshot.length > 32 * 1024) throw new Error();
    const integrity = await (await brokeredFetch(buildURL("GenerateIT", true), {
      body: JSON.stringify([PUBLIC_REQUEST_KEY, snapshot]),
    })).json();
    const factory = webPoSignalOutput[0];
    if (typeof factory !== "function") throw new Error();
    const mint = await factory(new Uint8Array(Buffer.from(integrity[0], "base64")));
    if (typeof mint !== "function") throw new Error();
    // At/past the refresh threshold, mint this request without caching a
    // session whose safe lifetime has already expired.
    const lifetime = Math.max(0, Math.min(300, integrity[1] - integrity[2]));
    session = { dom, mint, expiresAt: Date.now() + lifetime * 1000 };
    return session;
  } catch (error) {
    dom.window.close();
    throw error;
  }
}

async function handleMessage(message) {
  if (message?.type === "fetch-result") {
    const pending = pendingFetches.get(message.id);
    if (!pending || typeof message.bodyBase64 !== "string" || message.bodyBase64.length > 12 * 1024 * 1024) process.exit(1);
    pendingFetches.delete(message.id);
    pending.resolve(new Response(Buffer.from(message.bodyBase64, "base64")));
    return;
  }
  if (message?.type !== "mint" || operationId !== null || !Number.isSafeInteger(message.id) ||
      typeof message.videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/u.test(message.videoId)) process.exit(1);
  operationId = message.id;
  try {
    const current = await proofSession();
    const result = await current.mint(new TextEncoder().encode(message.videoId));
    if (!ArrayBuffer.isView(result) || result.byteLength < 60 || result.byteLength > 384) throw new Error();
    const token = Buffer.from(result.buffer, result.byteOffset, result.byteLength).toString("base64url");
    if (token.length < 80 || token.length > 512) throw new Error();
    send({ type: "result", id: operationId, token });
  } catch {
    send({ type: "error", id: operationId });
  } finally {
    operationId = null;
  }
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 12 * 1024 * 1024 + 1024) process.exit(1);
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    try { void handleMessage(JSON.parse(line)).catch(() => process.exit(1)); }
    catch { process.exit(1); }
  }
});
process.stdin.on("end", () => process.exit(0));
