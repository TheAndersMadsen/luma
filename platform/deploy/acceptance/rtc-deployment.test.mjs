import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');

// This opt-in fixture starts only disposable loopback services. It exercises
// the published service definitions and generated proxy/configuration bytes.
test('real Traefik prefix reaches an authenticated LiveKit room without logging join credentials', {
  skip: process.env.REVIVAL_TEST_RTC_DEPLOYMENT !== '1', timeout: 120_000,
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'revival-rtc-deployment-'));
  const project = `revival-rtc-${randomUUID().slice(0, 8)}`;
  const env = {
    ...process.env,
    REVIVAL_CONFIG_DIR: path.join(directory, 'config'),
    REVIVAL_SECRETS_DIR: path.join(directory, 'secrets'),
    REVIVAL_ENV_FILE: path.join(directory, 'secrets/runtime.env'),
    REVIVAL_DATA_DIR: path.join(directory, 'data'),
    REVIVAL_BUILD_DIR: path.join(directory, 'data/build'),
    REVIVAL_STATE_DIR: path.join(directory, 'state'),
  };
  const docker = ['--context', process.env.REVIVAL_TEST_DOCKER_CONTEXT || 'desktop-linux'];
  const fixture = path.join(directory, 'compose.json');
  const compose = [...docker, 'compose', '--project-name', project, '-f', fixture];
  let protectedValues = [];
  const run = (command, args, selectedEnv = env) => {
    const result = spawnSync(command, args, { cwd: root, env: selectedEnv, encoding: 'utf8', timeout: 65_000, maxBuffer: 2 * 1024 * 1024 });
    // Never put rendered configuration or generated signing credentials in a
    // test failure. The diagnostic is the operation, not its sensitive output.
    if (result.status !== 0) {
      const logs = fs.existsSync(fixture) ? spawnSync('docker', [...compose, 'logs', '--no-color'],
        { encoding: 'utf8', timeout: 10_000 }).stdout : '';
      let diagnostic = `${result.stderr || ''}\n${logs || ''}`;
      for (const value of protectedValues) diagnostic = diagnostic.replaceAll(value, '[redacted]');
      assert.fail(`isolated room operation failed: ${diagnostic.slice(-6000)}`);
    }
    return result.stdout;
  };
  t.after(() => {
    spawnSync('docker', [...compose, 'down', '--volumes'], { encoding: 'utf8', timeout: 20_000 });
    fs.rmSync(directory, { recursive: true, force: true });
  });
  run(process.execPath, [path.join(root, 'revival'), 'setup', 'production', '--domain', 'rtc.example.test',
    '--acme-email', 'acme@example.test', '--operator-email', 'owner@example.test']);
  const values = Object.fromEntries(fs.readFileSync(env.REVIVAL_ENV_FILE, 'utf8').split('\n')
    .filter(line => /^[A-Z][A-Z0-9_]*=/u.test(line)).map(line => {
      const separator = line.indexOf('='); return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  const production = path.join(env.REVIVAL_CONFIG_DIR, 'production');
  protectedValues = Object.entries(values).filter(([name, value]) => /SECRET|TOKEN|PASSWORD|KEY/u.test(name) && value.length > 4).map(([, value]) => value);
  const model = JSON.parse(run('docker', [...docker, 'compose', '--env-file', env.REVIVAL_ENV_FILE,
    '-f', 'compose.yaml', '-f', 'platform/compose/production.yaml',
    '-f', path.join(production, 'operator.compose.yaml'), 'config', '--format', 'json'], { ...env, ...values }));
  // Local fixture replaces TLS/ACME with loopback HTTP. The route and exact
  // StripPrefix/credential-log policy remain generated production definitions.
  const staticFile = path.join(production, 'traefik.yaml');
  let staticConfig = fs.readFileSync(staticFile, 'utf8');
  staticConfig = staticConfig.replace(/certificatesResolvers:[\s\S]*?(?=accessLog:)/u, '');
  fs.chmodSync(staticFile, 0o644);
  fs.writeFileSync(staticFile, staticConfig);
  const dynamicFile = path.join(production, 'traefik-dynamic.yaml');
  let dynamic = fs.readFileSync(dynamicFile, 'utf8').replaceAll('Host(`rtc.example.test`)', 'Host(`127.0.0.1`)');
  dynamic = dynamic.replace(/^      tls:\n        certResolver: letsencrypt\n/gmu, '');
  fs.chmodSync(dynamicFile, 0o644);
  fs.writeFileSync(dynamicFile, dynamic);
  const services = { livekit: model.services.livekit, traefik: model.services.traefik };
  for (const service of Object.values(services)) {
    delete service.depends_on;
    service.ports = service.ports.map(port => ({ ...port, host_ip: '127.0.0.1', published: '0' }));
  }
  const secretNames = Object.values(services).flatMap(service => service.secrets.map(secret => secret.source));
  const secrets = Object.fromEntries(secretNames.map(name => [name, model.secrets[name]]));
  const volumes = Object.fromEntries(Object.values(services).flatMap(service => (service.volumes || [])
    .filter(volume => volume.type === 'volume').map(volume => [volume.source, {}])));
  fs.writeFileSync(fixture, JSON.stringify({ services, secrets, volumes,
    networks: { 'cosmos-internal': { internal: true }, 'rtc-edge': {}, 'public-edge': {} } }), { mode: 0o600 });
  run('docker', [...compose, 'up', '--detach', '--wait', '--wait-timeout', '45']);
  const address = run('docker', [...compose, 'port', 'traefik', '443']).trim();
  const origin = `http://${address}`;
  const response = await fetch(`${origin}/livekit/`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).trim(), 'OK');
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: values.COSMOS_RTC_API_KEY,
    sub: 'synthetic-surface', nbf: now - 5, exp: now + 60,
    video: { roomJoin: true, room: project, canPublish: false, canSubscribe: false, canPublishData: true } })}`;
  const token = `${unsigned}.${createHmac('sha256', values.COSMOS_RTC_API_SECRET).update(unsigned).digest('base64url')}`;
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/livekit/rtc?access_token=${token}&auto_subscribe=0&sdk=js&protocol=16`);
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('authenticated room join timed out')), 8000);
      socket.onmessage = event => { clearTimeout(timeout); assert.ok(event.data); resolve(); };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('authenticated room join failed')); };
    });
  } finally { socket.close(); }
  const invalid = await fetch(`${origin}/livekit/rtc/validate?access_token=synthetic-query-must-not-persist`, { signal: AbortSignal.timeout(5000) });
  assert.equal(invalid.status, 401);
  const logs = run('docker', [...compose, 'logs', '--no-color', 'traefik']);
  assert.ok(logs.includes('/livekit/'));
  for (const sensitive of [token, values.COSMOS_RTC_API_SECRET, 'synthetic-query-must-not-persist', 'access_token=']) {
    assert.ok(!logs.includes(sensitive), 'proxy logs retained a credential or query');
  }
});
