import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const productionPath = path.join(root, "platform/compose/production.yaml");
const edgePath = path.join(
  root,
  "platform/edge/nginx/ai-pin-revival-center.conf.template",
);
const streamPath = path.join(
  root,
  "platform/edge/nginx/ai-pin-revival-device-edge.stream.conf.template",
);
const envoyPath = path.join(root, "platform/edge/envoy/envoy.yaml.tpl");
const production = fs.readFileSync(productionPath, "utf8");
const edge = fs.readFileSync(edgePath, "utf8");
const stream = fs.readFileSync(streamPath, "utf8");
const envoy = fs.readFileSync(envoyPath, "utf8");
const auth = fs.readFileSync(path.join(root, "center/src/server/auth.ts"), "utf8");
const loginStart = fs.readFileSync(
  path.join(root, "center/src/app/api/auth/login/start/route.ts"),
  "utf8",
);
const callback = fs.readFileSync(
  path.join(root, "center/src/app/api/auth/callback/humane/route.ts"),
  "utf8",
);
const logout = fs.readFileSync(
  path.join(root, "center/src/app/api/auth/logout/route.ts"),
  "utf8",
);
const canary = fs.readFileSync(
  path.join(root, "platform/deploy/vps/remote/canary.sh"),
  "utf8",
);

const canonicalOrigin = "https://center.andersmadsen.dk";
const canonicalIssuer = `${canonicalOrigin}/realms/humane`;
const legacyOrigin = "https://cosmos.andersmadsen.dk";
const deviceAuthorities = [
  "api.cosmos.humane.cloud",
  "onboarding.cosmos.humane.cloud",
  "connectivity-check.cosmos.humane.cloud",
  "n.cosmos.humane.cloud",
  "cosmos-api.andersmadsen.dk",
  "aipin.andersmadsen.dk",
];

function composeEnvironment() {
  const env = {
    ...process.env,
    REVIVAL_RELEASE_ID: "center-domain-contract",
    COSMOS_DATABASE_URL: "postgresql://cosmos:placeholder@postgres/cosmos",
    COSMOS_EDGE_TOKEN: "placeholder-edge",
    COSMOS_ADMIN_TOKEN: "placeholder-admin",
    COSMOS_CENTER_PROJECTION_TOKEN: "placeholder-projection",
    COSMOS_CAPTURE_UPLOAD_BASE_URL: "https://uploads.example.test",
    COSMOS_ONBOARDING_ENDPOINT: "https://onboarding.example.test",
    COSMOS_ENROLLMENT_PINCODE: "0000",
    COSMOS_ENROLLMENT_USER_ID: "U:center-domain-contract",
    COSMOS_OPAQUE_SEED: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    AUTH_SESSION_SECRET: "placeholder-session",
    COSMOS_SHARE_TOKEN_SECRET: "placeholder-share",
    KEYCLOAK_CLIENT_SECRET: "placeholder-keycloak",
    COSMOS_KEYCLOAK_DB_PASSWORD: "placeholder-keycloak-db",
    COSMOS_PG_PASSWORD: "placeholder-postgres",
    GRAFANA_ADMIN_PASSWORD: "placeholder-grafana",
    SEARXNG_SECRET: "placeholder-search-secret",
    REVIVAL_PIN_BRIDGE_OWNER_SUB: "owner-center-domain-contract",
    REVIVAL_PIN_BRIDGE_DEVICE_ID: "device-center-domain-contract",
  };
  for (const name of [
    "REVIVAL_PUBLIC_ORIGIN",
    "COSMOS_OIDC_ISSUER",
    "COSMOS_CAPTURE_SHARE_BASE_URL",
  ]) {
    delete env[name];
  }
  return env;
}

test("production defaults make Center the single dashboard and identity origin", (context) => {
  const available = spawnSync("docker", ["compose", "version"], {
    cwd: root,
    encoding: "utf8",
  });
  if (available.error?.code === "ENOENT") {
    context.skip("Docker Compose is unavailable");
    return;
  }
  assert.equal(available.status, 0, available.stderr);

  const result = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      "compose.yaml",
      "-f",
      "platform/compose/production.yaml",
      "config",
      "--format",
      "json",
    ],
    { cwd: root, encoding: "utf8", env: composeEnvironment() },
  );
  assert.equal(result.status, 0, result.stderr);
  const model = JSON.parse(result.stdout);

  for (const workload of [
    "ai-bus",
    "account",
    "contacts",
    "feature-flags",
    "notable-events",
    "provisioning",
  ]) {
    assert.equal(model.services[workload].environment.COSMOS_OIDC_ISSUER, canonicalIssuer);
  }
  assert.equal(
    model.services["ai-bus"].environment.COSMOS_CAPTURE_SHARE_BASE_URL,
    canonicalOrigin,
  );
  assert.equal(model.services.keycloak.environment.KC_HOSTNAME, canonicalOrigin);
  assert.doesNotMatch(JSON.stringify(model), new RegExp(legacyOrigin.replaceAll(".", "\\.")));
});

test("legacy Cosmos is only a method-preserving temporary redirect", () => {
  const legacyServers = [...edge.matchAll(
    /server\s*\{(?:(?!\n\}).)*?server_name\s+cosmos\.andersmadsen\.dk;(?:(?!\n\}).)*?\n\}/gs,
  )].map((match) => match[0]);
  assert.equal(legacyServers.length, 2, "HTTP and HTTPS legacy vhosts are required");
  for (const block of legacyServers) {
    assert.match(block, /return 307 https:\/\/center\.andersmadsen\.dk\$request_uri;/);
    assert.doesNotMatch(block, /proxy_pass|return 30[128]/);
  }
  assert.equal((edge.match(/return 307 /g) ?? []).length, 2);
  assert.equal((edge.match(/return 308 /g) ?? []).length, 1);
  assert.doesNotMatch(edge, /return 30[12] /);
});

test("canonical Center edge pins forwarding, TLS, and identity routes", () => {
  assert.match(edge, /server_name center\.andersmadsen\.dk;[\s\S]*return 308 https:\/\/center\.andersmadsen\.dk\$request_uri;/);
  assert.match(edge, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
  assert.match(edge, /ssl_session_tickets off;/);
  assert.match(edge, /Strict-Transport-Security "max-age=31536000" always;/);
  assert.doesNotMatch(edge, /includeSubDomains|preload/i);
  // Keycloak is reachable only through the identity routes asserted below, so
  // no /admin path can reach its console. Center's OWN operator console lives
  // at /admin behind an operator session, so the edge must NOT blanket-404 it.
  assert.doesNotMatch(edge, /location = \/admin \{ return 404; \}/);
  assert.doesNotMatch(edge, /location \^~ \/admin\/ \{ return 404; \}/);
  // The assistant turn is streamed; buffering it defeats the whole surface.
  assert.match(
    edge,
    /location = \/api\/assistant\/stream \{[\s\S]*?proxy_buffering off;[\s\S]*?proxy_pass http:\/\/ai_pin_revival_center;/,
  );
  assert.match(edge, /location = \/realms\/humane \{[\s\S]*?proxy_pass http:\/\/ai_pin_revival_keycloak;/);
  assert.match(edge, /location \^~ \/realms\/humane\/ \{[\s\S]*?proxy_pass http:\/\/ai_pin_revival_keycloak;/);
  assert.match(edge, /location \^~ \/realms\/ \{ return 404; \}/);
  assert.match(edge, /location \^~ \/resources\/ \{[\s\S]*?proxy_pass http:\/\/ai_pin_revival_keycloak;/);
  assert.match(edge, /location \/ \{[\s\S]*?proxy_pass http:\/\/ai_pin_revival_center;/);
  for (const header of [
    "Host center.andersmadsen.dk",
    "X-Forwarded-Host center.andersmadsen.dk",
    "X-Forwarded-Proto https",
    "X-Forwarded-Port 443",
  ]) {
    assert.match(edge, new RegExp(`proxy_set_header ${header.replaceAll(".", "\\.")};`));
  }
  assert.deepEqual(
    [...edge.matchAll(/@@([A-Z0-9_]+)@@/g)].map((match) => match[1]).sort(),
    [
      "REVIVAL_CENTER_PORT",
      "REVIVAL_KEYCLOAK_PORT",
      "REVIVAL_LOCAL_TLS_PORT",
      "REVIVAL_LOCAL_TLS_PORT",
      "REVIVAL_PUBLIC_TLS_CERTIFICATE",
      "REVIVAL_PUBLIC_TLS_CERTIFICATE",
      "REVIVAL_PUBLIC_TLS_PRIVATE_KEY",
      "REVIVAL_PUBLIC_TLS_PRIVATE_KEY",
    ].sort(),
  );
  assert.doesNotMatch(edge, /proxy_pass http:\/\/(?!ai_pin_revival_(?:center|keycloak))[^;]+;/);
});

test("the dashboard vhost leaves the public :443 to the device edge stream", () => {
  // The Pin dials every clone gateway on 443 and Envoy must stay the only TLS
  // peer, so 443 belongs to an ssl_preread stream and this vhost terminates on
  // the loopback port that stream forwards to. Both halves are pinned here
  // because they are only safe together: a vhost that keeps the public bind
  // makes the stream unloadable and Nginx fails to bind at reload, taking every
  // vhost on the host with it — and `nginx -t` reports that configuration as OK.
  const listens = [...edge.matchAll(/(?:^|[{;])[ \t]*listen[ \t]+([^;#{}\n]+);/gm)]
    .map((match) => match[1].trim())
    .filter((directive) => !directive.startsWith("#"));
  assert.ok(listens.length > 0, "the Center vhost must declare listen directives");
  for (const directive of listens) {
    assert.doesNotMatch(
      directive,
      /(^|[^.\d])443\b/,
      `the Center vhost must not bind the public :443 (${directive})`,
    );
  }
  assert.equal(
    listens.filter((directive) => directive.startsWith("127.0.0.1:@@REVIVAL_LOCAL_TLS_PORT@@ ssl")).length,
    2,
    "both TLS server blocks must listen on the loopback port the stream forwards to",
  );
  assert.match(stream, /(?:^|[{;])[ \t]*listen[ \t]+443;/m);
  assert.match(stream, /^[ \t]*ssl_preread[ \t]+on;$/m);
  assert.doesNotMatch(
    stream,
    /^[ \t]*ssl_certificate/m,
    "a certificate in the stream would end the device's mTLS at Nginx",
  );
  assert.match(stream, /^[ \t]*proxy_pass \$ai_pin_revival_443_backend;$/m);
  assert.match(
    stream,
    /^[ \t]*access_log \/var\/log\/nginx\/ai-pin-revival-device-edge\.log ai_pin_revival_device_edge;$/m,
    "the plane that produced zero server-side lines must log every session",
  );
  assert.deepEqual(
    [...stream.matchAll(/@@([A-Z0-9_]+)@@/g)].map((match) => match[1]).sort(),
    ["REVIVAL_DEVICE_EDGE_BACKEND", "REVIVAL_LOCAL_TLS_BACKEND"],
  );
});

test("every SNI the device edge stream routes is one Envoy declares a chain for", () => {
  // A hostname the device is redirected to but the server does not serve is the
  // whole finding: the ClientHello dies at an unserved port and nothing anywhere
  // records it. render-envoy.py refuses to render when these two lists diverge;
  // this pins that the lists are in fact equal on today's source.
  const routed = [...stream.matchAll(/^[ \t]*([A-Za-z0-9._-]+)[ \t]+ai_pin_revival_device_edge;$/gm)]
    .map((match) => match[1])
    .sort();
  const declared = [
    ...new Set(
      [...envoy.matchAll(/server_names:\s*\[([^\]]*)\]/g)].flatMap((match) =>
        match[1].split(",").map((name) => name.trim().replaceAll('"', "")).filter(Boolean),
      ),
    ),
  ].sort();
  assert.ok(declared.length > 0, "Envoy must declare filter chain server names");
  assert.deepEqual(routed, declared);
});

test("dashboard cutover does not absorb device-facing authorities", () => {
  const dashboardSource = `${production}\n${edge}`;
  for (const authority of deviceAuthorities) {
    assert.doesNotMatch(
      dashboardSource,
      new RegExp(authority.replaceAll(".", "\\.")),
      `${authority} must remain outside the dashboard vhost`,
    );
  }
});

test("edge header buffers cover the sealed-token cookie budget in both directions", () => {
  // A successful login is the largest header exchange Center performs, and the
  // 4k default made every one of them a 502 while rejected credentials, which
  // set no cookies, still answered 401. The sizes are pinned to the cookie
  // constants rather than to literals so that widening the token budget in
  // auth.ts cannot silently outgrow the edge again.
  const chunkBytes = Number(auth.match(/TOKEN_COOKIE_CHUNK_BYTES = (\d+)/)?.[1]);
  const maxChunks = Number(auth.match(/TOKEN_COOKIE_MAX_CHUNKS = (\d+)/)?.[1]);
  assert.ok(Number.isInteger(chunkBytes) && Number.isInteger(maxChunks));

  const size = (value) => {
    const [, digits, unit] = value.match(/^(\d+)([km]?)$/i) ?? [];
    return Number(digits) * (unit.toLowerCase() === "k" ? 1024 : unit.toLowerCase() === "m" ? 1048576 : 1);
  };
  const directive = (name) => {
    const found = edge.match(new RegExp(`\\n\\s*${name}\\s+(?:(\\d+)\\s+)?(\\d+[kKmM]?);`));
    assert.ok(found, `${name} must be set on the Center vhost`);
    return { count: found[1] ? Number(found[1]) : 1, bytes: size(found[2]) };
  };

  // Set-Cookie: manifest + every chunk + the cleared slots + cosmos_session, plus
  // the security and cache headers Center attaches to the same reply. Nginx must
  // fit that entire block in ONE buffer.
  const responseBudget = maxChunks * (chunkBytes + 123) + 1900;
  // The browser echoes the same set as a single Cookie line on every request.
  const requestBudget = maxChunks * (chunkBytes + 16) + 600;

  const proxyBuffer = directive("proxy_buffer_size");
  const proxyBuffers = directive("proxy_buffers");
  const clientBuffers = directive("large_client_header_buffers");
  assert.ok(
    proxyBuffer.bytes >= responseBudget,
    `proxy_buffer_size ${proxyBuffer.bytes} < ${responseBudget}`,
  );
  assert.ok(proxyBuffers.bytes >= responseBudget && proxyBuffers.count >= 2);
  assert.ok(
    clientBuffers.bytes >= requestBudget && clientBuffers.count >= 2,
    `large_client_header_buffers ${clientBuffers.bytes} < ${requestBudget}`,
  );

  // Widening only the reply turns the 502 into a 400 on the next request, so the
  // origin has to accept the echo too: Node caps the whole request header block.
  const compose = fs.readFileSync(path.join(root, "compose.yaml"), "utf8");
  const nodeLimit = Number(
    compose.match(/NODE_OPTIONS:\s*--max-http-header-size=(\d+)/)?.[1],
  );
  assert.ok(nodeLimit >= requestBudget, `NODE_OPTIONS header cap ${nodeLimit} < ${requestBudget}`);
});

test("a live canary exchange proves the request half of that budget on the deployed edge", () => {
  // Everything above is regex over files. No acceptance test in this directory
  // makes a network request, and the live canary used to exercise only
  // small-header paths, so the deployed nginx, the tunnel hop and Node's own cap
  // were protected by nothing but the text comparison in this test. The canary
  // now sends a full-size Cookie line through the same origin a browser uses.
  assert.match(
    canary,
    /TOKEN_COOKIE_CHUNK_BYTES/,
    "the canary must size its probe from Center's own cookie constants, not a literal",
  );
  assert.match(canary, /TOKEN_COOKIE_MAX_CHUNKS/);
  assert.match(canary, /max_chunks\*\(chunk_bytes\+16\)\+600/);
  assert.match(
    canary,
    /large_header_status="\$\(curl[\s\S]{0,400}\$center_base\/login"\)"/,
    "the large-header probe must go to /login through $center_base",
  );
  assert.match(
    canary,
    /\[\[ "\$large_header_status" == "\$login_status" \]\]/,
    "the large request must answer exactly what the small one did",
  );
  // And it must keep saying which half is unproven rather than reading as full
  // coverage of the 502 that actually happened.
  assert.match(canary, /covers the REQUEST half only/);
  assert.doesNotMatch(canary, /Set-Cookie response budget (?:proven|verified)/i);
});

test("Center OIDC contract binds canonical callback, S256, state, nonce, and logout", () => {
  assert.match(auth, /u\.searchParams\.set\("response_type", "code"\)/);
  assert.match(auth, /u\.searchParams\.set\("redirect_uri", params\.redirectUri\)/);
  assert.match(auth, /u\.searchParams\.set\("state", params\.state\)/);
  assert.match(auth, /u\.searchParams\.set\("nonce", params\.nonce\)/);
  assert.match(auth, /u\.searchParams\.set\("code_challenge", params\.codeChallenge\)/);
  assert.match(auth, /u\.searchParams\.set\("code_challenge_method", "S256"\)/);
  assert.match(auth, /crypto\.subtle\.digest\("SHA-256", new TextEncoder\(\)\.encode\(verifier\)\)/);

  assert.match(loginStart, /const redirectUri = `\$\{origin\}\/api\/auth\/callback\/humane`/);
  for (const cookie of ["oidc_state", "oidc_nonce", "oidc_verifier", "oidc_next"]) {
    assert.match(loginStart, new RegExp(`res\\.cookies\\.set\\("${cookie}"`));
  }
  assert.match(loginStart, /httpOnly: true/);
  assert.match(loginStart, /sameSite: "lax"/);
  assert.match(loginStart, /maxAge: 600/);

  assert.match(callback, /state !== expectedState/);
  assert.match(callback, /codeVerifier: verifier/);
  assert.match(callback, /expectedNonce: nonce/);
  assert.match(callback, /redirectUri: `\$\{origin\}\/api\/auth\/callback\/humane`/);
  assert.match(logout, /const post = `\$\{origin\}\/login`/);
  assert.match(logout, /endSessionUrl\(origin, \{ idTokenHint: tokens\?\.idToken, postLogoutRedirectUri: post \}\)/);
});

test("production canary proves unauthenticated PKCE and keeps authenticated exchange explicit", () => {
  assert.match(canary, /\/api\/auth\/login\/start\?next=%2Fwifi/);
  assert.match(canary, /\/api\/auth\/callback\/humane\?code=untrusted-canary&state=deliberately-wrong/);
  assert.match(canary, /\/api\/auth\/logout/);
  assert.match(canary, /hashlib\.sha256\(verifier\.encode\(\)\)\.digest\(\)/);
  assert.match(canary, /query\["code_challenge_method"\] == \["S256"\]/);
  assert.match(canary, /query\["redirect_uri"\] == \[f"\{origin\}\/api\/auth\/callback\/humane"\]/);
  assert.match(canary, /authenticated OIDC code exchange remains unknown/);
  assert.doesNotMatch(canary, /OIDC code exchange (?:passed|verified|succeeded)/i);
});
