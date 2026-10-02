'use strict';

const child = require('node:child_process');
const fs = require('node:fs');
const tty = require('node:tty');

const { resolveTool } = require('./authority');

// Reading `process.stdin.isTTY` creates Node's TTY handle for fd 0, which puts
// the terminal into non-blocking mode: a synchronous read then fails with
// EAGAIN whenever the owner has not already typed ahead. Test the descriptors
// directly, and wait out EAGAIN in case another module opened that handle.
function interactiveTerminal() {
  return tty.isatty(0) && tty.isatty(1);
}

function readTerminalLine(endedMessage) {
  const buffer = Buffer.alloc(4096);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    let length;
    try {
      length = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
      Atomics.wait(pause, 0, 0, 50);
      continue;
    }
    if (length === 0) throw new Error(endedMessage);
    return buffer.subarray(0, length).toString('utf8').replace(/[\r\n]+$/u, '');
  }
}

// Reads one line from the terminal with echo off, in a shell that restores
// echo even when interrupted. The value leaves through a pipe, never argv.
const HIDDEN_LINE = [
  "trap 'stty echo; printf \"\\n\" >&2; exit 130' INT TERM",
  'stty -echo',
  'IFS= read -r value; status=$?',
  'stty echo',
  "printf '\\n' >&2",
  '[ "$status" -eq 0 ] || exit 1',
  'printf \'%s\' "$value"',
].join('\n');

function readHiddenTerminalLine(prompt, endedMessage) {
  process.stderr.write(prompt);
  const typed = child.spawnSync(resolveTool('sh'), ['-c', HIDDEN_LINE], {
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    maxBuffer: 128 * 1024,
  });
  if (typed.error || typed.status !== 0) throw new Error(endedMessage);
  return typed.stdout;
}

// A secret named on the command line as `--stdin`: hidden at a terminal,
// otherwise the piped input. Never argv.
function secretFromStdin(name) {
  const source = tty.isatty(0) && tty.isatty(2)
    ? readHiddenTerminalLine(
      `Type or paste ${name}, then press Enter; the terminal does not show it: `,
      `no value was entered; ${name} was not changed`,
    )
    : fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(source, 'utf8') > 64 * 1024) throw new Error('configuration value exceeds 64 KiB');
  return source.replace(/\r?\n$/u, '');
}

module.exports = {
  interactiveTerminal,
  readHiddenTerminalLine,
  readTerminalLine,
  secretFromStdin,
};
