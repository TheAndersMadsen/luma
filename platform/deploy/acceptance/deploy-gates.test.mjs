import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { at } from "./source-offsets.mjs";

/*
 * The gates themselves, gated.
 *
 * Three separate 100%-production outages shipped green through canary.sh,
 * staging-smoke.sh and preflight.sh in one week, and every one of them was the
 * same mistake: a check that looked like coverage and was not. A canary that
 * never asked Center for wearer data. A staging pass whose only `live` assertion
 * ran under an identity production never has. A preflight that proved five PKI
 * files parse without ever asking whether they belong to each other.
 *
 * These assertions are about the SHAPE of the gates. They cannot run the gates —
 * those need a VPS, a restored backup and root — so what they pin is that the
 * property each gate was strengthened to check is still being checked, and that
 * each gate still says out loud what it cannot prove. A gate that quietly stops
 * asserting something is exactly how this happened.
 *
 * FILE RULE — every POSITIVE pin here is line-anchored: `^…$` with the `m` flag,
 * matching the executable line rather than the words.
 *
 * That rule is not style. Substring pins on this file's subject matter are
 * self-defeating, because these scripts explain themselves at length: the five
 * wearer routes the canary drives are also named in the `warn` sentence emitted
 * on the branch where those routes are NOT driven, and in the comment block
 * above it. Five `canary.includes("/api/…")` assertions therefore proved the
 * data-plane loop existed while being satisfied by the sentence announcing that
 * it had not run — the whole loop was deletable with the gate still green. Same
 * for `/x-data-state/`, which a helper function's own name satisfied.
 *
 * NEGATIVE pins (`assert.doesNotMatch`) are deliberately NOT anchored: a
 * forbidden string must be caught wherever it appears, including inside a
 * comment. Anchoring one of those would narrow it into uselessness.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const remote = path.join(root, "platform/deploy/vps/remote");
const read = (name) => fs.readFileSync(path.join(remote, name), "utf8");

const canary = read("canary.sh");
const staging = read("staging-smoke.sh");
const preflight = read("preflight.sh");
const deploy = read("deploy.sh");
const common = [
  read("common.sh"),
  ...fs.readdirSync(path.join(remote, "lib")).filter((name) => name.endsWith(".sh")).sort()
    .map((name) => fs.readFileSync(path.join(remote, "lib", name), "utf8")),
].join("\n");
const domain = read("domain.sh");
const heldReleaseExec = read("held-release-exec.py");
const searchPolicy = fs.readFileSync(path.join(root, "cosmos/search/settings.yml"), "utf8");

test("every remote gate script is syntactically valid bash", () => {
  // domain.sh is in this list because it is sourced by every one of the others
  // and now carries a gate of its own (the certificate/private-key digest), so a
  // parse error in it breaks preflight, deploy, rollback, backup and canary at
  // once — at source time, before any of them reaches a check.
  for (const name of ["canary.sh", "staging-smoke.sh", "preflight.sh", "deploy.sh", "common.sh", "domain.sh",
    ...fs.readdirSync(path.join(remote, "lib")).filter((entry) => entry.endsWith(".sh")).sort().map((entry) => path.join("lib", entry))]) {
    const result = spawnSync("bash", ["-n", path.join(remote, name)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

test("staging proves SearXNG through a deterministic engine with real results", () => {
  // Anonymous general-search engines often return rate limits or CAPTCHAs from
  // a datacenter IP. That tests the VPS's reputation, not the candidate. The
  // GitHub engine is deterministic for this public project query and still
  // proves SearXNG can make an outbound request, decode it, and return results.
  assert.match(
    staging,
    /^\s*if wget -q -T 20 -O \/tmp\/search-canary\.json "http:\/\/127\.0\.0\.1:8080\/search\?q=%21github\+penumbraos&format=json"; then$/m,
  );
  assert.match(
    staging,
    /^\s*&& python -c ".*assert engines == \{\\"github\\"\}"; then$/m,
    "the deterministic SearXNG canary must prove that only GitHub answered",
  );
  assert.match(staging, /^\s*github_probe_ok=0$/m);
  assert.match(staging, /^\s*for attempt in 1 2 3; do$/m);
  assert.match(staging, /^\s*\[ "\$attempt" -ge 3 \] \|\| sleep 2$/m);
  assert.match(
    staging,
    /^\s*python -c ".*github probe failed: results=%s engines=%s unresponsive=%s.*" \|\| true$/m,
    "a failed warm-up probe must preserve bounded diagnostics in the deploy transcript",
  );
  assert.match(
    staging,
    /^\s*wget -q -T 20 -O \/tmp\/search-default\.json "http:\/\/127\.0\.0\.1:8080\/search\?q=ai\+pin\+revival\+canary&format=json&language=en"$/m,
  );
  assert.match(
    staging,
    /^\s*python -c ".*item\.get\(\\"engines\\"\).*assert engines <= \{\\"bing\\",\\"resulthunter\\",\\"searchch\\",\\"yandex\\"\}; assert \\"bing\\" in engines; assert engines & \{\\"resulthunter\\",\\"searchch\\",\\"yandex\\"\}"$/m,
    "staging must require both the primary and an independent general-search fallback",
  );
  assert.match(
    staging,
    /^\s*wget -q -T 20 -O \/tmp\/search-fallback\.json "http:\/\/127\.0\.0\.1:8080\/search\?q=%21resulthunter\+%21yandex\+%21searchch\+ai\+pin\+revival\+canary&format=json&language=en"$/m,
  );
  assert.match(
    staging,
    /^\s*python -c ".*\/tmp\/search-fallback\.json.*assert engines and engines <= \{\\"resulthunter\\",\\"searchch\\",\\"yandex\\"\}"$/m,
    "staging must prove usable general-search results with Bing excluded",
  );
});

test("production SearXNG policy disables blocked defaults and enables measured engines", () => {
  assert.match(searchPolicy, /^    keep_only:$/m);
  for (const engine of ["bing", "github", "resulthunter", "searchch", "yandex"]) {
    assert.match(searchPolicy, new RegExp(`^      - ${engine}$`, "mu"));
  }
  for (const engine of ["brave", "duckduckgo", "google cse", "seznam", "startpage", "wiby", "wikidata"]) {
    assert.doesNotMatch(searchPolicy, new RegExp(`^      - ${engine}$`, "mu"));
  }
  for (const engine of ["bing", "resulthunter", "searchch", "yandex"]) {
    assert.match(
      searchPolicy,
      new RegExp(`^  - name: ${engine}\\n    disabled: false$`, "mu"),
    );
  }
  assert.match(searchPolicy, /^  default_lang: en$/m);
  assert.doesNotMatch(searchPolicy, /^  default_lang: all$/m);
});

test("production canary rejects empty or unexpected SearXNG results", () => {
  assert.match(
    canary,
    /^  'http:\/\/searxng:8080\/search\?q=ai\+pin\+revival\+canary&format=json&language=en' >"\$work\/search\.json"$/m,
  );
  assert.match(canary, /^    assert isinstance\(results,list\) and results$/m);
  assert.match(
    canary,
    /^def attributed_engines\(results\):$/m,
  );
  assert.match(canary, /^assert "bing" in engines$/m);
  assert.match(canary, /^assert engines & \{"resulthunter","searchch","yandex"\}$/m);
  assert.match(
    canary,
    /^  'http:\/\/searxng:8080\/search\?q=%21resulthunter\+%21yandex\+%21searchch\+ai\+pin\+revival\+canary&format=json&language=en' >"\$work\/search-fallback\.json"$/m,
  );
  assert.match(canary, /^assert fallback_engines$/m);
  assert.match(canary, /^assert fallback_engines <= \{"resulthunter","searchch","yandex"\}$/m);
});

test("this file's own anchoring rule is enforced, not merely stated", () => {
  /*
   * The header declares that every positive pin is line-anchored. A rule stated
   * in a comment is exactly the kind of assurance this file exists to distrust —
   * it was true of one assertion and false of its four neighbours in the same
   * test, which is how the canary's data-plane gate stayed green over a deletable
   * request loop. So the rule checks itself.
   *
   * An unanchored `assert.match` here is a substring search over a script that
   * documents itself in prose: the sentence explaining why a check exists, the
   * warning emitted when the check is skipped, and the check itself all contain
   * the same words. Anchoring is what separates "the script mentions this" from
   * "the script does this".
   */
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  // A JavaScript regex literal: escapes and character classes respected, so a
  // `\/` inside the pattern does not end it early.
  const literal = /,\s*(\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[a-z]*)/;
  // Call sites only: match at the start of a line, so the mentions of the same
  // token inside this test's own strings and comments are not scanned.
  const calls = [...source.matchAll(/^\s*assert\.match\(/gmu)];
  const unanchored = [];
  for (const call of calls) {
    const found = literal.exec(source.slice(call.index, call.index + 800));
    assert.ok(found, `could not read the regex literal for the pin at offset ${call.index}`);
    const pattern = found[1];
    const flags = pattern.slice(pattern.lastIndexOf("/") + 1);
    if (!pattern.startsWith("/^") || !flags.includes("m")) unanchored.push(pattern);
  }
  assert.ok(calls.length >= 40, `expected this file to still contain its pins; found only ${calls.length}`);
  assert.deepEqual(
    unanchored,
    [],
    "every assert.match in this file must be line-anchored (^…$ with the m flag)",
  );
});

test("the canary reaches Center's own data plane, not only ai-bus directly", () => {
  // Before this existed, every Cosmos probe in the canary bypassed Center and
  // dialled 127.0.0.1:18086 with a synthesized x-forwarded-client-cert, and the
  // single owner-cookie request went to a route that imports nothing from
  // center/src/server/cosmos.ts. A completely degraded wearer data plane passed.
  assert.match(canary, /^\s*--require-wearer-plane\) require_wearer_plane=1; shift ;;$/m);

  // The request LOOP, not the route names. The five routes below also appear in
  // canary.sh's else-branch `warn` — the sentence emitted when the data plane is
  // deliberately not exercised — so the previous `canary.includes("/api/health")`
  // form was satisfied by the announcement that the loop had not run. Deleting
  // the loop entirely left this test green.
  assert.match(
    canary,
    /^\s*for surface in health:\/api\/health notes:\/api\/capture\/notes \\$/m,
    "the canary must issue the wearer-plane requests, not merely name the routes",
  );
  assert.match(
    canary,
    /^\s*memories:\/api\/capture\/memories features:\/api\/settings\/features wifi:\/api\/settings\/wifi; do$/m,
    "all five wearer surfaces must stay in the request loop",
  );
  assert.match(
    canary,
    /^\s*\|\| fail "Center wearer surface must answer 200 with an owner session: \$route \(\$surface_status\)"$/m,
    "a non-200 from any wearer surface must fail the canary, naming the route",
  );

  // Content, not status: a status check on these routes is guaranteed to pass by
  // design, because they answer 200 whether the read succeeded or degraded. Pin
  // the ASSERTIONS that read the content — `/x-data-state/` was satisfied by the
  // `def state()` helper's own body and `/provenance/` by a variable binding, so
  // both matched with nothing asserted about either value.
  assert.match(canary, /^assert webapi\.get\("state"\)=="live",/m);
  assert.match(canary, /^assert grpc\.get\("state"\)=="degraded", \($/m);
  assert.match(canary, /^assert state\("notes"\)=="live",/m);
  assert.match(canary, /^assert state\("memories"\)=="degraded", \($/m);
  assert.match(canary, /^assert set\(provenance\)==\{"captures","notes","aiMic","music","calls"\}$/m);
  assert.match(canary, /^    assert provenance\[part\]\.get\("state"\)=="live",/m);
  assert.match(canary, /^    assert provenance\[part\]\.get\("state"\)=="degraded",/m);
  // Pin the ASSERT, not the sentence. `authenticated edge principal required`
  // also appears in the prose above the gate explaining why that is the correct
  // answer for an identity-less call, so a bare substring match stayed green
  // when the assertion itself was gutted — the exact shape of coverage this
  // file exists to catch.
  assert.match(canary, /^assert "authenticated edge principal required" in detail,/m);

  // The Wi-Fi contract is load-bearing across a partition boundary: Center's
  // /api/settings/wifi route decides `live` vs `degraded`, and a route change
  // that reports `live` for a read with no sealed tokens would resurrect the
  // "you have no saved networks" lie this canary was built to catch. Pinned
  // here so removing the assertion is a failing gate, not a quiet deletion.
  assert.match(canary, /^assert state\("wifi"\)=="degraded",/m);
  assert.match(canary, /^assert body\("wifi"\)\.get\("networks"\)==\[\],/m);
});

test("the wearer-plane gate is armed on the post-cutover canaries and nowhere else", () => {
  const armed = [...deploy.matchAll(/--require-wearer-plane/g)];
  assert.equal(armed.length, 2, "exactly the two post-cutover canary invocations contain the flag");

  // The candidate-validation canaries must NOT contain it: at that point the
  // release has not been accepted and the gate would fail for reasons that are
  // not defects. The two that must are the pair that brackets the cutover — the
  // final quiesced run and the run after the public edge is activated.
  //
  // This has to be measured from the LAST `restore_ingress_services`, not the
  // first: the first is at the top of the candidate-validation path, so slicing
  // there covers nearly the whole file and the "after activation" claim passes
  // no matter where the flag actually sits.
  const activation = deploy.lastIndexOf("restore_ingress_services");
  assert.ok(activation > 0);
  assert.match(
    deploy.slice(activation),
    /^\s*--require-owner-spotify --require-wearer-plane --cookie-file "\$owner_canary_cookie"$/m,
    "the last gate before acceptance must exercise the wearer data plane",
  );
  // …and nothing earlier than the cutover may contain the flag with a cookie jar,
  // which is what would make the "post-cutover" name a fiction.
  assert.doesNotMatch(
    deploy.slice(0, activation),
    /--require-owner-spotify --require-wearer-plane --cookie-file/,
    "a pre-cutover canary must not claim post-cutover wearer coverage",
  );
});

test("the canary keeps saying which wearer coverage it does not have", () => {
  // The --cookie-file jar carries a Center session and no sealed Keycloak
  // tokens, on purpose, and this block's assertions are the honest-degraded
  // contract that follows from that. The warning below is what stops the block
  // being read as wearer coverage.
  //
  // It is now CONDITIONAL, and the condition is the whole point of this change:
  // canary.sh mints its own sealed bearer on every run
  // (canary-wearer-plane.test.mjs), so the sentence would be a lie on any run
  // where that succeeded. `|| warn` is the shape that keeps it true in both
  // directions — still emitted, verbatim, whenever the sealed bearer is absent.
  assert.match(canary, /^\s*\|\| warn "the sealed-bearer wearer plane is NOT proven:/m);
  assert.match(canary, /^\s*\(\(wearer_plane_proven\)\) \\$/m);
  assert.match(canary, /^\s*warn "authenticated OIDC code exchange remains unknown:/m);
  // Center's cookie is `carry_tokens` — TOKENS_COOKIE in center/src/server/auth.ts,
  // chunked as `carry_tokens.0` / `carry_tokens.1`. This pin used to name
  // `__carry_tokens`, an identifier that exists nowhere in Center: anyone
  // reconciling the gate against Center's source found nothing and had to guess
  // whether the gate was stale or the underscores were a chunk-prefix convention.
  // canary.sh's runtime refusal always used the real name, so the doc and the
  // code disagreed with only the doc pinned.
  assert.match(
    common,
    /^# does NOT hold the separate `carry_tokens` manifest and chunk cookies that$/m,
    "write_owner_canary_cookie must state what it does not mint, in Center's own vocabulary",
  );
  assert.match(
    canary,
    /^\s*if grep -q 'carry_tokens' "\$cookie_file"; then$/m,
    "the wearer-plane gate must refuse a jar that carries wearer token material",
  );
  assert.doesNotMatch(canary + common, /__carry_tokens/);

  /*
   * This used to be an absolute ban on the canary claiming the wearer plane was
   * proven, and it was right: nothing in the script could prove it. Something
   * can now — write_wearer_canary_jar obtains a real sealed bearer — so the ban
   * becomes a budget of exactly one claim, on the branch that earned it.
   *
   * Deleting the ban outright would have retired the only assertion standing
   * between this file and a canary that announces coverage it does not have,
   * which is the failure mode that shipped two outages green. So: one claim, it
   * must be the success log, and it must come after the flag that records the
   * proof is set.
   */
  const claims = [...canary.matchAll(/wearer (?:bearer|plane) (?:proven|verified|confirmed)/gi)];
  assert.equal(claims.length, 1, "exactly one line in the canary may claim the wearer plane is proven");
  assert.match(canary, /^\s*wearer_plane_proven=1$/m);
  assert.match(
    canary,
    /^\s*log "sealed-bearer wearer plane proven against \$wearer_base for a dedicated canary identity"$/m,
  );
  assert.ok(
    at(canary, "wearer_plane_proven=1")
      < at(canary, 'log "sealed-bearer wearer plane proven'),
    "the claim must follow the assertions that earn it",
  );
});

test("a canary run that skips Center's data plane says so instead of staying quiet", () => {
  // --require-wearer-plane is armed on exactly two deploy invocations, so on
  // every other run the credential-free honest-degraded contract goes
  // unexercised. That used to mean Center's data plane was untouched entirely —
  // the shape that shipped three outages green — and the sentence below said so.
  //
  // It no longer has to be true: the sealed-bearer block runs on every
  // invocation and refuses the deploy when it cannot. So canary.sh now emits one
  // of TWO sentences here, and both are pinned: this one, still exact, for the
  // run where nothing reached the data plane, and a narrower one naming only the
  // contract that was skipped when the sealed bearer did prove the plane. A
  // single sentence covering both cases would have to be vague enough to be
  // useless on the case that matters.
  //
  // Anchored matches over the emitted `warn` lines, so neither sentence can
  // drift from its consequence or be satisfied by the comment block above it.
  assert.match(
    canary,
    /^\s*warn "Center's own data plane was not exercised in this run \(--require-wearer-plane is off\):.*100%-degraded wearer plane would pass this canary"$/m,
    "the warning must state the consequence, not merely that a flag was off",
  );
  assert.match(
    canary,
    /^\s*warn "the credential-free honest-degraded contract was not exercised in this run \(--require-wearer-plane is off\):.*would pass this canary"$/m,
    "the narrower warning must name the contract that was skipped, not merely the flag",
  );
  assert.match(canary, /^    if \(\(wearer_plane_proven\)\); then$/m);
});

test("a failed status probe names the endpoint, and a refused one still fails loudly", () => {
  // One helper serves fifteen probes across Center, ai-bus, connectivity,
  // Grafana, Keycloak and the Pin bridge.
  assert.match(
    common,
    /^\s*\|\| fail "HTTP canary expected \$expected but received \$actual: \$\{target:-unknown target\}"$/m,
  );
  // The URL only. Header values contain the admin roster and web-projection
  // tokens on other requests through this same helper's sibling.
  assert.match(common, /^\s*http:\/\/\*\|https:\/\/\*\) target="\$argument"; break ;;$/m);
  assert.doesNotMatch(common, /fail "HTTP canary expected \$expected but received \$actual"/);
  // curl writes 000 on a refused or timed-out connection; without this the
  // assignment killed the script through `set -e` and no gate was ever named.
  assert.match(common, /^\s*actual="\$\(http_status "\$@" \|\| true\)"$/m);
});

test("the canary asserts only what can vary at runtime", () => {
  // mesh.services and mesh.methods are computed from a `pub const` registry
  // table, so they are identical for every run of a given binary. As gate
  // assertions they were vacuous and lent false authority to the live number
  // printed beside them.
  assert.doesNotMatch(canary, /mesh\.get\("services"/);
  assert.doesNotMatch(canary, /mesh\.get\("methods"/);
  assert.match(canary, /^assert mesh\.get\("reachable"\) == mesh\.get\("total"\) == 7$/m);
  assert.match(canary, /^print\(f"\{mesh\.get\('reachable'\)\}\/\{mesh\.get\('total'\)\} processes serving health"\)$/m);
});

test("the Grafana probe is labelled as Grafana", () => {
  // 13001 is Grafana; Center is 14000. This line sat among Center loopback
  // checks and read as one.
  assert.match(canary, /^expect_status 200 http:\/\/127\.0\.0\.1:13001\/api\/health\s+# grafana, not Center$/m);
});

test("the Pin adapter is proven from Center's own network namespace", () => {
  // The host can reach the host-network adapter even when INPUT rejects the
  // Center container's spotify-control hop. Both probes are required: the
  // second is the browser-visible path that failed in production.
  assert.match(canary, /^expect_status 200 http:\/\/10\.0\.7\.1:18081\/healthz$/m);
  assert.match(
    canary,
    /^if ! docker exec -i "\$center_container" node - "\$center_adapter_expected" <<'NODE'$/m,
  );
  assert.match(canary, /^\s*origin = new URL\(configured\)\.origin;$/m);
  assert.match(canary, /^\s*const response = await fetch\(`\$\{origin\}\/readyz`, \{$/m);
  assert.match(
    canary,
    /^\s*fail "Center cannot reach the private Pin adapter readiness endpoint"$/m,
  );
});

test("always-open Center paths are pinned to 200 with no redirect", () => {
  assert.match(
    canary,
    /^for path in \/wifi \/favicon\.ico \/manifest\.json; do$/m,
    "/wifi must not share /login's redirect tolerance",
  );
  assert.match(canary, /^\s*\[\[ "\$status" == 200 \]\] \|\| fail "Center always-open path must answer 200: \$path \(\$status\)"$/m);
  assert.match(canary, /^\s*\|\| fail "Center always-open path emitted a redirect target: \$path"$/m);
});

test("the owner Spotify gate reports a device error loudly instead of swallowing it as absence", () => {
  // The name says what the gate ENFORCES. It does not refuse the deploy: the
  // canary prints PIN_SPOTIFY_ERROR and warns, then continues, deliberately —
  // a Spotify fault the Pin reports is a device fact, not a cloud-deployment
  // defect, so it follows the same warn-don't-fail shape as pin_unavailable
  // (canary.sh states this in its own comment). The previous title, "refuses a
  // device-reported error instead of passing it", read to anyone auditing gates
  // by grepping test names as a deploy blocker. In a codebase where three
  // outages shipped through gates that claimed more than they checked, a gate
  // NAME that overstates its enforcement is the same defect one level up.
  //
  // What is enforced: "error" is one of the five real SpotifyPinState values —
  // a failure the Pin reported, not an absence — so it must never be folded
  // into the accepted set, and it must never present the generic setup card.
  assert.doesNotMatch(canary, /"disabled","not_configured","pairing","ready","error"\}/);
  assert.match(canary, /^\s*assert state in \{"disabled","not_configured","pairing","ready"\}$/m);
  assert.match(canary, /^\s*print\("PIN_SPOTIFY_ERROR", file=sys\.stderr\)$/m);
  assert.match(canary, /^\s*warn "the paired Pin reports a Spotify error;/m);
});

test("staging runs its Center data plane under the production identity too", () => {
  // Pass 1 injects COSMOS_PRINCIPAL, which no production deployment sets, so its
  // `live` verdict was satisfied by that header alone and said nothing about the
  // wearer bearer chain. Pass 2 removes it and asserts the honest contract.
  assert.match(staging, /^\s*--env-file "\$projection_work\/center-production-identity\.env" \\$/m);
  assert.match(
    staging,
    /^production_identity=\{key:value for key,value in center\.items\(\) if key!="COSMOS_PRINCIPAL"\}$/m,
  );
  assert.match(staging, /^\s*raise SystemExit\("the production Center projection still carries a static principal"\)$/m);
  assert.match(staging, /^center_production_identity_container="\$\{scope\}-center-production-identity"$/m);
  assert.match(staging, /^\s*'test -z "\$\{COSMOS_PRINCIPAL:-\}"' \\$/m);

  // Same honest-failure contract as the canary, so the two gates cannot drift
  // into disagreeing about what a healthy identity-less read looks like.
  assert.match(staging, /^assert webapi\.get\("configured"\) is True and webapi\.get\("state"\)=="live", \($/m);
  assert.match(staging, /^assert grpc\.get\("state"\)=="degraded", \($/m);
  assert.match(staging, /^assert "authenticated edge principal required" in detail, \($/m);
  assert.match(staging, /^\s*"the notes read returned the owner's rows with no owner identity present"$/m);

  // COSMOS_PRINCIPAL must remain a staging-only injection: setting it in compose
  // would seal every wearer's notes under one deployment-wide key.
  for (const file of ["compose.yaml", "platform/compose/production.yaml"]) {
    assert.doesNotMatch(
      fs.readFileSync(path.join(root, file), "utf8"),
      /^\s*COSMOS_PRINCIPAL:/m,
      `${file} must never set a deployment-wide principal`,
    );
  }
});

test("preflight proves the edge trusts the CAs that actually issue device certificates", () => {
  // Envoy requires a client certificate on both device listeners, and the
  // certificates those anchors must accept are minted from entirely different
  // directories. A rotated or mis-mounted anchor is rejected during the TLS
  // handshake, so no workload logs anything and every HTTP-level gate passes.
  assert.match(preflight, /^anchor_accepts_issuer "\$attest_dir\/ca\.crt" "\$edge_certs\/onboarding-client-ca\.crt" \\$/m);
  assert.match(preflight, /^anchor_accepts_issuer "\$duc_dir\/duc-ca\.crt" "\$edge_certs\/api-client-ca\.crt" \\$/m);
  // Subject AND public key: subject alone accepts a re-issued CA holding a
  // different key, key alone accepts a differently named authority. Both halves
  // must reach the printed identity, so pin the identity line as well — a
  // certificate_identity that stopped emitting the digest would otherwise leave
  // every anchor comparison resting on the DN alone.
  assert.match(
    preflight,
    /^\s*subject="\$\(openssl x509 -in "\$certificate" -noout -subject -nameopt RFC2253\)" \|\| return 1$/m,
  );
  assert.match(preflight, /^\s*public="\$\(public_key_digest certificate "\$certificate" 0\)" \|\| return 1$/m);
  assert.match(preflight, /^\s*printf '%s\\t%s\\n' "\$\{subject#subject=\}" "\$public"$/m);
  // And that the digest is genuinely of the certificate's DER public key rather
  // than of the PEM text, which would compare equal for two encodings of the
  // same key and unequal for the same key re-wrapped.
  assert.match(domain, /^\s*certificate:0\) openssl x509 -in "\$path" -pubkey -noout 2>\/dev\/null \\$/m);
  assert.match(domain, /^\s*\| openssl pkey -pubin -outform DER >"\$work" 2>\/dev\/null \|\| status=1 ;;$/m);
  // A bundle is a legitimate anchor shape, so every certificate in the file is
  // enumerated rather than only the first.
  assert.match(preflight, /^\s*\/-----BEGIN CERTIFICATE-----\/ \{ count \+= 1 \}$/m);
  // The server half is bound to the exact release-held activation source, not a
  // mutable tree pathname, then checked against the immutable legacy root and
  // every SNI value accepted by either device listener.
  assert.match(
    heldReleaseExec,
    /^    "platform\/deploy\/pin\/activate\.mjs": "REVIVAL_HELD_PIN_ACTIVATE",$/m,
  );
  assert.match(preflight, /^verify_pinned_legacy_edge_certificate\(\) \($/m);
  assert.match(preflight, /^  release_material_file_is_safe "\$activate_source" \|\| return 1$/m);
  assert.match(
    preflight,
    /^  \[\[ "\$source_sha" == 1b947b4e4dae58dc5f8aac1863723eb0eaa313da993e2b8ec7abed38727e22ed \]\] \\$/m,
  );
  assert.match(
    preflight,
    /^  \[\[ "\$subject" == "subject=CN=Carry Clone Root EC 1,O=humane-carry-clone" \]\] \|\| return 1$/m,
  );
  assert.match(
    preflight,
    /^  sudo -n openssl verify -purpose sslserver -CAfile "\$root_file" "\$edge_certs\/server\.crt" >\/dev\/null \\$/m,
  );
  assert.match(
    preflight,
    /^  for authority in \\\n    onboarding\.carry\.humane\.cloud onboarding\.clone\.invalid carry-edge \\\n    api\.carry\.humane\.cloud api\.clone\.invalid eastus\.carry\.humane\.cloud eastus-1\.carry\.humane\.cloud; do$/m,
  );
  assert.doesNotMatch(preflight, /edge server certificate is not checked against the root/u);
});

test("no PKI gate can pass by hashing an openssl failure", () => {
  // The empty-input collision.
  //
  // `digest="$(openssl … 2>/dev/null | sha256sum | awk '{print $1}')"` cannot
  // fail: `2>/dev/null` eats the message and the substitution reports awk's
  // status, which is always 0. A failed openssl therefore yields
  // sha256("") = e3b0c4…7852b855 — 64 characters, so an `[[ -n "$digest" ]]`
  // guard passes it — and because BOTH sides of a certificate-vs-key comparison
  // were built that way, two failed runs produced two identical digests and the
  // pair "matched" having read neither file. I reproduced exactly that with two
  // junk PEMs: the old form passed, the current form fails.
  //
  // This was live production shell, on the gate standing between a mismatched
  // edge pair and a Pin that cannot finish a TLS handshake — Envoy rejects the
  // client certificate, no workload logs a line, every HTTP probe stays green.
  assert.match(
    domain,
    /^DOMAIN_EMPTY_INPUT_SHA256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855$/m,
  );
  assert.match(domain, /^\s*\[\[ "\$digest" != "\$DOMAIN_EMPTY_INPUT_SHA256" \]\] \|\| return 1$/m);
  // Status-checked at every stage, not only at the end: an empty DER file is a
  // failure even when the exit codes lie.
  assert.match(domain, /^\s*if \(\(status != 0\)\) \|\| \[\[ ! -s "\$work" \]\]; then rm -f -- "\$work"; return 1; fi$/m);

  // Every certificate/key digest in the deploy shell must come from that helper.
  // A single re-introduced inline pipeline restores the hole, so pin the SHAPE
  // rather than the three call sites: no executable line may pipe openssl into
  // sha256sum. (Leading-`#` lines are excluded — the comments explaining the bug
  // necessarily quote it.)
  for (const [name, source] of [["preflight.sh", preflight], ["domain.sh", domain], ["deploy.sh", deploy]]) {
    assert.doesNotMatch(
      source,
      /^[^#\n]*openssl[^#\n]*\|\s*sha256sum/m,
      `${name}: hash a public key through public_key_digest, never an inline openssl|sha256sum pipeline`,
    );
  }
  assert.match(preflight, /^\s*public="\$\(public_key_digest certificate "\$certificate" 0\)" \|\| return 1$/m);
  assert.match(preflight, /^server_public="\$\(public_key_digest certificate "\$edge_certs\/server\.crt" 1\)" \\$/m);
  assert.match(preflight, /^key_public="\$\(public_key_digest private-key "\$edge_certs\/server\.key" 1\)" \\$/m);
  assert.match(preflight, /^\[\[ "\$server_public" == "\$key_public" \]\] \|\| fail "edge server certificate and private key do not match"$/m);
  assert.match(domain, /^\s*certificate_public="\$\(public_key_digest certificate "\$certificate" 1\)" \\$/m);
  assert.match(domain, /^\s*key_public="\$\(public_key_digest private-key "\$private_key" 1\)" \\$/m);
});

test("preflight refuses a certificate that expires inside the deploy's own horizon", () => {
  // Nothing in this suite referenced the expiry loop, so it could have been
  // deleted with the file still advertising itself as pinning "the property each
  // gate was strengthened to check". An expired anchor fails exactly the way a
  // mismatched one does — during the TLS handshake, with no workload log — and
  // seven days is the margin that makes it an operator's problem rather than an
  // outage.
  assert.match(preflight, /^\s*sudo -n openssl x509 -checkend 604800 -in "\$certificate" -noout >\/dev\/null \\$/m);
  assert.match(preflight, /^\s*\|\| fail "certificate expires within seven days: \$certificate"$/m);
  // The list too: dropping one certificate from the loop is otherwise invisible.
  assert.match(preflight, /^for certificate in "\$edge_certs\/server\.crt" "\$edge_certs\/api-client-ca\.crt" \\$/m);
  assert.match(
    preflight,
    /^\s*"\$edge_certs\/onboarding-client-ca\.crt" "\$attest_dir\/ca\.crt" "\$duc_dir\/duc-ca\.crt"; do$/m,
    "all five device-path certificates must stay in the expiry loop",
  );
  // And the durable-input assertion preflight makes before anything else runs.
  assert.match(preflight, /^assert_durable_inputs$/m);
  assert.match(preflight, /^assert_active_durable_mounts$/m);
});

test("the deploy measures and records the public ingress outage it imposes on the wearer", () => {
  // quiesce_ingress_services stops the cloudflared user unit, the cloudflared
  // system unit, nginx.service and penumbra-center-bridge.service. nginx is the
  // HOST's shared web server, so aipin.andersmadsen.dk,
  // connectivity-check.carry.humane.cloud and the default vhost go down with the
  // project — and the paired Pin, reporting device status every five minutes, is
  // connection-REFUSED for the whole window. Refused, not 502'd: nginx is not
  // running to log it, so the outage leaves no server-side trace and was
  // reconstructible only by diffing access-log timestamps. Real windows in this
  // host's journal: 3m21s, 3m36s, 9m56s, 10m05s. Unbudgeted, unrecorded, and
  // roughly a fifth of device-status reports are lost in bands matching them.
  assert.match(deploy, /^PUBLIC_INGRESS_BUDGET_SECONDS=\d+$/m);

  // The mark has to sit at the step that actually stops the units — the backup
  // invoked with --leave-quiesced — not at the later quiesce_ingress_services
  // call, which would silently under-report every window by the duration of a
  // full restore-tested backup.
  const quiesceMark = at(deploy, "\nopen_public_ingress_window\nwriters_quiesced=1\n");
  const quiescingBackup = at(deploy, '--backup-id "$deployment_id" --leave-quiesced --already-locked');
  assert.ok(
    quiesceMark < quiescingBackup,
    "the window must be opened before the quiescing backup, not after it",
  );
  assert.match(deploy, /^record_public_ingress_window$/m);
  // Recovery re-quiesces, so it opens a window too — and opening is idempotent,
  // because recovery usually runs while the first window is still open and
  // restarting the clock there would report only its flattering tail.
  assert.match(
    deploy,
    /^\s*\[\[ -z "\$public_ingress_quiesce_epoch" \]\] \|\| return 0$/m,
    "opening an already-open window must not discard the outage so far",
  );
  // Anchored on the PAIR, not on a bare `open_public_ingress_window` line: the
  // reconcile's recovery opens a window with the same indentation earlier in the
  // file, so a lone-line anchor resolves there and the cutover recovery's own
  // ordering stops being checked at all while the assertion still passes.
  const recoveryOpen = at(
    deploy,
    '\n  open_public_ingress_window\n  quiesce_ingress_services "$ingress_evidence" 0 "$record" "$cloudflared_route_state"',
  );
  const recoveryQuiesce = at(deploy, 'quiesce_ingress_services "$ingress_evidence" 0 "$record" "$cloudflared_route_state"');
  assert.ok(recoveryOpen < recoveryQuiesce, "recovery's own ingress outage must be measured too");

  // THE RECONCILE'S OWN WINDOW. Resuming an armed transaction stops the same four
  // units and holds them down for as long as the cutover does — two restore-tested
  // backups, two candidate starts, three canaries. On 2026-08-11 that resume kept
  // the edge closed from 21:04:37Z to 21:17:45Z and recorded NOTHING: the record's
  // PUBLIC_INGRESS_WINDOW read 950s for a night that cost the wearer about 1738s
  // across two windows, so the budget line under-reported by more than the budget.
  //
  // Definition order first, because bash resolves a function at CALL time: the
  // reconcile runs near the top of this script, and the helpers used to be defined
  // several hundred lines below it. Instrumenting the reconcile without moving
  // them would have been a "command not found" in the middle of an armed
  // transaction rather than a measurement.
  const windowDefinition = at(deploy, "\nrecord_public_ingress_window() {\n");
  const reconcileCall = at(deploy, "\nreconcile_pending_deployment_transaction\n");
  assert.ok(
    windowDefinition < reconcileCall,
    "the window helpers must be defined above the reconcile that calls them",
  );
  // Opened before the resume's re-quiesce, and OUTSIDE the conditional guarding
  // it: the case where a dead predecessor already left the edge down is the case
  // the reconcile exists for, and it is the one that has been down longest.
  const resumeOpen = at(deploy, "\n    open_public_ingress_window\n    if ! assert_ingress_quiesced; then\n");
  const resumeQuiesce = at(deploy, 'quiesce_ingress_services "$pending_record/ingress-active.tsv" 0 "$pending_record" desired');
  assert.ok(resumeOpen < resumeQuiesce, "a resumed armed transaction must measure the outage it imposes");
  // Closed once the edge is serving and proven to match its recorded state, before
  // the public canary — the same instant the cutover path closes its own.
  const resumeRestore = at(deploy, 'restore_ingress_services "$pending_record/ingress-active.tsv" "$pending_record" desired');
  const resumeRecord = at(deploy, "\n    record_public_ingress_window\n");
  assert.ok(
    resumeRestore < resumeRecord && resumeRecord < at(deploy, '>"$pending_record/INGRESS_ACTIVATED.tmp"'),
    "the resume's window must close when the edge reopens, not when the deployment ends",
  );
  // And the reconcile's failure exits, which are the longer windows: the resume's
  // own close is only reached when the transaction is accepted.
  assert.match(
    deploy,
    /^\s*record_public_ingress_window \|\| warn "the public ingress window could not be recorded in \$record"$/m,
  );
  assert.ok(
    at(deploy, "\n    record_public_ingress_window || warn") < reconcileCall,
    "finish_reconcile must record a window it left open",
  );

  // Durable in the deployment record, printed to the operator, and carried in
  // --json — three readers, because a number that only exists in a terminal
  // scrollback is the same as no number.
  assert.match(deploy, /^\s*mv "\$record\/PUBLIC_INGRESS_WINDOW\.tmp" "\$record\/PUBLIC_INGRESS_WINDOW"$/m);
  assert.match(deploy, /^\s*sync -f "\$record\/PUBLIC_INGRESS_WINDOW"$/m);
  assert.match(deploy, /^\s*log "public ingress was down for \$\{elapsed\}s/m);
  assert.match(
    deploy,
    /^\s*\|\| warn "public ingress window \$\{total\}s exceeded the \$\{PUBLIC_INGRESS_BUDGET_SECONDS\}s budget/m,
    "an over-budget window must be said out loud, not merely stored",
  );
  // Budgeted against the TOTAL, not the last window: two five-minute outages in
  // one deployment cost the wearer the same as one ten-minute outage.
  assert.match(deploy, /^\s*\(\(total <= PUBLIC_INGRESS_BUDGET_SECONDS\)\) \\$/m);
  assert.match(deploy, /^\s*"canary":"read-only","publicIngressWindowSeconds":int\(window\) if window else None,$/m);

  // The failure route too. A deploy that did not ship still took ingress down,
  // usually for longer, and the happy-path call sits after public acceptance —
  // so precisely the worse windows were the ones nothing recorded.
  assert.match(
    deploy,
    /^\s*if \[\[ -n "\$public_ingress_quiesce_epoch" \]\]; then$/m,
    "finish_deploy must record the window on every exit that left one open",
  );
  assert.match(
    deploy,
    /^\s*warn "public ingress is STILL DOWN; the figure below is the window so far, not its total width"$/m,
    "a failed recovery must not report a window as if it had closed",
  );
});

test("the ingress budget is the measured cost of one quiesced operation, not a round guess", () => {
  /*
   * WHY THIS PINS AN EXACT NUMBER WHEN THE TEST ABOVE DELIBERATELY PINS `\d+`.
   *
   * 420 was in this constant for as long as the window existed, and it was never
   * a cost — it was a hope, set from reconstructed access-log bands before any
   * phase was timed. When the phases were finally attributed from the deployment
   * records' own marker mtimes and their backup directories (20260812T140840Z on
   * this release's code, with both landed optimisations in it), a clean
   * single-run cutover measured 450-456s:
   *
   *   80.4s  pre-candidate restore-proven backup (--leave-quiesced)
   *  130.7s  quiesce the four ingress units + isolated staging smoke
   *    7.5s  stop containers, install config/Nginx/Cloudflare route, arm
   *   69.6s  candidate up -d, image+config evidence, precommit canary, bridge
   *   81.6s  post-candidate zero-delta restore-proven backup
   *   37.6s  seal checks, zero-delta compares, restart, Keycloak migration
   *    ~43s  desired-state verifies, two quiesced canaries, restore ingress
   *
   * Every one of those rows must observe a quiesced state to prove what it
   * proves. So the budget sat BELOW the floor of a successful deploy, which
   * means the warn fired on correct behaviour and therefore stopped containing
   * information — the failure mode this whole file exists to catch, wearing the
   * clothes of a safety margin.
   *
   * The number is pinned rather than shape-checked because the pressure on it
   * runs the wrong way: the tempting edit is DOWN, back to a figure that reads
   * better in a report and that nothing can hit. Anyone lowering it has to come
   * through this test and produce a phase table that supports the new number.
   */
  assert.match(
    deploy,
    /^PUBLIC_INGRESS_BUDGET_SECONDS=480$/m,
    "the budget must stay at the measured floor of one cutover window plus headroom",
  );
  // 480 is also 300 * 1.6, and the warn below counts the wearer's loss in
  // 300s device-status reports. A budget that is not a whole number of what the
  // warn reports in is a budget the operator has to convert in their head.
  assert.match(
    deploy,
    /^\s*\|\| warn "public ingress window \$\{total\}s exceeded the \$\{PUBLIC_INGRESS_BUDGET_SECONDS\}s budget; the wearer lost roughly \$\(\(total \/ 300\)\) device-status reports to this deployment"$/m,
  );

  /*
   * THE COMPOSITE DISCLOSURE.
   *
   * The budget is a PER-OPERATION number and `total` is CUMULATIVE, and on a
   * deployment that both resumes a predecessor's armed transaction and then cuts
   * over, those are not the same quantity. 20260812T140840Z recorded
   * 310s + 453s = 763s exactly that way — a 310s resume of 20260812T130434Z's
   * pending candidate, then its own 453s cutover — and read as a single figure
   * against a single-operation budget it looks like one 763s outage that no
   * phase table can explain. Both windows were ordinary; there were two of them.
   *
   * The total stays the budgeted quantity, because the wearer really did lose
   * all of it and inflating the budget to cover a composite would be the
   * fiction. What must not disappear is the sentence that says which half to go
   * and read, printed only when there IS more than one window.
   */
  assert.match(
    deploy,
    /^\s*if \(\(elapsed != total\)\); then$/m,
    "a deployment with more than one window must say so, not merely sum them",
  );
  assert.match(
    deploy,
    /^\s*\|\| warn "this single window alone was \$\{elapsed\}s against the \$\{PUBLIC_INGRESS_BUDGET_SECONDS\}s per-operation budget"$/m,
    "the per-operation budget must be read against a single window, not only the sum",
  );
  assert.match(
    deploy,
    /^\s*warn "this deployment imposed more than one outage on the wearer; \$\{elapsed\}s of the \$\{total\}s total is this window, and the rest was quiesced before it\. Read PUBLIC_INGRESS_WINDOW in the record for the individual rows"$/m,
  );
  // The row shape is what makes that sentence actionable, so it is pinned here
  // too: one row per window, its own seconds AND the running total, so a reader
  // of the record can do the split without the terminal scrollback.
  assert.match(
    deploy,
    /^\s*printf 'window\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "\$public_ingress_quiesce_utc" "\$ended_utc" \\$/m,
  );
  assert.match(deploy, /^\s*"\$elapsed" "\$total" "\$PUBLIC_INGRESS_BUDGET_SECONDS"$/m);
});

test("the window closes before the commit, and nothing quiesced may be moved into that gap", () => {
  /*
   * WHAT THIS PROTECTS, AND WHY IT IS WORTH A TEST OF ITS OWN.
   *
   * There is a real region between `record_public_ingress_window` and
   * `complete_candidate_commit` in which public ingress is already restored and
   * the candidate is already serving the wearer. It is small on purpose: the
   * final public canary and the durable INGRESS_ACTIVATED marker, nothing else.
   *
   * It is also the obvious place to hide expensive proof work, and that is a
   * trap. The two restore-proven backups are 162s of the ~450s window, and each
   * carries roughly 33s of isolated restore verification — restoring the
   * archives into throwaway volumes, booting two scratch PostgreSQL clusters and
   * comparing manifests. Moving the post-candidate one down here would take ~33s
   * off the wearer's outage and keep the proof ahead of the commit, so it looks
   * free.
   *
   * It is not free, because it changes what a FAILURE costs. Today that
   * verification fails with the edge still down, the previous application
   * recoverable and no wearer traffic on the candidate. Down here it would fail
   * with the candidate already containing production, leaving two choices: commit
   * against a backup whose restore proof just failed, or take a SECOND outage to
   * unwind — which is longer than the 33s the move saved, and lands exactly the
   * two-window composite the budget disclosure above exists to describe. The
   * same reasoning is why the over-budget branch warns instead of failing.
   *
   * So the ordering is pinned: the window closes, the public canary runs, the
   * marker lands, the pointer is published. Anything else that wants to live in
   * that gap has to move this assertion first.
   */
  const windowClosed = at(deploy, "\nrestore_ingress_services \"$ingress_evidence\" \"$record\" desired\n");
  const recordWindow = at(deploy, "\nrecord_public_ingress_window\n# The last gate before the deployment is accepted");
  const ingressActivated = at(deploy, '>"$record/INGRESS_ACTIVATED.tmp"');
  const commit = at(deploy, "\ncomplete_candidate_commit || fail");
  assert.ok(
    windowClosed < recordWindow,
    "the window must close after the edge is serving again, not before",
  );
  assert.ok(
    recordWindow < ingressActivated && ingressActivated < commit,
    "the public canary and its marker sit between the window close and the pointer publication",
  );
  // No backup may be taken in that gap. backup.sh's own isolated restore
  // verification is the expensive thing that would want to be here, and the
  // whole point is that it stays where a failure is still recoverable.
  const gap = deploy.slice(recordWindow, commit);
  assert.doesNotMatch(
    gap,
    /backup\.sh/,
    "no backup may run between the window close and the commit; a restore proof that fails there has no recovery that is cheaper than the outage it saved",
  );
});

test("the canary proves the device listeners actually demand a client certificate", () => {
  // The one check that exercises the mTLS boundary in the refusing direction: a
  // reachable TLS listener that answers no HTTP without a client certificate.
  // Unpinned until now, and it is the only signal that would notice
  // `require_client_certificate` being turned off.
  assert.match(
    canary,
    /^for authority in api\.carry\.humane\.cloud onboarding\.carry\.humane\.cloud; do$/m,
  );
  assert.match(canary, /^\s*fail "mTLS edge accepted a client without a certificate: \$authority"$/m);
  // The liveness precondition matters as much as the refusal: without it a
  // REFUSED TCP connection also produces "curl did not succeed", and the canary
  // would read a dead edge as proof that the edge is strict.
  assert.match(
    canary,
    /^\s*timeout 3 bash -c '<\/dev\/tcp\/127\.0\.0\.1\/18443' 2>\/dev\/null \|\| fail "mTLS edge is not listening"$/m,
    "a refused TCP connection must never be accepted as proof that mTLS is enforced",
  );
});
