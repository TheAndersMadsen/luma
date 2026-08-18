import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * platform/edge/render-envoy.py, executed.
 *
 * The renderer carries the ONE build-time guard standing where the audit's HIGH
 * finding lives: the device dials every clone gateway at <host>:443, and a name
 * the :443 stream does not route to the mTLS edge is not a 404 — the ClientHello
 * dies before a request line exists, so nginx, Envoy and Cosmos all write
 * nothing. That is how api.cosmos.humane.cloud went unserved indefinitely. The
 * runtime probe for it was explicitly NOT implemented; assert_edge_reachable is
 * its stated substitute ("the strongest source-level substitute available").
 *
 * Nothing executed render-envoy.py. It is invoked from exactly one line of
 * remote/deploy.sh, which needs a VPS, so replacing `if declared != routed:`
 * with `if False:` produced a failure set identical to pristine across the whole
 * acceptance suite. center-domain-contract.test.mjs compares the two lists on
 * today's source, which catches a divergence in the DATA and says nothing about
 * the removal of the guard that enforces it — the two are different assertions
 * and this file is the second one.
 *
 * Every case below runs the real script. Fixtures are synthetic so the negative
 * cases can exist at all (the shipped pair agrees, by design), and the last test
 * runs the shipped pair so the fixtures cannot drift into testing a shape the
 * production templates no longer have.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const renderer = path.join(root, "platform/edge/render-envoy.py");
const streamTemplateName = "ai-pin-revival-device-edge.stream.conf.template";
const edgeUpstream = "ai_pin_revival_device_edge";
// 40-160 characters of [A-Za-z0-9_-], per TOKEN_PATTERN in the renderer.
const token = "e".repeat(48);

function temporaryDirectory(context, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `revival-${name}-`));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/*
 * An Envoy template that satisfies every check the SNI guard is not.
 *
 * The renderer refuses a template that does not contain exactly two
 * `@@EDGE_TOKEN@@` placeholders, a `@@CERT_DIR@@`, and exactly three
 * `access_log:` keys ("a silent edge is not deployable"). Those are independent
 * preconditions, checked BEFORE the SNI comparison — a fixture that misses one
 * would fail for the wrong reason and prove nothing about the guard under test.
 * So the shape here mirrors production exactly: one listener log and two
 * http_connection_manager chains, each with its own log and proof-token header.
 */
function envoyTemplate(serverNameGroups) {
  assert.equal(serverNameGroups.length, 2, "the fixture must contain production's two filter chains");
  const chains = serverNameGroups
    .map((names) => [
      "    - filter_chain_match:",
      `        server_names: [${names.map((name) => `"${name}"`).join(", ")}]`,
      "      filters:",
      "      - name: envoy.filters.network.http_connection_manager",
      "        typed_config:",
      "          access_log:",
      "          - name: envoy.access_loggers.stdout",
      "          route_config:",
      "            request_headers_to_add:",
      "            - header: { key: x-cosmos-edge-proof, value: @@EDGE_TOKEN@@ }",
    ].join("\n"))
    .join("\n");
  return [
    "static_resources:",
    "  listeners:",
    "  - name: device-edge",
    "    access_log:",
    "    - name: envoy.access_loggers.stdout",
    "    transport_socket:",
    "      common_tls_context:",
    "        tls_certificates:",
    "        - certificate_chain: { filename: @@CERT_DIR@@/server.crt }",
    "    filter_chains:",
    chains,
    "",
  ].join("\n");
}

/** A stream template whose SNI map hands `routed` to the mTLS edge. */
function streamTemplate(routed, { includeMap = true } = {}) {
  if (!includeMap) return "# no map here\nserver {\n    listen 443;\n}\n";
  return [
    "map $ssl_preread_server_name $ai_pin_revival_443_backend {",
    "    hostnames;",
    "",
    "    default                          ai_pin_revival_local_tls;",
    "",
    ...routed.map((name) => `    ${name}      ${edgeUpstream};`),
    "}",
    "",
    "server {",
    "    listen 443;",
    "    ssl_preread on;",
    "    proxy_pass $ai_pin_revival_443_backend;",
    "}",
  ].join("\n");
}

function fixture(context, name, { served, routed, includeMap = true, writeStream = true }) {
  const work = temporaryDirectory(context, name);
  const envoyDirectory = path.join(work, "edge/envoy");
  const nginxDirectory = path.join(work, "edge/nginx");
  fs.mkdirSync(envoyDirectory, { recursive: true });
  fs.mkdirSync(nginxDirectory, { recursive: true });
  const template = path.join(envoyDirectory, "envoy.yaml.tpl");
  fs.writeFileSync(template, envoyTemplate(served));
  if (writeStream) fs.writeFileSync(path.join(nginxDirectory, streamTemplateName), streamTemplate(routed, { includeMap }));
  const environment = path.join(work, "protected.env");
  fs.writeFileSync(environment, `COSMOS_EDGE_TOKEN=${token}\n`, { mode: 0o600 });
  return { work, template, environment, output: path.join(work, "rendered/envoy.yaml") };
}

function render({ template, environment, output }) {
  return spawnSync("python3", [renderer, "--template", template, "--env", environment, "--output", output], {
    encoding: "utf8",
  });
}

test("[implemented] the renderer accepts an Envoy edge the public :443 stream fully routes", (context) => {
  const served = [["onboarding.cosmos.humane.cloud", "cosmos-edge"], ["api.cosmos.humane.cloud"]];
  const routed = ["onboarding.cosmos.humane.cloud", "cosmos-edge", "api.cosmos.humane.cloud"];
  const prepared = fixture(context, "edge-render-agree", { served, routed });
  const result = render(prepared);
  assert.equal(result.status, 0, `renderer refused an agreeing pair: ${result.stderr}`);

  // The rendered file is the point of the command, so prove it landed with the
  // token substituted and 0600 — a guard that passes and writes nothing, or
  // writes the proof token world-readable, is not a working renderer.
  const rendered = fs.readFileSync(prepared.output, "utf8");
  assert.doesNotMatch(rendered, /@@EDGE_TOKEN@@|@@CERT_DIR@@/u, "placeholders must be substituted, not carried through");
  assert.ok(rendered.includes(token), "the proof token must reach the rendered configuration");
  assert.equal(fs.statSync(prepared.output).mode & 0o777, 0o600);
});

test("[implemented] the renderer refuses an SNI Envoy serves that :443 does not route", (context) => {
  /*
   * The failure the whole guard exists for, in the direction that produced the
   * outage: Envoy declares a filter chain for a gateway the device is redirected
   * to, and the public :443 stream hands that name to the local TLS backend
   * instead of the mTLS edge. Nothing refuses the connection and nothing logs a
   * request, because no request is ever framed.
   */
  const prepared = fixture(context, "edge-render-unrouted", {
    served: [["onboarding.cosmos.humane.cloud"], ["api.cosmos.humane.cloud", "eastus.cosmos.humane.cloud"]],
    routed: ["onboarding.cosmos.humane.cloud", "api.cosmos.humane.cloud"],
  });
  const result = render(prepared);
  assert.notEqual(result.status, 0, "an unrouted filter chain must not render");
  assert.match(result.stderr, /Envoy serves but :443 does not route: eastus\.cosmos\.humane\.cloud/u);
  assert.equal(fs.existsSync(prepared.output), false, "a refused render must not leave a configuration behind");
});

test("[implemented] the renderer refuses an SNI :443 routes that Envoy does not serve", (context) => {
  // The other direction: the stream hands a name to the mTLS edge for which
  // Envoy has no filter chain, so the device reaches Envoy and is dropped during
  // the handshake — the same zero-evidence symptom, one hop later.
  const prepared = fixture(context, "edge-render-unserved", {
    served: [["onboarding.cosmos.humane.cloud"], ["api.cosmos.humane.cloud"]],
    routed: ["onboarding.cosmos.humane.cloud", "api.cosmos.humane.cloud", "eastus-1.cosmos.humane.cloud"],
  });
  const result = render(prepared);
  assert.notEqual(result.status, 0, "an unserved routed name must not render");
  assert.match(result.stderr, /:443 routes but Envoy does not serve: eastus-1\.cosmos\.humane\.cloud/u);
  assert.equal(fs.existsSync(prepared.output), false);
});

test("[implemented] an SNI mapped to the local backend does not count as routed to the edge", (context) => {
  /*
   * `default ai_pin_revival_local_tls;` and any explicit entry pointing at the
   * local TLS backend are the stream's way of saying "serve this here". A
   * comparison that read every map entry as an edge route would accept exactly
   * the configuration this guard exists to refuse: the device's own gateway
   * quietly terminated at Center's vhost instead of at Envoy.
   */
  const work = temporaryDirectory(context, "edge-render-local");
  fs.mkdirSync(path.join(work, "edge/envoy"), { recursive: true });
  fs.mkdirSync(path.join(work, "edge/nginx"), { recursive: true });
  const template = path.join(work, "edge/envoy/envoy.yaml.tpl");
  fs.writeFileSync(template, envoyTemplate([["onboarding.cosmos.humane.cloud"], ["api.cosmos.humane.cloud"]]));
  fs.writeFileSync(
    path.join(work, "edge/nginx", streamTemplateName),
    [
      "map $ssl_preread_server_name $ai_pin_revival_443_backend {",
      "    hostnames;",
      "",
      "    default                          ai_pin_revival_local_tls;",
      "",
      "    onboarding.cosmos.humane.cloud    ai_pin_revival_device_edge;",
      "    api.cosmos.humane.cloud           ai_pin_revival_local_tls;",
      "}",
    ].join("\n"),
  );
  const environment = path.join(work, "protected.env");
  fs.writeFileSync(environment, `COSMOS_EDGE_TOKEN=${token}\n`, { mode: 0o600 });
  const result = render({ template, environment, output: path.join(work, "rendered/envoy.yaml") });
  assert.notEqual(result.status, 0, "a gateway parked on the local TLS backend is not routed to the edge");
  assert.match(result.stderr, /Envoy serves but :443 does not route: api\.cosmos\.humane\.cloud/u);
});

test("[implemented] the renderer refuses when the stream template is absent or has no SNI map", (context) => {
  // Both are the guard failing OPEN if it were written the obvious way: a
  // missing file or a map that was renamed would otherwise yield an empty routed
  // set, which compares unequal and happens to fail — or, if the comparison were
  // ever relaxed, compares as "nothing to check" and passes.
  const missing = fixture(context, "edge-render-missing", {
    served: [["onboarding.cosmos.humane.cloud"], ["api.cosmos.humane.cloud"]],
    routed: [],
    writeStream: false,
  });
  const absent = render(missing);
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /device edge stream template is missing or unsafe/u);

  const unmapped = fixture(context, "edge-render-unmapped", {
    served: [["onboarding.cosmos.humane.cloud"], ["api.cosmos.humane.cloud"]],
    routed: [],
    includeMap: false,
  });
  const noMap = render(unmapped);
  assert.notEqual(noMap.status, 0);
  assert.match(noMap.stderr, /device edge stream template has no SNI map/u);
});

test("[implemented] an edge that names no SNI at all is refused rather than compared as equal", (context) => {
  /*
   * The one way the comparison itself fails OPEN.
   *
   * `declared != routed` is an equality between two sets, and two EMPTY sets are
   * equal. An Envoy template whose filter chains contain `server_names: []`, paired
   * with a stream map that hands nothing to the mTLS edge, therefore satisfies the
   * guard while serving and routing precisely nothing — the device plane dark, and
   * a renderer that reported success. Every other precondition in main() is still
   * met by that shape: the chains are still there, so the two `@@EDGE_TOKEN@@`
   * placeholders and the three `access_log:` keys all still count.
   *
   * `if not names: raise SystemExit(...)` in envoy_server_names is what closes it,
   * and removing that line left all six tests above green — the equality does the
   * catching in every case where ONE side is empty, and only this case reaches the
   * line itself. Asserted here from the empty side that is actually authored by
   * hand: an operator editing chains out of the template one at a time.
   */
  const prepared = fixture(context, "edge-render-nameless", { served: [[], []], routed: [] });
  const result = render(prepared);
  assert.notEqual(result.status, 0, "an edge declaring no SNI must not render, however the stream is mapped");
  assert.match(result.stderr, /Envoy template declares no filter chain server names/u);
  assert.equal(fs.existsSync(prepared.output), false, "a refused render must not leave a configuration behind");
});

test("[implemented] the shipped Envoy and :443 stream templates agree, proven by rendering them", (context) => {
  /*
   * The fixtures above prove the guard works. This proves the guard is satisfied
   * by the templates that actually deploy — and it runs the same code path
   * deploy.sh runs, so a template edit that breaks the pair fails here instead of
   * at the one moment nobody can afford it.
   */
  const work = temporaryDirectory(context, "edge-render-shipped");
  const environment = path.join(work, "protected.env");
  fs.writeFileSync(environment, `COSMOS_EDGE_TOKEN=${token}\n`, { mode: 0o600 });
  const result = render({
    template: path.join(root, "platform/edge/envoy/envoy.yaml.tpl"),
    environment,
    output: path.join(work, "rendered/envoy.yaml"),
  });
  assert.equal(result.status, 0, `the shipped edge templates no longer render: ${result.stderr}`);
  const rendered = fs.readFileSync(path.join(work, "rendered/envoy.yaml"), "utf8");
  assert.doesNotMatch(rendered, /@@[A-Z_]+@@/u, "the shipped template left an unsubstituted placeholder");
});
