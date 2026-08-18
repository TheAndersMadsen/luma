import "./tsResolve.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";

/*
 * The env-plane WRITER. `configuration-inventory.test.mjs` holds the read side
 * to disclosing names and states and nothing else; this file holds the write
 * side to three things that are much easier to get wrong.
 *
 *   NOTHING OUTSIDE §4 CAN BE WRITTEN. Not by a route that forgot to check, not
 *   by a request naming a setting directly, not by an entry hand-added to the
 *   store on the VPS. Every secret and identity name in the catalog is offered
 *   to the writer here and has to be refused, by name, with a reason.
 *
 *   A REFUSAL HAS TO BE ACTIONABLE. "Invalid value" is the message that sends an
 *   operator to SSH and edit Compose by hand, which is the out-of-band change
 *   the whole deploy-proposal mechanism exists to prevent. So every refusal is
 *   asserted to name the setting and say what a usable value would be.
 *
 *   THE STORE CANNOT LIE ABOUT BEING EMPTY. An unreadable or corrupt store that
 *   read as "no pending changes" would invite a save that overwrites entries
 *   nobody could see — the same failure `channelStore.ts` was rewritten for.
 */

process.env.KEYCLOAK_BASE_URL = "https://keycloak.test";
process.env.AUTH_SESSION_SECRET = "0123456789abcdef0123456789abcdef";

const root = new URL("../", import.meta.url);
const source = (relative) => readFile(new URL(relative, root), "utf8");

const { setLogSinkForTests } = await import("../src/server/log.ts");
// These modules log on every write, and a log line on stdout is a stray record
// in this runner's TAP stream. The sink seam exists for exactly this — and what
// it captures is itself an assertion target below: `server/log.ts` is a shared
// stream and this module's rule is that a write records the NAME and the
// operator there, never the value.
const logLines = [];
setLogSinkForTests((level, line) => logLines.push(`${level} ${line}`));

const { configurationCatalog, proposalTarget, validateProposedValue } = await import(
  "../src/server/configuration.ts"
);
const {
  ConfigurationProposalsUnavailableError,
  pendingProposals,
  proposalStoreFile,
  proposeValue,
  withdrawProposal,
} = await import("../src/server/configurationProposals.ts");

const catalog = configurationCatalog();
const OPERATOR = { sub: "operator-subject", email: "op@example.test" };

/** A scratch store for one case, torn down whether or not the case passed. */
function withStore(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "configuration-proposals-"));
  const file = path.join(directory, "configuration-proposals.json");
  const saved = process.env.REVIVAL_CENTER_CONFIG_PROPOSALS_FILE;
  process.env.REVIVAL_CENTER_CONFIG_PROPOSALS_FILE = file;
  try {
    return run(file);
  } finally {
    if (saved === undefined) delete process.env.REVIVAL_CENTER_CONFIG_PROPOSALS_FILE;
    else process.env.REVIVAL_CENTER_CONFIG_PROPOSALS_FILE = saved;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

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

const writable = catalog.filter((setting) => proposalTarget(setting) !== null);

test("the catalog is self-consistent about what may be written", () => {
  assert.ok(writable.length > 0, "no setting is writable at all, so this whole surface is dead");

  for (const setting of catalog) {
    if (setting.editable === "deploy-proposal") {
      // A proposable setting with no constraint is a free-text field into a
      // protected env file. The biconditional is enforced rather than assumed
      // because the failure is silent until someone types into it.
      assert.ok(setting.constraint, `${setting.name} is proposable and declares no constraint`);
      assert.ok(setting.delivery, `${setting.name} is proposable and does not say whether it is delivered`);
      assert.ok(
        setting.delivery.via === "env-plane" || setting.delivery.reason.length > 40,
        `${setting.name} is not delivered by the env plane and must say what to edit instead`,
      );
    } else {
      assert.equal(setting.constraint, null, `${setting.name} is not proposable and must contain no constraint`);
      assert.equal(setting.delivery, null, `${setting.name} is not proposable and must contain no delivery claim`);
    }
  }

  // A writable setting's home has to be one of the four files the deploy stages
  // — `compose` is not a file `stage_private_configuration` copies, so a value
  // written "into" it would land nowhere.
  for (const setting of writable) {
    assert.ok(
      ["center.env", "runtime.env", "cosmos.env", "providers.env"].includes(proposalTarget(setting)),
      `${setting.name} would be written into ${proposalTarget(setting)}, which the deploy does not stage`,
    );
    assert.equal(setting.sensitivity, "operational");
  }
});

test("nothing outside the writable set can be proposed, and every refusal says why", () => {
  for (const setting of catalog) {
    if (proposalTarget(setting) !== null) continue;
    const outcome = validateProposedValue(setting.name, "anything");
    assert.equal(outcome.ok, false, `${setting.name} must not be writable from the dashboard`);
    assert.ok(
      typeof outcome.reason === "string" && outcome.reason.length > 20,
      `${setting.name} was refused without telling the operator anything`,
    );
  }

  // The names §5a calls out by hand, so the assertion survives a catalog edit
  // that accidentally drops one of them.
  for (const name of [
    "AUTH_SESSION_SECRET",
    "COSMOS_SHARE_TOKEN_SECRET",
    "COSMOS_EDGE_TOKEN",
    "COSMOS_ADMIN_TOKEN",
    "KEYCLOAK_CLIENT_SECRET",
    "COSMOS_DUC_CA_KEY",
    "COSMOS_ENROLLMENT_PINCODE",
    "COSMOS_OPERATOR_EMAILS",
    "COSMOS_DATABASE_URL",
  ]) {
    assert.equal(validateProposedValue(name, "x").ok, false, name);
  }

  // An unknown name is refused as an unknown name, not accepted as a new one.
  for (const name of ["PATH", "NOT_A_SETTING", "cosmos_llm_model", ""]) {
    assert.equal(validateProposedValue(name, "x").ok, false, name);
  }
});

test("a value that cannot survive an env file is refused before it reaches one", () => {
  // `update_env_value` in the deploy refuses a newline outright, so accepting
  // one here would turn a typo in a browser into a failed deploy at the point
  // of no return. A CR does the same; a tab and a non-ASCII byte are refused
  // for the same reason a log line is flattened — one record, one meaning.
  for (const hostile of [
    "openai/x\nCOSMOS_PG_PASSWORD=pwned",
    "openai/x\rCOSMOS_PG_PASSWORD=pwned",
    "openai/x\ty",
    "openai/ünicode",
    "",
    "   ",
  ]) {
    const outcome = validateProposedValue("COSMOS_LLM_MODEL", hostile);
    assert.equal(outcome.ok, false, JSON.stringify(hostile));
    assert.match(outcome.reason, /COSMOS_LLM_MODEL/);
  }
  assert.equal(validateProposedValue("COSMOS_LLM_MODEL", 8000).ok, false);
  assert.equal(validateProposedValue("COSMOS_LLM_MODEL", null).ok, false);
  assert.equal(validateProposedValue("COSMOS_LLM_MODEL", "a".repeat(600)).ok, false);

  // The SHARED length cap, reached through the one setting whose own grammar
  // does not bound its length: a scope list is any number of well-formed
  // tokens, so `a.repeat(600)` above is refused by the model constraint's 128
  // and proves nothing about the shared rule. Without the shared cap this value
  // saves happily and then fails the deploy, which refuses the whole store over
  // it — the form is the only cheap place to say no.
  const overlong = validateProposedValue("KEYCLOAK_SCOPES", `openid ${"a".repeat(600)}`);
  assert.equal(overlong.ok, false);
  assert.match(overlong.reason, /KEYCLOAK_SCOPES must be at most 512 characters/);
});

test("each constraint accepts what it documents and refuses the rest, in words", () => {
  const accepted = (name, value) => {
    const outcome = validateProposedValue(name, value);
    assert.equal(outcome.ok, true, `${name}=${value} should have been accepted: ${outcome.reason}`);
    return outcome.value;
  };
  const refused = (name, value, expected) => {
    const outcome = validateProposedValue(name, value);
    assert.equal(outcome.ok, false, `${name}=${value} should have been refused`);
    assert.match(outcome.reason, expected);
    return outcome.reason;
  };

  // Whitespace is trimmed, not rejected: an operator pasting a value picks up a
  // trailing space and that is not a mistake worth a red message.
  assert.equal(accepted("COSMOS_LLM_MODEL", "  openai/gpt-4o-mini  "), "openai/gpt-4o-mini");
  accepted("COSMOS_LLM_MODEL", "anthropic/claude-sonnet-4.5");
  accepted("COSMOS_LLM_MODEL", "llama3.1:70b");
  refused("COSMOS_LLM_MODEL", "openai/gpt 4o", /provider model id/);
  refused("COSMOS_LLM_MODEL", "$(rm -rf /)", /provider model id/);

  accepted("COSMOS_AZURE_SPEECH_VOICE", "en-US-AvaMultilingualNeural");
  accepted("COSMOS_AZURE_SPEECH_VOICE", "da-DK-ChristelNeural");
  refused("COSMOS_AZURE_SPEECH_VOICE", "Ava", /locale and voice name/);

  accepted("REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS", "5000");
  // The bounds are in the message, because "out of range" without them is a
  // guessing game the operator plays against a form.
  refused("REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS", "10", /between 500 and 60000/);
  refused("REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS", "600000", /between 500 and 60000/);
  refused("REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS", "5s", /whole number/);
  refused("REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS", "-1", /whole number/);
  refused("REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS", "5000.5", /whole number/);

  accepted("KEYCLOAK_SCOPES", "openid email profile");
  assert.equal(accepted("KEYCLOAK_SCOPES", "openid  email"), "openid email");
  // The one refusal that would lock the operator out of the surface they made
  // the change on, so the message has to say that rather than "required field".
  refused("KEYCLOAK_SCOPES", "email profile", /must include openid[\s\S]*sign in/);
  refused("KEYCLOAK_SCOPES", `openid ${"a b c d e f g h i j k l".replaceAll(" ", " ")}`, /at most 12/);
});

test("the store round-trips one change, atomically and at mode 600", () => {
  withStore((file) => {
    assert.deepEqual(pendingProposals(), []);

    const outcome = proposeValue("COSMOS_LLM_MODEL", "openai/gpt-4o-mini", OPERATOR);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.proposal.value, "openai/gpt-4o-mini");
    assert.equal(outcome.proposal.target, "providers.env");
    assert.equal(outcome.proposal.proposedBy, OPERATOR.sub);

    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // The sibling the atomic replace writes must not survive it; a leftover
    // would sit next to the store under a name nothing cleans up.
    assert.deepEqual(
      fs.readdirSync(path.dirname(file)),
      ["configuration-proposals.json"],
    );

    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.settings.COSMOS_LLM_MODEL.value, "openai/gpt-4o-mini");
    assert.equal(stored.settings.COSMOS_LLM_MODEL.proposedBy, OPERATOR.sub);
    assert.match(stored.settings.COSMOS_LLM_MODEL.proposedAt, /^\d{4}-\d{2}-\d{2}T/);

    const [pending] = pendingProposals();
    assert.equal(pending.name, "COSMOS_LLM_MODEL");
    assert.equal(pending.proposedByEmail, OPERATOR.email);
  });
});

test("a write is audited by name, and the value stays in the file that holds it", () => {
  /*
   * The store IS the audit record — who, when, which setting, which file — and
   * `server/log.ts` is a shared stream with exactly one reader (`docker logs`).
   * Putting the value in both means an operational log line now carries
   * configuration content, and the habit is what eventually carries something
   * that matters. So the line names the setting and the operator, and the value
   * is only ever in the store.
   *
   * Asserted over the captured sink rather than over the source text, because a
   * source assertion is satisfied by any rewording and this is a rule about the
   * bytes that reach the stream.
   */
  withStore(() => {
    logLines.length = 0;
    const value = "eastus-improbable-voice-name";
    assert.equal(proposeValue("COSMOS_AZURE_SPEECH_VOICE", "en-US-JennyNeural", OPERATOR).ok, true);
    assert.equal(proposeValue("COSMOS_LLM_MODEL", "openai/gpt-4o-mini", OPERATOR).ok, true);
    assert.equal(withdrawProposal("COSMOS_LLM_MODEL", OPERATOR), true);

    assert.equal(logLines.length, 3, "every write must leave exactly one audit line");
    const stream = logLines.join("\n");
    for (const proposed of ["en-US-JennyNeural", "openai/gpt-4o-mini", value]) {
      assert.ok(!stream.includes(proposed), `a proposed value reached the shared log: ${proposed}`);
    }
    // What it must contain instead, so the line is still worth having.
    for (const line of logLines) {
      assert.ok(line.includes(OPERATOR.sub), "an audit line does not name the operator who made the change");
    }
    assert.ok(stream.includes("COSMOS_AZURE_SPEECH_VOICE"));
    assert.ok(stream.includes("COSMOS_LLM_MODEL"));
  });
});

test("a second change is merged, never written over the first", () => {
  withStore(() => {
    assert.equal(proposeValue("COSMOS_LLM_MODEL", "openai/gpt-4o-mini", OPERATOR).ok, true);
    assert.equal(proposeValue("KEYCLOAK_SCOPES", "openid email", OPERATOR).ok, true);
    assert.deepEqual(
      pendingProposals().map((proposal) => proposal.name).sort(),
      ["COSMOS_LLM_MODEL", "KEYCLOAK_SCOPES"],
    );

    // Re-proposing replaces that one entry and leaves the other alone.
    assert.equal(proposeValue("KEYCLOAK_SCOPES", "openid email profile", OPERATOR).ok, true);
    const scopes = pendingProposals().find((proposal) => proposal.name === "KEYCLOAK_SCOPES");
    assert.equal(scopes.value, "openid email profile");
    assert.equal(pendingProposals().length, 2);

    assert.equal(withdrawProposal("KEYCLOAK_SCOPES", OPERATOR), true);
    assert.equal(withdrawProposal("KEYCLOAK_SCOPES", OPERATOR), false);
    assert.deepEqual(pendingProposals().map((proposal) => proposal.name), ["COSMOS_LLM_MODEL"]);
  });
});

test("a refused value never reaches the store", () => {
  withStore((file) => {
    assert.equal(proposeValue("AUTH_SESSION_SECRET", "0".repeat(32), OPERATOR).ok, false);
    assert.equal(proposeValue("COSMOS_DUC_CA_KEY", "----BEGIN", OPERATOR).ok, false);
    assert.equal(proposeValue("REVIVAL_PIN_SETUP_ORIGIN", "https://elsewhere.test", OPERATOR).ok, false);
    assert.equal(proposeValue("COSMOS_DEADLINE_MS", "9000", OPERATOR).ok, false);
    assert.equal(proposeValue("KEYCLOAK_SCOPES", "email", OPERATOR).ok, false);
    // Not "the file has no such key" — the file must not exist at all, because
    // a refused write that still created a store would be a write.
    assert.equal(fs.existsSync(file), false);
  });
});

test("an unreadable or corrupt store is never reported as empty", () => {
  withStore((file) => {
    // A directory where the store should be: readFileSync raises EISDIR for
    // every uid, so this cannot pass by accident on a runner with more rights
    // than the container has.
    fs.mkdirSync(file);
    assert.throws(() => pendingProposals(), ConfigurationProposalsUnavailableError);
    assert.throws(() => proposeValue("COSMOS_LLM_MODEL", "openai/gpt-4o-mini", OPERATOR), {
      name: "ConfigurationProposalsUnavailableError",
    });
    fs.rmdirSync(file);
  });

  withStore((file) => {
    fs.writeFileSync(file, "{ not json");
    assert.throws(() => pendingProposals(), /not valid JSON/);
  });

  withStore((file) => {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 9, settings: {} }));
    assert.throws(() => pendingProposals(), /schema version 9/);
  });

  withStore((file) => {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1 }));
    assert.throws(() => pendingProposals(), /no settings object/);
  });
});

test("delivery says whether a value has landed, and admits when it cannot tell", () => {
  withStore(() => {
    // KEYCLOAK_SCOPES is in Center's own environment, so this process can
    // compare — against a value the operator supplied, which is why the answer
    // discloses nothing the caller did not already have.
    proposeValue("KEYCLOAK_SCOPES", "openid email profile", OPERATOR);
    withEnvironment({ KEYCLOAK_SCOPES: "openid email" }, () => {
      assert.equal(pendingProposals()[0].delivery, "pending");
    });
    withEnvironment({ KEYCLOAK_SCOPES: "openid email profile" }, () => {
      assert.equal(pendingProposals()[0].delivery, "applied");
    });
  });

  withStore(() => {
    // COSMOS_LLM_MODEL lives in the backend's environment. Reporting it as
    // "pending" from a value this container does not have would be the same lie
    // as rendering a backend outage as "you have no captures".
    proposeValue("COSMOS_LLM_MODEL", "openai/gpt-4o-mini", OPERATOR);
    withEnvironment({ COSMOS_LLM_MODEL: "openai/gpt-4o-mini" }, () => {
      assert.equal(pendingProposals()[0].delivery, "unconfirmable");
    });
  });
});

test("an entry this build would no longer accept is surfaced, not silently dropped", () => {
  withStore((file) => {
    // What a catalog change between deploys leaves behind, and what a hand-edit
    // on the VPS looks like. The deploy refuses the whole file over either, so
    // the console has to show it or the operator cannot deploy at all.
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        settings: {
          AUTH_SESSION_SECRET: { value: "smuggled", proposedAt: "2026-01-01T00:00:00.000Z" },
          COSMOS_LLM_MODEL: { value: "not a model", proposedAt: "2026-01-02T00:00:00.000Z" },
          MALFORMED: { proposedAt: "2026-01-03T00:00:00.000Z" },
        },
      }),
    );
    assert.deepEqual(
      pendingProposals()
        .map((proposal) => [proposal.name, proposal.delivery])
        .sort(),
      [
        ["AUTH_SESSION_SECRET", "refused"],
        ["COSMOS_LLM_MODEL", "refused"],
        ["MALFORMED", "refused"],
      ],
    );
    // And it can be removed, which is the only way out of that state.
    assert.equal(withdrawProposal("AUTH_SESSION_SECRET", OPERATOR), true);
  });
});

test("the store lives on the Center data volume by default", () => {
  withEnvironment({ REVIVAL_CENTER_CONFIG_PROPOSALS_FILE: undefined }, () => {
    // The deploy reads this exact name from the host side of the same bind
    // mount, so the default is part of the contract rather than a convenience.
    assert.equal(proposalStoreFile(), "/data/configuration-proposals.json");
  });
});

test("the writer is operator-gated, same-origin, and separate from the reader", async () => {
  const [writer, reader] = await Promise.all([
    source("src/app/api/admin/configuration/proposals/route.ts"),
    source("src/app/api/admin/configuration/route.ts"),
  ]);

  // The reader stays incapable of writing. Next serves 405 for a verb a route
  // file does not export, so this is the framework enforcing it.
  for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.doesNotMatch(reader, new RegExp(`export\\s+(?:async\\s+)?function\\s+${verb}\\b`));
  }

  assert.match(writer, /export async function GET\(/);
  assert.match(writer, /export async function PUT\(/);
  assert.match(writer, /export async function DELETE\(/);
  assert.doesNotMatch(writer, /export\s+(?:async\s+)?function\s+POST\b/);

  // The second gate, evaluated inside the route from the session cookie, on
  // every verb — including the read, because knowing which changes are queued
  // is knowing what the next deploy will do.
  assert.equal(writer.match(/requireOperatorRequest\(\)/g).length, 1);
  assert.equal(writer.match(/await operatorOf\(\)/g).length, 3);
  assert.equal(writer.match(/operator instanceof Response\) return operator/g).length, 3);

  // A cookie must not be spendable by a page the operator merely visited.
  assert.equal(writer.match(/isSameOriginRequest\(request\)/g).length, 2);

  // Nothing here reads the environment: the values in a response are values the
  // operator supplied, and there is no branch that could echo a running one.
  assert.doesNotMatch(writer, /process\.env/);
});

test("the route sits behind the operator path prefix", async () => {
  const { isOperatorPath } = await import("../src/server/auth.ts?configuration-proposals-gate");
  assert.equal(isOperatorPath("/api/admin/configuration/proposals"), true);
});

test("the console offers an input only where a value can actually land", async () => {
  const panel = await source("src/app/admin/AdminConfiguration.tsx");

  // One condition, and it is the server's derived verdict — not `editable`, not
  // `sensitivity`, not a list restated in the client. A second rule here is how
  // a field appears for a setting the server would refuse.
  assert.match(panel, /setting\.writable === "proposable" && setting\.constraint \? \(/);
  assert.equal(panel.match(/<ProposalRow/g).length, 1);
  assert.equal(panel.match(/className=\{styles\.settingInput\}/g).length, 1);

  // A secret is a row with a state and a sentence, never a disabled input
  // holding dots — and never a rendered value of any kind.
  assert.doesNotMatch(panel, /type="password"/);
  assert.doesNotMatch(panel, /setting\.value/);
  assert.match(panel, /\{setting\.guidance\}/);

  // Every editable row states when the change takes effect, from the server's
  // own sentence, next to the control rather than once at the top of the pane.
  assert.match(panel, /\{setting\.effect\.detail\}/);
  assert.match(panel, /describeConstraint\(constraint\)/);

  // And the console never claims a removal undid anything.
  assert.match(panel, /it does not put the old one back/);
});
