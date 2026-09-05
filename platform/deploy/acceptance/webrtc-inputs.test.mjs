import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ROOT, testProcessEnvironment } = require('../../cli/context.js');

test('native compiler inputs require pinned bytes and an exact extracted tree', () => {
  const result = spawnSync('python3', [path.join(ROOT, 'cosmos/native/prepare_test.py')], {
    env: testProcessEnvironment(), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 3 tests/u);
});
