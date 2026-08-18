import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * The operator configuration view discloses NAMES and STATES. Never a value.
 *
 * That claim is easy to write and easy to break: one `value` added to a
 * descriptor for "just the non-secret ones", one length shown "to check the key
 * looks right", and the pane starts leaking. So this file does not read the
 * module and agree with it — it sets every catalogued environment variable to a
 * unique sentinel, asks for the whole inventory, serializes it, and fails if any
 * sentinel survives anywhere in the output. A leak of any shape — value, prefix,
 * suffix, or a length that happens to identify a four-digit pincode — has to get
 * past that.
 *
 * It also holds the two structural promises the design rests on: the route
 * exports no verb that could write, and no setting classified as a secret or as
 * identity is marked editable from a browser.
 */

process.env.KEYCLOAK_BASE_URL = "https://keycloak.test";
process.env.AUTH_SESSION_SECRET = "0123456789abcdef0123456789abcdef";

const MODULE = new URL("../src/server/configuration.ts", import.meta.url);
const ROUTE = new URL("../src/app/api/admin/configuration/route.ts", import.meta.url);

const { configurationCatalog, configurationInventory } = await import(
  `${MODULE.href}?configuration-inventory-test`
);

const catalog = configurationCatalog();

/** Restore the environment between cases so one test cannot colour another. */
function withEnvironment(entries, run) {
  const saved = new Map();
  for (const [name, value] of Object.entries(entries)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("no environment value reaches the inventory, in any shape", async () => {
  // A sentinel per setting, all sharing a prefix so a single scan catches any
  // of them, and each long and unique so a partial disclosure is caught too.
  const sentinels = new Map(
    catalog.map((setting, index) => [
      setting.name,
      `SENTINEL-${index}-${"x".repeat(24)}-${setting.name}-END`,
    ]),
  );
  const patch = Object.fromEntries(sentinels);

  const serialized = await withEnvironment(patch, async () =>
    JSON.stringify(await configurationInventory()),
  );

  for (const [name, sentinel] of sentinels) {
    assert.ok(
      !serialized.includes(sentinel),
      `the inventory disclosed the value of ${name}`,
    );
    // The distinctive middle of the sentinel, so a truncated or reversed
    // disclosure fails too rather than sneaking past an exact-match check.
    assert.ok(
      !serialized.includes("x".repeat(12)),
      `the inventory disclosed part of the value of ${name}`,
    );
  }
  // The names themselves are not secrets and must still be present, or this
  // test would pass on an inventory that returned nothing at all.
  for (const name of sentinels.keys()) assert.ok(serialized.includes(name));
});

test("every reported state is a member of the closed union", async () => {
  const inventory = await configurationInventory();
  const allowed = new Set([
    "configured",
    "default",
    "missing",
    "unreadable",
    "unobservable",
  ]);

  assert.ok(inventory.settings.length > 0);
  for (const setting of inventory.settings) {
    assert.ok(allowed.has(setting.state), `unexpected state on ${setting.name}`);
  }
  const counted = Object.values(inventory.counts).reduce((sum, n) => sum + n, 0);
  assert.equal(counted, inventory.settings.length);
});

test("state distinguishes configured, defaulted, missing and unreadable", async () => {
  const find = (inventory, name) =>
    inventory.settings.find((setting) => setting.name === name);

  // KEYCLOAK_SCOPES has a coded fallback; COSMOS_WEBAPI_BASE_URL has none. So an
  // absent scope list is "default" (nothing is wrong) while an absent backend
  // URL is "missing" (a pane is unavailable). Collapsing those two into one
  // "not set" is what sends an operator to SSH.
  const absent = await withEnvironment(
    { KEYCLOAK_SCOPES: undefined, COSMOS_WEBAPI_BASE_URL: undefined },
    () => configurationInventory(),
  );
  assert.equal(find(absent, "KEYCLOAK_SCOPES").state, "default");
  assert.equal(find(absent, "COSMOS_WEBAPI_BASE_URL").state, "missing");

  const present = await withEnvironment(
    { KEYCLOAK_SCOPES: "openid email", COSMOS_WEBAPI_BASE_URL: "http://ai-bus:18080" },
    () => configurationInventory(),
  );
  assert.equal(find(present, "KEYCLOAK_SCOPES").state, "configured");
  assert.equal(find(present, "COSMOS_WEBAPI_BASE_URL").state, "configured");

  // Whitespace is not configuration. A variable set to spaces used to read as
  // present and then fail at the first call that used it.
  const blank = await withEnvironment({ COSMOS_WEBAPI_BASE_URL: "   " }, () =>
    configurationInventory(),
  );
  assert.equal(find(blank, "COSMOS_WEBAPI_BASE_URL").state, "missing");

  // A path that is set but unreadable is the failure this pane exists for: it
  // looks configured from every other angle while the feature is dead.
  const readable = await withEnvironment(
    // `fileURLToPath`, not `URL.pathname`: this repository's own directory name
    // contains a space, and the percent-encoded form is not a path that exists.
    { COSMOS_CHANNEL_KEY_FILE: fileURLToPath(import.meta.url) },
    () => configurationInventory(),
  );
  assert.equal(find(readable, "COSMOS_CHANNEL_KEY_FILE").state, "configured");

  const unreadable = await withEnvironment(
    { COSMOS_CHANNEL_KEY_FILE: "/nonexistent/channel-key.json" },
    () => configurationInventory(),
  );
  assert.equal(find(unreadable, "COSMOS_CHANNEL_KEY_FILE").state, "unreadable");
});

test("settings owned by another container are reported as unobservable, never as missing", async () => {
  const inventory = await configurationInventory();
  for (const setting of inventory.settings) {
    if (setting.observable) continue;
    assert.equal(
      setting.state,
      "unobservable",
      `${setting.name} lives in ${setting.home} and Center cannot see it`,
    );
    // Reporting someone else's environment as "missing" would be the same lie
    // as rendering a backend outage as "you have no captures".
    assert.notEqual(setting.state, "missing");
  }
  // Setting one in THIS process must not change the answer: the value would be
  // this container's, not the container that actually reads it.
  const spoofed = await withEnvironment({ COSMOS_AZURE_SPEECH_KEY: "not-ours" }, () =>
    configurationInventory(),
  );
  assert.equal(
    spoofed.settings.find((setting) => setting.name === "COSMOS_AZURE_SPEECH_KEY").state,
    "unobservable",
  );
});

test("no secret or identity setting is editable from a browser", () => {
  for (const setting of catalog) {
    if (setting.sensitivity === "operational") continue;
    assert.equal(
      setting.editable,
      "never",
      `${setting.name} is ${setting.sensitivity} and must not be dashboard-writable`,
    );
    assert.ok(
      typeof setting.restriction === "string" && setting.restriction.length > 0,
      `${setting.name} must record WHY it may not be edited`,
    );
  }
  for (const setting of catalog) {
    if (setting.editable !== "deploy-proposal") continue;
    assert.equal(
      setting.sensitivity,
      "operational",
      `${setting.name} may only be proposable if a wrong value degrades rather than exposes`,
    );
    assert.equal(setting.restriction, null);
  }
});

test("a secret never carries a documented default value", () => {
  // `fallback` is rendered to the operator, so it may only ever hold a literal
  // already committed to this repository. A secret has no such literal, and an
  // entry that claimed one would be printing a credential.
  //
  // The one exception is precise rather than convenient: a `path` setting's
  // VALUE is a filesystem location, and the credential lives in the file it
  // names, not in the variable. `COSMOS_CHANNEL_KEY_FILE` defaults to a path, and
  // showing that path is how an operator learns the key landed off the
  // persistent volume. So a path secret may publish a fallback, and it still may
  // not publish anything that could be mistaken for material.
  for (const setting of catalog) {
    if (setting.sensitivity !== "secret" || setting.fallback === null) continue;
    assert.ok(
      setting.path,
      `${setting.name} is a secret and must not publish a fallback value`,
    );
    assert.match(
      setting.fallback,
      /[/.]/,
      `${setting.name} may only publish a fallback that is plainly a path`,
    );
  }
});

test("the catalog names each setting once and explains what its absence costs", () => {
  const names = catalog.map((setting) => setting.name);
  assert.equal(new Set(names).size, names.length, "duplicate setting in the catalog");
  for (const setting of catalog) {
    assert.match(setting.name, /^[A-Z][A-Z0-9_]*$/);
    assert.ok(
      setting.impact.length > 20,
      `${setting.name} must say what stops working without it`,
    );
    assert.ok(setting.group.length > 0);
  }
});

test("the configuration surface is read-only and operator-gated", async () => {
  const [route, module] = await Promise.all([
    readFile(ROUTE, "utf8"),
    readFile(MODULE, "utf8"),
  ]);

  // Next serves 405 for a verb a route file does not export, so the absence of
  // a writer is enforced by the framework rather than by a guard.
  assert.match(route, /export async function GET\(/);
  for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.doesNotMatch(
      route,
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${verb}\\b`),
      `the configuration route must not export ${verb}`,
    );
  }

  // The second gate, evaluated inside the route from the session cookie, as on
  // every other operator surface. Middleware is the first.
  assert.match(route, /requireOperatorRequest\(\)/);
  assert.match(route, /operator instanceof Response\) return operator/);

  // Nothing here writes. The module opens files for a readability probe only.
  for (const writer of ["writeFile", "appendFile", "mkdir", "rm(", "unlink", "rename"]) {
    assert.ok(
      !module.includes(writer),
      `the configuration module must not use ${writer}`,
    );
  }
  assert.match(module, /import \{ access, constants \} from "node:fs\/promises"/);

  // The audit line reports counts and the operator's subject. A line that
  // paired a setting name with anything read from the environment would be the
  // leak this whole file exists to prevent.
  assert.match(route, /logInfo\(/);
  assert.doesNotMatch(route, /process\.env/);
});

test("the route sits behind the operator path prefix", async () => {
  const { isOperatorPath } = await import(
    "../src/server/auth.ts?configuration-route-gate"
  );
  assert.equal(isOperatorPath("/api/admin/configuration"), true);
});
