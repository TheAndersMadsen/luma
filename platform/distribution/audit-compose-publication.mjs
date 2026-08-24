#!/usr/bin/env node

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const source = Buffer.concat(chunks).toString("utf8");
  const model = JSON.parse(source);
  if (!model.services || typeof model.services !== "object") throw new Error("Compose model has no services");
  for (const [name, service] of Object.entries(model.services)) {
    if (service.build !== undefined) throw new Error(`${name} retains a build section`);
    if (typeof service.image !== "string" || !/@sha256:[0-9a-f]{64}$/u.test(service.image)) {
      throw new Error(`${name} image is not digest-pinned`);
    }
    for (const volume of service.volumes || []) {
      if (typeof volume === "object" && volume.type === "bind") {
        throw new Error(`${name} retains a host bind mount`);
      }
    }
  }
  for (const [kind, entries] of [["secret", model.secrets], ["config", model.configs]]) {
    for (const [name, entry] of Object.entries(entries || {})) {
      if (entry?.file !== undefined) throw new Error(`${kind} ${name} retains a local file`);
    }
  }
  if (/\/(?:home|Users)\/|REVIVAL_CONFIG_DIR|REVIVAL_SECRETS_DIR/u.test(source)) {
    throw new Error("Compose publication contains an operator-local path");
  }
  process.stdout.write(`${Object.keys(model.services).length} publishable services\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
