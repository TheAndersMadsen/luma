'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PYTHON_HELPER = path.join(__dirname, 'rooted-source-helper.py');
const ROOTED_SOURCE_HELPER_SHA256 = 'b7e00634dba4d847122c2442a76355495373c7b07781950b9affaab83708a41e';
const MAX_ROOTED_SOURCE_HELPER_BYTES = 64 * 1024;

function statReceipt(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: (Number(stat.mode) & 0o7777).toString(8),
    nlink: stat.nlink.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

function sameStat(left, right) {
  return JSON.stringify(statReceipt(left)) === JSON.stringify(statReceipt(right));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    (left.mode & 0o170000n) === (right.mode & 0o170000n);
}

function safeRelative(relativePath) {
  return relativePath === '.' || (typeof relativePath === 'string' && relativePath.length > 0 &&
    !relativePath.includes('\\') && !relativePath.includes('\0') &&
    !path.posix.isAbsolute(relativePath) &&
    relativePath.split('/').every((part) => part !== '' && part !== '.' && part !== '..'));
}

function descriptorRoot() {
  if (process.platform !== 'linux') {
    throw new Error('native descriptor-rooted reads require Linux procfs; use the batched reader');
  }
  const candidate = '/proc/self/fd';
  try {
    if (fs.statSync(candidate).isDirectory()) return candidate;
  } catch {
    // Fall through to the fail-closed diagnostic.
  }
  throw new Error('native descriptor-rooted reads require Linux /proc/self/fd');
}

function safeLstat(candidate, relativePath, label, changed = false) {
  try {
    return fs.lstatSync(candidate, { bigint: true });
  } catch (error) {
    if (changed && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)) {
      throw new Error(`${label} changed during descriptor traversal: ${relativePath}`);
    }
    throw error;
  }
}

function openNoFollow(candidate, flags, relativePath, label) {
  try {
    return fs.openSync(candidate, flags);
  } catch (error) {
    if (['ELOOP', 'EMLINK', 'ENOTDIR'].includes(error?.code)) {
      throw new Error(`symbolic links are forbidden in ${label}: ${relativePath}`);
    }
    throw error;
  }
}

function openCanonicalRoot(canonicalRoot, directoryFlags, descriptorBase, relativePath, label) {
  let realRoot;
  try {
    realRoot = fs.realpathSync.native(canonicalRoot);
  } catch (error) {
    throw new Error(`${label} cannot resolve its source root: ${error.code ?? 'unknown error'}`);
  }
  if (realRoot !== canonicalRoot) {
    throw new Error(`${label} source root ancestors must not be symbolic links`);
  }
  const chain = [];
  try {
    const filesystemRoot = path.parse(canonicalRoot).root;
    const rootDescriptor = openNoFollow(filesystemRoot, directoryFlags, relativePath, label);
    const rootStat = fs.fstatSync(rootDescriptor, { bigint: true });
    chain.push({ descriptor: rootDescriptor, before: rootStat, name: null, parent: null });
    for (const part of canonicalRoot.slice(filesystemRoot.length).split(path.sep).filter(Boolean)) {
      const parent = chain.at(-1).descriptor;
      const descriptorPath = path.join(descriptorBase, String(parent), part);
      const before = safeLstat(descriptorPath, relativePath, label);
      if (before.isSymbolicLink() || !before.isDirectory()) {
        throw new Error(`${label} source root ancestors must be real directories`);
      }
      const descriptor = openNoFollow(descriptorPath, directoryFlags, relativePath, label);
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isDirectory() || !sameIdentity(before, opened)) {
        fs.closeSync(descriptor);
        throw new Error(`${label} source root changed before descriptor traversal`);
      }
      chain.push({ descriptor, before: opened, name: part, parent });
    }
    return chain;
  } catch (error) {
    for (const node of chain.reverse()) fs.closeSync(node.descriptor);
    throw error;
  }
}

function verifyCanonicalRoot(chain, descriptorBase, relativePath, label) {
  for (let index = 0; index < chain.length; index += 1) {
    const node = chain[index];
    const descriptorAfter = fs.fstatSync(node.descriptor, { bigint: true });
    const pathAfter = node.parent === null
      ? safeLstat(path.parse(descriptorBase).root || '/', relativePath, label, true)
      : safeLstat(
        path.join(descriptorBase, String(node.parent), node.name),
        relativePath,
        label,
        true,
      );
    const compare = index === chain.length - 1 ? sameStat : sameIdentity;
    if (pathAfter.isSymbolicLink() || !compare(node.before, descriptorAfter) ||
        !compare(descriptorAfter, pathAfter)) {
      throw new Error(`${label} source root changed during descriptor traversal: ${relativePath}`);
    }
  }
}

/** Hold and verify every source-root and source-path component descriptor. */
function withStableRootedNode(root, relativePath, expected, label, callback, expectedRoot = null) {
  if (!safeRelative(relativePath)) {
    throw new Error(`${label} reported an unsafe source path: ${relativePath}`);
  }
  if (!fs.constants.O_NOFOLLOW) {
    throw new Error(`${label} requires O_NOFOLLOW support`);
  }
  const canonicalRoot = path.resolve(root);
  const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW |
    (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_CLOEXEC || 0);
  const fileFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW |
    (fs.constants.O_CLOEXEC || 0);
  const descriptorBase = descriptorRoot();
  const rootChain = openCanonicalRoot(
    canonicalRoot,
    directoryFlags,
    descriptorBase,
    relativePath,
    label,
  );
  const opened = [];
  try {
    const rootDescriptor = rootChain.at(-1).descriptor;
    const rootDescriptorStat = rootChain.at(-1).before;
    if (expectedRoot && JSON.stringify(statReceipt(rootDescriptorStat)) !== JSON.stringify(expectedRoot)) {
      throw new Error(`${label} root changed during descriptor traversal: ${relativePath}`);
    }
    opened.push({
      descriptor: rootDescriptor,
      parentDescriptor: null,
      name: null,
      sourcePath: '.',
      before: rootDescriptorStat,
    });

    const parts = relativePath === '.' ? [] : relativePath.split('/');
    let sourcePath = '';
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      sourcePath = sourcePath ? `${sourcePath}/${part}` : part;
      const parentDescriptor = opened.at(-1).descriptor;
      const descriptorPath = path.join(descriptorBase, String(parentDescriptor), part);
      const pathStat = safeLstat(descriptorPath, relativePath, label);
      if (pathStat.isSymbolicLink()) {
        throw new Error(`symbolic links are forbidden in ${label}: ${sourcePath}`);
      }
      const isFinal = index === parts.length - 1;
      if (!isFinal && !pathStat.isDirectory()) {
        throw new Error(`${label} ancestor is not a directory: ${sourcePath}`);
      }
      const descriptor = openNoFollow(
        descriptorPath,
        isFinal && expected !== 'directory' ? fileFlags : directoryFlags,
        sourcePath,
        label,
      );
      const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
      if (!sameStat(pathStat, descriptorStat)) {
        fs.closeSync(descriptor);
        throw new Error(`${label} changed before descriptor read: ${sourcePath}`);
      }
      if ((!isFinal || expected === 'directory') && !descriptorStat.isDirectory()) {
        fs.closeSync(descriptor);
        throw new Error(`${label} path is not a directory: ${sourcePath}`);
      }
      if (isFinal && expected === 'file' && !descriptorStat.isFile()) {
        fs.closeSync(descriptor);
        throw new Error(`${label} supports only regular files: ${sourcePath}`);
      }
      if (isFinal && expected === 'any' &&
          !descriptorStat.isFile() && !descriptorStat.isDirectory()) {
        fs.closeSync(descriptor);
        throw new Error(`${label} supports only regular files and directories: ${sourcePath}`);
      }
      if (isFinal && descriptorStat.isFile() && descriptorStat.nlink !== 1n) {
        fs.closeSync(descriptor);
        throw new Error(`hard-linked files are forbidden in ${label}: ${sourcePath}`);
      }
      opened.push({
        descriptor,
        parentDescriptor,
        name: part,
        sourcePath,
        before: descriptorStat,
      });
    }

    const finalNode = opened.at(-1);
    if (finalNode.before.isFile() && finalNode.before.nlink !== 1n) {
      throw new Error(`hard-linked files are forbidden in ${label}: ${relativePath}`);
    }
    const value = callback(
      finalNode.descriptor,
      path.join(descriptorBase, String(finalNode.descriptor)),
      finalNode.before,
    );
    for (const node of opened.slice(1)) {
      const descriptorAfter = fs.fstatSync(node.descriptor, { bigint: true });
      const pathAfter = safeLstat(
        path.join(descriptorBase, String(node.parentDescriptor), node.name),
        relativePath,
        label,
        true,
      );
      if (pathAfter.isSymbolicLink() || !sameStat(node.before, descriptorAfter) ||
          !sameStat(descriptorAfter, pathAfter)) {
        throw new Error(`${label} changed during descriptor traversal: ${relativePath}`);
      }
    }
    verifyCanonicalRoot(rootChain, descriptorBase, relativePath, label);
    return {
      value,
      stat: finalNode.before,
      ancestry: opened.map((node) => ({
        path: node.sourcePath,
        ...statReceipt(node.before),
      })),
    };
  } finally {
    for (const node of opened.slice(1).reverse()) {
      try {
        fs.closeSync(node.descriptor);
      } catch {
        // Preserve the original traversal error.
      }
    }
    for (const node of rootChain.reverse()) {
      try {
        fs.closeSync(node.descriptor);
      } catch {
        // Preserve the original traversal error.
      }
    }
  }
}

function readStableRootedFile(root, relativePath, label, expectedRoot = null) {
  const result = withStableRootedNode(
    root,
    relativePath,
    'file',
    label,
    (descriptor) => fs.readFileSync(descriptor),
    expectedRoot,
  );
  if (BigInt(result.value.length) !== result.stat.size) {
    throw new Error(`${label} changed during descriptor read: ${relativePath}`);
  }
  return {
    data: result.value,
    stat: result.stat,
    receipt: {
      path: relativePath,
      ancestry: result.ancestry,
      sha256: crypto.createHash('sha256').update(result.value).digest('hex'),
    },
  };
}

function readStableRootedDirectory(root, relativePath, label, expectedRoot = null) {
  const result = withStableRootedNode(
    root,
    relativePath,
    'directory',
    label,
    (_descriptor, descriptorPath) => fs.readdirSync(descriptorPath),
    expectedRoot,
  );
  const names = result.value.sort((left, right) => left.localeCompare(right, 'en'));
  return {
    names,
    stat: result.stat,
    receipt: {
      path: relativePath,
      ancestry: result.ancestry,
      namesSha256: crypto.createHash('sha256').update(JSON.stringify(names)).digest('hex'),
    },
  };
}

function readStableRootedEntry(root, relativePath, label, expectedRoot = null) {
  const result = withStableRootedNode(
    root,
    relativePath,
    'any',
    label,
    (descriptor, descriptorPath, stat) => stat.isDirectory()
      ? { kind: 'directory', names: fs.readdirSync(descriptorPath) }
      : { kind: 'file', data: fs.readFileSync(descriptor) },
    expectedRoot,
  );
  if (result.value.kind === 'file') {
    if (BigInt(result.value.data.length) !== result.stat.size) {
      throw new Error(`${label} changed during descriptor read: ${relativePath}`);
    }
    return {
      kind: 'file',
      data: result.value.data,
      stat: result.stat,
      receipt: {
        path: relativePath,
        ancestry: result.ancestry,
        sha256: crypto.createHash('sha256').update(result.value.data).digest('hex'),
      },
    };
  }
  const names = result.value.names.sort((left, right) => left.localeCompare(right, 'en'));
  return {
    kind: 'directory',
    names,
    stat: result.stat,
    receipt: {
      path: relativePath,
      ancestry: result.ancestry,
      namesSha256: crypto.createHash('sha256').update(JSON.stringify(names)).digest('hex'),
    },
  };
}

function pythonStat(receipt, kind) {
  return {
    dev: BigInt(receipt.dev),
    ino: BigInt(receipt.ino),
    mode: BigInt(Number.parseInt(receipt.mode, 8) |
      (kind === 'directory' ? 0o040000 : 0o100000)),
    nlink: BigInt(receipt.nlink),
    uid: BigInt(receipt.uid),
    gid: BigInt(receipt.gid),
    size: BigInt(receipt.size),
    mtimeNs: BigInt(receipt.mtimeNs),
    ctimeNs: BigInt(receipt.ctimeNs),
  };
}

function trustedPythonCandidates({ pathLaunch = process.platform === 'darwin' } = {}) {
  const filesystemRoot = path.parse(process.execPath).root;
  const rootOwnedSystemCandidates = [
    path.join(filesystemRoot, 'usr', 'bin', 'python3'),
    path.join(filesystemRoot, 'Library', 'Developer', 'CommandLineTools', 'usr', 'bin', 'python3'),
  ];
  if (pathLaunch) return rootOwnedSystemCandidates;
  return [
    path.join(path.dirname(process.execPath), 'python3'),
    path.join(filesystemRoot, 'opt', 'homebrew', 'bin', 'python3'),
    path.join(filesystemRoot, 'usr', 'local', 'bin', 'python3'),
    ...rootOwnedSystemCandidates,
  ];
}

function securePythonAncestor(stat, allowedOwners) {
  return !stat.isSymbolicLink() && stat.isDirectory() &&
    allowedOwners.has(Number(stat.uid)) && (stat.mode & 0o022n) === 0n;
}

function samePythonAncestor(receipt, stat) {
  const current = statReceipt(stat);
  return ['dev', 'ino', 'mode', 'uid', 'gid'].every((field) => receipt[field] === current[field]);
}

function resolveTrustedPython3({
  candidates = trustedPythonCandidates(),
  realpathSync = fs.realpathSync.native,
  lstatSync = fs.lstatSync,
  accessSync = fs.accessSync,
  requireRootOwned = process.platform === 'darwin',
  requireCanonicalPath = process.platform === 'darwin',
} = {}) {
  const allowedOwners = new Set([0]);
  if (!requireRootOwned && typeof process.getuid === 'function') allowedOwners.add(process.getuid());
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (!path.isAbsolute(candidate)) continue;
      const candidateMetadata = lstatSync(candidate, { bigint: true });
      if (candidateMetadata.isSymbolicLink() && requireCanonicalPath) continue;
      const canonical = realpathSync(candidate);
      if (requireCanonicalPath && canonical !== candidate) continue;
      const metadata = lstatSync(canonical, { bigint: true });
      if (metadata.isSymbolicLink() || !metadata.isFile() ||
          !allowedOwners.has(Number(metadata.uid)) || (metadata.mode & 0o022n) !== 0n ||
          (metadata.mode & 0o111n) === 0n) {
        continue;
      }
      const filesystemRoot = path.parse(canonical).root;
      let cursor = filesystemRoot;
      let secure = true;
      const ancestry = [];
      const rootMetadata = lstatSync(filesystemRoot, { bigint: true });
      if (!securePythonAncestor(rootMetadata, allowedOwners)) continue;
      ancestry.push({ path: filesystemRoot, receipt: statReceipt(rootMetadata) });
      for (const part of canonical.slice(filesystemRoot.length).split(path.sep).filter(Boolean).slice(0, -1)) {
        cursor = path.join(cursor, part);
        const ancestor = lstatSync(cursor, { bigint: true });
        if (!securePythonAncestor(ancestor, allowedOwners)) {
          secure = false;
          break;
        }
        ancestry.push({ path: cursor, receipt: statReceipt(ancestor) });
      }
      if (!secure) continue;
      accessSync(canonical, fs.constants.X_OK);
      return { path: canonical, receipt: statReceipt(metadata), ancestry };
    } catch {
      // Try the next fixed, audited installation location.
    }
  }
  throw new Error('no secure Python 3 exists at an audited installation location');
}

function verifyTrustedPythonPath(python, label) {
  let canonical;
  try {
    canonical = fs.realpathSync.native(python.path);
  } catch {
    throw new Error(`${label} Python 3 changed during the batched descriptor read`);
  }
  if (canonical !== python.path) {
    throw new Error(`${label} Python 3 path became symbolic during the batched descriptor read`);
  }
  for (const ancestor of python.ancestry) {
    let metadata;
    try {
      metadata = fs.lstatSync(ancestor.path, { bigint: true });
    } catch {
      throw new Error(`${label} Python 3 ancestry changed during the batched descriptor read`);
    }
    if (!securePythonAncestor(metadata, new Set([0])) ||
        !samePythonAncestor(ancestor.receipt, metadata)) {
      throw new Error(`${label} Python 3 ancestry changed during the batched descriptor read`);
    }
  }
  let metadata;
  try {
    metadata = fs.lstatSync(python.path, { bigint: true });
  } catch {
    throw new Error(`${label} Python 3 changed during the batched descriptor read`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || Number(metadata.uid) !== 0 ||
      (metadata.mode & 0o022n) !== 0n || (metadata.mode & 0o111n) === 0n ||
      JSON.stringify(statReceipt(metadata)) !== JSON.stringify(python.receipt)) {
    throw new Error(`${label} Python 3 changed during the batched descriptor read`);
  }
}

function pythonRootedEntries(root, relativePaths, label, {
  walk,
  prune,
  expectedRoot,
  pythonExecutable,
  spawnSync = childProcess.spawnSync,
} = {}) {
  let helperDescriptor;
  let helperStat;
  let helperSource;
  try {
    if (!fs.constants.O_NOFOLLOW) throw new Error('helper authority requires O_NOFOLLOW');
    helperDescriptor = fs.openSync(
      PYTHON_HELPER,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_CLOEXEC || 0),
    );
    helperStat = fs.fstatSync(helperDescriptor, { bigint: true });
    if (!helperStat.isFile() || helperStat.nlink !== 1n ||
        helperStat.size > BigInt(MAX_ROOTED_SOURCE_HELPER_BYTES)) {
      throw new Error('invalid helper authority');
    }
    const helperBytes = fs.readFileSync(helperDescriptor);
    const descriptorAfter = fs.fstatSync(helperDescriptor, { bigint: true });
    const pathAfter = fs.lstatSync(PYTHON_HELPER, { bigint: true });
    if (!sameStat(helperStat, descriptorAfter) || !sameStat(descriptorAfter, pathAfter) ||
        crypto.createHash('sha256').update(helperBytes).digest('hex') !==
          ROOTED_SOURCE_HELPER_SHA256) {
      throw new Error('helper authority changed or digest mismatch');
    }
    helperSource = helperBytes.toString('utf8');
  } catch {
    throw new Error(`${label} requires the batched descriptor helper`);
  } finally {
    if (helperDescriptor !== undefined) fs.closeSync(helperDescriptor);
  }
  const request = JSON.stringify({
    root: path.resolve(root),
    label,
    paths: relativePaths,
    walk,
    prune,
    expectedRoot,
  });
  const darwinPathLaunch = process.platform === 'darwin';
  if (darwinPathLaunch && pythonExecutable !== undefined) {
    throw new Error(`${label} cannot override the fixed Darwin Python 3 authority`);
  }
  const python = resolveTrustedPython3({
    candidates: darwinPathLaunch
      ? trustedPythonCandidates({ pathLaunch: true })
      : pythonExecutable ? [pythonExecutable] : trustedPythonCandidates({ pathLaunch: false }),
    requireRootOwned: darwinPathLaunch,
    requireCanonicalPath: darwinPathLaunch,
  });
  let pythonDescriptor;
  let result;
  try {
    pythonDescriptor = fs.openSync(
      python.path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_CLOEXEC || 0),
    );
    const openedPython = fs.fstatSync(pythonDescriptor, { bigint: true });
    if (JSON.stringify(statReceipt(openedPython)) !== JSON.stringify(python.receipt)) {
      throw new Error(`${label} Python 3 changed before descriptor-authorized launch`);
    }
    if (darwinPathLaunch) verifyTrustedPythonPath(python, label);
    // Linux executes the held Python descriptor. XNU exposes fdesc entries for
    // I/O but does not make them executable, so Darwin executes one link-free,
    // root-owned system pathname while retaining the open descriptor and
    // revalidating the exact file plus its ancestry before and after launch.
    // The helper itself remains hash-pinned `-c` bytes, never a pathname.
    result = spawnSync(
      darwinPathLaunch ? python.path : '/dev/fd/3',
      ['-I', '-B', '-c', helperSource], {
      input: request,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: {
        LANG: 'C',
        LC_ALL: 'C',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
      },
      stdio: darwinPathLaunch
        ? ['pipe', 'pipe', 'pipe']
        : ['pipe', 'pipe', 'pipe', pythonDescriptor],
    });
  } finally {
    if (pythonDescriptor !== undefined) fs.closeSync(pythonDescriptor);
  }
  if (darwinPathLaunch) verifyTrustedPythonPath(python, label);
  let pythonAfter;
  try {
    pythonAfter = fs.lstatSync(python.path, { bigint: true });
  } catch {
    throw new Error(`${label} Python 3 changed during the batched descriptor read`);
  }
  if (JSON.stringify(statReceipt(pythonAfter)) !== JSON.stringify(python.receipt)) {
    throw new Error(`${label} Python 3 changed during the batched descriptor read`);
  }
  let response;
  try {
    response = JSON.parse(result.stdout || 'null');
  } catch {
    response = null;
  }
  if (result.error || result.signal || result.status !== 0 || response?.ok !== true) {
    const detail = typeof response?.error === 'string'
      ? response.error
      : result.error?.message ?? `helper exited with status ${String(result.status)}`;
    throw new Error(`${label} batched descriptor read failed: ${detail}`);
  }
  const entries = response.entries.map((entry) => {
    const stat = pythonStat(entry.stat, entry.kind);
    const ancestry = entry.ancestry;
    if (entry.kind === 'file') {
      const data = Buffer.from(entry.data, 'base64');
      return {
        kind: 'file',
        data,
        stat,
        receipt: {
          path: entry.path,
          ancestry,
          sha256: crypto.createHash('sha256').update(data).digest('hex'),
        },
      };
    }
    const names = entry.names;
    return {
      kind: 'directory',
      names,
      stat,
      receipt: {
        path: entry.path,
        ancestry,
        namesSha256: crypto.createHash('sha256').update(JSON.stringify(names)).digest('hex'),
      },
    };
  });
  return { rootReceipt: response.root, entries };
}

function readStableRootedEntries(root, relativePaths, label, {
  walk = false,
  prune = [],
  expectedRoot = null,
  platform = process.platform,
  pythonExecutable,
  spawnSync,
} = {}) {
  if (!Array.isArray(relativePaths) || relativePaths.some((item) => !safeRelative(item))) {
    throw new Error(`${label} received an unsafe batched source path`);
  }
  if (!Array.isArray(prune) || prune.some((item) => !safeRelative(item))) {
    throw new Error(`${label} received an unsafe batched prune path`);
  }
  if (platform === 'darwin') {
    return pythonRootedEntries(root, relativePaths, label, {
      walk,
      prune,
      expectedRoot,
      pythonExecutable,
      spawnSync,
    });
  }
  if (platform !== 'linux') {
    throw new Error(`${label} has no audited descriptor-relative reader for ${platform}`);
  }
  const entries = [];
  const seen = new Set();
  const pruned = new Set(prune);
  let rootReceipt = expectedRoot;
  const visit = (relativePath) => {
    if (seen.has(relativePath)) return;
    // A pruned boundary is outside the captured model, including the boundary
    // directory itself. Recording its inode/ctime while omitting its children
    // made `.git` metadata an accidental source-policy input.
    if (relativePath !== '.' && [...pruned].some((boundary) =>
      relativePath === boundary || relativePath.startsWith(`${boundary}/`))) {
      seen.add(relativePath);
      return;
    }
    const entry = readStableRootedEntry(root, relativePath, label, rootReceipt);
    if (!rootReceipt) {
      const { path: _rootPath, ...capturedRoot } = entry.receipt.ancestry[0];
      rootReceipt = capturedRoot;
    }
    seen.add(relativePath);
    entries.push(entry);
    if (walk && entry.kind === 'directory') {
      for (const name of entry.names) {
        visit(relativePath === '.' ? name : `${relativePath}/${name}`);
      }
    }
  };
  for (const relativePath of [...new Set(relativePaths)].sort((left, right) =>
    left.localeCompare(right, 'en'))) {
    visit(relativePath);
  }
  if (entries.length === 0) {
    // Match the sealed helper: an all-pruned request returns no entries but
    // still proves which canonical root was consulted.
    const rootAuthority = readStableRootedEntry(root, '.', label, expectedRoot);
    const { path: _rootPath, ...capturedRoot } = rootAuthority.receipt.ancestry[0];
    rootReceipt = capturedRoot;
  }
  return { rootReceipt, entries };
}

module.exports = {
  ROOTED_SOURCE_HELPER_SHA256,
  readStableRootedDirectory,
  readStableRootedEntry,
  readStableRootedEntries,
  readStableRootedFile,
  resolveTrustedPython3,
  sameStat,
  statReceipt,
};
