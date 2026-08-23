/*
 * ═══════════════════════════════════════════════════════════════════════════
 * DEPLOYMENT CONFIGURATION, SEEN FROM THE DASHBOARD
 *
 * This module answers exactly one question — "which settings does the running
 * Center have, and which is it missing?" — and it is deliberately incapable of
 * answering any other. It reads names and derives states. It never returns a
 * value, never returns part of one, and never writes anything.
 *
 * The rest of this comment is the design for the surface it belongs to. It
 * lives here rather than in `docs/` because `platform/deploy/acceptance/
 * layout.sh` pins `docs/` to an exact three-file allowlist.
 *
 * §3's env-plane proposal mechanism IS built now; `server/configurationProposals
 * .ts` is the writer and `apply_configuration_proposals` in
 * `platform/deploy/vps/remote/common.sh` is the only thing that applies one.
 * The two deviations from the design as written below are recorded at §8, so
 * the prose and the code cannot quietly disagree.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 1. HOW CONFIGURATION REACHES THE RUNNING SYSTEM TODAY
 *
 * Four protected files on the VPS, mode 600, under
 * `/home/anders/ai-pin-revival/private`:
 *
 *   runtime.env    the Compose interpolation environment — the file that fills
 *                  every `${VAR}` in platform/compose/production.yaml
 *   center.env     this container's own environment
 *   cosmos.env     the backend workloads' environment
 *   providers.env  third-party model, speech and search credentials
 *
 * `stage_private_configuration` (platform/deploy/vps/remote/common.sh) copies
 * all four into the deployment's staging directory at deploy time, normalizes
 * the REVIVAL_*→COSMOS_* aliases, and merges the scoped provider values into
 * runtime.env. Compose then renders production.yaml against them, and the
 * services start with whatever that produced.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 2. WHY A DASHBOARD WRITER IS NOT A SMALL FEATURE
 *
 * `record_configuration_evidence` sha256s all four files — plus their mode and
 * owner, plus edge/envoy.yaml, the Spotify token, the Nginx site files, and the
 * rendered Compose model — into `<deployment>/config-digests.tsv`.
 * `verify_configuration_evidence` recomputes that table and requires EXACT
 * equality. It is called from:
 *
 *   drift.sh                     against the accepted deployment
 *   preflight.sh                 before a deploy is allowed to start
 *   deploy.sh                    pre-activation recovery, and post-commit
 *   rollback.sh                  against the CURRENT deployment, before rolling
 *
 * That last one is the whole argument. If Center writes to `private/center.env`
 * at 03:00 and something breaks at 04:00, `rollback.sh` recomputes the current
 * deployment's digests, finds they no longer match the record, and REFUSES. The
 * dashboard edit did not merely change a setting: it disarmed the recovery path
 * for the live system, silently, and the operator finds out at the worst
 * possible moment. Pre-activation recovery inside deploy.sh fails the same way.
 *
 * So the rule is not "be careful with secrets". It is:
 *
 *   NOTHING may write to the four protected env files outside the deploy
 *   transaction, because the deploy transaction's digest of those files is what
 *   makes rollback trustworthy.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 3. THE THREE PLANES A SETTING CAN LIVE IN
 *
 * A setting that has to change without a deploy does not belong in the env
 * plane at all. There are three, and picking the right one is the design:
 *
 *   FLAG PLANE      Runtime feature flags. Already live, already operator-only,
 *                   already reaching the device: /api/admin/flags → cosmos's
 *                   flags API → the Pin's next flag sync. NOT in the digest
 *                   table, so changing one does not disturb rollback. Anything
 *                   that needs to change while the system is up belongs here.
 *
 *   ENV PLANE       The four protected files. In the digest table. A change
 *                   here is a DEPLOYMENT, not an edit, and must ride the deploy
 *                   transaction so the new digests are recorded as part of the
 *                   same record that carries the new release.
 *
 *   NEVER PLANE     Material whose writer must not exist inside the app that
 *                   faces the internet. See §5.
 *
 *   The env-plane mechanism, as built: Center writes a change PROPOSAL into its
 *   own `/data` volume — which is deliberately absent from config-digests.tsv —
 *   and touches nothing under `private/`. The deploy is the only thing that
 *   applies it: `apply_configuration_proposals` runs while the deploy stages
 *   the private configuration, so the new values and the new digests are
 *   captured by the SAME `record_configuration_evidence` call, in the same
 *   deployment record, as the release they ship with. Drift detection is never
 *   bypassed because the change is never out-of-band; the previous deployment
 *   record keeps the previous digests, so rollback keeps meaning what it meant.
 *   The cost is that a config change requires a deploy. That cost is the
 *   feature.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 4. SAFE TO EDIT FROM THE DASHBOARD (as env-plane proposals)
 *
 * Non-secret, single-file, no cross-service invariant, no authorization or
 * identity meaning, and wrong values degrade rather than expose:
 *
 *   COSMOS_DEADLINE_MS, KEYCLOAK_SCOPES, REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS,
 *   COSMOS_AZURE_SPEECH_VOICE, COSMOS_LLM_MODEL, COSMOS_VISION_MODEL,
 *   COSMOS_PPLX_MODEL, COSMOS_LLM_REASONING_EFFORT, COSMOS_REMOTE_TTS_ENABLED,
 *   REVIVAL_PIN_SETUP_ORIGIN
 *
 * Each descriptor below carries `editable`, so this list is data rather than
 * prose, and the writer refuses anything not marked for it. `COSMOS_PPLX_MODEL`
 * and `COSMOS_LLM_REASONING_EFFORT` appear in the sentence above but not in the
 * catalog; Center does not read either, so it has no state to report for them
 * and the writer has nothing to validate against. The catalog is the authority
 * — the writer's allowlist is derived from `editable`, never from this prose.
 *
 * A proposable descriptor additionally carries `constraint`, because "safe to
 * edit" is not "any string is fine": COSMOS_DEADLINE_MS is a millisecond budget
 * and KEYCLOAK_SCOPES stops every sign-in working the moment it loses `openid`.
 * The constraint is the server-side check AND the sentence the operator reads
 * when a value is refused, so the two cannot drift apart.
 *
 * And it carries `delivery`, which is where this list turned out to be
 * optimistic. Four of the names above are safe to edit and CANNOT be delivered
 * by the env plane as this deployment is wired — COSMOS_DEADLINE_MS,
 * REVIVAL_PIN_SETUP_ORIGIN, COSMOS_FEATURE_FLAGS_METRICS_URL and
 * COSMOS_REMOTE_TTS_ENABLED. See `ConfigurationDelivery` below for what stops
 * each one. They stay in the catalog with the reason attached rather than being
 * quietly dropped: an operator who is told "not editable" with no explanation
 * goes to the VPS and edits a file that was never going to help.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 5. MUST NEVER BE EDITABLE FROM THE DASHBOARD — AND WHY
 *
 * a. SECRETS AND KEY MATERIAL. AUTH_SESSION_SECRET, COSMOS_SHARE_TOKEN_SECRET,
 *    COSMOS_EDGE_TOKEN, COSMOS_ADMIN_TOKEN, COSMOS_CENTER_PROJECTION_TOKEN,
 *    KEYCLOAK_CLIENT_SECRET, COSMOS_OPAQUE_SEED, COSMOS_PG_PASSWORD,
 *    COSMOS_KEYCLOAK_DB_PASSWORD, KEYCLOAK_ADMIN_PASSWORD,
 *    GRAFANA_ADMIN_PASSWORD, SEARXNG_SECRET, COSMOS_DUC_CA_KEY, and every
 *    provider API key.
 *
 *    Center is the surface an attacker reaches first — it is the public web
 *    app. Putting the writer for the credentials that PROTECT Center inside
 *    Center means one stolen operator cookie, or one server-side request
 *    forgery in a route handler, is total compromise rather than a session
 *    compromise. COSMOS_DUC_CA_KEY is the device-user CA: it mints device
 *    identities. That writer must not be reachable from a browser at all.
 *
 * b. CROSS-SERVICE INVARIANTS. drift.sh asserts that COSMOS_EDGE_TOKEN is
 *    byte-identical across all four env files and appears exactly twice in the
 *    rendered edge/envoy.yaml, and that the Spotify adapter token is at least
 *    32 bytes and different from it. COSMOS_ENROLLMENT_PINCODE and
 *    COSMOS_ENROLLMENT_USER_ID must agree across runtime, cosmos and center. A
 *    single-file editor cannot maintain those, and the failure surfaces later,
 *    as a drift check on a deploy the operator did not connect to the edit.
 *
 * c. IDENTITY AND AUTHORIZATION. COSMOS_OPERATOR_EMAILS is the bootstrap
 *    operator allowlist: an editor for it lets one operator session mint
 *    permanent operator access for any address, including an attacker's, which
 *    converts a session compromise into persistence. REVIVAL_PIN_BRIDGE_OWNER_SUB
 *    and REVIVAL_PIN_BRIDGE_DEVICE_ID are cross-checked by drift.sh against the
 *    pairing rows derived from Postgres; editing one side re-points the Pin
 *    bridge at a different device or owner. KEYCLOAK_BASE_URL / _REALM /
 *    _CLIENT_ID define who the identity provider even is.
 *
 * d. DEPLOYMENT IDENTITY. REVIVAL_RELEASE_ID, REVIVAL_IMAGE_TAG, the
 *    REVIVAL_*_DIR paths and every port. These are what the release manifest,
 *    the image evidence and the Compose digest are computed against; changing
 *    one from the dashboard makes the running system disagree with its own
 *    attestation.
 *
 * e. A SELF-LOCKING SPECIAL CASE. Rotating AUTH_SESSION_SECRET invalidates
 *    every session including the operator's own, mid-request. Even with a
 *    correct writer it belongs to a shell on the host, not a browser button.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 6. WHO, WHAT IS MASKED, WHAT IS LOGGED
 *
 * WHO      Operator session only, enforced twice, as everywhere else in this
 *          codebase: `middleware.ts` refuses `/api/admin/*` before the route
 *          runs, and the route calls `requireOperatorRequest` again from the
 *          session cookie. One rule (`operatorGateOutcome`), two enforcement
 *          points. A wearer session gets 403; no session gets 401.
 *
 * MASKED   Everything. Not "secrets are masked" — EVERYTHING. This surface
 *          emits names and a state from a closed union, and nothing else: no
 *          value, no prefix, no suffix, no length, no hash. A length is a
 *          partial secret for a four-digit enrollment pincode, and a rule with
 *          an exception list is a rule that leaks the day someone adds the
 *          wrong entry to the list. `verify/configuration-inventory.test.mjs`
 *          proves it by setting every catalogued variable to a unique sentinel
 *          and asserting no sentinel survives into the serialized response.
 *
 * WRITE-ONLY  Considered and rejected for secrets: a secret would be settable
 *          and never readable back. Worth stating because it is also the reason
 *          a dashboard secret editor buys so little — you could set a value but
 *          never confirm it, so the operator still SSHes in to check.
 *
 *          A PROPOSED value is a different thing and is readable back: it is
 *          operational by construction (§4), it is a value the operator just
 *          typed, and hiding it would mean an operator could not see what the
 *          next deploy is about to apply. What is never read back is the
 *          RUNNING value, proposed or not — the store holds only what was
 *          proposed, and `stateOf` still reduces the environment to a state.
 *
 * LOGGED   Every read logs one line: the operator's subject and the counts by
 *          state. Never a name-to-value pair, never a value — `server/log.ts`
 *          is explicitly not for secrets. A write logs the operator's subject
 *          and the setting NAME, and no value: a proposed value is not a secret
 *          but the log is a shared stream, and the proposal file is the record
 *          that carries the value anyway.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 7. WHAT CENTER CAN HONESTLY SEE
 *
 * Center observes its own process environment and nothing else. Values in
 * cosmos.env and providers.env never enter this container, so their state is
 * reported as `unobservable` with the file that owns them named — which is
 * still most of the answer an operator wants ("where do I put the Azure key?")
 * and is the only claim the data supports. Reporting them as `missing` would be
 * a lie of exactly the kind this codebase already refuses elsewhere, where a
 * backend outage must not render as "you have no captures".
 *
 * A later, honest upgrade: the backend already exposes an operator surface that
 * Center proxies with COSMOS_ADMIN_TOKEN (see api/admin/overview). Teaching it
 * to report its own configuration STATES would turn `unobservable` into real
 * answers without any value ever crossing a network boundary. Not built today.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 8. WHERE THE BUILT WRITER DEVIATES FROM §3, AND WHY
 *
 * a. THE PROPOSAL IS NOT SIGNED. §3 said "signed". A signature is only worth
 *    anything when the VERIFIER holds a key the forger does not, and here it
 *    cannot: the only key Center could sign with is one Center holds, and the
 *    adversary a signature would have to stop — someone who can write into
 *    Center's `/data` volume — is by definition inside Center's container or on
 *    the host, where that key is. So a signature here would be a ritual that
 *    proves nothing while reading as though it proved something, and a rotated
 *    AUTH_SESSION_SECRET would additionally brick every pending proposal at the
 *    worst moment. What replaces it is defence the forger genuinely cannot
 *    bypass, on the far side: `apply_configuration_proposals` re-derives its own
 *    allowlist and its own value grammar, in the deploy, and refuses the whole
 *    file — failing the deploy — if it names anything not marked proposable
 *    here or carries a value that does not match. A forged proposal therefore
 *    cannot set a variable this file did not authorize, signature or not.
 *    `platform/deploy/acceptance/configuration-proposals.test.mjs` pins the two
 *    allowlists to each other so they cannot drift apart.
 *
 * b. THE DEPLOY NEVER WRITES BACK. §6 wanted the proposal file to also record
 *    "which deployment consumed it". That would put a writer for Center's own
 *    data volume inside the deploy transaction, at staging time, for an audit
 *    field — and a failed write there is a failed deploy. The store is a
 *    DESIRED-STATE document instead of a queue: every deploy applies every
 *    entry, applying twice is applying once, and nothing needs to be marked
 *    consumed. Center reports whether an entry has landed by comparing its own
 *    process environment against the proposed value, which is a comparison
 *    against a value the operator supplied, so it discloses nothing new — and
 *    for a setting in another container's environment it honestly reports that
 *    it cannot tell, exactly as §7 requires.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { access, constants } from "node:fs/promises";

/**
 * What is true about one setting, from this process's point of view.
 *
 * A closed union on purpose: the response body is built only from these, so
 * there is no shape in which a value could ride along.
 */
export type ConfigurationState =
  /** Present in this process's environment with a non-empty value. */
  | "configured"
  /** Absent, and the code's documented fallback applies. Nothing is broken. */
  | "default"
  /** Absent with no fallback — whatever depends on it is unavailable. */
  | "missing"
  /** A path setting whose target this process cannot read. */
  | "unreadable"
  /** Lives in another container's environment; Center cannot see it. */
  | "unobservable";

/** Why the setting matters, which is what decides whether a writer may exist. */
export type ConfigurationSensitivity =
  /** Credential or key material. Never dashboard-writable. See §5a. */
  | "secret"
  /** Names who someone is, or what they may do. Never dashboard-writable. §5c. */
  | "identity"
  /** Tuning, endpoints, model choice. Wrong values degrade, they do not expose. */
  | "operational";

/** Which protected file on the VPS an operator would have to edit. */
export type ConfigurationHome =
  | "center.env"
  | "runtime.env"
  | "cosmos.env"
  | "providers.env"
  /** A literal in platform/compose/production.yaml — not an env file at all. */
  | "compose";

/** Whether the writer may touch this, and through which plane. See §3. */
export type ConfigurationEditability =
  /** Eligible for an env-plane proposal that the next deploy applies. */
  | "deploy-proposal"
  /** Never from a browser, for the reason recorded in `restriction`. */
  | "never";

/**
 * What a proposed value has to be, checked on the server and explained to the
 * operator in the same breath.
 *
 * "Operational" (§4) means a wrong value degrades rather than exposes — it does
 * NOT mean any string is acceptable. `COSMOS_DEADLINE_MS` set to "soon" makes
 * every gRPC call fail at parse time; `KEYCLOAK_SCOPES` without `openid` makes
 * the authorization request fail for everyone including the operator who typed
 * it. Both of those are a deploy away from being noticed, which is exactly the
 * kind of mistake a form is supposed to catch before it is committed.
 *
 * Every shape is data rather than a predicate: a `RegExp` would not survive
 * `JSON.stringify` into the operator's browser, and the point of shipping the
 * constraint to the client is that the hint the operator reads and the rule the
 * server enforces are the same object.
 */
export type ConfigurationConstraint =
  /** A whole number in a closed range, in the unit named. */
  | { kind: "integer"; minimum: number; maximum: number; unit: string }
  /** Literally "true" or "false"; the readers of these parse nothing else. */
  | { kind: "boolean" }
  /** An absolute origin — scheme and host, no path, no query. */
  | { kind: "origin"; schemes: readonly string[] }
  /** A space-separated list, each token matching `pattern`. */
  | { kind: "tokens"; required: readonly string[]; pattern: string; maximum: number }
  /** A single opaque name a third party defines, constrained to a safe shape. */
  | { kind: "identifier"; pattern: string; maximum: number; shape: string };

/**
 * Whether a value written into the env plane actually REACHES the process that
 * reads the setting.
 *
 * A separate question from `editable`, and the one that turned out to have
 * surprising answers. `editable` is the security decision (§4/§5): may a
 * browser-reachable writer exist for this at all. This is a plumbing fact about
 * `platform/compose/production.yaml`, and three settings §4 calls safe to edit
 * fail it:
 *
 *   REVIVAL_PIN_SETUP_ORIGIN         production.yaml assigns it a LITERAL, so no
 *                                    env file can override it.
 *   COSMOS_FEATURE_FLAGS_METRICS_URL  the same, from the base compose.yaml that
 *                                    production.yaml merges with.
 *   COSMOS_DEADLINE_MS                the Center service declares an explicit
 *                                    environment allowlist and this name is not
 *                                    on it, so a value in center.env is never
 *                                    handed to the container that reads it.
 *   COSMOS_REMOTE_TTS_ENABLED         the deploy proves the speech provider with
 *                                    a live canary and then writes it itself,
 *                                    after proposals are applied.
 *
 * Every one of those would have accepted a value, saved it, deployed it, and
 * changed nothing — the exact "a field that pretends a value is live" failure a
 * configuration console has to not have. So the reason is declared per
 * descriptor rather than derived from `home`, and
 * `platform/deploy/acceptance/configuration-proposals.test.mjs` checks each
 * declaration against production.yaml so a later Compose change that plumbs one
 * of these through cannot leave the claim here stale.
 */
export type ConfigurationDelivery =
  /** A value in the env file named by `home` reaches the reader. */
  | { via: "env-plane" }
  /** It would not, for the reason given — which names the file to edit instead. */
  | { via: "blocked"; reason: string };

/** Whether THIS deployment can actually contain a change to this setting. */
export type ConfigurationWritability =
  /** Editable, and a value written into its home would reach the reader. */
  | "proposable"
  /** Editable in principle; this deployment's Compose model does not contain it. */
  | "not-delivered"
  /** Not editable from a browser. `restriction` says why. */
  | "never";

/**
 * When a change actually reaches the process that reads the setting.
 *
 * A closed union so the UI cannot invent a third promise. There is no "live"
 * member and there never can be for the env plane: §2 is the argument that
 * nothing may write the protected files outside the deploy transaction, so
 * "next-deploy" is not a limitation of this implementation, it is the whole
 * mechanism. Anything that must change while the system is up belongs in the
 * flag plane instead, and the console links there.
 */
export interface ConfigurationEffect {
  when: "next-deploy" | "no-writer";
  /** One sentence naming the file, who restarts with it, and the moment. */
  detail: string;
}

export interface ConfigurationSetting {
  /** The environment variable's name. Names are not secrets; values are. */
  name: string;
  /** The pane this belongs under. */
  group: string;
  sensitivity: ConfigurationSensitivity;
  home: ConfigurationHome;
  /** True when this process's own environment carries it, so state is real. */
  observable: boolean;
  /** A path setting is additionally checked for readability. */
  path: boolean;
  /**
   * The literal the code falls back to, or null when there is none.
   *
   * Only ever a value that is already committed to this repository — a coded
   * default in `.env.example` or `compose.yaml`. A `secret` setting must never
   * contain one UNLESS it is a `path` setting, whose value is a filesystem
   * location rather than the material the file holds; the verify test enforces
   * exactly that split rather than trusting the descriptors to be right.
   */
  fallback: string | null;
  /** What stops working when this is missing. The reason to show the pane. */
  impact: string;
  editable: ConfigurationEditability;
  /** Why a writer may not exist, when `editable` is "never". */
  restriction: string | null;
  /**
   * What a proposed value must be. Non-null exactly when `editable` is
   * "deploy-proposal"; the verify test enforces the biconditional rather than
   * trusting a new descriptor to remember, because a proposable setting with no
   * constraint is a free-text field into a protected env file.
   */
  constraint: ConfigurationConstraint | null;
  /**
   * Whether the env plane can deliver a value for this. Non-null exactly when
   * `editable` is "deploy-proposal"; a `never` setting has `restriction`
   * instead, and there is no writer to ask the question for.
   */
  delivery: ConfigurationDelivery | null;
}

/** A setting plus the state derived for it. Still no value, by construction. */
export interface ConfigurationSettingState extends ConfigurationSetting {
  state: ConfigurationState;
  writable: ConfigurationWritability;
  effect: ConfigurationEffect;
  /**
   * What to do instead, when this cannot be changed from here.
   *
   * Present for everything that is not `proposable`, and it names the file. An
   * operator who cannot find the setting does not give up — they SSH in and
   * edit Compose by hand, which is the out-of-band change §2 exists to prevent.
   * Telling them where it lives is therefore a safety feature, not a courtesy.
   */
  guidance: string | null;
}

export interface ConfigurationInventory {
  settings: ConfigurationSettingState[];
  counts: Record<ConfigurationState, number>;
  /**
   * True when nothing observable is `missing`. Not "everything is fine" — an
   * unobservable setting could still be absent in another container.
   */
  complete: boolean;
}

const never = (restriction: string) =>
  ({ editable: "never", restriction, constraint: null, delivery: null }) as const;

const proposable = (
  constraint: ConfigurationConstraint,
  delivery: ConfigurationDelivery = { via: "env-plane" },
) => ({ editable: "deploy-proposal", restriction: null, constraint, delivery }) as const;

/** Editable by §4, and undeliverable by this deployment's Compose model. */
const undeliverable = (reason: string): ConfigurationDelivery => ({ via: "blocked", reason });

/**
 * A millisecond budget an operator may widen or tighten.
 *
 * The floor is not decoration. A deadline below a second turns every call into
 * a timeout on a backend that is merely warm rather than broken, and the pane
 * that reports it renders the wording reserved for a backend outage — so the
 * dashboard would be reporting an outage it caused itself.
 */
const timeoutMs = (minimum: number, maximum: number): ConfigurationConstraint => ({
  kind: "integer",
  minimum,
  maximum,
  unit: "milliseconds",
});

/**
 * A third-party model name.
 *
 * Deliberately a SHAPE and not a list: the provider adds models faster than
 * this catalog could follow, and a closed list would refuse the model the
 * operator is actually paying for. Wrong values fail loudly at the provider,
 * which is the §4 test for what may be edited at all. What the shape is really
 * defending is the env file: no whitespace, no quotes, no `$`, nothing that
 * changes the meaning of a `KEY=value` line.
 */
const modelIdentifier = (shape: string): ConfigurationConstraint => ({
  kind: "identifier",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$",
  maximum: 128,
  shape,
});

/*
 * The catalog.
 *
 * Ordered by pane, then by how badly its absence hurts. Every entry that Center
 * actually reads at runtime appears here; the unobservable entries are the ones
 * an operator has to configure elsewhere and would otherwise go looking for
 * over SSH.
 */
const CATALOG: ConfigurationSetting[] = [
  // ── Authentication ────────────────────────────────────────────────────────
  {
    name: "KEYCLOAK_BASE_URL",
    group: "Authentication",
    sensitivity: "identity",
    home: "center.env",
    observable: true,
    path: false,
    fallback: null,
    impact:
      "Unset means this deployment has NO authentication: middleware opens every wearer route and no session can contain the operator claim.",
    ...never("Names the identity provider itself; changing it re-points every sign-in."),
  },
  {
    name: "AUTH_SESSION_SECRET",
    group: "Authentication",
    sensitivity: "secret",
    home: "center.env",
    observable: true,
    path: false,
    fallback: null,
    impact:
      "Required whenever Keycloak is configured; Center refuses to sign sessions without it rather than falling back to a public dev key.",
    ...never("Session signing key. Rotating it invalidates every session including the operator's own, mid-request."),
  },
  {
    name: "KEYCLOAK_CLIENT_SECRET",
    group: "Authentication",
    sensitivity: "secret",
    home: "center.env",
    observable: true,
    path: false,
    fallback: null,
    impact: "The authorization-code exchange fails and no one can sign in.",
    ...never("Confidential client credential; the deploy's Keycloak client reconciliation owns it."),
  },
  {
    name: "KEYCLOAK_REALM",
    group: "Authentication",
    sensitivity: "identity",
    home: "center.env",
    observable: true,
    path: false,
    fallback: "humane",
    impact: "A wrong realm makes every token fail verification.",
    ...never("Identity topology; the deploy reconciles the realm's client against this."),
  },
  {
    name: "KEYCLOAK_CLIENT_ID",
    group: "Authentication",
    sensitivity: "identity",
    home: "center.env",
    observable: true,
    path: false,
    fallback: "center",
    impact:
      "Also the client whose roles grant the operator claim, so a wrong value silently removes operator access.",
    ...never("Identity topology, and half of the operator role lookup."),
  },
  {
    name: "KEYCLOAK_SCOPES",
    group: "Authentication",
    sensitivity: "operational",
    home: "center.env",
    observable: true,
    path: false,
    fallback: "openid email profile",
    impact: "Widen only once the realm defines the extra scopes, or authorization fails.",
    // `openid` is required, and its absence is the one failure here that locks
    // the operator out of the surface they made the change on: without it the
    // authorization request is not an OIDC request, no id_token comes back, and
    // no session — operator or wearer — can be minted until the next deploy
    // undoes it. Refusing that value at the form is the only cheap moment.
    ...proposable({
      kind: "tokens",
      required: ["openid"],
      pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$",
      maximum: 12,
    }),
  },
  {
    name: "COSMOS_OPERATOR_EMAILS",
    group: "Authentication",
    sensitivity: "identity",
    home: "center.env",
    observable: true,
    path: false,
    fallback: null,
    impact:
      "The self-hosted bootstrap allowlist. Empty is normal and correct once the legacy `carry-operator` realm role is granted.",
    ...never("An editor here converts one operator session into permanent operator access for any address."),
  },

  // ── Backend ───────────────────────────────────────────────────────────────
  {
    name: "COSMOS_WEBAPI_BASE_URL",
    group: "Backend",
    sensitivity: "operational",
    home: "center.env",
    observable: true,
    path: false,
    fallback: null,
    impact: "Memories, captures and notes have no source; those panes render unavailable.",
    ...never("Points Center at its backend; the Compose network topology owns it."),
  },
  {
    name: "COSMOS_GRPC_ENDPOINT",
    group: "Backend",
    sensitivity: "operational",
    home: "center.env",
    observable: true,
    path: false,
    fallback: null,
    impact: "The fallback endpoint for any workload without its own COSMOS_ENDPOINT_*.",
    ...never("Service topology, rendered from Compose service names."),
  },
  {
    name: "COSMOS_ADMIN_TOKEN",
    group: "Backend",
    sensitivity: "secret",
    home: "center.env",
    observable: true,
    path: false,
    fallback: null,
    impact:
      "Without it the operator console is unavailable: overview, flags and provisioning all answer 503.",
    ...never("Backend admin credential, and one of the values drift.sh requires to be identical across all four env files."),
  },
  {
    name: "COSMOS_EDGE_TOKEN",
    group: "Backend",
    sensitivity: "secret",
    home: "center.env",
    observable: true,
    path: false,
    fallback: null,
    impact: "The edge rejects Center's calls to the backend.",
    ...never("drift.sh requires this to be byte-identical in all four env files AND to appear exactly twice in the rendered edge/envoy.yaml."),
  },
  {
    name: "COSMOS_CENTER_PROJECTION_TOKEN",
    group: "Backend",
    sensitivity: "secret",
    home: "center.env",
    observable: true,
    path: false,
    fallback: null,
    impact: "The purpose-scoped wearer projection Center reads is refused.",
    ...never("Purpose-scoped credential shared with the backend; both sides must change together."),
  },
  {
    name: "COSMOS_SHARE_TOKEN_SECRET",
    group: "Backend",
    sensitivity: "secret",
    home: "center.env",
    observable: true,
    path: false,
    fallback: null,
    impact: "Share links cannot be minted or verified.",
    ...never("Rotating it invalidates every share link already handed out."),
  },
  {
    name: "COSMOS_DEADLINE_MS",
    group: "Backend",
    sensitivity: "operational",
    home: "center.env",
    observable: true,
    path: false,
    fallback: "8000",
    impact: "Per-call deadline for gRPC and the web API. Raise it only for a slow backend.",
    ...proposable(
      timeoutMs(1_000, 120_000),
      undeliverable(
        "The Center service declares an explicit environment allowlist in platform/compose/production.yaml and COSMOS_DEADLINE_MS is not on it, so a value in center.env is never handed to the container that reads it — this deployment always runs the coded defaults. Adding it to that allowlist is a Compose change, and not a free one: server/cosmos.ts falls back to 20000 for the upload call and 8000 elsewhere, so a single value would also shorten the upload deadline.",
      ),
    ),
  },
  {
    name: "COSMOS_FEATURE_FLAGS_METRICS_URL",
    group: "Backend",
    sensitivity: "operational",
    home: "compose",
    observable: true,
    path: false,
    fallback: null,
    impact:
      "Optional. Without it a flag change reports push_queued instead of confirming the device fetched it.",
    ...proposable(
      { kind: "origin", schemes: ["http", "https"] },
      undeliverable(
        "compose.yaml assigns the Center service this value as a literal, and production.yaml merges rather than overrides that block, so no env file can change it. Edit compose.yaml and deploy.",
      ),
    ),
  },
  {
    name: "COSMOS_CONTRACTS_DIR",
    group: "Backend",
    sensitivity: "operational",
    home: "compose",
    observable: true,
    path: true,
    fallback: "../contracts/wire",
    impact:
      "A wrong path throws inside the first gRPC call, and every workload-backed pane renders the wording reserved for a backend outage.",
    ...never("Set by the container image to match where the build stage copied the contracts."),
  },
  {
    name: "COSMOS_CHANNEL_KEY_FILE",
    group: "Backend",
    sensitivity: "secret",
    home: "center.env",
    observable: true,
    path: true,
    fallback: ".cosmos-channel-key.json in the working directory",
    impact:
      "Must be on the persistent volume and readable by 1000:1001, or established channel keys are lost on restart.",
    ...never("Points at wearer key material; the deploy owns the volume it must live on."),
  },

  // ── Device pairing ────────────────────────────────────────────────────────
  {
    name: "REVIVAL_PIN_BRIDGE_OWNER_SUB",
    group: "Device pairing",
    sensitivity: "identity",
    home: "center.env",
    observable: true,
    path: false,
    fallback: null,
    impact: "The exact Keycloak subject paired to this Pin. Nothing else may drive the bridge.",
    ...never("drift.sh cross-checks this against the pairing rows derived from Postgres; editing one side re-points the bridge at a different owner."),
  },
  {
    name: "REVIVAL_PIN_BRIDGE_DEVICE_ID",
    group: "Device pairing",
    sensitivity: "identity",
    home: "center.env",
    observable: true,
    path: false,
    fallback: null,
    impact: "The exact device the pinned bridge targets.",
    ...never("drift.sh cross-checks this against the pairing rows derived from Postgres."),
  },
  {
    name: "REVIVAL_SPOTIFY_ADAPTER_URL",
    group: "Device pairing",
    sensitivity: "operational",
    home: "compose",
    observable: true,
    path: false,
    fallback: null,
    impact: "Spotify controls are unavailable. Center never holds Spotify credentials either way.",
    ...never("The adapter's bind address is a Compose literal on a private network."),
  },
  {
    name: "REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE",
    group: "Device pairing",
    sensitivity: "secret",
    home: "compose",
    observable: true,
    path: true,
    fallback: null,
    impact:
      "Mounted as a Compose secret. drift.sh requires it to be at least 32 bytes, owned 1000:1001, mode 400 or 440, and different from COSMOS_EDGE_TOKEN.",
    ...never("Purpose-scoped adapter credential with mode and owner asserted by drift.sh."),
  },
  {
    name: "REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS",
    group: "Device pairing",
    sensitivity: "operational",
    home: "runtime.env",
    observable: true,
    path: false,
    fallback: "5000",
    impact: "How long a Spotify control call may take before it reports unavailable.",
    ...proposable(timeoutMs(500, 60_000)),
  },

  // ── Pin releases ──────────────────────────────────────────────────────────
  {
    name: "REVIVAL_PIN_RELEASE_DIR",
    group: "Pin releases",
    sensitivity: "operational",
    home: "compose",
    observable: true,
    path: true,
    fallback: null,
    impact:
      "Unset or unreadable means the installer serves no release and /api/pin/releases/current answers 503.",
    ...never("A read-only mount whose host path the deploy owns."),
  },
  {
    name: "REVIVAL_PIN_SETUP_ORIGIN",
    group: "Pin releases",
    sensitivity: "operational",
    home: "compose",
    observable: true,
    path: false,
    fallback: null,
    // Named for the standalone Setup SPA that used to fetch artifacts from its
    // own origin. The installer is part of Center now, so this is set to
    // Center's own origin and grants nothing the same-origin rule would not.
    // It remains the one seam for a non-Center client. Do NOT clear it as a
    // hardening step: canary.sh and staging-smoke.sh pin it to Center's exact
    // origin, so an empty value fails the deploy instead of tightening anything.
    impact:
      "The one extra origin allowed to fetch release artifacts, beyond Center's own. Wrong value means 403 on download.",
    ...proposable(
      { kind: "origin", schemes: ["https"] },
      undeliverable(
        "platform/compose/production.yaml assigns the Center service this value as a literal, so no env file can change it. canary.sh and staging-smoke.sh also pin it to Center's exact origin, so changing it is a Compose edit AND a change to those two gates, together, in one release.",
      ),
    ),
  },

  // ── Deployment identity ───────────────────────────────────────────────────
  {
    name: "REVIVAL_RELEASE_ID",
    group: "Deployment",
    sensitivity: "operational",
    home: "runtime.env",
    observable: true,
    path: false,
    fallback: null,
    impact: "The immutable revision reported by /api/version and stamped on every image label.",
    ...never("The release identity the image evidence and the release manifest are computed against."),
  },
  {
    name: "REVIVAL_DEPLOYMENT_ENVIRONMENT",
    group: "Deployment",
    sensitivity: "operational",
    home: "compose",
    observable: true,
    path: false,
    fallback: "production",
    impact: "Shown on the About pane so a reader knows which deployment they are looking at.",
    ...never("Declares which deployment this is; the Compose profile owns it."),
  },
  {
    name: "REVIVAL_CENTER_CONFIG_PROPOSALS_FILE",
    group: "Deployment",
    sensitivity: "operational",
    home: "compose",
    observable: true,
    // Not a `path` check. This file legitimately does not exist until the first
    // proposal is saved, and an absent store is the healthy first-run state —
    // reporting a healthy deployment as `unreadable` is the false alarm that
    // teaches an operator to ignore this pane.
    path: false,
    fallback: "/data/configuration-proposals.json",
    impact:
      "Where dashboard configuration proposals wait for the next deploy. The deploy reads it from the Center data volume by its coded name, so pointing this somewhere else leaves proposals saved and permanently unapplied.",
    ...never("The one path the deploy looks for pending proposals at; re-pointing it from the dashboard would silently disconnect the writer from the thing that applies it."),
  },

  // ── Providers (another container's environment) ───────────────────────────
  {
    name: "COSMOS_AZURE_SPEECH_KEY",
    group: "Providers",
    sensitivity: "secret",
    home: "providers.env",
    observable: false,
    path: false,
    fallback: null,
    impact: "Remote text-to-speech is unavailable; the Pin falls back to on-device speech.",
    ...never("Third-party credential held by the backend. It never enters this container."),
  },
  {
    name: "COSMOS_AZURE_SPEECH_REGION",
    group: "Providers",
    sensitivity: "operational",
    home: "providers.env",
    observable: false,
    path: false,
    fallback: null,
    impact: "Must match the region the speech key was issued for, or every synthesis call fails.",
    ...never("Paired with the speech key; both belong to the backend's environment."),
  },
  {
    name: "COSMOS_AZURE_SPEECH_VOICE",
    group: "Providers",
    sensitivity: "operational",
    home: "providers.env",
    observable: false,
    path: false,
    fallback: "en-US-AvaMultilingualNeural",
    impact: "Which voice the Pin speaks with.",
    // A locale followed by a voice name, which is Azure's own shape. The
    // catalog does not enumerate voices: the region decides which exist, the
    // list changes, and a wrong-but-well-formed name fails at the provider with
    // a message that names the voice — which is the §4 bargain.
    ...proposable({
      kind: "identifier",
      pattern: "^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+$",
      maximum: 64,
      shape: "a locale and voice name, like en-US-AvaMultilingualNeural",
    }),
  },
  {
    name: "COSMOS_MUSICBRAINZ_BASE_URL",
    group: "Providers",
    sensitivity: "operational",
    home: "providers.env",
    observable: false,
    path: false,
    fallback: "https://musicbrainz.org",
    impact: "Which real recording catalog backs smart playlists.",
    ...never("Backend egress destination; it never enters this container."),
  },
  {
    name: "COSMOS_SHOPPING_VISUAL_SEARCH_URL",
    group: "Providers",
    sensitivity: "operational",
    home: "providers.env",
    observable: false,
    path: false,
    fallback: null,
    impact: "Visual product search remains unavailable until a catalog adapter is configured.",
    ...never("Backend egress destination; it never enters this container."),
  },
  {
    name: "COSMOS_SHOPPING_ALLOWED_HOSTS",
    group: "Providers",
    sensitivity: "operational",
    home: "providers.env",
    observable: false,
    path: false,
    fallback: null,
    impact: "The visual-search endpoint is refused unless its exact hostname is listed.",
    ...never("Must be reviewed with the backend endpoint."),
  },
  {
    name: "COSMOS_SHOPPING_API_KEY",
    group: "Providers",
    sensitivity: "secret",
    home: "providers.env",
    observable: false,
    path: false,
    fallback: null,
    impact: "Authenticated visual product search cannot run.",
    ...never("Third-party credential held by the backend."),
  },
  {
    name: "COSMOS_LLM_API_KEY",
    group: "Providers",
    sensitivity: "secret",
    home: "providers.env",
    observable: false,
    path: false,
    fallback: null,
    impact: "The assistant cannot answer.",
    ...never("Third-party credential held by the backend."),
  },
  {
    name: "COSMOS_LLM_BASE_URL",
    group: "Providers",
    sensitivity: "operational",
    home: "providers.env",
    observable: false,
    path: false,
    fallback: null,
    impact: "Which inference endpoint the assistant calls.",
    ...never("Changing the endpoint changes where wearer prompts are sent."),
  },
  {
    name: "COSMOS_LLM_MODEL",
    group: "Providers",
    sensitivity: "operational",
    home: "providers.env",
    observable: false,
    path: false,
    fallback: null,
    impact: "Which model answers. Safe to change; wrong values fail loudly at the provider.",
    ...proposable(modelIdentifier("a provider model id, like openai/gpt-4o-mini")),
  },
  {
    name: "COSMOS_VISION_MODEL",
    group: "Providers",
    sensitivity: "operational",
    home: "runtime.env",
    observable: false,
    path: false,
    fallback: null,
    impact: "Which model reads what the camera captured.",
    ...proposable(modelIdentifier("a provider model id, like openai/gpt-4o-mini")),
  },

  // ── Backend workloads (another container's environment) ───────────────────
  {
    name: "COSMOS_REMOTE_TTS_ENABLED",
    group: "Backend workloads",
    sensitivity: "operational",
    home: "cosmos.env",
    observable: false,
    path: false,
    fallback: null,
    impact:
      "Whether the backend synthesizes speech remotely. The deploy proves the provider with a live canary before it commits.",
    ...proposable(
      { kind: "boolean" },
      undeliverable(
        "deploy.sh proves the speech provider returns real audio and then sets COSMOS_REMOTE_TTS_ENABLED=true in the staged cosmos.env itself, after any proposal is applied — so a value set here would be overwritten by the deploy that was supposed to contain it. Turning remote speech off is a change to that step, not to an env file.",
      ),
    ),
  },
  {
    name: "COSMOS_ENROLLMENT_PINCODE",
    group: "Backend workloads",
    sensitivity: "secret",
    home: "cosmos.env",
    observable: false,
    path: false,
    fallback: null,
    impact: "The four-digit code the Pin needs to enroll against this deployment.",
    ...never("Low entropy and required to agree across runtime, cosmos and center — even its LENGTH is a partial secret."),
  },
  {
    name: "COSMOS_DATABASE_URL",
    group: "Backend workloads",
    sensitivity: "secret",
    home: "cosmos.env",
    observable: false,
    path: false,
    fallback: null,
    impact: "Every workload loses persistence.",
    ...never("Carries the database password, and the deploy transaction restores against this exact database."),
  },
  {
    name: "COSMOS_REQUIRE_DEVICE_ATTESTATION",
    group: "Backend workloads",
    sensitivity: "identity",
    home: "cosmos.env",
    observable: false,
    path: false,
    fallback: null,
    impact: "Whether the backend demands a valid device attestation before serving a Pin.",
    ...never("A device authorization boundary. Weakening it from a browser is exactly the move to prevent."),
  },
  {
    name: "COSMOS_DUC_CA_KEY",
    group: "Backend workloads",
    sensitivity: "secret",
    home: "runtime.env",
    observable: false,
    path: false,
    fallback: null,
    impact: "The device-user CA. Without it no device identity can be issued.",
    ...never("This key MINTS device identities. Its writer must not be reachable from a browser under any gate."),
  },
];

/**
 * Derive one setting's state.
 *
 * The environment value is read into a local, reduced immediately to a boolean,
 * and never leaves this function. There is deliberately no branch that returns,
 * measures or hashes it.
 */
async function stateOf(setting: ConfigurationSetting): Promise<ConfigurationState> {
  if (!setting.observable) return "unobservable";

  const present = (process.env[setting.name] ?? "").trim().length > 0;
  if (!present) return setting.fallback === null ? "missing" : "default";

  if (setting.path) {
    // A path that is set but unreadable is the failure this pane exists to
    // surface: it renders as "configured" everywhere else while the feature is
    // quietly dead. `access` is used rather than a read so nothing this module
    // touches can ever hold key material in memory.
    const target = (process.env[setting.name] ?? "").trim();
    try {
      await access(target, constants.R_OK);
    } catch {
      return "unreadable";
    }
  }
  return "configured";
}

/**
 * The four protected env files the deploy stages, by the `home` that names one.
 *
 * `compose` is deliberately absent rather than mapped to a "closest" file: a
 * value written into runtime.env for a variable production.yaml sets as a
 * literal is overridden at container start and the operator is told a change
 * landed that never did.
 */
const ENV_FILE_HOMES = new Set<ConfigurationHome>([
  "center.env",
  "runtime.env",
  "cosmos.env",
  "providers.env",
]);

/**
 * Which env file, if any, a proposal for this setting would be written into.
 *
 * Null is the answer for everything the writer must refuse, and it is one
 * function rather than three checks scattered across the route, the store and
 * the console: not editable, not delivered by this deployment's Compose model,
 * or homed outside the four files the deploy stages.
 */
export function proposalTarget(setting: ConfigurationSetting): ConfigurationHome | null {
  if (setting.editable !== "deploy-proposal") return null;
  if (setting.delivery?.via !== "env-plane") return null;
  return ENV_FILE_HOMES.has(setting.home) ? setting.home : null;
}

function writabilityOf(setting: ConfigurationSetting): ConfigurationWritability {
  if (setting.editable !== "deploy-proposal") return "never";
  return proposalTarget(setting) ? "proposable" : "not-delivered";
}

/** Who starts with the value once the deploy has staged the file that holds it. */
const CARRIED_BY: Record<ConfigurationHome, string> = {
  "center.env": "the Center container",
  "runtime.env": "every service Compose interpolates it into",
  "cosmos.env": "the backend workloads",
  "providers.env": "the backend workloads, once staging merges it into runtime.env",
  compose: "the container Compose declares it on",
};

function effectOf(setting: ConfigurationSetting): ConfigurationEffect {
  const target = proposalTarget(setting);
  if (!target) {
    return {
      when: "no-writer",
      detail: "Nothing here changes this. It takes effect when the next deploy stages whatever you changed by hand.",
    };
  }
  return {
    when: "next-deploy",
    detail: `Saved now, written into ${target} by the next deploy, and read by ${CARRIED_BY[target]} when it restarts. Nothing changes before that deploy runs.`,
  };
}

function guidanceOf(setting: ConfigurationSetting): string | null {
  switch (writabilityOf(setting)) {
    case "proposable":
      return null;
    case "not-delivered":
      // The descriptor's own sentence, not a generic one. An operator told
      // "this cannot be changed here" goes looking in the env files, finds
      // nothing, adds a line, deploys, and watches it do nothing — so the
      // reason has to name the file that really decides.
      return setting.delivery?.via === "blocked"
        ? `${setting.name} is safe to change, but not from here: ${setting.delivery.reason}`
        : `${setting.name} cannot be delivered by this deployment's Compose model.`;
    case "never":
      return setting.sensitivity === "secret"
        ? `${setting.name} is credential material and has no dashboard writer, by design. Set it in ${setting.home} on the VPS, then deploy — the deploy is what records the new digests, so the change stays inside the transaction that makes rollback trustworthy.`
        : `${setting.name} has no dashboard writer. Set it in ${setting.home} on the VPS and deploy.`;
  }
}

/*
 * ───────────────────────────────────────────────────────────────────────────
 * VALIDATION
 *
 * Server-side and authoritative. The same constraint objects are serialized to
 * the browser so the form can render a hint, but nothing the client does is
 * trusted: `validateProposedValue` is called again in the route handler with
 * whatever bytes arrived, and it is the only thing that decides.
 *
 * Every refusal says what is wrong AND what would be right, in the operator's
 * terms. "Invalid value" is the message that sends someone to SSH.
 */

/** A refusal an operator can act on, or the exact bytes that will be stored. */
export type ProposedValueOutcome =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/**
 * The rule every proposed value obeys before its own constraint is consulted.
 *
 * These are not stylistic. A value is going to become the right-hand side of a
 * `KEY=value` line in a mode-600 file that Compose interpolates: a newline
 * forges a second assignment, and `update_env_value` in the deploy refuses one
 * outright — which would turn a typo in a browser into a failed deploy at the
 * point of no return rather than a rejected form. A non-ASCII byte is not
 * forbidden by the file format but has no legitimate use in any value this
 * catalog accepts, and it renders identically to a byte that is.
 */
const MAXIMUM_VALUE_LENGTH = 512;

function validateShared(name: string, raw: unknown): ProposedValueOutcome {
  if (typeof raw !== "string") {
    return { ok: false, reason: `${name} must be sent as a string.` };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return {
      ok: false,
      reason: `${name} cannot be empty. To stop proposing a value for it, remove the proposal instead — an empty assignment would be written into the env file as a real, empty setting.`,
    };
  }
  if (value.length > MAXIMUM_VALUE_LENGTH) {
    return {
      ok: false,
      reason: `${name} must be at most ${MAXIMUM_VALUE_LENGTH} characters; this one is ${value.length}.`,
    };
  }
  if (!/^[\x20-\x7e]+$/.test(value)) {
    return {
      ok: false,
      reason: `${name} may only contain printable ASCII. Line breaks, tabs and non-ASCII characters cannot be represented in an env file and would fail the deploy that tried to write them.`,
    };
  }
  return { ok: true, value };
}

function validateAgainst(
  name: string,
  value: string,
  constraint: ConfigurationConstraint,
): ProposedValueOutcome {
  switch (constraint.kind) {
    case "integer": {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        return {
          ok: false,
          reason: `${name} must be a whole number of ${constraint.unit} between ${constraint.minimum} and ${constraint.maximum}. "${value}" is not a whole number.`,
        };
      }
      const parsed = Number(value);
      if (parsed < constraint.minimum || parsed > constraint.maximum) {
        return {
          ok: false,
          reason: `${name} must be between ${constraint.minimum} and ${constraint.maximum} ${constraint.unit}; ${parsed} is outside that range.`,
        };
      }
      return { ok: true, value };
    }
    case "boolean": {
      if (value !== "true" && value !== "false") {
        return {
          ok: false,
          reason: `${name} must be exactly "true" or "false". The workload that reads it parses nothing else, and "${value}" would be read as false.`,
        };
      }
      return { ok: true, value };
    }
    case "origin": {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return {
          ok: false,
          reason: `${name} must be an absolute origin such as ${constraint.schemes[0]}://center.example.com. "${value}" is not a URL.`,
        };
      }
      if (!constraint.schemes.includes(parsed.protocol.replace(":", ""))) {
        return {
          ok: false,
          reason: `${name} must use ${constraint.schemes.join(" or ")}; "${parsed.protocol.replace(":", "")}" is not accepted here.`,
        };
      }
      // An origin with a path is the mistake that produces a CORS allowlist
      // entry matching nothing: the browser sends the origin alone, so a
      // trailing path silently never matches and downloads answer 403.
      if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
        return {
          ok: false,
          reason: `${name} must be an origin only — scheme, host and port. Drop everything after "${parsed.origin}"; a path or query here never matches and the value quietly stops working.`,
        };
      }
      if (parsed.origin !== value.replace(/\/$/, "")) {
        return {
          ok: false,
          reason: `${name} must be written exactly as "${parsed.origin}".`,
        };
      }
      return { ok: true, value: parsed.origin };
    }
    case "tokens": {
      const tokens = value.split(" ").filter((token) => token.length > 0);
      if (tokens.length > constraint.maximum) {
        return {
          ok: false,
          reason: `${name} may name at most ${constraint.maximum} values; this one names ${tokens.length}.`,
        };
      }
      const shape = new RegExp(constraint.pattern);
      const malformed = tokens.find((token) => !shape.test(token));
      if (malformed !== undefined) {
        return {
          ok: false,
          reason: `${name} is a space-separated list, and "${malformed}" is not a usable entry. Use letters, digits, and . _ : - only.`,
        };
      }
      const missing = constraint.required.filter((required) => !tokens.includes(required));
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `${name} must include ${missing.join(" and ")}. Without it the authorization request is not an OIDC request, so no one — including you — can sign in until a later deploy puts it back.`,
        };
      }
      return { ok: true, value: tokens.join(" ") };
    }
    case "identifier": {
      if (value.length > constraint.maximum) {
        return {
          ok: false,
          reason: `${name} must be at most ${constraint.maximum} characters; this one is ${value.length}.`,
        };
      }
      if (!new RegExp(constraint.pattern).test(value)) {
        return {
          ok: false,
          reason: `${name} must be ${constraint.shape}. "${value}" is not that shape.`,
        };
      }
      return { ok: true, value };
    }
  }
}

/**
 * May this name be proposed at all, and is this value acceptable for it?
 *
 * ONE function, because the two questions have one answer and separating them
 * is how a caller ends up checking the second without the first. The name is
 * looked up in the catalog rather than trusted: an unknown name, a `never`
 * name, and a name whose home is a Compose literal are all refused here, before
 * any value is examined, so nothing outside §4's list can reach the store even
 * if a route handler forgets to ask.
 */
export function validateProposedValue(name: string, raw: unknown): ProposedValueOutcome {
  const setting = CATALOG.find((entry) => entry.name === name);
  if (!setting) {
    return { ok: false, reason: `${name} is not a setting this deployment reads.` };
  }
  if (setting.editable !== "deploy-proposal") {
    return {
      ok: false,
      reason:
        setting.restriction ??
        `${name} cannot be changed from the dashboard.`,
    };
  }
  if (!proposalTarget(setting)) {
    return { ok: false, reason: guidanceOf(setting) ?? `${name} cannot be changed from the dashboard.` };
  }
  if (!setting.constraint) {
    // Unreachable while the verify test holds; stated rather than assumed,
    // because the failure mode of assuming is a free-text write.
    return { ok: false, reason: `${name} has no declared constraint, so no value can be accepted for it.` };
  }

  const shared = validateShared(name, raw);
  if (!shared.ok) return shared;
  return validateAgainst(name, shared.value, setting.constraint);
}

const EMPTY_COUNTS: Record<ConfigurationState, number> = {
  configured: 0,
  default: 0,
  missing: 0,
  unreadable: 0,
  unobservable: 0,
};

/**
 * The whole inventory: every catalogued setting, with a state and no value.
 *
 * Read per call rather than captured at import, so a restarted container and a
 * test that points one entry at a scratch path both see the truth.
 */
export async function configurationInventory(): Promise<ConfigurationInventory> {
  const settings = await Promise.all(
    CATALOG.map(async (setting) => ({
      ...setting,
      state: await stateOf(setting),
      // All three are derived from the descriptor, never from the environment.
      // Keeping them out of the descriptors means a new entry cannot claim to
      // be writable in a way that disagrees with `editable` and `home`.
      writable: writabilityOf(setting),
      effect: effectOf(setting),
      guidance: guidanceOf(setting),
    })),
  );
  const counts = { ...EMPTY_COUNTS };
  for (const setting of settings) counts[setting.state] += 1;
  return {
    settings,
    counts,
    complete: counts.missing === 0 && counts.unreadable === 0,
  };
}

/** The catalog itself, for tests and for a future writer's allowlist check. */
export function configurationCatalog(): readonly ConfigurationSetting[] {
  return CATALOG;
}
