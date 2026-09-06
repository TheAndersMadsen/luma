import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ROOT, testProcessEnvironment } = require('../../cli/context.js');

test('native compiler and local STT model inputs require pinned bytes', () => {
  const result = spawnSync('python3', [path.join(ROOT, 'cosmos/native/prepare_test.py')], {
    env: testProcessEnvironment(), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 9 tests/u);
});

test('patched recognition source is acquired and reused only with verified bytes', () => {
  const result = spawnSync('python3', [path.join(ROOT, 'cosmos/native/prepare_whisper_test.py')], {
    env: testProcessEnvironment(), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran [1-9][0-9]* tests/u);
});
