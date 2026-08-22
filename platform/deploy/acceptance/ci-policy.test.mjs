import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CI_PATH = path.join(ROOT, ".github", "workflows", "ci.yml");
const RELEASE_PATH = path.join(ROOT, ".github", "workflows", "release-cli.yml");
const DARWIN_TEST_PATH = path.join(
  ROOT,
  "platform",
  "deploy",
  "acceptance",
  "darwin-rooted-reader.test.mjs",
);

const ACTIONS = Object.freeze({
  "actions/checkout": Object.freeze({
    sha: "d23441a48e516b6c34aea4fa41551a30e30af803",
    version: "v6",
  }),
  "actions/setup-node": Object.freeze({
    sha: "249970729cb0ef3589644e2896645e5dc5ba9c38",
    version: "v6",
  }),
  "actions/cache/restore": Object.freeze({
    sha: "55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
    version: "v6",
  }),
  "actions/cache/save": Object.freeze({
    sha: "55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
    version: "v6",
  }),
  "dtolnay/rust-toolchain": Object.freeze({
    sha: "38ae5351029910ad7674ccfad89c37cbd636f3c4",
    version: "1.91.1",
  }),
  "actions/upload-artifact": Object.freeze({
    sha: "b7c566a772e6b6bfb58ed0dc250532a479d7789f",
    version: "v6",
  }),
  "actions/download-artifact": Object.freeze({
    sha: "018cc2cf5baa6db3ef3c5f8a56943fffe632ef53",
    version: "v6",
  }),
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function withoutInlineComment(value) {
  const marker = value.indexOf(" #");
  return (marker === -1 ? value : value.slice(0, marker)).trim();
}

function tokenize(text, label) {
  invariant(typeof text === "string" && text.endsWith("\n"), `${label} must end in one newline`);
  invariant(Buffer.byteLength(text, "utf8") <= 1024 * 1024, `${label} exceeds the policy parser byte bound`);
  invariant(!text.includes("\0") && !text.includes("\t"), `${label} contains unsafe YAML whitespace`);
  const rawLines = text.replaceAll("\r\n", "\n").split("\n");
  invariant(rawLines.length <= 10_000, `${label} exceeds the policy parser line bound`);
  invariant(rawLines.every((line) => line.length <= 32 * 1024), `${label} exceeds the policy parser line-size bound`);
  const lines = rawLines.map((raw, index) => {
    const prefix = /^( *)/u.exec(raw)[1];
    const trimmed = raw.slice(prefix.length);
    return {
      index,
      raw,
      indent: prefix.length,
      code: trimmed.startsWith("#") ? "" : trimmed,
    };
  });
  assertYamlSurface(lines, text, label);
  return lines;
}

function assertYamlSurface(lines, text, label) {
  const expressionStarts = text.match(/\$\{\{/gu)?.length ?? 0;
  const expressionEnds = text.match(/\}\}/gu)?.length ?? 0;
  invariant(expressionStarts === expressionEnds, `${label} has an unbalanced GitHub expression`);

  const sequenceEpoch = new Map();
  const containers = [];
  const seen = new Map();
  let blockIndent = null;
  for (const line of lines) {
    if (blockIndent !== null) {
      if (line.code === "" || line.indent > blockIndent) continue;
      blockIndent = null;
    }
    if (line.code === "") continue;
    while (containers.length > 0 && containers.at(-1).indent >= line.indent) containers.pop();
    const sequence = line.code.startsWith("- ");
    if (sequence) sequenceEpoch.set(line.indent, (sequenceEpoch.get(line.indent) ?? 0) + 1);
    for (const indent of [...sequenceEpoch.keys()]) {
      if (indent > line.indent) sequenceEpoch.delete(indent);
    }
    const match = /^(?:- )?([A-Za-z0-9_-]+):(.*)$/u.exec(line.code);
    if (!match) continue;
    const effectiveIndent = line.indent + (sequence ? 2 : 0);
    const epochs = [...sequenceEpoch.entries()]
      .filter(([indent]) => indent < effectiveIndent)
      .sort(([left], [right]) => left - right)
      .map(([indent, epoch]) => `${indent}:${epoch}`)
      .join("/");
    const parents = containers.map(({ indent, key }) => `${indent}:${key}`).join("/");
    const scope = `${parents}|${effectiveIndent}|${epochs}`;
    const keys = seen.get(scope) ?? new Set();
    invariant(!keys.has(match[1]), `${label} repeats YAML key ${match[1]} at line ${line.index + 1}`);
    keys.add(match[1]);
    seen.set(scope, keys);
    const value = withoutInlineComment(match[2].trim());
    if (value === "") containers.push({ indent: effectiveIndent, key: match[1] });
    if (["|", "|-", ">", ">-"].includes(value)) blockIndent = line.indent;
  }
}

function keyValue(code) {
  const match = /^([A-Za-z0-9_-]+):(.*)$/u.exec(code);
  if (!match) return null;
  return { key: match[1], value: withoutInlineComment(match[2].trim()) };
}

function readValue(lines, index, propertyIndent, initial) {
  if (!["|", "|-", ">", ">-"].includes(initial)) {
    return { value: initial, end: index + 1 };
  }
  const body = [];
  let cursor = index + 1;
  while (cursor < lines.length && (lines[cursor].code === "" || lines[cursor].indent > propertyIndent)) {
    if (lines[cursor].code !== "") body.push(lines[cursor].raw.trim());
    cursor += 1;
  }
  return { value: body.join("\n"), end: cursor };
}

function nestedMap(lines, start, end, headerIndent, name) {
  const header = lines.findIndex((line, index) =>
    index >= start && index < end && line.indent === headerIndent && line.code === `${name}:`);
  if (header === -1) return new Map();
  const result = new Map();
  let cursor = header + 1;
  while (cursor < end && (lines[cursor].code === "" || lines[cursor].indent > headerIndent)) {
    const line = lines[cursor];
    if (line.code !== "" && line.indent === headerIndent + 2) {
      const pair = keyValue(line.code);
      invariant(pair !== null, `invalid ${name} mapping at line ${line.index + 1}`);
      invariant(!result.has(pair.key), `duplicate ${name}.${pair.key}`);
      const parsed = readValue(lines, cursor, line.indent, pair.value);
      result.set(pair.key, parsed.value);
      cursor = parsed.end;
      continue;
    }
    cursor += 1;
  }
  return result;
}

function directValue(lines, start, end, indent, name) {
  const matches = [];
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    if (line.indent !== indent) continue;
    const pair = keyValue(line.code);
    if (pair?.key === name) matches.push(pair.value);
  }
  invariant(matches.length <= 1, `duplicate ${name} property`);
  return matches[0];
}

function parseSteps(lines, start, end, label) {
  const stepsHeader = lines.findIndex((line, index) =>
    index >= start && index < end && line.indent === 4 && line.code === "steps:");
  if (stepsHeader === -1) return [];
  const starts = [];
  for (let index = stepsHeader + 1; index < end; index += 1) {
    if (lines[index].indent === 6 && lines[index].code.startsWith("- ")) starts.push(index);
  }
  return starts.map((stepStart, position) => {
    const stepEnd = starts[position + 1] ?? end;
    const properties = new Map();
    const propertyLines = new Map();
    const first = keyValue(lines[stepStart].code.slice(2));
    invariant(first !== null, `${label} has an invalid step at line ${lines[stepStart].index + 1}`);
    properties.set(first.key, first.value);
    propertyLines.set(first.key, lines[stepStart].raw);
    let cursor = stepStart + 1;
    while (cursor < stepEnd) {
      const line = lines[cursor];
      if (line.code !== "" && line.indent === 8) {
        const pair = keyValue(line.code);
        invariant(pair !== null, `${label} has an invalid step property at line ${line.index + 1}`);
        invariant(!properties.has(pair.key), `${label} repeats step property ${pair.key}`);
        const parsed = readValue(lines, cursor, line.indent, pair.value);
        properties.set(pair.key, parsed.value);
        propertyLines.set(pair.key, line.raw);
        cursor = parsed.end;
        continue;
      }
      cursor += 1;
    }
    return {
      start: stepStart,
      end: stepEnd,
      properties,
      propertyLines,
      with: nestedMap(lines, stepStart, stepEnd, 8, "with"),
      source: lines.slice(stepStart, stepEnd).map((line) => line.raw).join("\n"),
    };
  });
}

function parseWorkflow(text, label) {
  const lines = tokenize(text, label);
  const jobsHeader = lines.findIndex((line) => line.indent === 0 && line.code === "jobs:");
  invariant(jobsHeader !== -1, `${label} has no jobs mapping`);
  const jobStarts = [];
  for (let index = jobsHeader + 1; index < lines.length; index += 1) {
    if (lines[index].indent !== 2) continue;
    const pair = keyValue(lines[index].code);
    if (pair && pair.value === "") jobStarts.push({ name: pair.key, start: index });
  }
  const jobs = new Map();
  for (let position = 0; position < jobStarts.length; position += 1) {
    const { name, start } = jobStarts[position];
    const end = jobStarts[position + 1]?.start ?? lines.length;
    invariant(!jobs.has(name), `${label} repeats job ${name}`);
    jobs.set(name, {
      name,
      start,
      end,
      runsOn: directValue(lines, start, end, 4, "runs-on"),
      if: directValue(lines, start, end, 4, "if"),
      env: nestedMap(lines, start, end, 4, "env"),
      permissions: nestedMap(lines, start, end, 4, "permissions"),
      steps: parseSteps(lines, start, end, `${label}.${name}`),
      source: lines.slice(start, end).map((line) => line.raw).join("\n"),
    });
  }
  invariant(jobs.size > 0, `${label} has no parsed jobs`);
  const parsedUses = [...jobs.values()].flatMap((job) =>
    job.steps.filter((step) => step.properties.has("uses")));
  const rawUsesCount = lines.filter((line) => /^uses:/u.test(line.code) || /^- uses:/u.test(line.code)).length;
  invariant(parsedUses.length === rawUsesCount, `${label} contains an unscoped uses declaration`);
  return {
    text,
    label,
    lines,
    jobs,
    permissions: nestedMap(lines, 0, jobsHeader, 0, "permissions"),
    uses: parsedUses,
  };
}

function actionIdentity(step) {
  const value = step.properties.get("uses");
  if (!value) return null;
  const match = /^([^@\s]+)@([0-9a-f]{40})$/u.exec(value);
  invariant(match !== null, `action must use one immutable 40-hex commit: ${value}`);
  return { repository: match[1], sha: match[2] };
}

function stepsUsing(job, repository) {
  return job.steps.filter((step) => actionIdentity(step)?.repository === repository);
}

function validateActionPins(workflow) {
  invariant(workflow.uses.length > 0, `${workflow.label} has no actions`);
  for (const step of workflow.uses) {
    const action = actionIdentity(step);
    const expected = ACTIONS[action.repository];
    invariant(expected !== undefined, `${workflow.label} uses an unapproved action: ${action.repository}`);
    invariant(action.sha === expected.sha, `${action.repository} is not pinned to its reviewed commit`);
    const line = step.propertyLines.get("uses");
    invariant(
      line.includes(`# ${expected.version}`),
      `${action.repository} must retain its human-readable ${expected.version} comment`,
    );
    if (action.repository === "actions/checkout") {
      invariant(
        step.with.get("persist-credentials") === "false",
        "checkout must not persist the workflow token into repository Git configuration",
      );
    }
    if (action.repository === "actions/setup-node") {
      invariant(
        step.with.get("package-manager-cache") === "false",
        "setup-node automatic package-manager caching must stay explicitly disabled",
      );
    }
  }
}

function validatePermissions(ci, release) {
  for (const workflow of [ci, release]) {
    invariant(
      workflow.permissions.size === 1 && workflow.permissions.get("contents") === "read",
      `${workflow.label} must default to contents: read`,
    );
  }
  for (const [name, job] of ci.jobs) {
    invariant(job.permissions.size === 0, `CI job ${name} must not widen token permissions`);
  }
  for (const [name, job] of release.jobs) {
    if (name === "publish") {
      invariant(
        job.permissions.size === 1 && job.permissions.get("contents") === "write",
        "only the release publish job may receive contents: write",
      );
    } else {
      invariant(job.permissions.size === 0, `release job ${name} must inherit read-only permissions`);
    }
  }
}

function validateRunners(workflow) {
  for (const [name, job] of workflow.jobs) {
    invariant(job.runsOn !== undefined, `${workflow.label}.${name} has no runner`);
    invariant(!/latest|self-hosted|\$\{\{/u.test(job.runsOn), `${workflow.label}.${name} uses a moving or private runner`);
    invariant(
      job.runsOn === "ubuntu-24.04" || job.runsOn === "macos-15",
      `${workflow.label}.${name} uses an unreviewed runner: ${job.runsOn}`,
    );
  }
}

function cachePathLines(step) {
  return (step.with.get("path") ?? "").split("\n").filter(Boolean);
}

function assertTrustedSave(step, label) {
  const condition = step.properties.get("if") ?? "";
  invariant(condition.includes("success()"), `${label} must require prior success`);
  invariant(condition.includes("github.event_name == 'push'"), `${label} must require a push`);
  invariant(condition.includes("github.ref == 'refs/heads/main'"), `${label} must require main`);
  invariant(!condition.includes("pull_request") && !condition.includes("||"), `${label} may not write on low-trust events`);
}

function validateCacheJob(job, {
  restoreId,
  keyPrefix,
  paths,
  sourceFresh = false,
}) {
  const restores = stepsUsing(job, "actions/cache/restore");
  const saves = stepsUsing(job, "actions/cache/save");
  invariant(restores.length === 1, `${job.name} must have one restore-only cache step`);
  invariant(saves.length === 1, `${job.name} must have one trusted cache save step`);
  const restore = restores[0];
  const save = saves[0];
  invariant(!restore.properties.has("if"), `${job.name} cache restore must run on every event`);
  invariant(restore.properties.get("id") === restoreId, `${job.name} cache restore has the wrong identity`);
  assertTrustedSave(save, `${job.name} cache save`);
  const expectedHit = `steps.${restoreId}.outputs.cache-hit != 'true'`;
  invariant((save.properties.get("if") ?? "").includes(expectedHit), `${job.name} cache save must avoid an existing exact key`);
  for (const step of [restore, save]) {
    const key = step.with.get("key") ?? "";
    invariant(key.startsWith(keyPrefix), `${job.name} cache namespace changed`);
    if (sourceFresh) {
      invariant(
        key.endsWith("-${{ github.sha }}"),
        `${job.name} target cache must use a source-fresh exact key`,
      );
    }
    assert.deepEqual(cachePathLines(step), paths, `${job.name} cache paths changed`);
    for (const cachedPath of cachePathLines(step)) {
      invariant(
        !/node_modules|secrets|credentials|signing|private-assets|(?:^|\/)\.env(?:$|\/)/iu.test(cachedPath),
        `${job.name} attempts to cache source output or sensitive material`,
      );
    }
  }
}

function assertUnconditionalValidation(job, commandPattern, label) {
  const matches = job.steps.filter((step) => commandPattern.test(step.properties.get("run") ?? ""));
  invariant(matches.length > 0, `${label} validation command is missing`);
  for (const step of matches) {
    invariant(!step.properties.has("if"), `${label} validation may not be conditional on cache state`);
  }
}

function validateCaches(ci, release) {
  const center = ci.jobs.get("center");
  const cosmos = ci.jobs.get("cosmos");
  const pin = ci.jobs.get("pin-runtime");
  const builder = ci.jobs.get("pin-builder-linux-amd64");
  invariant(center && cosmos && pin && builder, "CI cache-owning jobs are missing");

  invariant(center.env.get("NPM_CONFIG_CACHE") === "${{ runner.temp }}/center-npm-cache", "Center npm cache must stay external");
  validateCacheJob(center, {
    restoreId: "center-npm-cache",
    keyPrefix: "center-npm-v1-",
    paths: ["${{ env.NPM_CONFIG_CACHE }}/_cacache"],
  });
  for (const step of [...stepsUsing(center, "actions/cache/restore"), ...stepsUsing(center, "actions/cache/save")]) {
    invariant(
      (step.with.get("key") ?? "").includes("'center/adapters/spotify/package-lock.json'"),
      "Center download cache must include the Spotify adapter lockfile",
    );
  }
  validateCacheJob(cosmos, {
    restoreId: "cosmos-rust-cache",
    keyPrefix: "cosmos-rust-v2-",
    sourceFresh: true,
    paths: [
      "${{ env.CARGO_HOME }}/registry",
      "${{ env.CARGO_HOME }}/git",
      "${{ env.CARGO_TARGET_DIR }}",
    ],
  });
  validateCacheJob(pin, {
    restoreId: "pin-runtime-rust-cache",
    keyPrefix: "pin-runtime-rust-v2-",
    sourceFresh: true,
    paths: [
      "${{ env.CARGO_HOME }}/registry",
      "${{ env.CARGO_HOME }}/git",
      "${{ env.CARGO_TARGET_DIR }}",
    ],
  });
  validateCacheJob(builder, {
    restoreId: "pin-builder-deps",
    keyPrefix: "pin-builder-dependencies-v3-",
    paths: [
      "${{ runner.temp }}/pin-builder-data/build/pin-builder-cache-data/cargo-registry",
      "${{ runner.temp }}/pin-builder-data/build/pin-builder-cache-data/cargo-git",
      "${{ runner.temp }}/pin-builder-data/build/pin-builder-cache-data/gradle-caches",
      "${{ runner.temp }}/pin-builder-data/build/pin-builder-cache-data/gradle-wrapper",
      "${{ runner.temp }}/pin-builder-data/build/pin-builder-cache-data/npm-cacache",
    ],
  });

  assert.deepEqual(
    [cosmos.env.get("CARGO_HOME"), cosmos.env.get("CARGO_TARGET_DIR")],
    ["${{ runner.temp }}/cosmos-cargo-home", "${{ runner.temp }}/cosmos-cargo-target"],
  );
  assert.deepEqual(
    [pin.env.get("CARGO_HOME"), pin.env.get("CARGO_TARGET_DIR")],
    ["${{ runner.temp }}/pin-runtime-cargo-home", "${{ runner.temp }}/pin-runtime-cargo-target"],
  );
  invariant(cosmos.env.get("CARGO_HOME") !== pin.env.get("CARGO_HOME"), "Cargo home namespaces collide");
  invariant(cosmos.env.get("CARGO_TARGET_DIR") !== pin.env.get("CARGO_TARGET_DIR"), "Cargo target namespaces collide");

  const cacheNamespaces = [...ci.jobs.values()].flatMap((job) =>
    stepsUsing(job, "actions/cache/restore").map((step) =>
      (step.with.get("key") ?? "").split("${{")[0]));
  invariant(new Set(cacheNamespaces).size === cacheNamespaces.length, "CI cache namespaces collide");

  for (const job of ci.jobs.values()) {
    for (const step of job.steps) {
      const condition = step.properties.get("if") ?? "";
      const repository = actionIdentity(step)?.repository;
      if (condition.includes("cache-hit")) {
        invariant(repository === "actions/cache/save", `${job.name} lets a cache hit skip non-cache work`);
      }
    }
  }
  assertUnconditionalValidation(center, /npm ci --prefix center/u, "Center lockfile install");
  assertUnconditionalValidation(center, /npm --prefix center (?:run typecheck|test|run test:ui)/u, "Center checks");
  const centerResidueCleanup = center.steps.filter((step) => {
    const command = step.properties.get("run") ?? "";
    return /rm -f center\/tsconfig\.tsbuildinfo center\/next-env\.d\.ts/u.test(command);
  });
  invariant(centerResidueCleanup.length === 1, "Center generated type/build residue cleanup is missing");
  invariant(
    centerResidueCleanup[0].properties.get("if") === "${{ always() }}",
    "Center generated type/build residue cleanup must run after failures",
  );
  assertUnconditionalValidation(cosmos, /cargo fmt/u, "Cosmos format");
  assertUnconditionalValidation(cosmos, /cargo test/u, "Cosmos tests");
  assertUnconditionalValidation(pin, /cargo fmt/u, "Pin runtime format");
  assertUnconditionalValidation(pin, /cargo test/u, "Pin runtime tests");

  const platform = ci.jobs.get("layout-and-wire");
  invariant(platform !== undefined, "complete platform CI job is missing");
  assertUnconditionalValidation(platform, /\.\/revival check platform/u, "complete platform suite");
  invariant(!ci.jobs.has("source-gate"), "serial duplicate release source gate must stay removed");
  assertUnconditionalValidation(center, /npm --prefix center run build/u, "Center production build");
  assertUnconditionalValidation(
    center,
    /npm ci --prefix center\/adapters\/spotify[\s\S]*npm test --prefix center\/adapters\/spotify/u,
    "Spotify adapter lockfile install and tests",
  );
  assertUnconditionalValidation(cosmos, /cargo clippy --workspace --all-targets --locked/u, "Cosmos clippy");
  for (const duplicate of [
    "store_postgres::tests::migrations_are_globally_numbered_and_append_only",
    "store_postgres::tests::migration_parser_preserves_every_explicit_statement",
    "tests::ai_bus_startup_rejects_missing_or_invalid_kid_scope_before_binding",
  ]) {
    invariant(
      !cosmos.steps.some((step) => (step.properties.get("run") ?? "").includes(duplicate)),
      `ordinary Cosmos workspace test must not be rerun serially: ${duplicate}`,
    );
  }
  assertUnconditionalValidation(
    cosmos,
    /production_wrapping_key_is_4096_bit_and_accepts_explicit_sha1_oaep[\s\S]*--ignored --exact --test-threads=1/u,
    "Cosmos release-only RSA compatibility",
  );

  for (const job of release.jobs.values()) {
    for (const step of job.steps) {
      const repository = actionIdentity(step)?.repository ?? "";
      invariant(!repository.startsWith("actions/cache"), "release workflow must remain cache-independent");
      invariant(!step.with.has("cache-from") && !step.with.has("cache-to"), "release workflow consumes a build cache");
    }
  }
}

function validateNativeBuilder(ci) {
  const job = ci.jobs.get("pin-builder-linux-amd64");
  invariant(job !== undefined, "native linux/amd64 Pin builder job is missing");
  invariant(job.runsOn === "ubuntu-24.04", "native Pin builder must use fixed hosted ubuntu-24.04 x64");
  invariant(!job.if, "native Pin builder job may not be conditional");
  invariant(!/^\s*(?:container|services):/mu.test(job.source), "native Pin builder may only use the disposable host Docker engine");
  assertUnconditionalValidation(job, /test "\$RUNNER_ARCH" = X64/u, "native x64 proof");
  assertUnconditionalValidation(job, /test "\$\(uname -m\)" = x86_64/u, "native uname proof");
  invariant(stepsUsing(job, "docker/setup-buildx-action").length === 0, "CI must not bypass the continuous broker with Buildx");
  invariant(stepsUsing(job, "docker/build-push-action").length === 0, "CI must not bypass the continuous broker with a direct image build");

  const runSteps = job.steps.filter((step) => step.properties.has("run"));
  const check = runSteps.filter((step) => /\/usr\/bin\/node \.\/revival pin check(?:\s|$)/u.test(step.properties.get("run")));
  const debug = runSteps.filter((step) => /\/usr\/bin\/node \.\/revival pin build-debug(?:\s|$)/u.test(step.properties.get("run")));
  const verify = runSteps.filter((step) => /\/usr\/bin\/python3 -B platform\/containers\/pin-builder\/debug-store\.py[\s\S]*select-latest/u.test(step.properties.get("run")));
  invariant(check.length === 1, "native builder must execute exactly one continuous Pin check session");
  invariant(debug.length === 1, "native builder must execute exactly one continuous debug publication session");
  invariant(verify.length === 1, "native builder must verify exactly one append-only debug selection");
  invariant(check[0].start < debug[0].start && debug[0].start < verify[0].start, "native Pin session and verification order changed");

  for (const [label, step] of [["check", check[0]], ["debug", debug[0]]]) {
    const command = step.properties.get("run");
    invariant(!step.properties.has("if"), `native ${label} session may not be conditional`);
    for (const fragment of [
      "set -euo pipefail",
      'data="$RUNNER_TEMP/pin-builder-data"',
      'build="$data/build"',
      'REVIVAL_DATA_DIR="$data" REVIVAL_BUILD_DIR="$build"',
      "/usr/bin/node ./revival pin",
    ]) {
      invariant(command.includes(fragment), `native ${label} session lost ${fragment}`);
    }
    invariant(!/(?:^|\s)(?:node|python3|sh|docker)(?:\s|$)/mu.test(command), `native ${label} session uses an ambient executable`);
    invariant(!/preparePinBuilderLaneDirectories|exec-docker|install -d|\/usr\/bin\/docker|DOCKER_(?:CONFIG|HOST|CONTEXT|TLS)|--mount|--device|\badb\b|\bssh\b|\bscp\b/iu.test(command), `native ${label} session bypasses broker authority`);
  }

  const debugCommand = debug[0].properties.get("run");
  invariant(
    /pin build-debug\s*\\?\s*--role installer --role bootstrap --role hook --role server --role hook-injector/u.test(debugCommand),
    "native debug session must compile the exact five roles in fixed order",
  );
  const verifyCommand = verify[0].properties.get("run");
  for (const evidence of [
    'root="$RUNNER_TEMP/pin-builder-data/build/pin-debug-builder-state/artifacts/device-debug"',
    'selected["schema"] == "revival.pin-debug-selected-set"',
    '"installer", "bootstrap", "hook", "server", "hook-injector"',
    'len(selected["setId"]) == 64',
  ]) {
    invariant(verifyCommand.includes(evidence), `native append-only debug evidence lost ${evidence}`);
  }
  invariant(!/latest\.json|payloadComplete|installable|release/u.test(verifyCommand), "native selection verification refers to the retired mutable publication format");

  const restore = stepsUsing(job, "actions/cache/restore")[0];
  const save = stepsUsing(job, "actions/cache/save")[0];
  invariant(restore.start < check[0].start, "native dependency restore must precede both broker sessions");
  invariant(save.start > verify[0].start, "native dependency save must follow verified all-five publication");
}

function validateDarwinJob(ci, darwinTestSource) {
  const job = ci.jobs.get("darwin-rooted-reader");
  invariant(job !== undefined, "real macOS rooted-reader job is missing");
  invariant(job.runsOn === "macos-15", "Darwin rooted-reader must use fixed hosted macos-15");
  invariant(!job.if, "Darwin rooted-reader job may not be conditional");
  const executions = job.steps.filter((step) =>
    (step.properties.get("run") ?? "").includes(
      "node --test platform/deploy/acceptance/darwin-rooted-reader.test.mjs",
    ));
  invariant(executions.length === 1, "macOS job must execute the focused Darwin acceptance test");
  invariant(!executions[0].properties.has("if"), "Darwin acceptance execution may not be conditional");
  invariant(darwinTestSource.includes('process.platform === "darwin"'), "Darwin test lacks a real-kernel guard");
  invariant(!/platform\s*:\s*["']darwin["']/u.test(darwinTestSource), "Darwin test forces a mocked platform");
  invariant(darwinTestSource.includes("readStableRootedEntries"), "Darwin test does not exercise the production reader");
  invariant(darwinTestSource.includes("resolveTrustedPython3"), "Darwin test does not prove trusted Python resolution");
  invariant(darwinTestSource.includes("source root ancestors must not be symbolic links"), "Darwin test lacks root-ancestor refusal");
  invariant(darwinTestSource.includes("hard-linked files are forbidden"), "Darwin test lacks hardlink refusal");
}

function validateWorkflowSources({ ciText, releaseText, darwinTestSource }) {
  const ci = parseWorkflow(ciText, "ci.yml");
  const release = parseWorkflow(releaseText, "release-cli.yml");
  validateActionPins(ci);
  validateActionPins(release);
  validatePermissions(ci, release);
  validateRunners(ci);
  validateRunners(release);
  validateCaches(ci, release);
  validateNativeBuilder(ci);
  validateDarwinJob(ci, darwinTestSource);
  assertUnconditionalValidation(
    ci.jobs.get("layout-and-wire"),
    /node --test platform\/deploy\/acceptance\/ci-policy\.test\.mjs/u,
    "CI policy self-check",
  );
  assertUnconditionalValidation(
    release.jobs.get("build"),
    /node --test platform\/deploy\/acceptance\/ci-policy\.test\.mjs/u,
    "release CI policy self-check",
  );
  return { ci, release };
}

function fixture() {
  return {
    ciText: fs.readFileSync(CI_PATH, "utf8"),
    releaseText: fs.readFileSync(RELEASE_PATH, "utf8"),
    darwinTestSource: fs.readFileSync(DARWIN_TEST_PATH, "utf8"),
  };
}

function changed(before, after, label) {
  assert.notEqual(after, before, `${label} mutation did not apply`);
  return after;
}

function removeJob(text, name) {
  const parsed = parseWorkflow(text, "mutation source");
  const job = parsed.jobs.get(name);
  invariant(job !== undefined, `mutation source lacks ${name}`);
  const lines = text.split("\n");
  lines.splice(job.start, job.end - job.start);
  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}

function expectRejected(mutator, expected) {
  const original = fixture();
  const mutated = mutator({ ...original });
  assert.throws(() => validateWorkflowSources(mutated), expected);
}

test("real CI and release workflows satisfy the reproducible cache and hosted-runner policy", () => {
  validateWorkflowSources(fixture());
});

test("mutation: an action tag cannot replace a reviewed full commit", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace(
        "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
        "actions/checkout@v6",
      ),
      "floating action",
    );
    return value;
  }, /immutable 40-hex commit/u);
});

for (const unsafeRunner of ["ubuntu-latest", "self-hosted"]) {
  test(`mutation: ${unsafeRunner} cannot replace a fixed hosted runner`, () => {
    expectRejected((value) => {
      value.ciText = changed(
        value.ciText,
        value.ciText.replace("runs-on: ubuntu-24.04", `runs-on: ${unsafeRunner}`),
        unsafeRunner,
      );
      return value;
    }, /moving or private runner/u);
  });
}

test("mutation: top-level read-only permissions cannot disappear", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace("\npermissions:\n  contents: read\n", "\n"),
      "permissions removal",
    );
    return value;
  }, /default to contents: read/u);
});

test("mutation: setup-node automatic package-manager caching cannot be enabled", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace("package-manager-cache: false", "package-manager-cache: true"),
      "setup-node cache",
    );
    return value;
  }, /automatic package-manager caching/u);
});

test("mutation: cache saves cannot run for pull requests", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace(
        /if: \$\{\{ success\(\).*steps\.center-npm-cache\.outputs\.cache-hit != 'true' \}\}/u,
        "if: ${{ success() && github.event_name == 'pull_request' }}",
      ),
      "pull-request cache save",
    );
    return value;
  }, /must require a push/u);
});

test("mutation: CI cannot bypass the continuous broker with a direct Docker command", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace(
        "/usr/bin/node ./revival pin check",
        "/usr/bin/docker build .\n          /usr/bin/node ./revival pin check",
      ),
      "direct Docker build",
    );
    return value;
  }, /bypasses broker authority/u);
});

test("mutation: the combined actions/cache action cannot replace explicit restore", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace("actions/cache/restore@", "actions/cache@"),
      "general cache action",
    );
    return value;
  }, /unapproved action/u);
});

test("mutation: a cache hit cannot skip lockfile installation or validation", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace(
        "      - name: install from lockfile\n        run:",
        "      - name: install from lockfile\n        if: steps.center-npm-cache.outputs.cache-hit != 'true'\n        run:",
      ),
      "cache-hit skip",
    );
    return value;
  }, /cache hit skip non-cache work/u);
});

test("mutation: Center incremental typecheck residue cleanup cannot disappear", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace("center/tsconfig.tsbuildinfo ", ""),
      "Center tsbuildinfo cleanup",
    );
    return value;
  }, /generated type\/build residue cleanup is missing/u);
});

test("mutation: Center Next type declaration cleanup cannot disappear", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace(" center/next-env.d.ts", ""),
      "Center next-env cleanup",
    );
    return value;
  }, /generated type\/build residue cleanup is missing/u);
});

test("mutation: Cosmos and Pin runtime cache namespaces cannot collide", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replaceAll("cosmos-rust-v2-", "pin-runtime-rust-v2-"),
      "cache namespace collision",
    );
    return value;
}, /cosmos cache namespace changed|cache namespaces collide/u);
});

test("mutation: Cargo target caches cannot revert to lockfile-only exact keys", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replaceAll("-${{ github.sha }}", ""),
      "stale Cargo exact key",
    );
    return value;
  }, /source-fresh exact key/u);
});

test("mutation: release coverage cannot return to one serial duplicate source gate", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace("./revival check platform", "./revival release check"),
      "serial release gate",
    );
    return value;
  }, /complete platform suite/u);
});

test("mutation: an ordinary Cosmos workspace test cannot be rerun serially", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace(
        "      - name: real Postgres lifecycle and atomic migration contention\n",
        "      - name: duplicate ordinary Cosmos test\n" +
          "        working-directory: cosmos\n" +
          "        run: cargo test -p cosmos tests::ai_bus_startup_rejects_missing_or_invalid_kid_scope_before_binding -- --exact\n" +
          "      - name: real Postgres lifecycle and atomic migration contention\n",
      ),
      "duplicate ordinary Cosmos test",
    );
    return value;
  }, /ordinary Cosmos workspace test must not be rerun serially/u);
});

test("mutation: a duplicate YAML key is rejected before policy interpretation", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace("    runs-on: ubuntu-24.04", "    runs-on: ubuntu-24.04\n    runs-on: ubuntu-24.04"),
      "duplicate YAML key",
    );
    return value;
  }, /repeats YAML key runs-on/u);
});

test("mutation: an unbalanced GitHub expression is rejected", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace("${{ runner.temp }}", "${{ runner.temp }"),
      "unbalanced expression",
    );
    return value;
  }, /unbalanced GitHub expression/u);
});

test("mutation: the release workflow cannot consume CI caches", () => {
  expectRejected((value) => {
    value.releaseText = changed(
      value.releaseText,
      value.releaseText.replace(
        "    steps:\n      - uses:",
        `    steps:\n      - name: unsafe release cache\n        uses: actions/cache/restore@${ACTIONS["actions/cache/restore"].sha} # v6\n        with:\n          path: \${{ runner.temp }}/release-cache\n          key: unsafe-release-cache\n      - uses:`,
      ),
      "release cache",
    );
    return value;
  }, /release workflow must remain cache-independent/u);
});

test("mutation: native linux/amd64 canonical builder proof cannot disappear", () => {
  expectRejected((value) => {
    value.ciText = removeJob(value.ciText, "pin-builder-linux-amd64");
    return value;
  }, /native linux\/amd64 Pin builder job is missing|CI cache-owning jobs are missing/u);
});

test("mutation: native debug artifact execution cannot disappear", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace(
        "/usr/bin/node ./revival pin build-debug",
        "/usr/bin/node ./revival pin check",
      ),
      "native debug artifact execution",
    );
    return value;
  }, /exactly one continuous Pin check session|exactly one continuous debug publication session/u);
});

test("mutation: native debug role order cannot drift", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace(
        "--role installer --role bootstrap --role hook --role server --role hook-injector",
        "--role bootstrap --role installer --role hook --role server --role hook-injector",
      ),
      "native debug role order",
    );
    return value;
  }, /exact five roles in fixed order/u);
});

test("mutation: native broker sessions cannot redirect the reviewed external build root", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replaceAll('build="$data/build"', 'build="$data/unreviewed"'),
      "native broker build root",
    );
    return value;
  }, /session lost build=/u);
});

test("mutation: a whole persistent cache home cannot replace one cache-data leaf", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace(
        "${{ runner.temp }}/pin-builder-data/build/pin-builder-cache-data/cargo-registry",
        "${{ runner.temp }}/pin-builder-data/build/pin-builder-cache-data",
      ),
      "whole Pin builder cache mount",
    );
    return value;
  }, /cache paths changed/u);
});

test("mutation: a Gradle configuration home cannot replace the reviewed download-only leaf", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replaceAll("pin-builder-cache-data/gradle-caches", "pin-builder-cache-data/gradle-home"),
      "persistent Gradle home",
    );
    return value;
  }, /cache paths changed/u);
});

test("mutation: the explicit local Docker socket policy cannot disappear", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace(
        "/usr/bin/node ./revival pin check",
        "DOCKER_HOST=tcp://hostile.invalid /usr/bin/node ./revival pin check",
      ),
      "ambient Docker socket",
    );
    return value;
  }, /bypasses broker authority/u);
});

test("mutation: native sessions must enter through the trusted absolute Node boundary", () => {
  expectRejected((value) => {
    value.ciText = changed(
      value.ciText,
      value.ciText.replace(
        "/usr/bin/node ./revival pin check",
        "node ./revival pin check",
      ),
      "ambient Node entrypoint",
    );
    return value;
  }, /exactly one continuous Pin check session/u);
});

test("mutation: the real macOS rooted-reader job cannot disappear", () => {
  expectRejected((value) => {
    value.ciText = removeJob(value.ciText, "darwin-rooted-reader");
    return value;
  }, /real macOS rooted-reader job is missing/u);
});
