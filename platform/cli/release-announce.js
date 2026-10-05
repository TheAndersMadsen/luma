'use strict';
// `./luma release announce` posts a published release's patch notes to the
// maintainer's Discord updates channel through a channel webhook. It runs
// after `gh release edit --draft=false`, never before: it reads the GitHub
// release and refuses a draft or a missing one, so the channel never
// announces what an update check cannot yet install. The post is one embed
// built from the release notes `release publish --notes` stored and the
// commits since the previous tag. A receipt in the publication directory
// makes it one post per release.
//
// The webhook URL is a credential (anyone holding it can post as the
// channel), so it lives only in LUMA_SECRETS_DIR/release/discord-webhook at
// mode 0600, written by `--set-webhook` from standard input, and never
// reaches argv, output, or a receipt.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR, SECRETS_DIR, atomicWrite, resolveTool } = require('./context');
const { secretFromStdin } = require('./terminal');

const USAGE = './luma release announce --version X.Y.Z [--confirm]\n' +
  '       ./luma release announce --set-webhook   (reads the webhook URL from standard input)';
const RELEASE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const WEBHOOK = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{17,20}\/[A-Za-z0-9_-]{60,80}$/u;
const WEBHOOK_FILE = path.join(SECRETS_DIR, 'release', 'discord-webhook');
const REPOSITORY = 'https://github.com/TheAndersMadsen/luma';
// Discord's embed limits: description 4096, a field's value 1024, the whole
// embed 6000 characters.
const DESCRIPTION_LIMIT = 4096;
const FIELD_LIMIT = 1024;
const EMBED_COLOR = 0xf2c14e;

function parseAnnounceArguments(argv) {
  const options = { version: null, confirm: false, setWebhook: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--confirm') options.confirm = true;
    else if (argument === '--set-webhook') options.setWebhook = true;
    else if (argument === '--version') {
      options.version = argv[index + 1] ?? null;
      index += 1;
    } else throw new Error(`unknown release announce option: ${argument}`);
  }
  if (options.setWebhook) {
    if (options.version !== null || options.confirm) throw new Error('--set-webhook takes no other option');
    return options;
  }
  if (!options.version || !RELEASE_VERSION.test(options.version)) throw new Error('--version X.Y.Z is required');
  return options;
}

/** Store the channel webhook from standard input (mode 0600). */
function setWebhook(runtime) {
  const url = runtime.readWebhook().trim();
  if (!WEBHOOK.test(url)) {
    throw new Error('that is not a Discord webhook URL (https://discord.com/api/webhooks/ID/TOKEN); nothing was saved');
  }
  atomicWrite(runtime.webhookFile, `${url}\n`, 0o600);
  runtime.print(`Saved the Discord webhook to ${runtime.webhookFile} (mode 0600).`);
}

function storedWebhook(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`no Discord webhook is saved; run \`./luma release announce --set-webhook\` and paste the channel's webhook URL`);
    }
    throw error;
  }
  if (!WEBHOOK.test(text)) throw new Error(`${file} holds no Discord webhook URL; save it again with --set-webhook`);
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`${file} is readable by others (mode ${mode.toString(8)}); chmod 600 it`);
  return text;
}

// Release notes are written as GitHub Markdown. Discord renders bold, code,
// links, and lists in an embed, so a heading becomes a bold line.
function discordMarkdown(notes) {
  return notes
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s+(.+?)\s*#*$/u, '**$1**'))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function clip(text, limit, ending) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - ending.length).trimEnd()}${ending}`;
}

// One line per commit, linked, newest last so the list reads in order. The
// list ends with a compare link when it outgrows the field.
function changesField(commits, previousTag, tag) {
  const compare = previousTag ? `${REPOSITORY}/compare/${previousTag}...${tag}` : `${REPOSITORY}/commits/${tag}`;
  const lines = commits.slice().reverse().map(({ sha, subject }) =>
    `• [${subject.replace(/[[\]]/gu, '')}](${REPOSITORY}/commit/${sha})`);
  const kept = [];
  for (const [index, line] of lines.entries()) {
    const tail = `…and ${lines.length - index} more: [full diff](${compare})`;
    const reserve = index < lines.length - 1 ? tail.length + 1 : 0;
    if ([...kept, line].join('\n').length + reserve > FIELD_LIMIT) {
      kept.push(tail);
      break;
    }
    kept.push(line);
  }
  return kept.join('\n') || `[Full diff](${compare})`;
}

/** The webhook body for one published release. */
function announcement({ version, notes, release, commits, previousTag }) {
  const tag = `v${version}`;
  const description = notes
    ? clip(discordMarkdown(notes), DESCRIPTION_LIMIT, `…\n\n[Read the full notes](${release.url})`)
    : `[Read the release on GitHub](${release.url})`;
  const fields = [];
  if (commits.length) {
    fields.push({ name: `Changes (${commits.length})`, value: changesField(commits, previousTag, tag) });
  }
  fields.push({
    name: 'How to update',
    value: 'In Center: **Settings → Software updates → Install now**.\n' +
      'On the server: `./luma update production`.\n' +
      'Servers with automatic updates install it overnight.',
  });
  return {
    username: 'Luma',
    // Notes and commit subjects are text, never a ping.
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Luma ${version}`,
      url: release.url,
      color: EMBED_COLOR,
      description,
      fields,
      footer: { text: previousTag ? `${previousTag} → ${tag}` : tag },
      timestamp: release.publishedAt,
    }],
  };
}

function git(runtime, args) {
  const result = runtime.run('git', args);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || '').trim().split('\n')[0]}`);
  return result.stdout.trim();
}

function publishedRelease(runtime, tag) {
  const result = runtime.run('gh', ['release', 'view', tag, '--json', 'url,isDraft,publishedAt,tagName']);
  if (result.status !== 0) {
    throw new Error(`GitHub has no ${tag} release yet (${(result.stderr || '').trim().split('\n')[0]}); ` +
      'create and publish it first, then announce it');
  }
  const release = JSON.parse(result.stdout);
  if (release.isDraft) throw new Error(`${tag} is still a draft on GitHub; run gh release edit ${tag} --draft=false first`);
  return release;
}

function commitsSince(runtime, tag) {
  let previousTag = null;
  const described = runtime.run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`]);
  if (described.status === 0) previousTag = described.stdout.trim() || null;
  const range = previousTag ? `${previousTag}..${tag}` : tag;
  const log = git(runtime, ['log', '--no-merges', '--format=%H%x1f%s', range]);
  const commits = log ? log.split('\n').map((line) => {
    const [sha, subject] = line.split('\x1f');
    return { sha, subject };
  }) : [];
  return { previousTag, commits };
}

async function announceRelease(options, runtime) {
  const { version } = options;
  const tag = `v${version}`;
  const root = path.join(runtime.dataDir, 'publication', tag);
  const receipt = path.join(root, 'receipts', 'discord-announcement.json');
  if (fs.existsSync(receipt)) {
    const previous = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    runtime.print(`${tag} was already announced on Discord at ${previous.postedAt} (message ${previous.messageId}); ` +
      `remove ${receipt} to post it again.`);
    return previous;
  }
  const notesFile = path.join(root, 'release-notes.txt');
  const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : '';
  const release = publishedRelease(runtime, tag);
  const { previousTag, commits } = commitsSince(runtime, tag);
  const body = announcement({ version, notes, release, commits, previousTag });

  if (!options.confirm) {
    runtime.print(`Plan: post this announcement of ${tag} to the saved Discord webhook (nothing is sent without --confirm):`);
    runtime.print(JSON.stringify(body, null, 2));
    return body;
  }
  const webhook = storedWebhook(runtime.webhookFile);
  // wait=true makes Discord answer with the message it created.
  const response = await runtime.fetch(`${webhook}?wait=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const answer = await response.text();
  if (!response.ok) {
    throw new Error(`Discord refused the announcement with HTTP ${response.status}: ${answer.slice(0, 200)}`);
  }
  const message = JSON.parse(answer);
  const record = { tag, messageId: message.id, channelId: message.channel_id, postedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  runtime.print(`Announced ${tag} on Discord (message ${message.id} in channel ${message.channel_id}).`);
  return record;
}

function defaultAnnounceRuntime() {
  return Object.freeze({
    dataDir: DATA_DIR,
    webhookFile: WEBHOOK_FILE,
    run: (command, args) => childProcess.spawnSync(resolveTool(command), args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
    fetch: (...args) => globalThis.fetch(...args),
    print: (line) => process.stdout.write(`${line}\n`),
    readWebhook: () => secretFromStdin('the Discord webhook URL'),
  });
}

function announceCommand(options, runtime = defaultAnnounceRuntime()) {
  if (options.setWebhook) return Promise.resolve().then(() => setWebhook(runtime));
  return announceRelease(options, runtime);
}

module.exports = {
  ANNOUNCE_USAGE: USAGE,
  announceCommand,
  announcement,
  discordMarkdown,
  parseAnnounceArguments,
};
