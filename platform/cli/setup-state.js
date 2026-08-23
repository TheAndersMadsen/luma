'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR, isInsideSource } = require('./context');

const TRACKS = Object.freeze(['local', 'contributor', 'production', 'pin']);
const STATE_DIR = path.resolve(process.env.REVIVAL_STATE_DIR || DATA_DIR);
const STATE_FILE = path.join(STATE_DIR, 'setup-state.json');
const STATE_FILE_MAX_BYTES = 4096;

function validateStateRoot({ create = false } = {}) {
  if (isInsideSource(STATE_DIR)) throw new Error(`setup state must be outside the source tree: ${STATE_DIR}`);
  if (fs.existsSync(STATE_DIR)) {
    const stat = fs.lstatSync(STATE_DIR);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`setup state root must be a real directory: ${STATE_DIR}`);
    }
    if ((stat.mode & 0o777) !== 0o700) {
      throw new Error(`setup state root must have mode 0700: ${STATE_DIR}`);
    }
    return true;
  }
  if (!create) return false;
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(STATE_DIR, 0o700);
  return true;
}

function readSetupState() {
  if (!validateStateRoot()) return null;
  if (!fs.existsSync(STATE_FILE)) return null;
  const stat = fs.lstatSync(STATE_FILE);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`setup state must be a regular mode-0600 file: ${STATE_FILE}`);
  }
  if (stat.size > STATE_FILE_MAX_BYTES) {
    throw new Error(`setup state exceeds ${STATE_FILE_MAX_BYTES} bytes: ${STATE_FILE}`);
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
  validateStateRoot({ create: true });
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

module.exports = { TRACKS, STATE_DIR, STATE_FILE, readSetupState, selectSetupTrack };
