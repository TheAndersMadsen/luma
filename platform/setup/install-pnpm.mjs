#!/usr/bin/env -S bun --no-env-file
// Installs the native pnpm executable. No Node or npm bootstrap is needed.
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import contract from '../containers/pin-builder/toolchain.json' with { type: 'json' };
const destination = process.argv[2];
if (!destination || process.argv.length !== 3) throw new Error('usage: bun platform/setup/install-pnpm.mjs ABSOLUTE_DIRECTORY');
if (resolve(destination) !== destination) throw new Error('pnpm destination must be absolute');
const { version, archives } = contract.toolchain.pnpm;
const asset = `${process.platform}-${process.arch}`;
const digest = archives[asset];
if (!digest) throw new Error(`No pinned pnpm archive for ${asset}`);
const temporary = mkdtempSync(join(tmpdir(), 'luma-pnpm-'));
try {
  const response = await fetch(`https://github.com/pnpm/pnpm/releases/download/v${version}/pnpm-${asset}.tar.gz`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`pnpm download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('pnpm archive checksum mismatch');
  const archive = join(temporary, 'pnpm.tar.gz');
  writeFileSync(archive, bytes, { mode: 0o600 });
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', destination]);
  const observed = execFileSync(join(destination, 'pnpm'), ['--version'], { encoding: 'utf8' }).trim();
  if (observed !== version) throw new Error(`Expected pnpm ${version}; found ${observed}`);
  console.log(`pnpm ${version} installed in ${destination}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
