import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const nginx = fs.readFileSync(
  path.join(root, "platform/edge/nginx/ai-pin-revival-connectivity.conf"),
  "utf8",
);
const installer = fs.readFileSync(
  path.join(root, "platform/edge/install-connectivity.sh"),
  "utf8",
);
const canary = fs.readFileSync(
  path.join(root, "platform/deploy/vps/remote/canary.sh"),
  "utf8",
);

const exactHosts = [
  "connectivity-check.cosmos.humane.cloud",
  "n.cosmos.humane.cloud",
];

test("connectivity edge is scoped to the two exact stock authorities", () => {
  const match = nginx.match(/server_name\s+([^;]+);/);
  assert.ok(match, "connectivity server_name is required");
  assert.deepEqual(match[1].trim().split(/\s+/).sort(), [...exactHosts].sort());
  assert.doesNotMatch(nginx, /server_name[^;]*\*/);
  assert.doesNotMatch(nginx, /\.andersmadsen\.dk/);
});

test("connectivity edge exposes only the root 204 contract", () => {
  assert.match(nginx, /location\s*=\s*\/\s*\{[\s\S]*?\$request_method\s*=\s*GET\)\s*\{\s*return\s+204;/);
  assert.match(nginx, /location\s*=\s*\/\s*\{[\s\S]*?\$request_method\s*=\s*HEAD\)\s*\{\s*return\s+204;/);
  assert.match(nginx, /location\s*=\s*\/\s*\{[\s\S]*?return\s+405;[\s\S]*?\}/);
  assert.match(nginx, /location\s+\/\s*\{\s*return\s+404;\s*\}/);
  assert.doesNotMatch(nginx, /return\s+30[123578]/);
  assert.doesNotMatch(nginx, /proxy_pass|fastcgi_pass|grpc_pass/);
});

test("install and post-deploy canaries exercise both hosts, methods, and paths", () => {
  for (const script of [installer, canary]) {
    for (const host of exactHosts) assert.match(script, new RegExp(host.replaceAll(".", "\\.")));
    assert.match(script, /204/);
    assert.match(script, /-I/);
    assert.match(script, /-X POST/);
    assert.match(script, /405/);
    assert.match(script, /not-a-connectivity-check/);
    assert.match(script, /404/);
  }
});
