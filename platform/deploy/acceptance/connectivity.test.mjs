import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const nginx = fs.readFileSync(
  path.join(root, "platform/edge/nginx/ai-pin-revival-connectivity.conf"),
  "utf8",
);
const installer = fs.readFileSync(
  path.join(root, "platform/edge/install-connectivity.sh"),
  "utf8",
);
const hosts = [
  "connectivity-check.cosmos.humane.cloud",
  "n.cosmos.humane.cloud",
];

test("the Cosmos connectivity edge exposes only its two health authorities", () => {
  const match = nginx.match(/server_name\s+([^;]+);/);
  assert.ok(match);
  assert.deepEqual(match[1].trim().split(/\s+/).sort(), [...hosts].sort());
  assert.match(nginx, /\$request_method = GET\)\s+\{ return 204; \}/);
  assert.match(nginx, /\$request_method = HEAD\) \{ return 204; \}/);
  assert.match(nginx, /return 405;/);
  assert.match(nginx, /location \/ \{ return 404; \}/);
  assert.doesNotMatch(nginx, /proxy_pass|fastcgi_pass|grpc_pass/);
});

test("the direct installer validates Nginx and probes both authorities", () => {
  assert.match(installer, /nginx -t/);
  assert.match(installer, /systemctl (?:start|reload) nginx/);
  for (const host of hosts) {
    assert.match(installer, new RegExp(host.replaceAll(".", "\\.")));
  }
});
