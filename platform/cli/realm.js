'use strict';
// Luma's identity realm policy, and the two ways it reaches Keycloak. Setup
// writes it into the seed Keycloak imports only when it creates the realm.
// Keycloak skips that import once the realm exists, so every confirmed deploy
// also reconciles the running realm through Keycloak's own admin CLI.

const child = require('node:child_process');

const { resolveTool } = require('./authority');

const REALM = 'humane';

// `basic` puts `sub` in the access token, which Cosmos requires of the Bearer
// Center forwards.
const CENTER_DEFAULT_SCOPES = Object.freeze(['web-origins', 'acr', 'roles', 'profile', 'email', 'basic']);

// A temporary lockout that grows to 15 minutes. A permanent one would lock the
// owner, usually the only account, out until someone reached the server.
const BRUTE_FORCE = Object.freeze({
  bruteForceProtected: true,
  permanentLockout: false,
  failureFactor: 10,
  waitIncrementSeconds: 60,
  maxFailureWaitSeconds: 900,
  maxDeltaTimeSeconds: 43200,
  quickLoginCheckMilliSeconds: 1000,
  minimumQuickLoginWaitSeconds: 60,
});

// INFERRED Luma stay-signed-in policy. Keycloak 26's
// SessionExpirationUtils maps zero SSO timeouts back to defaults, not infinity.
// Keep ordinary revocable sessions. Offline grants survive normal logout.
const SESSION_POLICY = Object.freeze({
  ssoSessionIdleTimeout: 10 * 365 * 86400,
  ssoSessionMaxLifespan: 10 * 365 * 86400,
  ssoSessionIdleTimeoutRememberMe: 10 * 365 * 86400,
  ssoSessionMaxLifespanRememberMe: 10 * 365 * 86400,
  clientSessionIdleTimeout: 0,
  clientSessionMaxLifespan: 0,
  accessTokenLifespan: 900,
});

// Keycloak 26 requires both names by default and holds back an account without
// them behind a profile step that Center's direct password grant can never
// finish ("Account is not fully set up"). Center identifies accounts by email.
const OPTIONAL_PROFILE_ATTRIBUTES = Object.freeze(['firstName', 'lastName']);

const USER_PROFILE_PERMISSIONS = Object.freeze({ view: ['admin', 'user'], edit: ['admin', 'user'] });

/** Keycloak 26's default user profile, with first and last name optional. */
function userProfile() {
  return {
    attributes: [
      {
        name: 'username',
        displayName: '${username}',
        validations: { length: { min: 3, max: 255 }, 'username-prohibited-characters': {}, 'up-username-not-idn-homograph': {} },
        permissions: USER_PROFILE_PERMISSIONS,
        multivalued: false,
      },
      {
        name: 'email',
        displayName: '${email}',
        validations: { email: {}, length: { max: 255 } },
        required: { roles: ['user'] },
        permissions: USER_PROFILE_PERMISSIONS,
        multivalued: false,
      },
      ...OPTIONAL_PROFILE_ATTRIBUTES.map((name) => ({
        name,
        displayName: `\${${name}}`,
        validations: { length: { max: 255 }, 'person-name-prohibited-characters': {} },
        permissions: USER_PROFILE_PERMISSIONS,
        multivalued: false,
      })),
    ],
    groups: [{
      name: 'user-metadata',
      displayHeader: 'User metadata',
      displayDescription: 'Attributes, which refer to user metadata',
    }],
  };
}

/**
 * The realm-level policy both realm seeds carry. A seeded realm has no SMTP
 * server, and Keycloak's "Forgot password" can only send an email, so it stays
 * off. The reconcile turns it on once an owner configures SMTP.
 */
function realmPolicy() {
  return {
    resetPasswordAllowed: false,
    ...BRUTE_FORCE,
    ...SESSION_POLICY,
    components: {
      'org.keycloak.userprofile.UserProfileProvider': [{
        providerId: 'declarative-user-profile',
        subComponents: {},
        config: { 'kc.user.profile.config': [JSON.stringify(userProfile())] },
      }],
    },
  };
}

/** The default scopes the Center client lacks. Without `basic`, its access tokens carry no `sub`. */
function missingCenterScopes(defaultScopes) {
  const present = new Set(defaultScopes.map((scope) => scope.name));
  return CENTER_DEFAULT_SCOPES.filter((name) => !present.has(name));
}

/**
 * The admin changes that bring a running realm onto Luma's policy, from what
 * Keycloak reported. Pure, so every decision is testable without Keycloak.
 * Each change is `{ summary, args, body? }`: kcadm arguments, plus a JSON body
 * sent on standard input.
 */
function planRealmReconcile({
  realm, clientId, client, defaultScopes, optionalScopes = [], scopes, profile, users = [], defaultRoleHolders = [],
  directGrantExecutions = [], directGrantAlias = null,
}) {
  const changes = [];
  for (const name of missingCenterScopes(defaultScopes)) {
    const scope = scopes.find((candidate) => candidate.name === name);
    if (!scope) throw new Error(`realm ${REALM} has no ${name} client scope to give the ${clientId} client`);
    // Keycloak silently keeps a scope that is already optional, so it must
    // leave the optional list before it can become a default.
    if (optionalScopes.some((candidate) => candidate.name === name)) {
      changes.push({
        summary: `removed ${name} from the ${clientId} client's optional scopes`,
        args: ['delete', `clients/${client.id}/optional-client-scopes/${scope.id}`, '-r', REALM],
      });
    }
    changes.push({
      summary: `added the ${name} default scope to the ${clientId} client`,
      args: ['update', `clients/${client.id}/default-client-scopes/${scope.id}`, '-r', REALM],
    });
  }

  const timeoutOverrides = ['client.session.idle.timeout', 'client.session.max.lifespan'];
  if (timeoutOverrides.some((name) => Number(client.attributes?.[name] || 0) !== 0)) {
    changes.push({
      summary: `made the ${clientId} client inherit the persistent session policy`,
      args: ['update', `clients/${client.id}`, '-r', REALM, '-f', '-'],
      body: { attributes: { ...client.attributes, ...Object.fromEntries(timeoutOverrides.map((name) => [name, '0'])) } },
    });
  }

  // Keycloak gives its default roles to every account it creates, but not to
  // one a realm import creates, and earlier seeds listed none. Without them
  // the account console, where Center sends the owner to change a password,
  // refuses the account.
  const holders = new Set(defaultRoleHolders.map((user) => user.id));
  for (const user of users.filter((candidate) => !holders.has(candidate.id))) {
    const role = realm.defaultRole?.name;
    if (!role) throw new Error(`realm ${REALM} reports no default role`);
    changes.push({
      summary: `gave ${user.username} the realm's default roles, which the account console requires`,
      args: ['add-roles', '-r', REALM, '--uid', user.id, '--rolename', role],
    });
  }

  const required = (profile.attributes || []).filter((attribute) =>
    OPTIONAL_PROFILE_ATTRIBUTES.includes(attribute.name) && attribute.required !== undefined);
  if (required.length) {
    const body = {
      ...profile,
      attributes: profile.attributes.map((attribute) => {
        if (!required.includes(attribute)) return attribute;
        const { required: _required, ...optional } = attribute;
        return optional;
      }),
    };
    changes.push({
      summary: `made ${required.map((attribute) => attribute.name).join(' and ')} optional in the user profile`,
      args: ['update', 'users/profile', '-r', REALM, '-f', '-'],
      body,
    });
  }

  // Center's sign-in is Keycloak's direct password grant: the stock form has
  // username and password and no field for a one-time code, and the Pin's
  // enrollment sends the password alone. An authenticator added in Keycloak's
  // account console must protect those pages without locking Center out,
  // whose clients cannot answer a code, so the direct grant flow validates
  // the password and nothing else. Keycloak's own sign-in keeps offering the
  // code, because the browser flow is untouched. The code step sits in the
  // conditional subflow "Direct Grant - Conditional OTP", so the subflow is
  // what gets disabled: disabling only its OTP step leaves "Condition - user
  // configured" with nothing to check, the condition then matches every
  // account, and Keycloak 26 fails the empty subflow with an uncaught
  // AuthenticationFlowException (HTTP 500) on every password grant, the
  // state 0.3.40 to 0.3.42 left behind, so a disabled OTP step is restored.
  // Keycloak changes an execution's requirement through the flow: one PUT on
  // the flow's executions carries the execution's id, its current priority,
  // and the new requirement.
  const otpAt = directGrantExecutions.findIndex((execution) => execution.providerId === 'direct-grant-validate-otp');
  const otp = directGrantExecutions[otpAt];
  const subflow = directGrantExecutions.slice(0, Math.max(otpAt, 0)).findLast((execution) =>
    execution.authenticationFlow === true && execution.level === (otp?.level ?? 0) - 1);
  const executionsPath = `authentication/flows/${encodeURIComponent(directGrantAlias)}/executions`;
  if (subflow && directGrantAlias && subflow.requirement !== 'DISABLED' && typeof subflow.priority === 'number') {
    changes.push({
      summary: 'let an account with a second factor sign in to Center (the direct grant no longer asks for a code, which its form has no field for)',
      args: ['update', executionsPath, '-r', REALM, '-f', '-'],
      body: { id: subflow.id, requirement: 'DISABLED', priority: subflow.priority },
    });
  }
  if (subflow && directGrantAlias && otp.requirement === 'DISABLED' && typeof otp.priority === 'number') {
    changes.push({
      summary: 'restored the direct grant\'s code step inside its now-disabled subflow (disabling the step alone failed every Center sign-in)',
      args: ['update', executionsPath, '-r', REALM, '-f', '-'],
      body: { id: otp.id, requirement: 'REQUIRED', priority: otp.priority },
    });
  }

  const smtp = Boolean(realm.smtpServer?.host);
  const desired = { ...BRUTE_FORCE, ...SESSION_POLICY, resetPasswordAllowed: smtp };
  const settings = Object.fromEntries(Object.entries(desired).filter(([name, value]) => realm[name] !== value));
  if (Object.keys(settings).length) {
    const said = [];
    if (settings.bruteForceProtected) {
      said.push(`turned on brute-force protection (a temporary lockout after ${BRUTE_FORCE.failureFactor} failed sign-ins)`);
    } else if (Object.keys(settings).some((name) => Object.hasOwn(BRUTE_FORCE, name))) {
      said.push('restored Luma\'s brute-force lockout settings');
    }
    if (Object.hasOwn(settings, 'resetPasswordAllowed')) {
      said.push(smtp
        ? 'turned on Forgot password because an SMTP server is configured'
        : 'turned off Forgot password, which can only send an email and this realm has no SMTP server');
    }
    if (Object.keys(settings).some((name) => Object.hasOwn(SESSION_POLICY, name))) {
      said.push('enabled persistent Center sign-in (ten-year sessions, fifteen-minute access tokens)');
    }
    changes.push({ summary: said.join('; '), args: ['update', `realms/${REALM}`, '-f', '-'], body: settings });
  }
  return changes;
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/u).map((line) => line.trim())
    .find((line) => line && !line.startsWith('Logging into ')) || 'no error output';
}

// Runs inside the Keycloak container, whose own environment holds the
// bootstrap admin credentials. They never reach this host's arguments, output,
// or the container's process list. `--no-config` keeps no token on disk. The
// small heap stays inside the container's memory limit beside Keycloak.
const KCADM = [
  'KC_OPTS="-Xmx96m -XX:+UseSerialGC -XX:TieredStopAtLevel=1"',
  'KC_CLI_PASSWORD="$KC_BOOTSTRAP_ADMIN_PASSWORD"',
  'exec /opt/keycloak/bin/kcadm.sh "$@" --no-config --server http://localhost:8080',
  '--realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME"',
].join(' ');

/**
 * Keycloak's admin CLI inside this Compose project's running Keycloak.
 * `run(args, body)` answers the parsed JSON Keycloak printed, or null.
 */
function keycloakAdmin({ project = 'luma', docker = resolveTool('docker'), env = process.env } = {}) {
  const spawn = (args, input = '') => child.spawnSync(docker, args, {
    env,
    input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  const listed = spawn([
    'ps', '--quiet',
    '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', 'label=com.docker.compose.service=keycloak',
    '--filter', 'status=running',
  ]);
  if (listed.error || listed.status !== 0) {
    throw new Error(`docker could not list the ${project} Keycloak container: ${firstLine(listed.stderr || listed.error?.message)}`);
  }
  const containers = listed.stdout.split(/\r?\n/u).filter(Boolean);
  if (containers.length === 0) {
    throw new Error(`Keycloak is not running in the ${project} Compose project; run ./luma deploy production --confirm first`);
  }
  if (containers.length > 1) {
    throw new Error(`the ${project} Compose project runs ${containers.length} Keycloak containers; expected one`);
  }
  const [container] = containers;
  return Object.freeze({
    run(args, body) {
      const result = spawn(
        ['exec', '-i', container, 'bash', '-c', KCADM, 'kcadm', ...args],
        body === undefined ? '' : JSON.stringify(body),
      );
      if (result.error || result.status !== 0) {
        const detail = firstLine(result.stderr || result.error?.message);
        const hint = /invalid user credentials|invalid_grant/iu.test(detail)
          ? ' Keycloak refused the bootstrap admin (KEYCLOAK_ADMIN in runtime.env); restore that admin account in the master realm, then rerun.'
          : '';
        throw new Error(`Keycloak admin ${args.slice(0, 2).join(' ')} failed: ${detail}.${hint}`);
      }
      const text = result.stdout.trim();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Keycloak admin ${args.slice(0, 2).join(' ')} printed something other than JSON`);
      }
    },
  });
}

function centerClient(admin, clientId) {
  const clients = admin.run(['get', 'clients', '-r', REALM, '-q', `clientId=${clientId}`, '--fields', 'id,clientId,attributes']);
  const client = Array.isArray(clients) ? clients.find((candidate) => candidate.clientId === clientId) : null;
  if (!client) throw new Error(`realm ${REALM} has no ${clientId} client`);
  const defaultScopes = admin.run(['get', `clients/${client.id}/default-client-scopes`, '-r', REALM]) || [];
  return { client, defaultScopes };
}

/** Read the running realm, apply what differs from Luma's policy, and say what changed. */
function reconcileRealm(admin, { clientId = 'center' } = {}) {
  const realm = admin.run(['get', `realms/${REALM}`]);
  const { client, defaultScopes } = centerClient(admin, clientId);
  const missing = missingCenterScopes(defaultScopes).length > 0;
  const scopes = missing ? admin.run(['get', 'client-scopes', '-r', REALM, '--fields', 'id,name']) || [] : [];
  const optionalScopes = missing
    ? admin.run(['get', `clients/${client.id}/optional-client-scopes`, '-r', REALM]) || []
    : [];
  const profile = admin.run(['get', 'users/profile', '-r', REALM]) || { attributes: [] };
  const everyone = ['--fields', 'id,username', '--offset', '0', '--limit', '10000'];
  const users = admin.run(['get', 'users', '-r', REALM, ...everyone]) || [];
  const role = realm.defaultRole?.name;
  const defaultRoleHolders = role ? admin.run(['get', `roles/${role}/users`, '-r', REALM, ...everyone]) || [] : [];
  // Center's sign-in is the direct grant flow, so its executions carry the
  // second-factor policy. The executions endpoint is keyed by the flow's
  // alias, not its id.
  const flows = admin.run(['get', 'authentication/flows', '-r', REALM]) || [];
  const directGrant = flows.find((flow) => flow.alias === 'direct grant' && flow.topLevel === true);
  const directGrantExecutions = directGrant
    ? admin.run(['get', `authentication/flows/${encodeURIComponent(directGrant.alias)}/executions`, '-r', REALM]) || []
    : [];
  const changes = planRealmReconcile({
    realm, clientId, client, defaultScopes, optionalScopes, scopes, profile, users, defaultRoleHolders,
    directGrantExecutions, directGrantAlias: directGrant?.alias ?? null,
  });
  for (const change of changes) admin.run(change.args, change.body);
  return changes.map((change) => change.summary);
}

/**
 * Read-only: the reconcile's own client-scope check, so an access token
 * Center receives would carry `sub`, which Cosmos requires of its Bearer.
 */
function checkCenterTokens(admin, { clientId = 'center' } = {}) {
  const { client, defaultScopes } = centerClient(admin, clientId);
  const missing = missingCenterScopes(defaultScopes);
  if (missing.length) {
    throw new Error(`the ${clientId} client lacks the default scope${missing.length === 1 ? '' : 's'} ` +
      `${missing.join(', ')}${missing.includes('basic') ? ', so its access tokens carry no sub and Cosmos refuses them' : ''}; ` +
      'run ./luma deploy production --confirm, which reconciles the realm');
  }
  const realm = admin.run(['get', `realms/${REALM}`, '--fields', Object.keys(SESSION_POLICY).join(',')]);
  const drift = Object.entries(SESSION_POLICY).some(([name, value]) => realm[name] !== value);
  const override = ['client.session.idle.timeout', 'client.session.max.lifespan']
    .some((name) => Number(client.attributes?.[name] || 0) !== 0);
  if (drift || override) throw new Error('Center session timeouts differ from this release; run ./luma deploy production --confirm to restore persistent sign-in');

}

/** What a reconcile changed, one line each, for the operator. */
function reconcileReport(changed) {
  if (!changed.length) return [`Identity realm ${REALM} already matches this release's policy.`];
  return changed.map((summary) => `Identity realm ${REALM}: ${summary}.`);
}

/**
 * Replace the password of the account with this exact email, clear any
 * brute-force lockout on it, and end its sessions. The password travels only
 * on standard input.
 */
function setAccountPassword(admin, { email, password }) {
  const users = admin.run([
    'get', 'users', '-r', REALM, '-q', `email=${email}`, '-q', 'exact=true', '--fields', 'id,email',
  ]);
  const matches = Array.isArray(users) ? users.filter((user) => user.email === email) : [];
  if (matches.length !== 1) throw new Error(`realm ${REALM} has no account with the email ${email}`);
  const [{ id }] = matches;
  admin.run(['update', `users/${id}/reset-password`, '-r', REALM, '-f', '-'], {
    type: 'password', value: password, temporary: false,
  });
  admin.run(['delete', `attack-detection/brute-force/users/${id}`, '-r', REALM]);
  admin.run(['create', `users/${id}/logout`, '-r', REALM]);
  return id;
}

// `reconcile` applies the policy after a confirmed deploy; `check` is
// verification's read-only look at the Center client's scopes.
function realmMain(args) {
  const usage = 'usage: bun platform/cli/realm.js reconcile|check [--project-name NAME]';
  const [command, ...options] = args;
  let project = process.env.COMPOSE_PROJECT_NAME || 'luma';
  if (command !== 'reconcile' && command !== 'check') throw new Error(usage);
  if (options.length) {
    if (options.length !== 2 || options[0] !== '--project-name' || !/^[a-z0-9][a-z0-9_-]*$/u.test(options[1])) {
      throw new Error(usage);
    }
    [, project] = options;
  }
  const admin = keycloakAdmin({ project });
  const clientId = process.env.KEYCLOAK_CLIENT_ID || 'center';
  if (command === 'check') {
    checkCenterTokens(admin, { clientId });
    return;
  }
  for (const line of reconcileReport(reconcileRealm(admin, { clientId }))) process.stdout.write(`${line}\n`);
}

if (require.main === module) {
  const command = process.argv[2] === 'check' ? 'check' : 'reconcile';
  try {
    realmMain(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: identity realm ${command} failed: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  BRUTE_FORCE,
  SESSION_POLICY,
  CENTER_DEFAULT_SCOPES,
  REALM,
  checkCenterTokens,
  keycloakAdmin,
  planRealmReconcile,
  realmPolicy,
  reconcileRealm,
  reconcileReport,
  setAccountPassword,
  userProfile,
};
