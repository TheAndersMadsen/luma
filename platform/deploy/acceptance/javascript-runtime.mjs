#!/usr/bin/env -S bun --no-env-file
// E2E evidence for the built Center image. No account, provider, or Pin access.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { resolveTool } = require('../../cli/authority.js');
const root = resolve(import.meta.dirname, '../../..');
const [image, output] = process.argv.slice(2);
if (!image || !output || process.argv.length !== 4) {
  throw new Error('usage: bun platform/deploy/acceptance/javascript-runtime.mjs IMAGE EXTERNAL_REPORT.json');
}
const reportPath = resolve(output);
assert.ok(!reportPath.startsWith(`${root}${sep}`), 'evidence belongs outside the checkout');
const docker = resolveTool('docker');
const run = (args, options = {}) => execFileSync(docker, args, { encoding: 'utf8', timeout: 30000, ...options }).trim();
const name = `luma-js-e2e-${randomUUID()}`;
const report = {
  image,
  imageId: run(['image', 'inspect', image, '--format', '{{.Id}}']),
  platform: run(['image', 'inspect', image, '--format', '{{.Os}}/{{.Architecture}}']),
  checks: [],
};
const compose = JSON.parse(run(['compose', '--env-file', '/dev/null',
  '-f', resolve(root, 'compose.yaml'), 'config', '--no-interpolate', '--format', 'json']));
const center = compose.services.center;
assert.equal(center.read_only, true);
try {
  run(['run', '--detach', '--rm', '--name', name, '--platform', report.platform, '--publish', '127.0.0.1::4000',
    '--read-only', ...center.tmpfs.flatMap((mount) => ['--tmpfs', mount]),
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '256', '--memory', '1g',
    '--env', `BUN_OPTIONS=${center.environment.BUN_OPTIONS}`,
    '--env', 'LUMA_RELEASE_ID=bun-pnpm-check', '--env', 'LUMA_ENVIRONMENT=production',
    '--env', 'KEYCLOAK_BASE_URL=https://identity.example.test', image]);
  const port = run(['port', name, '4000/tcp']).split(':').at(-1);
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  const readyBy = Date.now() + 60000;
  while (Date.now() < readyBy) {
    try { ready = (await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (ready) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, 'Center did not become ready');
  const version = await fetch(`${origin}/api/version`).then((response) => response.json());
  assert.equal(version.release, 'bun-pnpm-check');
  assert.equal(version.environment, 'production');
  report.checks.push('public release and production identity');
  const [healthKind, ...healthCommand] = center.healthcheck.test;
  assert.equal(healthKind, 'CMD');
  run(['exec', name, ...healthCommand]);
  report.checks.push('canonical Compose health check succeeds in the image');
  const withCookie = await fetch(`${origin}/api/version`, { headers: { Cookie: `session-fixture=${'a'.repeat(20000)}` } });
  assert.equal(withCookie.status, 200);
  report.checks.push('large session-cookie headers are accepted');
  run(['exec', '--workdir', '/app/center', name, 'bun', '--no-env-file', '-e',
    'const sharp = require("node:module").createRequire(require.resolve("next"))("sharp"); const bytes = await sharp({create:{width:2,height:2,channels:3,background:"white"}}).webp().toBuffer(); if (!bytes.length) process.exit(1); const fs=require("node:fs"); fs.writeFileSync(".next/cache/runtime-check", bytes); fs.unlinkSync(".next/cache/runtime-check");']);
  report.checks.push('native image processing and writable Next cache on a read-only filesystem');
  for (const path of ['/', '/login']) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') || '', /text\/html/);
    assert.match(await response.text(), /<h1/);
    report.checks.push(`rendered ${path}`);
  }
  for (const path of ['/about', '/privacy', '/developers']) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
  }
  report.checks.push('removed public content pages remain absent');
  for (const [path, contentType, firstLine] of [
    ['/install.sh', 'text/x-shellscript', '#!/usr/bin/env bash'],
    ['/cloud-init.yaml', 'text/cloud-config', '#cloud-config'],
    ['/llms.txt', 'text/markdown', '# Luma Center'],
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get('content-type')?.startsWith(contentType), path);
    assert.ok((await response.text()).startsWith(firstLine), path);
    report.checks.push(`served ${path}`);
  }
  const api = await fetch(`${origin}/openapi.json`);
  assert.equal(api.status, 200);
  assert.match(api.headers.get('content-type') || '', /application\/json/);
  const specification = await api.json();
  assert.equal(specification.openapi, '3.1.2');
  assert.ok(specification.paths['/api/version']);
  report.checks.push('served the public OpenAPI contract');
  const privatePage = await fetch(`${origin}/settings`, { redirect: 'manual' });
  assert.ok([302, 303, 307, 308].includes(privatePage.status), 'settings must require sign-in');
  report.checks.push('private settings require sign-in');
  const runtime = JSON.parse(run(['exec', name, 'bun', '--no-env-file', '-e',
    'console.log(JSON.stringify({bun:process.versions.bun,uid:process.getuid()}))']));
  assert.equal(runtime.bun, '1.4.2');
  assert.notEqual(runtime.uid, 0);
  report.runtime = runtime;
  const worker = (script, values = []) => spawnSync(docker,
    ['exec', '-i', '--workdir', '/app/center', name, 'bun', '--no-env-file', 'runtime/youtube-player-worker.mjs'],
    { input: JSON.stringify({ script, values }), encoding: 'utf8', timeout: 3000 });
  const transformed = worker('const url = new URL(n); url.searchParams.set("n", url.searchParams.get("n").split("").reverse().join("")); return { n: url.toString() };',
    [['n', 'https://example.test/play?n=abc']]);
  assert.equal(transformed.status, 0, transformed.stderr);
  assert.equal(JSON.parse(transformed.stdout).n, 'https://example.test/play?n=cba');
  report.checks.push('packaged player URL transformation');
  const isolated = worker('return { n: [typeof process, typeof Bun, typeof require, typeof fetch, typeof Function].join(",") };');
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.equal(JSON.parse(isolated.stdout).n, 'undefined,undefined,undefined,undefined,undefined');
  report.checks.push('player has no host APIs');
  const bounded = worker('while (true) {}');
  assert.equal(bounded.error, undefined, 'interpreter failed to interrupt its own script');
  assert.notEqual(bounded.status, 0);
  report.checks.push('player interpreter interrupts CPU-bound scripts');
  for (const script of ['return {n: 42}', 'return {n: "x".repeat(20000)}', 'return {n: new Uint8Array(80 * 1024 * 1024)}']) {
    const invalid = worker(script);
    assert.equal(invalid.error, undefined);
    assert.notEqual(invalid.status, 0);
  }
  report.checks.push('player rejects invalid, oversized, and over-budget results');
  report.completedAt = new Date().toISOString();
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`Passed ${report.checks.length} image checks. Evidence: ${reportPath}`);
} finally {
  spawnSync(docker, ['rm', '--force', name], { stdio: 'ignore', timeout: 10000 });
}
