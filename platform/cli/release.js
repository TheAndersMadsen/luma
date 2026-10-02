'use strict';
// `./luma release publish` publishes one tagged release from the maintainer's
// machine (the signing keys never leave it, so CI runs checks but has no
// publication path), and every step below has exactly one implementation:
//
//   1. preflight, even for a plan: the ghcr.io login must be able to write
//      this repository's packages, the version must not be published on
//      GitHub or have unreceipted image tags on ghcr.io, because a release is
//      published once and a broken push after an hour of builds wastes it, and
//      a confirmed run needs the release signing key;
//   2. local builds, in parallel: the first-party images for linux/amd64 and
//      linux/arm64 into the BuildKit cache, and the Pin release (built and
//      signed from the protected signing.env with --pin-version, otherwise the
//      exact pinned signed archive is downloaded and verified);
//   3. pushes, one image at a time with bounded retries, because an unreliable
//      uplink drops parallel registry uploads. Each verified push writes a
//      receipt;
//   4. the audited, digest-pinned Compose application and its receipt;
//   5. the operator archive from platform/distribution/build.mjs;
//   6. the release signature: cosign signs SHA256SUMS with the maintainer's
//      key (`./luma release keygen`), and the signature is verified against
//      the committed public key that the one-line installer embeds.
//
// Every finished step leaves a receipt or an artifact in the publication
// directory, so a rerun resumes where the last one stopped. Without --confirm
// the command prints the plan and changes nothing.

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  BUILD_DIR,
  DATA_DIR,
  MINIMUM_COMPOSE_VERSION,
  ROOT,
  SECRETS_DIR,
  fail,
  operatorEnvironment,
  resolveTool,
  secureDirectory,
} = require('./context');
const { parseVersion, versionAtLeast } = require('./toolchain');
const { dockerCredential } = require('./registry');

const USAGE = './luma release publish --version X.Y.Z ' +
  '[--pin-version YYYY-MM-DD.N --pin-version-code INTEGER] [--notes FILE|-] [--confirm]\n' +
  '       ./luma release keygen';
const RELEASE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const PIN_VERSION = /^\d{4}-\d{2}-\d{2}\.\d+$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SOURCE_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const BUILDER = 'luma-release';
const ATTEMPTS = 5;
const RETRY_DELAY_MS = 15_000;
// Refusals another attempt cannot fix, with what to do instead.
const PERMANENT_FAILURES = Object.freeze([
  [/unauthori[sz]ed|denied|forbidden|authentication required|bad credentials|gh auth login/iu,
    'check the credentials this step uses: `./luma registry login --username GITHUB_USER` with a token ' +
    'that can write packages for ghcr.io, `gh auth status` for GitHub downloads'],
  [/required local command is unavailable/iu,
    'install the command it names (the GitHub CLI `gh` reads the Pin release, Docker builds the images), then rerun'],
  [/no assets match|release not found/iu,
    'that Pin archive is not published there; correct platform/distribution/pin-release-coordinates.json ' +
    'or build a new Pin release with --pin-version and --pin-version-code'],
]);
const LOG_MARK = '\n== ';
const LUMA = path.join(ROOT, 'luma');
const DISTRIBUTION = path.join(ROOT, 'platform', 'distribution');
const PIN_COORDINATES = path.join(DISTRIBUTION, 'pin-release-coordinates.json');
// The maintainer's release signing key pair: the private key lives with the
// other secrets and never enters the checkout. The public key is committed
// and embedded in `bootstrap` between these heredoc markers.
const SIGNING_KEY_DIR = path.join(SECRETS_DIR, 'release');
const SIGNING_KEY_NAME = 'cosign';
const RELEASE_SIGNING = Object.freeze({
  privateKey: path.join(SIGNING_KEY_DIR, `${SIGNING_KEY_NAME}.key`),
  publicKey: path.join(DISTRIBUTION, 'release-signing.pub'),
  bootstrap: path.join(ROOT, 'bootstrap'),
});
const BOOTSTRAP_KEY_BLOCK = /(RELEASE_SIGNING_PUBLIC_KEY="\$\(cat <<'RELEASE_SIGNING_PUBLIC_KEY_PEM'\n)(?:[^\n]*\n)*?(RELEASE_SIGNING_PUBLIC_KEY_PEM\n\)")/u;
const KEYGEN_HINT = 'create it with `./luma release keygen`, commit the public key it writes ' +
  '(platform/distribution/release-signing.pub, bootstrap, and the projection from ' +
  '`bun platform/setup/generate.mjs --write`), then publish';

// Build inputs of the first-party images, keyed by IMAGE_NAMES from
// platform/distribution/release-descriptor.mjs.
const IMAGES = Object.freeze({
  center: Object.freeze({
    title: 'Center', context: '.', dockerfile: './center/Dockerfile',
    wireContracts: true, releaseId: true,
  }),
  'center-iroh-bridge': Object.freeze({
    title: 'Center iroh bridge', context: '.', dockerfile: './platform/containers/center-iroh-bridge/Dockerfile',
  }),
  cosmos: Object.freeze({
    title: 'Cosmos backend', context: './cosmos', dockerfile: './cosmos/Dockerfile', wireContracts: true,
  }),
  keycloak: Object.freeze({
    title: 'Optimized Keycloak', context: '.', dockerfile: './platform/containers/keycloak/Dockerfile',
  }),
  'spotify-adapter': Object.freeze({
    title: 'Spotify adapter', context: './center/adapters/spotify', dockerfile: './center/adapters/spotify/Dockerfile',
  }),
});

function parsePublishArguments(argv) {
  const names = new Map([
    ['--version', 'version'],
    ['--pin-version', 'pinVersion'],
    ['--pin-version-code', 'pinVersionCode'],
    ['--notes', 'notes'],
  ]);
  const options = { version: null, pinVersion: null, pinVersionCode: null, notes: null, confirm: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--confirm' && !options.confirm) {
      options.confirm = true;
      continue;
    }
    const name = names.get(argument);
    const value = argv[index + 1];
    if (!name || options[name] !== null || value === undefined || (value.startsWith('-') && value !== '-')) {
      throw new Error(`unknown, repeated, or incomplete option: ${argument}`);
    }
    options[name] = value;
    index += 1;
  }
  if (!RELEASE_VERSION.test(options.version || '')) {
    throw new Error('--version must be a semantic version such as 1.2.3');
  }
  if ((options.pinVersion === null) !== (options.pinVersionCode === null)) {
    throw new Error('--pin-version and --pin-version-code are given together or not at all');
  }
  if (options.pinVersion !== null) {
    if (!PIN_VERSION.test(options.pinVersion)) throw new Error('--pin-version must be YYYY-MM-DD.N');
    if (!/^[1-9][0-9]{0,9}$/u.test(options.pinVersionCode) || Number(options.pinVersionCode) > 2_147_483_647) {
      throw new Error('--pin-version-code must be a positive Android versionCode');
    }
    options.pinVersionCode = Number(options.pinVersionCode);
  }
  return Object.freeze(options);
}

async function distributionModules() {
  const load = (name) => import(pathToFileURL(path.join(DISTRIBUTION, name)).href);
  const [descriptor, proof] = await Promise.all([load('release-descriptor.mjs'), load('release-proof.mjs')]);
  const names = Object.keys(IMAGES).sort();
  if (names.join('\0') !== [...descriptor.IMAGE_NAMES].sort().join('\0')) {
    throw new Error('release image build inputs do not match the release descriptor image set');
  }
  return Object.freeze({
    ...descriptor,
    repository: proof.RELEASE_PROOF_POLICY.repository,
    signatureName: proof.RELEASE_SIGNATURE_NAME,
    checksumsName: proof.RELEASE_CHECKSUMS_NAME,
    releaseSigningArguments: proof.releaseSigningArguments,
    releaseVerificationArguments: proof.releaseVerificationArguments,
    isReleaseSigningPublicKey: proof.isReleaseSigningPublicKey,
  });
}

// Whether this machine holds the private key and whether the checkout holds a
// public key rather than the committed empty placeholder.
function signingKeyState(signing, modules) {
  let publicKey = 'missing';
  try {
    const text = fs.readFileSync(signing.publicKey, 'utf8');
    publicKey = text.length === 0 ? 'placeholder' : modules.isReleaseSigningPublicKey(text) ? 'present' : 'invalid';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return Object.freeze({ privateKey: fs.existsSync(signing.privateKey), publicKey });
}

function requireSigningKey(signing, modules) {
  const state = signingKeyState(signing, modules);
  if (!state.privateKey) {
    throw new Error(`the release signing key ${signing.privateKey} is missing on this machine; ${KEYGEN_HINT}`);
  }
  if (state.publicKey !== 'present') {
    throw new Error(`${signing.publicKey} is ${state.publicKey === 'placeholder'
      ? 'the empty placeholder, so no installer could verify this release'
      : `${state.publicKey}, so no installer could verify this release`}; ${KEYGEN_HINT}`);
  }
}

function publicationPaths(version) {
  const root = path.join(DATA_DIR, 'publication', `v${version}`);
  return Object.freeze({
    root,
    state: path.join(root, 'publication.json'),
    logs: path.join(root, 'logs'),
    metadata: path.join(root, 'metadata'),
    receipts: path.join(root, 'receipts'),
    pin: path.join(root, 'pin'),
    environment: path.join(root, 'release-publication.env'),
    notes: path.join(root, 'release-notes.txt'),
    operator: path.join(root, 'operator-release'),
    nextPinCoordinates: path.join(root, 'pin-release-coordinates.json'),
  });
}

function writeAtomic(file, text) {
  const partial = `${file}.partial`;
  fs.writeFileSync(partial, text, { mode: 0o644 });
  fs.renameSync(partial, file);
}

function readReceipt(file, validate) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return validate(JSON.parse(text));
  } catch (error) {
    throw new Error(`${file} is not a valid receipt (${error.message}); remove it to redo that step`);
  }
}

function failureReason(result, log) {
  let text = `${result.stderr || ''}\n${result.stdout || ''}`;
  if (log) {
    try {
      const content = fs.readFileSync(log, 'utf8');
      text = `${content.slice(content.lastIndexOf(LOG_MARK))}\n${text}`;
    } catch {
      // The log is optional context. The exit status still reports the failure.
    }
  }
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  // The last matching line is the failure. Earlier ones are usually the build
  // echoing a command such as `curl --show-error`.
  const line = lines.findLast((entry) => /ERROR:|failed to solve/u.test(entry)) ||
    lines.findLast((entry) =>
      /(?<![-\w])error\b(?!-)|denied|unauthori[sz]ed|not permitted|no space left|^HTTP [45][0-9]{2}\b/iu.test(entry)) ||
    lines.at(-1) ||
    `exit status ${result.status}`;
  return line.slice(0, 240);
}

async function must(pending, label, log = null) {
  const result = await pending;
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${failureReason(result, log)}${log ? ` (log: ${log})` : ''}`);
  }
  return result;
}

async function withRetries(runtime, label, log, attempt) {
  for (let count = 1; ; count += 1) {
    const result = await attempt();
    if (result.status === 0) return result;
    const reason = failureReason(result, log);
    const permanent = PERMANENT_FAILURES.find(([pattern]) => pattern.test(reason));
    if (permanent || count === ATTEMPTS) {
      throw new Error(
        `${label} failed${count > 1 ? ` after ${count} attempts` : ''}: ${reason}${log ? ` (log: ${log})` : ''}` +
        (permanent ? `\n  ${permanent[1]}` : ''),
      );
    }
    const delay = RETRY_DELAY_MS * count;
    runtime.print(`  ${label} failed (attempt ${count} of ${ATTEMPTS}): ${reason}; retrying in ${delay / 1000}s`);
    await runtime.sleep(delay);
  }
}

// A release names one commit: the clean checkout of the annotated vVERSION tag.
async function releaseSource(runtime, version) {
  const git = async (...args) => {
    const result = await runtime.spawn('git', ['--no-optional-locks', ...args]);
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const revision = await git('rev-parse', '--verify', 'HEAD');
  if (!REVISION.test(revision || '')) throw new Error('a release is published from a git checkout with a commit');
  const changes = await git('status', '--porcelain');
  if (changes === null) throw new Error('git status failed in the release checkout');
  if (changes) {
    throw new Error(
      `refusing to publish from a working tree with ${changes.split('\n').length} changed or untracked paths; ` +
      'commit or remove them (git status lists them), then publish the tagged commit',
    );
  }
  const tag = `v${version}`;
  if (await git('cat-file', '-t', `refs/tags/${tag}`) !== 'tag') {
    throw new Error(
      `${tag} is missing or is not an annotated tag; tag the release commit with ` +
      `\`git tag -a ${tag} -m "Luma ${version}" HEAD\``,
    );
  }
  const tagged = await git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
  if (tagged !== revision) {
    throw new Error(`${tag} names ${tagged}, not the checked-out HEAD ${revision}; check out the tagged commit`);
  }
  const created = await git('show', '-s', '--format=%cI', 'HEAD');
  if (!created) throw new Error('cannot read the release commit time');
  return Object.freeze({ version, revision, tag, created });
}

async function requireCompose(runtime) {
  const result = await runtime.spawn('docker', ['compose', 'version', '--short']);
  const parsed = result.status === 0 ? parseVersion(result.stdout) : null;
  if (!parsed || !versionAtLeast(parsed, MINIMUM_COMPOSE_VERSION)) {
    throw new Error(`publishing needs Docker with Compose ${MINIMUM_COMPOSE_VERSION.join('.')} or newer`);
  }
}

// A confirmed publish spends up to an hour building before its first push, so
// the login is verified first: ghcr.io must grant it write access to this
// repository's package, which the granted scopes of its token show. Only a
// definite refusal stops the run. An unverifiable login is reported and the
// pushes' own permanent-failure reporting takes over.
async function requireRegistryLogin(context, pushesPending) {
  const { prefix, runtime } = context;
  if (!pushesPending) return;
  const credential = runtime.ghcrCredential();
  if (!credential) {
    throw new Error(
      `ghcr.io has no login in Docker's configuration (${BUILD_DIR}); run ` +
      './luma registry login --username GITHUB_USER with a token that can write packages, then publish',
    );
  }
  const repository = prefix.slice('ghcr.io/'.length);
  let response;
  try {
    response = await runtime.fetch(
      `https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull,push`,
      { headers: { authorization: `Basic ${Buffer.from(credential).toString('base64')}` } },
    );
  } catch (error) {
    runtime.print(`  could not verify the ghcr.io login (${error.message}); the first push stops at once when it cannot write`);
    return;
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`verifying the ghcr.io login failed: ghcr.io answered ${response.status}; ` +
      'run ./luma registry login --username GITHUB_USER with a token that can write packages, then publish');
  }
  let actions;
  try {
    const body = await response.json();
    const token = body.token ?? body.access_token ?? '';
    if (!token) throw new Error('ghcr.io answered no token');
    const claims = token.split('.').length === 3
      ? JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
      : null;
    if (claims) {
      if (!Array.isArray(claims.access)) throw new Error('its token lists no granted scopes');
      actions = claims.access
        .find((entry) => entry?.type === 'repository' && String(entry.name).toLowerCase() === repository.toLowerCase())
        ?.actions ?? [];
    } else {
      // ghcr.io has also answered valid logins with an opaque token whose
      // granted scopes it does not disclose (observed 2026-09-29). Opening one
      // upload session proves the write without sending a byte. The empty
      // session expires unused.
      const probe = await runtime.fetch(`https://ghcr.io/v2/${repository}/blobs/uploads/`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      actions = probe.status === 202 ? ['push'] : [];
    }
  } catch (error) {
    runtime.print(`  could not verify the ghcr.io login (${error.message}); the first push stops at once when it cannot write`);
    return;
  }
  if (!actions.includes('push')) {
    throw new Error(`the ghcr.io login cannot write packages (ghcr.io granted it ${actions.join(' and ') || 'nothing'} for ${repository}); ` +
      'run ./luma registry login --username GITHUB_USER with a token that can write packages, then publish');
  }
}

// A pushed tag starts the release workflow. It is not itself a publication.
// GitHub must hold the same annotated tag object, and no published release.
// Use gh's authenticated API for this private repository: checkout deliberately
// does not persist credentials, and a failed anonymous git lookup proves nothing.
// Receipted images are this publication's own pushes. Only unfinished refs are
// checked against GHCR. This applies equally to local and CI publication.
async function requireUnpublishedTag(context, status) {
  const { modules, prefix, release, runtime } = context;
  const pushesPending = status.pending.length > 0 || !status.application;
  if (!pushesPending) return;
  const [owner, name] = modules.repository.split('/');
  const queried = await runtime.spawn('gh', [
    'api', 'graphql',
    '-f', 'query=query($owner:String!,$name:String!,$tag:String!,$ref:String!){' +
      'repository(owner:$owner,name:$name){ref(qualifiedName:$ref){target{oid}}release(tagName:$tag){isDraft}}}',
    '-f', `owner=${owner}`, '-f', `name=${name}`,
    '-f', `tag=${release.tag}`, '-f', `ref=refs/tags/${release.tag}`,
  ], { github: true });
  if (queried.status !== 0) {
    throw new Error(`checking GitHub release state failed: ${failureReason(queried)}; check gh auth status and retry`);
  }
  let repository;
  try {
    const body = JSON.parse(queried.stdout);
    repository = body.data?.repository;
    if (body.errors?.length || !repository ||
        !(repository.ref === null || REVISION.test(repository.ref?.target?.oid || '')) ||
        !(repository.release === null || typeof repository.release?.isDraft === 'boolean')) {
      throw new Error('incomplete GitHub response');
    }
  } catch {
    throw new Error('cannot verify GitHub release state; check repository access with gh auth status and retry');
  }
  if (repository.ref) {
    const localTag = await runtime.spawn('git', ['--no-optional-locks', 'rev-parse', '--verify', `refs/tags/${release.tag}`]);
    if (localTag.status !== 0 || localTag.stdout.trim() !== repository.ref.target.oid) {
      throw new Error(`GitHub tag ${release.tag} differs from the local annotated tag; check out the original tag or publish a new version`);
    }
  }
  if (repository.release && !repository.release.isDraft) {
    throw new Error(
      `${release.tag} is already published on GitHub. ` +
      'A version is published once; publish a new version instead (README "Publish a release")',
    );
  }
  const refs = [
    ...status.pending.map((name) => `${prefix}/${name}:${release.tag}`),
    ...(status.application ? [] : [`${prefix}/application:${release.tag}`]),
  ];
  const existing = [];
  for (const reference of refs) {
    const probe = await runtime.spawn('docker', ['buildx', 'imagetools', 'inspect', reference]);
    if (probe.status === 0) existing.push(reference);
  }
  if (existing.length) {
    throw new Error(
      `${existing.join(', ')} already exist on ghcr.io: they were pushed, and image tags are meant never to change. ` +
      'A version is published once; publish a new version instead',
    );
  }
}

// Without --pin-version the release republishes the exact signed Pin archive
// named by pin-release-coordinates.json. The Pin changes only deliberately.
function pinPlan(options, modules) {
  if (options.pinVersion !== null) {
    return Object.freeze({
      source: 'build',
      version: options.pinVersion,
      versionCode: options.pinVersionCode,
      archive: `luma-pin-${options.pinVersion}.tar.gz`,
    });
  }
  const coordinates = JSON.parse(fs.readFileSync(PIN_COORDINATES, 'utf8'));
  const source = coordinates?.signedReleaseSource;
  if (coordinates?.schemaVersion !== 3 || !source ||
      !SOURCE_REPOSITORY.test(source.repository) || !SOURCE_TAG.test(source.tag)) {
    throw new Error(`${PIN_COORDINATES} is not a supported schema-version 3 Pin coordinate file`);
  }
  const expected = modules.validatePinPayload({
    schemaVersion: 1,
    archive: source.archive,
    sha256: source.sha256,
    size: source.size,
    releaseId: source.releaseId,
    version: coordinates.version,
    versionCode: coordinates.versionCode,
    signerSha256: source.signerSha256,
    manifestSha256: source.manifestSha256,
    receiptsSha256: source.receiptsSha256,
  });
  return Object.freeze({
    source: 'pinned',
    version: expected.version,
    versionCode: expected.versionCode,
    archive: expected.archive,
    repository: source.repository,
    tag: source.tag,
    expected,
  });
}

// The pinned archive has to be an asset of its GitHub release before anything
// is built: otherwise a confirmed run fails only after the image builds, and a
// plan would promise a republish that cannot happen.
async function requirePublishedPin(runtime, pin) {
  let listed = null;
  try {
    listed = await withRetries(runtime, `looking up ${pin.repository} ${pin.tag}`, null, () => runtime.spawn('gh', [
      'release', 'view', pin.tag, '--repo', pin.repository, '--json', 'assets',
    ], { github: true }));
  } catch (error) {
    if (!/release not found/iu.test(error.message)) throw error;
  }
  let assets = [];
  if (listed) {
    try {
      assets = JSON.parse(listed.stdout).assets ?? [];
    } catch {
      throw new Error(`gh returned no readable asset list for ${pin.repository} ${pin.tag}`);
    }
  }
  const asset = assets.find((entry) => entry?.name === pin.archive);
  if (asset && asset.size === pin.expected.size &&
      (!asset.digest || asset.digest === `sha256:${pin.expected.sha256}`)) return;
  const problem = !listed
    ? `${pin.repository} has no GitHub release ${pin.tag}`
    : asset
      ? `the ${pin.archive} asset of ${pin.repository} ${pin.tag} is not the pinned file`
      : `${pin.repository} ${pin.tag} has no ${pin.archive} asset`;
  throw new Error(
    `cannot republish the Pin release pinned in platform/distribution/pin-release-coordinates.json: ${problem}.\n` +
    `  Publish ${pin.tag} on GitHub from its publication directory first (README "Publish a release"), ` +
    'or build and sign a new Pin release with this one: add --pin-version YYYY-MM-DD.N --pin-version-code INTEGER.',
  );
}

function publicationRecord(release, pin) {
  return `${JSON.stringify({
    schemaVersion: 1,
    version: release.version,
    revision: release.revision,
    pin: { source: pin.source, version: pin.version, versionCode: pin.versionCode },
  })}\n`;
}

// A publication directory belongs to one revision and one Pin choice, so a
// resumed run can never mix receipts from two different builds.
function resumedPublication(paths, record) {
  let recorded;
  try {
    recorded = fs.readFileSync(paths.state, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (fs.existsSync(paths.root)) {
      throw new Error(`${paths.root} was not started by this command; move it aside to publish ${paths.root.split(path.sep).at(-1)}`);
    }
    return false;
  }
  if (recorded !== record) {
    throw new Error(
      `${paths.root} holds a publication of another revision or Pin release (see ${paths.state}); ` +
      'finish it with its original options, or move that directory aside to start over',
    );
  }
  return true;
}

function publicationStatus(context) {
  const { modules, paths, pin, prefix } = context;
  const pending = modules.IMAGE_NAMES.filter((name) => !readReceipt(
    path.join(paths.receipts, `${name}.json`),
    (value) => {
      const receipt = modules.validateImageReceipt(value, name);
      if (!receipt.reference.startsWith(`${prefix}/`)) throw new Error(`reference is not under ${prefix}`);
      return receipt;
    },
  ));
  return Object.freeze({
    pending,
    pinArchive: fs.existsSync(path.join(paths.pin, pin.archive)),
    application: readReceipt(path.join(paths.receipts, 'application.json'), modules.validateApplicationReceipt),
    operator: fs.existsSync(path.join(paths.operator, modules.checksumsName)),
    signature: fs.existsSync(path.join(paths.operator, modules.signatureName)),
  });
}

function printPlan(context, status, resumed) {
  const { modules, paths, pin, prefix, release, runtime } = context;
  const pushed = modules.IMAGE_NAMES.filter((name) => !status.pending.includes(name));
  runtime.print(`Luma ${release.version} from ${release.revision} (annotated tag ${release.tag})`);
  runtime.print(`Publication directory: ${paths.root}${resumed ? ' (resuming)' : ''}`);
  runtime.print(`  images       ${status.pending.length
    ? `build ${status.pending.join(', ')} for ${modules.IMAGE_PLATFORMS.join(' + ')}, then push one at a time to ${prefix}` +
      (pushed.length ? `; already pushed: ${pushed.join(', ')}` : '')
    : 'all pushed'}`);
  // Only the maintainer holds the Pin signing key, so say before a confirmed
  // run whether this machine has it.
  const signingKey = path.join(SECRETS_DIR, 'pin', 'signing.env');
  runtime.print(`  Pin release  ${status.pinArchive
    ? `${pin.archive} present`
    : pin.source === 'build'
      ? `build and sign ${pin.version} (versionCode ${pin.versionCode}) with the Pin signing key ${signingKey}` +
        (fs.existsSync(signingKey) ? '' : ' (MISSING on this machine: the confirmed run will fail; only the key holder can build a Pin release)')
      : `republish the pinned ${pin.archive} from ${pin.repository} ${pin.tag}`}`);
  runtime.print(`  application  ${status.application
    ? status.application.reference
    : `publish ${prefix}/application:${release.tag}`}`);
  runtime.print(`  operator     ${status.operator ? 'packed' : `pack into ${paths.operator}`}`);
  // Only the maintainer holds the release signing key. A confirmed run
  // refuses without it, and the plan says so first.
  const keys = signingKeyState(context.signing, modules);
  runtime.print(`  signature    ${status.signature
    ? `${modules.signatureName} present`
    : `sign ${modules.checksumsName} with ${context.signing.privateKey}` +
      (keys.privateKey ? '' : ' (MISSING on this machine: the confirmed run will refuse; ./luma release keygen creates it)')}` +
    (keys.publicKey === 'present'
      ? `, verified with the committed ${path.relative(ROOT, context.signing.publicKey)}`
      : `; ${path.relative(ROOT, context.signing.publicKey)} is ${keys.publicKey === 'placeholder' ? 'the empty PLACEHOLDER' : keys.publicKey.toUpperCase()}` +
        ' (the confirmed run will refuse; ./luma release keygen writes it, and it is committed before publishing)'));
  runtime.print('The plan reads only this machine\'s receipts: publish each version from one machine, with a GHCR ' +
    'login that can write packages (./luma registry login).');
}

function imageArguments(context, name, output) {
  const { modules, prefix, release } = context;
  const image = IMAGES[name];
  const labels = [
    `org.opencontainers.image.title=${image.title}`,
    `org.opencontainers.image.description=Luma ${image.title}`,
    `org.opencontainers.image.source=https://github.com/${modules.repository}`,
    `org.opencontainers.image.revision=${release.revision}`,
    `org.opencontainers.image.version=${release.version}`,
    `org.opencontainers.image.created=${release.created}`,
    'dk.andersmadsen.luma.product=Luma',
    `dk.andersmadsen.luma.release=${release.revision}`,
  ];
  return [
    'buildx', 'build',
    '--builder', BUILDER,
    '--platform', modules.IMAGE_PLATFORMS.join(','),
    '--pull',
    '--progress=plain',
    '--file', image.dockerfile,
    ...(image.wireContracts ? ['--build-context', 'wire_contracts=./contracts/wire'] : []),
    ...(image.releaseId ? ['--build-arg', `LUMA_RELEASE_ID=${release.revision}`] : []),
    ...labels.flatMap((label) => ['--label', label]),
    '--provenance=mode=max',
    '--sbom=true',
    '--tag', `${prefix}/${name}:${release.tag}`,
    ...output,
    image.context,
  ];
}

// Booting here, once, keeps the parallel builds from racing to start or
// recreate the builder container.
async function ensureBuilder(runtime) {
  const inspected = await runtime.spawn('docker', ['buildx', 'inspect', '--bootstrap', BUILDER]);
  if (inspected.status === 0) return;
  if (!/no builder "[^"]+" found/u.test(`${inspected.stderr}\n${inspected.stdout}`)) {
    throw new Error(`starting the ${BUILDER} buildx builder failed: ${failureReason(inspected)}`);
  }
  await must(
    runtime.spawn('docker', ['buildx', 'create', '--name', BUILDER, '--driver', 'docker-container', '--bootstrap']),
    `creating the ${BUILDER} buildx builder`,
  );
}

async function buildImage(context, name) {
  const log = path.join(context.paths.logs, `build-${name}.log`);
  await must(
    context.runtime.spawn('docker', imageArguments(context, name, ['--output', 'type=cacheonly']), { log }),
    `build ${name}`,
    log,
  );
  context.runtime.print(`  built ${name}`);
}

async function verifyPin(context, archive) {
  const { pin, runtime } = context;
  const payload = await runtime.describePin(archive);
  const expected = pin.source === 'pinned'
    ? pin.expected
    : { archive: pin.archive, version: pin.version, versionCode: pin.versionCode };
  const differing = Object.keys(expected).filter((field) => payload[field] !== expected[field]);
  if (differing.length) {
    throw new Error(
      `${archive} does not match the ${pin.source === 'pinned' ? 'pinned Pin release coordinates' : `requested Pin release ${pin.version}`}` +
      ` (${differing.join(', ')})`,
    );
  }
  return payload;
}

async function pinRelease(context) {
  const { paths, pin, runtime } = context;
  const target = path.join(paths.pin, pin.archive);
  if (fs.existsSync(target)) return verifyPin(context, target);
  const log = path.join(paths.logs, 'pin.log');
  if (pin.source === 'build') {
    runtime.print(`  building and signing Pin release ${pin.version} (log: ${log})`);
    await must(runtime.spawn('bun', [
      LUMA, 'pin', 'release', 'build', '--version', pin.version, '--version-code', String(pin.versionCode),
    ], { log }), `Pin release build ${pin.version}`, log);
    await must(
      runtime.spawn('bun', [LUMA, 'pin', 'release', 'export', '--output', target], { log }),
      `Pin release export ${pin.version}`,
      log,
    );
    try {
      return await verifyPin(context, target);
    } catch (error) {
      fs.rmSync(target, { force: true });
      throw error;
    }
  }
  runtime.print(`  downloading the pinned ${pin.archive} from ${pin.repository} ${pin.tag}`);
  const download = fs.mkdtempSync(path.join(paths.pin, '.download-'));
  try {
    await withRetries(runtime, `download ${pin.archive}`, log, () => runtime.spawn('gh', [
      'release', 'download', pin.tag,
      '--repo', pin.repository,
      '--pattern', pin.archive,
      '--dir', download,
      '--clobber',
    ], { log, github: true }));
    const downloaded = path.join(download, pin.archive);
    const payload = await verifyPin(context, downloaded);
    fs.renameSync(downloaded, target);
    return payload;
  } finally {
    fs.rmSync(download, { recursive: true, force: true });
  }
}

async function localBuilds(context, status) {
  const jobs = [];
  if (status.pending.length) {
    await ensureBuilder(context.runtime);
    context.runtime.print(`Building ${status.pending.join(', ')} in parallel into the build cache`);
    jobs.push(...status.pending.map((name) => buildImage(context, name)));
  }
  jobs.push(pinRelease(context));
  const results = await Promise.allSettled(jobs);
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason.message);
  if (failures.length) throw new Error(failures.join('\n'));
  const pin = results.at(-1).value;
  context.runtime.print(`  Pin release ${pin.version} verified (${pin.archive})`);
  return pin;
}

async function pushImage(context, name) {
  const { modules, paths, prefix, runtime } = context;
  const metadata = path.join(paths.metadata, `${name}.json`);
  const log = path.join(paths.logs, `push-${name}.log`);
  await withRetries(runtime, `push ${name}`, log, () => {
    fs.rmSync(metadata, { force: true });
    return runtime.spawn('docker', imageArguments(context, name, ['--push', '--metadata-file', metadata]), { log });
  });
  let digest = null;
  try {
    digest = JSON.parse(fs.readFileSync(metadata, 'utf8'))['containerimage.digest'];
  } catch {
    // Reported below with the metadata path.
  }
  if (!DIGEST.test(digest || '')) throw new Error(`buildx recorded no image digest for ${name} in ${metadata}`);
  const reference = `${prefix}/${name}@${digest}`;
  const inspected = await withRetries(runtime, `inspect ${name}`, null, () => runtime.spawn('docker', [
    'buildx', 'imagetools', 'inspect', '--raw', reference,
  ]));
  const platforms = new Set((JSON.parse(inspected.stdout).manifests || [])
    .map((manifest) => `${manifest.platform?.os}/${manifest.platform?.architecture}`));
  const missing = modules.IMAGE_PLATFORMS.filter((platform) => !platforms.has(platform));
  if (missing.length) throw new Error(`${reference} does not provide ${missing.join(' and ')}`);
  const receipt = modules.validateImageReceipt({
    schemaVersion: 2, name, reference, digest, platforms: [...modules.IMAGE_PLATFORMS],
  }, name);
  writeAtomic(path.join(paths.receipts, `${name}.json`), `${JSON.stringify(receipt)}\n`);
  runtime.print(`  pushed ${reference}`);
}

async function publishApplication(context) {
  const { modules, paths, prefix, release, runtime } = context;
  const compose = [
    'compose', '--env-file', paths.environment,
    '-f', 'compose.yaml', '-f', 'platform/compose/production.yaml',
    '--profile', '*',
  ];
  const tag = `${prefix}/application:${release.tag}`;
  const log = path.join(paths.logs, 'application.log');
  fs.rmSync(paths.environment, { force: true });
  await must(runtime.spawn('bun', [
    path.join(DISTRIBUTION, 'publication-environment.mjs'), paths.receipts, paths.environment, release.revision,
  ]), 'writing the publication environment');
  const model = await must(runtime.spawn('docker', [...compose, 'config', '--format', 'json']), 'rendering the Compose model');
  const audit = await must(
    runtime.spawn('bun', [path.join(DISTRIBUTION, 'audit-compose-publication.mjs')], { input: model.stdout }),
    'the Compose publication audit',
  );
  runtime.print(`  audit passed: ${audit.stdout.trim()}`);
  // --yes answers Compose's publish prompt for this audited, secret-free model
  // only. Runtime trust prompts stay interactive in the operator CLI.
  await withRetries(runtime, 'publish the Compose application', log, () => runtime.spawn('docker', [
    ...compose, 'publish', '--yes', '--resolve-image-digests', tag,
  ], { log }));
  const inspected = await withRetries(runtime, 'inspect the Compose application', null, () => runtime.spawn('docker', [
    'buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}',
  ]));
  const digest = JSON.parse(inspected.stdout).digest;
  const receipt = modules.validateApplicationReceipt({
    schemaVersion: 1, reference: `oci://${prefix}/application@${digest}`, digest,
  });
  writeAtomic(path.join(paths.receipts, 'application.json'), `${JSON.stringify(receipt)}\n`);
  runtime.print(`  published ${receipt.reference}`);
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (let read; (read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function verifiedArtifacts(directory, modules) {
  const sums = fs.readFileSync(path.join(directory, modules.checksumsName), 'utf8');
  const rows = sums.trimEnd().split('\n').map((line) => {
    const match = /^([0-9a-f]{64}) {2}([^/\s]+)$/u.exec(line);
    if (!match) throw new Error(`${directory}/${modules.checksumsName} has an invalid line: ${line}`);
    return { sha256: match[1], name: match[2] };
  });
  const listed = rows.map((row) => row.name).sort();
  const present = fs.readdirSync(directory)
    .filter((name) => name !== modules.checksumsName && name !== modules.signatureName).sort();
  if (listed.join('\0') !== present.join('\0')) {
    throw new Error(`${directory} does not hold exactly the files ${modules.checksumsName} lists`);
  }
  for (const row of rows) {
    if (sha256File(path.join(directory, row.name)) !== row.sha256) {
      throw new Error(`${row.name} does not match SHA256SUMS in ${directory}`);
    }
  }
  return Object.freeze({
    sums,
    artifacts: rows.map((row) => Object.freeze({ ...row, size: fs.statSync(path.join(directory, row.name)).size })),
  });
}

async function packOperatorArchive(context, pinArchive, notesFile) {
  const { modules, paths, release, runtime } = context;
  if (!fs.existsSync(path.join(paths.operator, 'SHA256SUMS'))) {
    // build.mjs writes SHA256SUMS last and refuses to replace outputs, so an
    // interrupted pack is discarded and packed again.
    fs.rmSync(paths.operator, { recursive: true, force: true });
    await must(runtime.spawn('bun', [
      path.join(DISTRIBUTION, 'build.mjs'),
      '--version', release.version,
      '--revision', release.revision,
      '--repository', modules.repository,
      '--tag', release.tag,
      '--receipts', paths.receipts,
      '--pin-archive', pinArchive,
      '--output', paths.operator,
      ...(notesFile ? ['--notes-file', notesFile] : []),
    ]), 'packing the operator archive');
  }
  return verifiedArtifacts(paths.operator, modules);
}

// cosign signs SHA256SUMS with the maintainer's key, then verifies the
// signature against the committed public key: a signature the one-line
// installer could not verify is discarded, not published. The key password
// comes from COSIGN_PASSWORD or cosign's own hidden prompt, never argv.
async function signChecksums(context) {
  const { modules, paths, runtime, signing } = context;
  const checksums = path.join(paths.operator, modules.checksumsName);
  const signature = path.join(paths.operator, modules.signatureName);
  if (!fs.existsSync(signature)) {
    runtime.print(`  signing ${modules.checksumsName} with ${signing.privateKey}`);
    await must(
      runtime.spawn('cosign', modules.releaseSigningArguments({ privateKey: signing.privateKey, checksums, signature }),
        { cosign: true }),
      `signing ${modules.checksumsName}`,
    );
  }
  const verified = await runtime.spawn('cosign', modules.releaseVerificationArguments({
    publicKey: signing.publicKey, checksums, signature,
  }), { cosign: true });
  if (verified.status !== 0) {
    fs.rmSync(signature, { force: true });
    throw new Error(
      `${modules.signatureName} does not verify against ${path.relative(ROOT, signing.publicKey)} ` +
      `(${failureReason(verified)}); the committed public key is not this machine's ${signing.privateKey}. ` +
      'Commit the public key of the key that signs releases, then publish again',
    );
  }
  runtime.print(`  ${modules.signatureName} verified with ${path.relative(ROOT, signing.publicKey)}`);
}

// The release notes --notes names: a file, or `-` for standard input. Plain
// text the descriptor stores and Center shows. Validated before any build.
function releaseNotes(options, modules, runtime) {
  if (options.notes == null) return null;
  let text;
  try {
    text = options.notes === '-' ? (runtime.readStdin ?? (() => fs.readFileSync(0, 'utf8')))()
      : fs.readFileSync(path.resolve(options.notes), 'utf8');
  } catch (error) {
    throw new Error(`cannot read the release notes ${options.notes}: ${error.message}`);
  }
  const notes = modules.validateReleaseNotes(text.replace(/\r\n/gu, '\n').trim());
  if (notes === null) throw new Error('--notes names empty release notes');
  return notes;
}

async function publishRelease(options, runtime) {
  const modules = await distributionModules();
  const release = await releaseSource(runtime, options.version);
  await requireCompose(runtime);
  const pin = pinPlan(options, modules);
  const paths = publicationPaths(release.version);
  const record = publicationRecord(release, pin);
  const context = Object.freeze({
    modules, paths, pin, release, runtime,
    prefix: `ghcr.io/${modules.repository.toLowerCase()}`,
    signing: runtime.signing ?? RELEASE_SIGNING,
  });
  const resumed = resumedPublication(paths, record);
  const status = publicationStatus(context);
  const notes = releaseNotes(options, modules, runtime);
  if (notes !== null && status.operator) {
    const packed = JSON.parse(fs.readFileSync(path.join(paths.operator, `luma-${release.version}.release.json`), 'utf8'));
    if ((packed.notes ?? null) !== notes) {
      throw new Error(`the operator archive in ${paths.operator} is already packed with other release notes; ` +
        'publish it with the notes it has, or move the publication directory aside to start over');
    }
  }
  await requireRegistryLogin(context, status.pending.length > 0 || !status.application);
  if (pin.source === 'pinned' && !status.pinArchive) await requirePublishedPin(runtime, pin);
  await requireUnpublishedTag(context, status);
  printPlan(context, status, resumed);
  if (!options.confirm) {
    runtime.print('Plan only: nothing was built, pushed, or published. Add --confirm to publish; ' +
      'a confirmed run resumes from the steps already finished.');
    return null;
  }
  // No unsigned publication exists: the key is required before the first build.
  requireSigningKey(context.signing, modules);

  for (const directory of [paths.root, paths.logs, paths.metadata, paths.receipts, paths.pin]) {
    secureDirectory(directory);
  }
  if (!resumed) fs.writeFileSync(paths.state, record, { mode: 0o600, flag: 'wx' });
  if (notes !== null) writeAtomic(paths.notes, notes);

  runtime.print('[1/5] Local builds');
  const pinPayload = await localBuilds(context, status);
  runtime.print('[2/5] Image pushes, one at a time');
  for (const name of status.pending) await pushImage(context, name);
  runtime.print('[3/5] Compose application');
  if (status.application) runtime.print(`  already published ${status.application.reference}`);
  else await publishApplication(context);
  runtime.print('[4/5] Operator archive');
  const { artifacts, sums } = await packOperatorArchive(
    context, path.join(paths.pin, pinPayload.archive), notes !== null ? paths.notes : null,
  );
  runtime.print('[5/5] Release signature');
  await signChecksums(context);

  runtime.print(`Release ${release.tag} is ready in ${paths.operator}:`);
  for (const artifact of artifacts) runtime.print(`  ${artifact.name}  ${artifact.size} bytes`);
  runtime.print(`  ${modules.signatureName}  ${fs.statSync(path.join(paths.operator, modules.signatureName)).size} bytes`);
  runtime.print(`${modules.checksumsName}:`);
  runtime.print(sums.trimEnd());
  // What `sha256sum SHA256SUMS` prints, for an installer without the public
  // key to compare with a copy sent through another channel.
  runtime.print(`Send the ${artifacts.length + 2} files to the installer; ${modules.signatureName} is the maintainer's ` +
    `signature they verify with the committed public key, and this line, sent separately in a message, ` +
    `checks ${modules.checksumsName} by hand: ${crypto.createHash('sha256').update(sums).digest('hex')}  ${modules.checksumsName}`);
  if (pin.source === 'build') {
    writeAtomic(paths.nextPinCoordinates, `${JSON.stringify({
      schemaVersion: 3,
      version: pinPayload.version,
      versionCode: pinPayload.versionCode,
      signedReleaseSource: {
        repository: modules.repository,
        tag: release.tag,
        archive: pinPayload.archive,
        size: pinPayload.size,
        sha256: pinPayload.sha256,
        releaseId: pinPayload.releaseId,
        signerSha256: pinPayload.signerSha256,
        manifestSha256: pinPayload.manifestSha256,
        receiptsSha256: pinPayload.receiptsSha256,
      },
    }, null, 2)}\n`);
    runtime.print(`Pin ${pinPayload.version} is new: once ${release.tag} is published on GitHub, commit ` +
      `${paths.nextPinCoordinates} as platform/distribution/pin-release-coordinates.json so later releases republish it.`);
  }
  runtime.print(`To put it on GitHub: git push origin ${release.tag}, then gh release create ${release.tag} ` +
    `--verify-tag --draft --title "Luma ${release.version}"${notes !== null ? ` --notes-file ${paths.notes}` : ''} ` +
    `${paths.operator}/* (README "Publish a release")`);
  return Object.freeze({ directory: paths.operator, artifacts });
}

// `./luma release keygen` creates the maintainer's release signing key pair
// once: cosign writes the private key (mode 0600, password from
// COSIGN_PASSWORD or its own hidden prompt) beside the other secrets, and the
// public key goes into the checkout, where the operator archive packs it and
// `bootstrap` embeds it. Nothing here prints or moves the private key.
async function generateSigningKey(runtime) {
  const modules = await distributionModules();
  const signing = runtime.signing ?? RELEASE_SIGNING;
  const directory = path.dirname(signing.privateKey);
  const generatedPublicKey = path.join(directory, `${SIGNING_KEY_NAME}.pub`);
  if (fs.existsSync(signing.privateKey)) {
    throw new Error(
      `${signing.privateKey} already exists; a release signing key is made once. ` +
      'To rotate it, move the current key pair out of the way deliberately, then run keygen again',
    );
  }
  secureDirectory(directory);
  fs.rmSync(generatedPublicKey, { force: true });
  runtime.print(`Creating the release signing key pair in ${directory} ` +
    '(cosign asks for a password twice unless COSIGN_PASSWORD is set; the password is never stored by Luma)');
  await must(
    runtime.spawn('cosign', ['generate-key-pair', '--output-key-prefix', SIGNING_KEY_NAME], { cosign: true, cwd: directory }),
    'cosign generate-key-pair',
  );
  fs.chmodSync(signing.privateKey, 0o600);
  const publicKey = fs.readFileSync(generatedPublicKey, 'utf8');
  if (!modules.isReleaseSigningPublicKey(publicKey)) {
    throw new Error(`${generatedPublicKey} is not one PEM public key`);
  }
  fs.writeFileSync(signing.publicKey, publicKey, { mode: 0o644 });
  const bootstrap = fs.readFileSync(signing.bootstrap, 'utf8');
  if (!BOOTSTRAP_KEY_BLOCK.test(bootstrap)) {
    throw new Error(`${signing.bootstrap} has no RELEASE_SIGNING_PUBLIC_KEY block to embed the public key in`);
  }
  fs.writeFileSync(signing.bootstrap, bootstrap.replace(BOOTSTRAP_KEY_BLOCK, (_, opening, closing) =>
    `${opening}${publicKey.endsWith('\n') ? publicKey : `${publicKey}\n`}${closing}`));
  runtime.print(`Private key: ${signing.privateKey} (mode 0600; back it up with the other secrets, never commit it)`);
  runtime.print(`Public key:  ${signing.publicKey} and embedded in ${signing.bootstrap}`);
  runtime.print('Next: run `bun platform/setup/generate.mjs --write` so Center serves the updated installer, commit ' +
    'platform/distribution/release-signing.pub, bootstrap, and center/src/lib/pin-setup/generated/bootstrap.ts, ' +
    'then publish the next release with ./luma release publish.');
  return Object.freeze({ privateKey: signing.privateKey, publicKey: signing.publicKey });
}

function spawnLogged(command, args, options, env) {
  const { log = null, input = null, github = false, cosign = false, cwd = ROOT } = options;
  return new Promise((resolve) => {
    let executable;
    try {
      executable = resolveTool(command);
    } catch (error) {
      resolve({ status: 127, stdout: '', stderr: error.message });
      return;
    }
    let output = 'pipe';
    if (log) {
      fs.appendFileSync(log, `${LOG_MARK}${new Date().toISOString()} ${command} ${args.join(' ')}\n`, { mode: 0o600 });
      output = fs.openSync(log, 'a');
    }
    // gh reads its own login and only gh sees GH_TOKEN. Cosign alone sees
    // COSIGN_PASSWORD, and without it asks on the maintainer's terminal, so
    // it keeps the inherited stdin. Neither value reaches the log or argv.
    const passthrough = (name) =>
      typeof process.env[name] === 'string' && !process.env[name].includes('\0') ? { [name]: process.env[name] } : {};
    const childEnv = github ? { ...env, ...passthrough('GH_TOKEN') }
      : cosign ? { ...env, ...passthrough('COSIGN_PASSWORD') }
        : env;
    const child = childProcess.spawn(executable, args, {
      cwd,
      env: childEnv,
      stdio: [input !== null ? 'pipe' : cosign ? 'inherit' : 'ignore', output, output],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (log) fs.closeSync(output);
      resolve(result);
    };
    if (!log) {
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    }
    if (input !== null) child.stdin.end(input);
    child.on('error', (error) => finish({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => finish({ status: code ?? 1, stdout, stderr }));
  });
}

function defaultRuntime() {
  // Docker's configuration (registry login and the buildx builder) lives in
  // the external build directory, so it has to exist before Docker runs.
  secureDirectory(BUILD_DIR);
  const env = operatorEnvironment();
  return Object.freeze({
    spawn: (command, args, options = {}) => spawnLogged(command, args, options, env),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    print: (line) => process.stdout.write(`${line}\n`),
    fetch: (...args) => globalThis.fetch(...args),
    ghcrCredential: () => dockerCredential('ghcr.io'),
    async describePin(archive) {
      const { describePinReleaseArchive } = await import(
        pathToFileURL(path.join(ROOT, 'platform', 'deploy', 'pin', 'import-release.mjs')).href
      );
      return describePinReleaseArchive({ archive });
    },
  });
}

function releaseCommand(args, runtime = null) {
  const operation = args.shift();
  let options;
  try {
    if (operation === 'keygen') {
      if (args.length) throw new Error('release keygen takes no options');
    } else if (operation === 'publish') {
      options = parsePublishArguments(args);
    } else {
      throw new Error(`unknown release command: ${operation ?? '(none)'}`);
    }
  } catch (error) {
    fail(`${error.message}\nusage: ${USAGE}`, 64);
  }
  return Promise.resolve()
    .then(() => (operation === 'keygen'
      ? generateSigningKey(runtime || defaultRuntime())
      : publishRelease(options, runtime || defaultRuntime())))
    .catch((error) => fail(error.message));
}

module.exports = {
  ATTEMPTS,
  failureReason,
  BUILDER,
  IMAGES,
  RELEASE_SIGNING,
  RETRY_DELAY_MS,
  USAGE,
  defaultRuntime,
  generateSigningKey,
  parsePublishArguments,
  publicationPaths,
  publishRelease,
  releaseCommand,
};
