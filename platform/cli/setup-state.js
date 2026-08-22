'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { BACKUP_DIR, isInsideSource } = require('./context');
const { operatorContract } = require('./command-spec');

const TRACKS = Object.freeze(['local', 'contributor', 'production', 'pin']);
const STATE_DIR = path.resolve(process.env.REVIVAL_STATE_DIR || path.dirname(BACKUP_DIR));
const STATE_FILE = path.join(STATE_DIR, 'setup-state.json');
const RECEIPT_DIR = path.join(STATE_DIR, 'setup-receipts');
const ROOT = path.resolve(__dirname, '..', '..');
const SHA256 = /^[0-9a-f]{64}$/u;
const RECEIPT_FIELDS = Object.freeze([
  'schemaVersion',
  'actionId',
  'actionBindingSha256',
  'untrackedPolicySha256',
  'untrackedEnumerationSha256',
  'trackedMembershipSha256',
  'trackedSourceBindingSha256',
  'trackedSourceEvidenceSha256',
  'executionBindingSha256',
  'invocationSha256',
  'completionSha256',
  'evidenceSha256',
  'evidenceKind',
  'completedAt',
  'expiresAt',
  'outcome',
]);
const COMPLETION_FIELDS = Object.freeze(['schemaVersion', 'actionId', 'outcome', 'status', 'signal']);
const INVOCATION_BINDING_FIELDS = Object.freeze([
  'schemaVersion',
  'actionId',
  'actionBindingSha256',
  'untrackedPolicySha256',
  'untrackedEnumerationSha256',
  'trackedMembershipSha256',
  'trackedSourceBindingSha256',
  'trackedSourceEvidenceSha256',
  'invocationSha256',
]);
const FILE_IDENTITY_FIELDS = Object.freeze([
  'dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs',
]);
const ACTION_SUCCESS_OUTCOMES = Object.freeze({
  'doctor.local': 'local-prerequisites-verified',
  'stack.up': 'local-stack-started',
  'stack.status': 'local-stack-running',
  'test': 'repository-gate-passed',
  'pin.check': 'pin-source-gate-passed',
  'config.check': 'configuration-validated',
  'doctor.production': 'production-preflight-passed',
  'backup': 'production-backup-created',
  'deploy.production': 'production-deployment-applied',
  'canary': 'production-canary-passed',
  'pin.doctor': 'pin-prerequisites-verified',
  'pin.release.inspect': 'pin-release-inspected',
  'pin.release.ship': 'pin-release-published',
  'pki.init': 'device-user-ca-created',
  'pki.import': 'device-user-ca-imported',
  'setup.import.vps-candidate': 'hosted-vps-candidate-imported',
  'setup.import.pin-release': 'hosted-pin-release-imported',
});
const IMPORT_EVIDENCE_KINDS = Object.freeze({
  'setup.import.vps-candidate': 'hosted-vps-provider-verified-import',
  'setup.import.pin-release': 'hosted-pin-provider-verified-import',
});
const TRACKED_SOURCE_SCHEMA_VERSION = 2;
const TRACKED_SOURCE_MAX_FILES = 10_000;
const TRACKED_SOURCE_MAX_BYTES = 512 * 1024 * 1024;
const TRACKED_SOURCE_MAX_FILE_BYTES = 256 * 1024 * 1024;
const TRACKED_SOURCE_MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const TRACKED_SOURCE_TIMEOUT_MILLISECONDS = 15_000;
const TRACKED_GIT_EXECUTABLE = '/usr/bin/git';
const TRACKED_UNTRACKED_POLICY = Object.freeze({
  schemaVersion: 1,
  allowedWorkspaceInstructions: Object.freeze(['AGENTS.md', 'CLAUDE.md']),
  enumeration: 'git-ls-files-others-unfiltered',
  usesRepositoryGitignore: false,
  usesGitInfoExclude: false,
  usesGlobalOrSystemExcludes: false,
});

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function canonicalJson(value) {
  return `${canonical(value)}\n`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function commandForId(actionId, contract = operatorContract()) {
  const command = contract.commands.find((entry) => entry.id === actionId);
  if (!command) throw new Error(`unknown setup receipt action: ${actionId}`);
  return command;
}

function eligibleJourneyStep(actionId, contract = operatorContract()) {
  const steps = contract.journeys.flatMap((journey) => journey.steps)
    .filter((step) => step.commandId === actionId);
  return steps.length > 0 && steps.every((step) => step.verification !== 'physical');
}

function receiptLifetimeMilliseconds(command) {
  if (command.effect === 'remote-mutation') return 30 * 60 * 1000;
  if (command.effect === 'device-mutation') return 0;
  if (command.id.startsWith('setup.import.')) return 30 * 24 * 60 * 60 * 1000;
  if (['stack.status', 'stack.up', 'doctor.local', 'doctor.production', 'config.check'].includes(command.id)) {
    return 15 * 60 * 1000;
  }
  return 24 * 60 * 60 * 1000;
}

function fileIdentity(metadata) {
  return Object.fromEntries(FILE_IDENTITY_FIELDS.map((field) => [field, String(metadata[field])]));
}

function sameFileIdentity(left, right) {
  return FILE_IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function trackedDeadline() {
  return process.hrtime.bigint() + BigInt(TRACKED_SOURCE_TIMEOUT_MILLISECONDS) * 1_000_000n;
}

function requireTrackedDeadline(deadline) {
  if (process.hrtime.bigint() >= deadline) throw new Error('tracked source capture exceeded its total time bound');
}

function remainingTrackedMilliseconds(deadline) {
  const remaining = deadline - process.hrtime.bigint();
  if (remaining <= 0n) throw new Error('tracked source capture exceeded its total time bound');
  return Math.max(1, Math.min(
    TRACKED_SOURCE_TIMEOUT_MILLISECONDS,
    Number((remaining + 999_999n) / 1_000_000n),
  ));
}

function stableDirectory(absolute, recordPath, deadline) {
  requireTrackedDeadline(deadline);
  const before = fs.lstatSync(absolute, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`tracked source directory is unsafe: ${recordPath}`);
  }
  const canonicalPath = fs.realpathSync.native(absolute);
  const after = fs.lstatSync(absolute, { bigint: true });
  const identity = fileIdentity(before);
  if (canonicalPath !== path.resolve(absolute) || !sameFileIdentity(identity, fileIdentity(after))) {
    throw new Error(`tracked source directory changed while captured: ${recordPath}`);
  }
  return Object.freeze({ path: recordPath, type: 'directory', ...identity });
}

function gitDirectoryEvidence(record) {
  // Read-only Git may create and remove an index.lock, which changes directory
  // timestamps without changing source authority. Bind the directory inode and
  // access policy here; the exact index inode/bytes and membership are bound
  // separately and retain all meaningful repository-change detection.
  return Object.freeze(Object.fromEntries([
    ['path', record.path],
    ['type', record.type],
    ...['dev', 'ino', 'mode', 'uid', 'gid'].map((field) => [field, record[field]]),
  ]));
}

function gitControlPathEvidence(record) {
  return record.type === 'directory' ? gitDirectoryEvidence(record) : record;
}

function stableBoundedFile(absolute, recordPath, maximumBytes, deadline, {
  rootOwnedExecutable = false,
} = {}) {
  requireTrackedDeadline(deadline);
  const before = fs.lstatSync(absolute, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n ||
      before.size < 0n || before.size > BigInt(maximumBytes)) {
    throw new Error(`tracked source file is unsafe or unbounded: ${recordPath}`);
  }
  if (rootOwnedExecutable && (
    before.uid !== 0n || (before.mode & 0o022n) !== 0n || (before.mode & 0o111n) === 0n
  )) throw new Error(`tracked Git executable is not fixed root-owned executable authority: ${recordPath}`);
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const openedIdentity = fileIdentity(opened);
    if (!sameFileIdentity(fileIdentity(before), openedIdentity)) {
      throw new Error(`tracked source file moved before open: ${recordPath}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const rebound = fs.lstatSync(absolute, { bigint: true });
    if (
      BigInt(bytes.length) !== opened.size ||
      !sameFileIdentity(openedIdentity, fileIdentity(after)) ||
      !sameFileIdentity(openedIdentity, fileIdentity(rebound))
    ) throw new Error(`tracked source file changed while captured: ${recordPath}`);
    requireTrackedDeadline(deadline);
    return Object.freeze({
      record: Object.freeze({
        path: recordPath,
        type: 'file',
        contentSha256: sha256(bytes),
        ...openedIdentity,
      }),
      bytes,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function stableTrackedSymlink(absolute, member, deadline) {
  requireTrackedDeadline(deadline);
  const before = fs.lstatSync(absolute, { bigint: true });
  if (!before.isSymbolicLink() || before.nlink !== 1n ||
      before.size < 0n || before.size > BigInt(TRACKED_SOURCE_MAX_FILE_BYTES)) {
    throw new Error(`tracked source link has an unexpected type: ${member.path}`);
  }
  const linkText = fs.readlinkSync(absolute, { encoding: 'buffer' });
  const after = fs.lstatSync(absolute, { bigint: true });
  const identity = fileIdentity(before);
  if (BigInt(linkText.length) !== before.size || !sameFileIdentity(identity, fileIdentity(after))) {
    throw new Error(`tracked source link changed while captured: ${member.path}`);
  }
  requireTrackedDeadline(deadline);
  return Object.freeze({
    path: member.path,
    gitMode: member.gitMode,
    objectId: member.objectId,
    type: 'symlink',
    linkTextBase64: linkText.toString('base64'),
    contentSha256: sha256(linkText),
    ...identity,
  });
}

function stableTrackedFile(absolute, member, deadline) {
  const selected = stableBoundedFile(
    absolute,
    member.path,
    TRACKED_SOURCE_MAX_FILE_BYTES,
    deadline,
  );
  return Object.freeze({
    path: member.path,
    gitMode: member.gitMode,
    objectId: member.objectId,
    type: 'file',
    contentSha256: selected.record.contentSha256,
    ...Object.fromEntries(FILE_IDENTITY_FIELDS.map((field) => [field, selected.record[field]])),
  });
}

function discoverTrackedGitDirectory(deadline) {
  const dotGitPath = path.join(ROOT, '.git');
  const metadata = fs.lstatSync(dotGitPath, { bigint: true });
  let dotGit;
  let gitDirectory;
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    dotGit = stableDirectory(dotGitPath, '.git', deadline);
    gitDirectory = dotGitPath;
  } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
    const captured = stableBoundedFile(dotGitPath, '.git', 4096, deadline);
    const source = captured.bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(captured.bytes)) {
      throw new Error('tracked Git indirection is not canonical UTF-8');
    }
    const match = /^gitdir: ([^\0\r\n]+)\n?$/u.exec(source);
    if (!match) throw new Error('tracked Git indirection has an unsupported shape');
    gitDirectory = path.resolve(ROOT, match[1]);
    dotGit = Object.freeze({ ...captured.record, type: 'gitfile' });
  } else {
    throw new Error('tracked source requires one real .git directory or gitfile');
  }
  const gitDir = stableDirectory(gitDirectory, 'gitdir', deadline);
  return Object.freeze({ dotGit, gitDir, gitDirectory: path.resolve(gitDirectory) });
}

function trackedGitEnvironment() {
  return Object.freeze({
    HOME: '/nonexistent',
    XDG_CONFIG_HOME: '/nonexistent',
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_PAGER: '/bin/cat',
    GIT_EDITOR: '/bin/false',
  });
}

function runTrackedGit(gitDirectory, commandArguments, deadline, label) {
  const result = spawnSync(TRACKED_GIT_EXECUTABLE, [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    '-c', 'core.attributesFile=/dev/null',
    '-c', 'core.excludesFile=/dev/null',
    '-c', 'submodule.recurse=false',
    '-c', 'fetch.recurseSubmodules=false',
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    `--git-dir=${gitDirectory}`,
    `--work-tree=${ROOT}`,
    ...commandArguments,
  ], {
    cwd: ROOT,
    env: trackedGitEnvironment(),
    encoding: 'buffer',
    maxBuffer: TRACKED_SOURCE_MAX_GIT_OUTPUT_BYTES,
    timeout: remainingTrackedMilliseconds(deadline),
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.signal !== null || result.stderr.length !== 0) {
    throw new Error(`fixed config-free Git could not enumerate ${label}: ${
      result.error?.message || result.stderr.toString('utf8').trim() || `status ${result.status}`
    }`);
  }
  requireTrackedDeadline(deadline);
  return result.stdout;
}

function trackedGitMembership(gitDirectory, deadline) {
  const output = runTrackedGit(
    gitDirectory,
    ['ls-files', '--cached', '--stage', '--full-name', '-z', '--'],
    deadline,
    'tracked source',
  );
  const rows = [];
  let offset = 0;
  let previousPath = null;
  let previousPathBytes = null;
  while (offset < output.length) {
    const end = output.indexOf(0, offset);
    if (end < 0) throw new Error('tracked Git membership is not NUL terminated');
    const row = output.subarray(offset, end);
    offset = end + 1;
    const separator = row.indexOf(0x09);
    if (separator <= 0) throw new Error('tracked Git membership row is malformed');
    const header = row.subarray(0, separator).toString('ascii');
    const pathBytes = row.subarray(separator + 1);
    const match = /^(100644|100755|120000) ([0-9a-f]{40}|[0-9a-f]{64}) 0$/u.exec(header);
    if (!match) throw new Error('tracked Git membership has an unsupported mode, object ID, or stage');
    const selectedPath = pathBytes.toString('utf8');
    if (!Buffer.from(selectedPath, 'utf8').equals(pathBytes) || pathBytes.length === 0 ||
        pathBytes.length > 4096 || path.isAbsolute(selectedPath) ||
        path.posix.normalize(selectedPath) !== selectedPath ||
        selectedPath.split('/').some((part) => part === '' || part === '.' || part === '..') ||
        selectedPath.split('/').includes('.git')) {
      throw new Error('tracked Git membership contains an unsafe path');
    }
    if (previousPath === selectedPath ||
        (previousPathBytes !== null && Buffer.compare(previousPathBytes, pathBytes) >= 0)) {
      throw new Error('tracked Git membership is duplicate or not canonical index order');
    }
    rows.push(Object.freeze({ gitMode: match[1], objectId: match[2], path: selectedPath }));
    if (rows.length > TRACKED_SOURCE_MAX_FILES) throw new Error('tracked source exceeds its file-count bound');
    previousPath = selectedPath;
    previousPathBytes = Buffer.from(pathBytes);
  }
  if (rows.length === 0) throw new Error('tracked source membership is empty');
  requireTrackedDeadline(deadline);
  return Object.freeze(rows);
}

function parseCanonicalUntrackedPaths(output, label) {
  const rows = [];
  let offset = 0;
  let previousPathBytes = null;
  while (offset < output.length) {
    const end = output.indexOf(0, offset);
    if (end < 0) throw new Error(`${label} is not NUL terminated`);
    const pathBytes = output.subarray(offset, end);
    offset = end + 1;
    const selectedPath = pathBytes.toString('utf8');
    if (!Buffer.from(selectedPath, 'utf8').equals(pathBytes) || pathBytes.length === 0 ||
        pathBytes.length > 4096 || path.isAbsolute(selectedPath) ||
        path.posix.normalize(selectedPath) !== selectedPath ||
        selectedPath.split('/').some((part) => part === '' || part === '.' || part === '..') ||
        selectedPath.split('/').includes('.git') ||
        (previousPathBytes !== null && Buffer.compare(previousPathBytes, pathBytes) >= 0)) {
      throw new Error(`${label} contains an unsafe, duplicate, or unordered path`);
    }
    rows.push(selectedPath);
    if (rows.length > TRACKED_SOURCE_MAX_FILES) throw new Error(`${label} exceeds its file-count bound`);
    previousPathBytes = Buffer.from(pathBytes);
  }
  return Object.freeze(rows);
}

function trackedGitUntracked(gitDirectory, deadline) {
  const untracked = parseCanonicalUntrackedPaths(runTrackedGit(
    gitDirectory,
    ['ls-files', '--others', '-z', '--'],
    deadline,
    'unfiltered untracked source',
  ), 'unfiltered untracked source');
  const allowed = new Set(TRACKED_UNTRACKED_POLICY.allowedWorkspaceInstructions);
  const unexpected = untracked.find((selectedPath) => !allowed.has(selectedPath));
  if (unexpected !== undefined) {
    throw new Error(`unexpected untracked source refuses setup receipt capture: ${unexpected}`);
  }
  requireTrackedDeadline(deadline);
  return untracked;
}

function validateTrackedDirectoryClosure(directoryPaths, deadline) {
  const expected = new Set(directoryPaths);
  const selected = [...expected].sort();
  const records = [];
  for (const relative of ['.', ...selected]) {
    requireTrackedDeadline(deadline);
    const absolute = relative === '.' ? ROOT : path.join(ROOT, ...relative.split('/'));
    const before = stableDirectory(absolute, relative, deadline);
    const children = fs.readdirSync(absolute, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const child of children) {
      if (!child.isDirectory() || (relative === '.' && child.name === '.git')) continue;
      const childPath = relative === '.' ? child.name : `${relative}/${child.name}`;
      if (!expected.has(childPath)) {
        throw new Error(`unexpected untracked directory refuses setup receipt capture: ${childPath}`);
      }
    }
    const after = stableDirectory(absolute, relative, deadline);
    if (canonical(after) !== canonical(before)) {
      throw new Error(`tracked source directory changed while closing its inventory: ${relative}`);
    }
    if (relative !== '.') records.push(before);
  }
  requireTrackedDeadline(deadline);
  return Object.freeze(records);
}

function captureTrackedSource() {
  const deadline = trackedDeadline();
  const root = stableDirectory(ROOT, '.', deadline);
  const gitExecutable = stableBoundedFile(
    TRACKED_GIT_EXECUTABLE,
    TRACKED_GIT_EXECUTABLE,
    16 * 1024 * 1024,
    deadline,
    { rootOwnedExecutable: true },
  ).record;
  const repository = discoverTrackedGitDirectory(deadline);
  const indexPath = path.join(repository.gitDirectory, 'index');
  const index = stableBoundedFile(indexPath, 'gitdir/index', 64 * 1024 * 1024, deadline).record;
  const membership = trackedGitMembership(repository.gitDirectory, deadline);
  const untracked = trackedGitUntracked(repository.gitDirectory, deadline);
  const required = new Set(membership.map((entry) => entry.path));
  for (const selected of ['revival', 'contracts/operator-setup.json']) {
    if (!required.has(selected)) throw new Error(`tracked source omits required launcher input: ${selected}`);
  }

  const directoryPaths = new Set();
  for (const member of membership) {
    const parts = member.path.split('/');
    for (let length = 1; length < parts.length; length += 1) {
      directoryPaths.add(parts.slice(0, length).join('/'));
    }
  }
  const directories = validateTrackedDirectoryClosure(directoryPaths, deadline);
  const entries = [];
  let totalBytes = 0;
  for (const member of membership) {
    requireTrackedDeadline(deadline);
    const absolute = path.join(ROOT, ...member.path.split('/'));
    const entry = member.gitMode === '120000'
      ? stableTrackedSymlink(absolute, member, deadline)
      : stableTrackedFile(absolute, member, deadline);
    totalBytes += Number(entry.size);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > TRACKED_SOURCE_MAX_BYTES) {
      throw new Error('tracked source exceeds its total byte bound');
    }
    entries.push(entry);
  }

  for (const entry of entries) {
    const absolute = path.join(ROOT, ...entry.path.split('/'));
    const rebound = entry.type === 'symlink'
      ? stableTrackedSymlink(absolute, entry, deadline)
      : stableTrackedFile(absolute, entry, deadline);
    if (canonical(rebound) !== canonical(entry)) {
      throw new Error(`tracked source entry changed before capture completed: ${entry.path}`);
    }
  }
  for (const directory of directories) {
    const rebound = stableDirectory(
      path.join(ROOT, ...directory.path.split('/')),
      directory.path,
      deadline,
    );
    if (canonical(rebound) !== canonical(directory)) {
      throw new Error(`tracked source directory changed before capture completed: ${directory.path}`);
    }
  }

  const rootAfter = stableDirectory(ROOT, '.', deadline);
  const gitExecutableAfter = stableBoundedFile(
    TRACKED_GIT_EXECUTABLE,
    TRACKED_GIT_EXECUTABLE,
    16 * 1024 * 1024,
    deadline,
    { rootOwnedExecutable: true },
  ).record;
  const repositoryAfter = discoverTrackedGitDirectory(deadline);
  const indexAfter = stableBoundedFile(indexPath, 'gitdir/index', 64 * 1024 * 1024, deadline).record;
  const untrackedAfter = trackedGitUntracked(repository.gitDirectory, deadline);
  if (
    canonical(rootAfter) !== canonical(root) ||
    canonical(gitExecutableAfter) !== canonical(gitExecutable) ||
    canonical(gitControlPathEvidence(repositoryAfter.dotGit)) !==
      canonical(gitControlPathEvidence(repository.dotGit)) ||
    canonical(gitDirectoryEvidence(repositoryAfter.gitDir)) !==
      canonical(gitDirectoryEvidence(repository.gitDir)) ||
    repositoryAfter.gitDirectory !== repository.gitDirectory ||
    canonical(indexAfter) !== canonical(index) ||
    canonical(untrackedAfter) !== canonical(untracked)
  ) throw new Error('tracked repository or Git authority changed while captured');

  const frozenEntries = Object.freeze(entries);
  const evidence = Object.freeze({
    schemaVersion: TRACKED_SOURCE_SCHEMA_VERSION,
    root,
    gitExecutable,
    repository: Object.freeze({
      dotGit: gitControlPathEvidence(repository.dotGit),
      gitDir: gitDirectoryEvidence(repository.gitDir),
      gitDirectory: repository.gitDirectory,
      index,
    }),
    untrackedPolicy: TRACKED_UNTRACKED_POLICY,
    untracked,
    membership,
    directories,
    entries: frozenEntries,
    fileCount: frozenEntries.length,
    totalBytes,
  });
  const semanticEntries = frozenEntries.map((entry) => ({
    path: entry.path,
    gitMode: entry.gitMode,
    objectId: entry.objectId,
    type: entry.type,
    size: entry.size,
    contentSha256: entry.contentSha256,
    ...(entry.type === 'symlink' ? { linkTextBase64: entry.linkTextBase64 } : {}),
  }));
  return Object.freeze({
    ...evidence,
    untrackedPolicySha256: sha256(canonical(TRACKED_UNTRACKED_POLICY)),
    untrackedEnumerationSha256: sha256(canonical(untracked)),
    trackedMembershipSha256: sha256(canonical(membership)),
    trackedSourceBindingSha256: sha256(canonical({
      schemaVersion: TRACKED_SOURCE_SCHEMA_VERSION,
      gitExecutableSha256: gitExecutable.contentSha256,
      indexSha256: index.contentSha256,
      untrackedPolicy: TRACKED_UNTRACKED_POLICY,
      untracked,
      membership,
      entries: semanticEntries,
    })),
    trackedSourceEvidenceSha256: sha256(canonical(evidence)),
  });
}

function exactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...fields].sort().join(',');
}

function exactIdentityRecord(value, fields) {
  return exactFields(value, [...fields, ...FILE_IDENTITY_FIELDS]) &&
    FILE_IDENTITY_FIELDS.every((field) => /^(?:0|[1-9][0-9]*)$/u.test(value[field] || ''));
}

function exactDirectoryRecord(value, expectedPath) {
  return exactIdentityRecord(value, ['path', 'type']) && value.path === expectedPath &&
    value.type === 'directory';
}

function exactGitDirectoryEvidence(value, expectedPath) {
  const fields = ['path', 'type', 'dev', 'ino', 'mode', 'uid', 'gid'];
  return exactFields(value, fields) && value.path === expectedPath && value.type === 'directory' &&
    fields.slice(2).every((field) => /^(?:0|[1-9][0-9]*)$/u.test(value[field] || ''));
}

function exactBoundedFileRecord(value, expectedPath, expectedType = 'file') {
  return exactIdentityRecord(value, ['path', 'type', 'contentSha256']) &&
    value.path === expectedPath && value.type === expectedType &&
    SHA256.test(value.contentSha256 || '');
}

function validatedTrackedSourceCapture(capture) {
  const topFields = [
    'schemaVersion', 'root', 'gitExecutable', 'repository', 'untrackedPolicy', 'untracked',
    'membership', 'directories',
    'entries', 'fileCount', 'totalBytes', 'trackedMembershipSha256',
    'untrackedPolicySha256', 'untrackedEnumerationSha256',
    'trackedSourceBindingSha256', 'trackedSourceEvidenceSha256',
  ];
  if (!exactFields(capture, topFields) || capture.schemaVersion !== TRACKED_SOURCE_SCHEMA_VERSION ||
      canonical(capture.untrackedPolicy) !== canonical(TRACKED_UNTRACKED_POLICY) ||
      !Array.isArray(capture.untracked) || capture.untracked.length >
        TRACKED_UNTRACKED_POLICY.allowedWorkspaceInstructions.length ||
      capture.untracked.some((selectedPath, index) =>
        !TRACKED_UNTRACKED_POLICY.allowedWorkspaceInstructions.includes(selectedPath) ||
        (index > 0 && Buffer.compare(
          Buffer.from(capture.untracked[index - 1]), Buffer.from(selectedPath),
        ) >= 0)) ||
      !Array.isArray(capture.membership) || !Array.isArray(capture.directories) ||
      !Array.isArray(capture.entries) || capture.fileCount !== capture.entries.length ||
      capture.fileCount !== capture.membership.length || capture.fileCount <= 0 ||
      capture.fileCount > TRACKED_SOURCE_MAX_FILES || !Number.isSafeInteger(capture.totalBytes) ||
      capture.totalBytes < 0 || capture.totalBytes > TRACKED_SOURCE_MAX_BYTES ||
      !exactFields(capture.repository, ['dotGit', 'gitDir', 'gitDirectory', 'index']) ||
      !exactDirectoryRecord(capture.root, '.') ||
      !exactBoundedFileRecord(capture.gitExecutable, TRACKED_GIT_EXECUTABLE) ||
      !exactGitDirectoryEvidence(capture.repository.gitDir, 'gitdir') ||
      !exactBoundedFileRecord(capture.repository.index, 'gitdir/index') ||
      !path.isAbsolute(capture.repository.gitDirectory || '') ||
      path.resolve(capture.repository.gitDirectory) !== capture.repository.gitDirectory ||
      !(
        exactGitDirectoryEvidence(capture.repository.dotGit, '.git') ||
        exactBoundedFileRecord(capture.repository.dotGit, '.git', 'gitfile')
      )) {
    throw new Error('setup receipt tracked-source capture has an unsupported shape');
  }
  const semanticEntries = [];
  let totalBytes = 0;
  let previousPath = null;
  const required = new Set();
  const expectedDirectoryPaths = new Set();
  for (let index = 0; index < capture.membership.length; index += 1) {
    const member = capture.membership[index];
    const entry = capture.entries[index];
    if (!exactFields(member, ['gitMode', 'objectId', 'path']) ||
        !['100644', '100755', '120000'].includes(member.gitMode) ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(member.objectId || '') ||
        typeof member.path !== 'string' || member.path.length === 0 || member.path.length > 4096 ||
        path.isAbsolute(member.path) || path.posix.normalize(member.path) !== member.path ||
        member.path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
        member.path.split('/').includes('.git') ||
        (previousPath !== null && Buffer.compare(Buffer.from(previousPath), Buffer.from(member.path)) >= 0) ||
        entry?.path !== member.path || entry.gitMode !== member.gitMode ||
        entry.objectId !== member.objectId || !['file', 'symlink'].includes(entry.type) ||
        (member.gitMode === '120000') !== (entry.type === 'symlink') ||
        !SHA256.test(entry.contentSha256 || '') ||
        !exactIdentityRecord(entry, [
          'path', 'gitMode', 'objectId', 'type', 'contentSha256',
          ...(entry.type === 'symlink' ? ['linkTextBase64'] : []),
        ])) {
      throw new Error('setup receipt tracked-source membership and entry set is not closed');
    }
    const size = Number(entry.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > TRACKED_SOURCE_MAX_FILE_BYTES) {
      throw new Error('setup receipt tracked-source entry exceeds its byte bound');
    }
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > TRACKED_SOURCE_MAX_BYTES) {
      throw new Error('setup receipt tracked-source total exceeds its byte bound');
    }
    required.add(member.path);
    const parts = member.path.split('/');
    for (let length = 1; length < parts.length; length += 1) {
      expectedDirectoryPaths.add(parts.slice(0, length).join('/'));
    }
    if (entry.type === 'symlink') {
      const linkBytes = Buffer.from(entry.linkTextBase64, 'base64');
      if (linkBytes.toString('base64') !== entry.linkTextBase64 ||
          linkBytes.length !== size || sha256(linkBytes) !== entry.contentSha256) {
        throw new Error('setup receipt tracked-source symlink evidence is not canonical');
      }
    }
    semanticEntries.push({
      path: entry.path,
      gitMode: entry.gitMode,
      objectId: entry.objectId,
      type: entry.type,
      size: entry.size,
      contentSha256: entry.contentSha256,
      ...(entry.type === 'symlink' ? { linkTextBase64: entry.linkTextBase64 } : {}),
    });
    previousPath = member.path;
  }
  if (totalBytes !== capture.totalBytes || !required.has('revival') ||
      !required.has('contracts/operator-setup.json')) {
    throw new Error('setup receipt tracked-source capture is incomplete');
  }
  const selectedDirectoryPaths = [...expectedDirectoryPaths].sort();
  if (capture.directories.length !== selectedDirectoryPaths.length ||
      !capture.directories.every((directory, index) =>
        exactDirectoryRecord(directory, selectedDirectoryPaths[index]))) {
    throw new Error('setup receipt tracked-source directory closure is incomplete');
  }
  const evidence = {
    schemaVersion: capture.schemaVersion,
    root: capture.root,
    gitExecutable: capture.gitExecutable,
    repository: capture.repository,
    untrackedPolicy: capture.untrackedPolicy,
    untracked: capture.untracked,
    membership: capture.membership,
    directories: capture.directories,
    entries: capture.entries,
    fileCount: capture.fileCount,
    totalBytes: capture.totalBytes,
  };
  const expectedUntrackedPolicy = sha256(canonical(capture.untrackedPolicy));
  const expectedUntrackedEnumeration = sha256(canonical(capture.untracked));
  const expectedMembership = sha256(canonical(capture.membership));
  const expectedBinding = sha256(canonical({
    schemaVersion: capture.schemaVersion,
    gitExecutableSha256: capture.gitExecutable.contentSha256,
    indexSha256: capture.repository.index?.contentSha256,
    untrackedPolicy: capture.untrackedPolicy,
    untracked: capture.untracked,
    membership: capture.membership,
    entries: semanticEntries,
  }));
  const expectedEvidence = sha256(canonical(evidence));
  if (
    capture.untrackedPolicySha256 !== expectedUntrackedPolicy ||
    capture.untrackedEnumerationSha256 !== expectedUntrackedEnumeration ||
    capture.trackedMembershipSha256 !== expectedMembership ||
    capture.trackedSourceBindingSha256 !== expectedBinding ||
    capture.trackedSourceEvidenceSha256 !== expectedEvidence
  ) throw new Error('setup receipt tracked-source capture digests do not close over its evidence');
  return capture;
}

function actionBindings(actionId, contract = operatorContract(), trackedSourceCapture) {
  const command = commandForId(actionId, contract);
  const actionBindingSha256 = sha256(canonical(command));
  const source = validatedTrackedSourceCapture(trackedSourceCapture || captureTrackedSource());
  return Object.freeze({
    command,
    actionBindingSha256,
    untrackedPolicySha256: source.untrackedPolicySha256,
    untrackedEnumerationSha256: source.untrackedEnumerationSha256,
    trackedMembershipSha256: source.trackedMembershipSha256,
    trackedSourceBindingSha256: source.trackedSourceBindingSha256,
    trackedSourceEvidenceSha256: source.trackedSourceEvidenceSha256,
  });
}

function receiptPath(actionId) {
  if (!/^[a-z0-9.-]+$/u.test(actionId)) throw new Error(`unsafe setup receipt action: ${actionId}`);
  return path.join(RECEIPT_DIR, `${actionId}.json`);
}

function validateReceiptDirectory({ create = false } = {}) {
  if (!create && !fs.existsSync(STATE_DIR)) return false;
  validateStateRoot();
  if (create) fs.mkdirSync(RECEIPT_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(RECEIPT_DIR)) return false;
  const stat = fs.lstatSync(RECEIPT_DIR);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
    throw new Error(`setup receipt root must be a real mode-0700 directory: ${RECEIPT_DIR}`);
  }
  return true;
}

function safeInvocationArguments(argv) {
  return Array.isArray(argv) && argv.length > 0 && argv.length <= 64 && argv.every((value) =>
    typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0'));
}

function parseExactOptions(values, {
  flags = [],
  valueOptions = [],
  requiredFlags = [],
  requiredValueOptions = [],
  forbidden = [],
} = {}) {
  const allowedFlags = new Set(flags);
  const allowedValues = new Set(valueOptions);
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (forbidden.includes(option) || forbidden.some((name) => option.startsWith(`${name}=`))) return false;
    if (allowedFlags.has(option)) {
      if (seen.has(option)) return false;
      seen.add(option);
      continue;
    }
    if (allowedValues.has(option)) {
      if (seen.has(option)) return false;
      const value = values[++index];
      if (!value || value.startsWith('-')) return false;
      seen.add(option);
      continue;
    }
    return false;
  }
  return requiredFlags.every((name) => seen.has(name)) &&
    requiredValueOptions.every((name) => seen.has(name));
}

function pkiInvocationIsAuthoritative(actionId, values) {
  if (values[0] !== 'device-user') return false;
  if (actionId === 'pki.init') {
    return parseExactOptions(values.slice(1), { flags: ['--confirm'], requiredFlags: ['--confirm'] });
  }
  return parseExactOptions(values.slice(1), {
    flags: ['--confirm'],
    valueOptions: ['--cert', '--key'],
    requiredFlags: ['--confirm'],
    requiredValueOptions: ['--cert', '--key'],
  });
}

function actionInvocationIsAuthoritative(actionId, values, command) {
  const forbidden = ['--dry-run', '--help', '-h'];
  if (values.some((value) => forbidden.includes(value) || value === 'help' || value === 'plan')) return false;
  const confirmations = values.filter((value) => value === '--confirm').length;
  if (command.confirmationRequired ? confirmations !== 1 : confirmations !== 0) return false;

  if (actionId === 'test') return values.length === 0 || (values.length === 1 && values[0] === '--source');
  if (actionId === 'pin.check') return values.length === 0;
  if (actionId === 'backup') {
    return parseExactOptions(values, {
      flags: ['--confirm', '--leave-quiesced', '--fetch', '--json'],
      valueOptions: ['--remote', '--backup-id', '--fetch-dir'],
      requiredFlags: ['--confirm'],
      forbidden,
    });
  }
  if (actionId === 'deploy.production') {
    if (values.includes('--skip-staging-smoke')) return false;
    const optionsValid = parseExactOptions(values, {
      flags: ['--confirm', '--cleanup-project-images', '--json'],
      valueOptions: ['--remote', '--candidate', '--candidate-id', '--min-free-gb'],
      requiredFlags: ['--confirm'],
      forbidden,
    });
    return optionsValid && Number(values.includes('--candidate')) + Number(values.includes('--candidate-id')) === 1;
  }
  if (actionId === 'canary') {
    return !values.includes('--from-tree') && !values.includes('--wearer-plane-optional') &&
      parseExactOptions(values, {
        flags: ['--confirm', '--require-remote-tts', '--json'],
        valueOptions: ['--remote', '--release-id', '--baseline', '--cookie-file'],
        requiredFlags: ['--confirm'],
        forbidden,
      });
  }
  if (actionId === 'pin.release.ship') {
    return !values.includes('--local') && parseExactOptions(values, {
      flags: ['--confirm', '--json'],
      valueOptions: ['--remote', '--remote-root', '--release-root'],
      requiredFlags: ['--confirm'],
      forbidden: [...forbidden, '--local'],
    });
  }
  if (actionId === 'pki.init' || actionId === 'pki.import') {
    return pkiInvocationIsAuthoritative(actionId, values);
  }
  if (actionId === 'setup.import.vps-candidate') {
    return parseExactOptions(values, {
      flags: ['--json'],
      valueOptions: ['--handoff-root', '--data-dir', '--verifier-cache-root'],
      requiredValueOptions: ['--handoff-root'],
      forbidden,
    });
  }
  if (actionId === 'setup.import.pin-release') {
    return parseExactOptions(values, {
      flags: ['--json'],
      valueOptions: ['--release-root', '--data-dir', '--verifier-cache-root'],
      requiredValueOptions: ['--release-root'],
      forbidden,
    });
  }
  // Remaining receipt-bearing commands are read-only or bounded local gates.
  // Their own parser already accepted every option; this layer excludes all
  // alternate help/plan/dry-run forms and binds the exact accepted argv.
  return values.every((value) => !value.startsWith('--dry-run='));
}

function exactCompletion(actionId, completion) {
  return completion !== null && typeof completion === 'object' && !Array.isArray(completion) &&
    Object.keys(completion).sort().join(',') === [...COMPLETION_FIELDS].sort().join(',') &&
    completion.schemaVersion === 1 && completion.actionId === actionId &&
    completion.outcome === ACTION_SUCCESS_OUTCOMES[actionId] &&
    completion.status === 0 && completion.signal === null;
}

function validateSetupInvocationBinding(binding, { actionId } = {}) {
  if (
    binding === null || typeof binding !== 'object' || Array.isArray(binding) ||
    Object.keys(binding).sort().join(',') !== [...INVOCATION_BINDING_FIELDS].sort().join(',') ||
    binding.schemaVersion !== 3 || typeof binding.actionId !== 'string' ||
    (actionId !== undefined && binding.actionId !== actionId) ||
    !SHA256.test(binding.actionBindingSha256 || '') ||
    !SHA256.test(binding.untrackedPolicySha256 || '') ||
    !SHA256.test(binding.untrackedEnumerationSha256 || '') ||
    !SHA256.test(binding.trackedMembershipSha256 || '') ||
    !SHA256.test(binding.trackedSourceBindingSha256 || '') ||
    !SHA256.test(binding.trackedSourceEvidenceSha256 || '') ||
    !SHA256.test(binding.invocationSha256 || '')
  ) throw new Error('setup invocation binding has an unsupported or mismatched shape');
  return binding;
}

function captureSetupInvocation(argv, { trackedSourceCapture } = {}) {
  if (!safeInvocationArguments(argv)) return null;
  const contract = operatorContract();
  const matched = matchedCommandForInvocation(argv, contract);
  const actionId = matched?.id;
  if (!actionId || !Object.hasOwn(ACTION_SUCCESS_OUTCOMES, actionId)) return null;
  const command = commandForId(actionId, contract);
  if (!eligibleJourneyStep(actionId, contract) || receiptLifetimeMilliseconds(command) <= 0) return null;
  if (!actionInvocationIsAuthoritative(actionId, argv.slice(matched.length), command)) return null;
  const bindings = actionBindings(actionId, contract, trackedSourceCapture);
  return Object.freeze({
    schemaVersion: 3,
    actionId,
    actionBindingSha256: bindings.actionBindingSha256,
    untrackedPolicySha256: bindings.untrackedPolicySha256,
    untrackedEnumerationSha256: bindings.untrackedEnumerationSha256,
    trackedMembershipSha256: bindings.trackedMembershipSha256,
    trackedSourceBindingSha256: bindings.trackedSourceBindingSha256,
    trackedSourceEvidenceSha256: bindings.trackedSourceEvidenceSha256,
    invocationSha256: sha256(canonical(argv)),
  });
}

function recordSetupInvocationSuccess(argv, completion, {
  evidenceSha256,
  invocationBinding,
  postTrackedSourceCapture,
  now = Date.now(),
  requireReceipt = false,
} = {}) {
  const refuse = (message) => {
    if (requireReceipt) throw new Error(message);
    return null;
  };
  if (!safeInvocationArguments(argv)) return refuse('setup success invocation is invalid');
  const after = captureSetupInvocation(argv, { trackedSourceCapture: postTrackedSourceCapture });
  if (after === null) {
    return refuse('setup invocation was a plan, status, dry-run, or otherwise non-authoritative form');
  }
  const actionId = after.actionId;
  try {
    validateSetupInvocationBinding(invocationBinding, { actionId });
  } catch {
    return refuse('setup invocation source or action evidence changed during execution');
  }
  if (canonical(invocationBinding) !== canonical(after)) {
    return refuse('setup invocation source or action evidence changed during execution');
  }
  const lifetime = receiptLifetimeMilliseconds(commandForId(actionId));
  if (!exactCompletion(actionId, completion)) {
    return refuse('setup command did not return its exact action-specific success result');
  }
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('setup success receipt time is invalid');
  const evidenceKind = IMPORT_EVIDENCE_KINDS[actionId] || 'authoritative-command-result';
  const imported = Object.hasOwn(IMPORT_EVIDENCE_KINDS, actionId);
  const selectedEvidence = imported
    ? evidenceSha256
    : sha256(canonical({ invocationBinding, completion }));
  if (!SHA256.test(selectedEvidence || '') || (!imported && evidenceSha256 !== undefined)) {
    throw new Error('setup success evidence does not match its action policy');
  }
  const invocationSha256 = after.invocationSha256;
  const completionSha256 = sha256(canonical(completion));
  validateReceiptDirectory({ create: true });
  const receipt = {
    schemaVersion: 5,
    actionId,
    actionBindingSha256: after.actionBindingSha256,
    untrackedPolicySha256: after.untrackedPolicySha256,
    untrackedEnumerationSha256: after.untrackedEnumerationSha256,
    trackedMembershipSha256: after.trackedMembershipSha256,
    trackedSourceBindingSha256: after.trackedSourceBindingSha256,
    trackedSourceEvidenceSha256: after.trackedSourceEvidenceSha256,
    executionBindingSha256: sha256(canonical(invocationBinding)),
    invocationSha256,
    completionSha256,
    evidenceSha256: selectedEvidence,
    evidenceKind,
    completedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + lifetime).toISOString(),
    outcome: 'success',
  };
  const destination = receiptPath(actionId);
  const temporary = path.join(RECEIPT_DIR, `.${actionId}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, canonicalJson(receipt), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return Object.freeze(receipt);
}

function readSetupActionReceipt(actionId, { now = Date.now() } = {}) {
  if (!validateReceiptDirectory()) return null;
  const selected = receiptPath(actionId);
  if (!fs.existsSync(selected)) return null;
  const stat = fs.lstatSync(selected);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size <= 0 || stat.size > 8192) {
    throw new Error(`setup action receipt must be a bounded regular mode-0600 file: ${selected}`);
  }
  const source = fs.readFileSync(selected, 'utf8');
  let receipt;
  try { receipt = JSON.parse(source); } catch { throw new Error(`setup action receipt is invalid JSON: ${selected}`); }
  if (source !== canonicalJson(receipt)) {
    throw new Error(`setup action receipt is not canonical: ${selected}`);
  }
  // Earlier receipts lacked the closed tracked membership plus unfiltered
  // untracked-source policy. They remain convenience-only history and cannot
  // advance the current journey.
  if (receipt?.schemaVersion !== 5) return null;
  if (
    Object.keys(receipt).sort().join(',') !== [...RECEIPT_FIELDS].sort().join(',') ||
    receipt.actionId !== actionId || receipt.outcome !== 'success' ||
    !SHA256.test(receipt.actionBindingSha256) ||
    !SHA256.test(receipt.untrackedPolicySha256) ||
    !SHA256.test(receipt.untrackedEnumerationSha256) ||
    !SHA256.test(receipt.trackedMembershipSha256) ||
    !SHA256.test(receipt.trackedSourceBindingSha256) ||
    !SHA256.test(receipt.trackedSourceEvidenceSha256) ||
    !SHA256.test(receipt.executionBindingSha256) ||
    !SHA256.test(receipt.invocationSha256) || !SHA256.test(receipt.completionSha256) ||
    !SHA256.test(receipt.evidenceSha256) ||
    !['authoritative-command-result', ...Object.values(IMPORT_EVIDENCE_KINDS)].includes(receipt.evidenceKind)
  ) throw new Error(`setup action receipt has an unsupported shape: ${selected}`);
  const completedAt = Date.parse(receipt.completedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  const bindings = actionBindings(actionId);
  const lifetime = receiptLifetimeMilliseconds(bindings.command);
  if (
    !Number.isSafeInteger(now) || !Number.isFinite(completedAt) || !Number.isFinite(expiresAt) ||
    completedAt > now + 5 * 60 * 1000 || expiresAt !== completedAt + lifetime || expiresAt <= now ||
    receipt.actionBindingSha256 !== bindings.actionBindingSha256 ||
    receipt.untrackedPolicySha256 !== bindings.untrackedPolicySha256 ||
    receipt.untrackedEnumerationSha256 !== bindings.untrackedEnumerationSha256 ||
    receipt.trackedMembershipSha256 !== bindings.trackedMembershipSha256 ||
    receipt.trackedSourceBindingSha256 !== bindings.trackedSourceBindingSha256 ||
    receipt.trackedSourceEvidenceSha256 !== bindings.trackedSourceEvidenceSha256
  ) return null;
  return Object.freeze(receipt);
}

function matchedCommandForInvocation(argv, contract = operatorContract()) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) return null;
  const tokens = argv;
  let selected = null;
  for (const command of contract.commands) {
    for (const candidate of [command.tokens, ...command.aliases]) {
      if (
        candidate.length <= tokens.length &&
        candidate.every((token, index) => tokens[index] === token) &&
        (selected === null || candidate.length > selected.length)
      ) selected = { id: command.id, length: candidate.length };
    }
  }
  return selected;
}

function commandIdForInvocation(argv, contract = operatorContract()) {
  return matchedCommandForInvocation(argv, contract)?.id ?? null;
}

function validateStateRoot() {
  if (isInsideSource(STATE_DIR)) throw new Error(`setup state must be outside the source tree: ${STATE_DIR}`);
  if (fs.existsSync(STATE_DIR)) {
    const stat = fs.lstatSync(STATE_DIR);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`setup state root is not a real directory: ${STATE_DIR}`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`setup state root must have mode 0700: ${STATE_DIR}`);
  } else {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(STATE_DIR, 0o700);
  }
}

function readSetupState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  const stat = fs.lstatSync(STATE_FILE);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`setup state must be a regular mode-0600 file: ${STATE_FILE}`);
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`setup state is invalid JSON: ${error.message}`);
  }
  if (state?.schemaVersion !== 1 || !TRACKS.includes(state.selectedTrack) ||
      Object.keys(state).sort().join(',') !== 'schemaVersion,selectedTrack') {
    throw new Error(`setup state has an unsupported shape: ${STATE_FILE}`);
  }
  return state;
}

function selectSetupTrack(selectedTrack) {
  if (!TRACKS.includes(selectedTrack)) throw new Error(`unknown setup track: ${selectedTrack}`);
  validateStateRoot();
  if (fs.existsSync(STATE_FILE)) {
    const stat = fs.lstatSync(STATE_FILE);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Error(`refusing to replace setup state unless it is a regular mode-0600 file: ${STATE_FILE}`);
    }
  }
  const temporary = path.join(STATE_DIR, `.setup-state.${process.pid}.tmp`);
  const contents = `${JSON.stringify({ schemaVersion: 1, selectedTrack }, null, 2)}\n`;
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, STATE_FILE);
    fs.chmodSync(STATE_FILE, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return readSetupState();
}

module.exports = {
  TRACKS,
  STATE_DIR,
  STATE_FILE,
  RECEIPT_DIR,
  readSetupState,
  selectSetupTrack,
  ACTION_SUCCESS_OUTCOMES,
  captureTrackedSource,
  captureSetupInvocation,
  validateSetupInvocationBinding,
  recordSetupInvocationSuccess,
  readSetupActionReceipt,
  commandIdForInvocation,
};
