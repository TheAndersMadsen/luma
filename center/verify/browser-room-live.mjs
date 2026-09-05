// Interactive, localhost-only browser acceptance for the real SDK adapter.
// Usage: Node 22 browser-room-live.mjs ISOLATED_SFU_JSON VERIFIED_WEBRTC_DIRECTORY
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { rolldown } from "rolldown";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const { cosmosTestEnvironment } = require("../../platform/cli/context.js");
const [input, nativeDirectory] = process.argv.slice(2);
if (!input || !nativeDirectory) throw new Error("Supply the isolated SFU JSON and verified native library directory");
const configured = JSON.parse(fs.readFileSync(input, "utf8"));
if (!/^ws:\/\/127\.0\.0\.1:[0-9]+(?:\/livekit)?$/u.test(configured.url)) throw new Error("Only an isolated loopback SFU is permitted");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "revival-browser-room-"));
const bootstrap = path.join(directory, "bootstrap.json");
const output = path.join(directory, "browser-room.js");
const bundle = await rolldown({ input: path.join(root, "center/src/lib/browserRoom.ts"), platform: "browser",
  transform: { define: { "process.env.NODE_ENV": '"production"' } } });
await bundle.write({ file: output, format: "esm" }); await bundle.close();
let child;
const html = `<!doctype html><meta charset="utf-8"><title>Room adapter acceptance</title>
<h1>Browser ↔ native room transport</h1><p id="status">Waiting for native fixture…</p>
<script type="module">
import { createBrowserRoom } from '/browser-room.js';
const state = document.querySelector('#status');
let input = false, frame = false;
let admit;
const admission = new Promise(resolve => { admit = resolve; });
try {
  let response;
  for (let i = 0; i < 120; i++) { response = await fetch('/bootstrap'); if (response.ok) break; await new Promise(r => setTimeout(r, 500)); }
  if (!response.ok) throw Error('native fixture unavailable');
  const room = createBrowserRoom();
  await room.connect(await response.json(), async payload => {
    if (payload !== 'synthetic native frame') throw Error('wrong frame');
    frame = true; state.textContent = 'Native frame received by browser.';
    await admission;
    return 'browser receipt';
  }, () => { state.textContent = input && frame ? 'PASS: attributed RPC in both directions; native disconnect fenced the browser.' : 'FAIL: connection lost before roundtrip'; });
  state.textContent = 'Connected; sending synthetic request…';
  input = await room.invoke('synthetic browser input') === 'native admission';
  if (!input) throw Error('wrong admission');
  admit();
} catch (error) { state.textContent = 'FAIL: browser adapter did not complete the transport check (code ' + (Number.isInteger(error?.code) ? error.code : 'unknown') + ')'; }
</script>`;
const server = http.createServer((request, response) => {
  response.setHeader("cache-control", "no-store"); response.setHeader("x-content-type-options", "nosniff");
  if (request.url === "/") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); }
  else if (request.url === "/browser-room.js") { response.setHeader("content-type", "text/javascript"); fs.createReadStream(output).pipe(response); }
  else if (request.url === "/bootstrap" && fs.existsSync(bootstrap)) {
    response.setHeader("content-type", "application/json"); fs.createReadStream(bootstrap).pipe(response);
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const log = fs.openSync(path.join(directory, "native.log"), "w", 0o600);
child = spawn("cargo", ["test", "--locked", "-p", "cosmos-rtc", "browser_adapter_native_roundtrip", "--", "--ignored", "--nocapture"], {
  cwd: path.join(root, "cosmos"), env: { ...cosmosTestEnvironment(), LK_CUSTOM_WEBRTC: path.resolve(nativeDirectory),
    COSMOS_RTC_BROWSER_TEST_INPUT: path.resolve(input), COSMOS_RTC_BROWSER_TEST_OUTPUT: bootstrap }, stdio: ["ignore", log, log],
});
fs.closeSync(log);
child.on("exit", code => { process.stdout.write(`Native fixture ${code === 0 ? "passed" : "failed"}; inspect the browser for its disconnect result.\n`); });
process.stdout.write(`Browser acceptance: http://127.0.0.1:${server.address().port}\n`);
const stop = () => { child.kill("SIGTERM"); server.close(); fs.rmSync(directory, { recursive: true, force: true }); process.exit(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
