import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../pin");

const LINEAGES = Object.freeze([
  {
    name: "understand",
    source: [
      "runtime/core/src/services/aibus/understand.rs",
      "runtime/core/src/services/aibus/understand/agentic.rs",
      "runtime/core/src/services/aibus/understand/cascade.rs",
      "runtime/core/src/services/aibus/understand/clock_family.rs",
      "runtime/core/src/services/aibus/understand/fast_path.rs",
      "runtime/core/src/services/aibus/understand/grounding.rs",
      "runtime/core/src/services/aibus/understand/persistence.rs",
      "runtime/core/src/services/aibus/understand/predicates.rs",
      "runtime/core/src/services/aibus/understand/request_prep.rs",
      "runtime/core/src/services/aibus/understand/resume.rs",
      "runtime/core/src/services/aibus/understand/streaming.rs",
    ],
    tests: ["runtime/core/src/services/aibus/understand/tests.rs"],
    discoverSourceUnder: ["runtime/core/src/services/aibus/understand"],
    baseline: Object.freeze({ testLines: 4_709, sourceLines: 5_962 }),
  },
  {
    name: "tool broker",
    source: [
      "runtime/core/src/services/aibus/tools/catalog.rs",
      "runtime/core/src/services/aibus/tools/authority.rs",
    ],
    tests: ["runtime/core/src/services/aibus/tools/catalog/tests.rs"],
    discoverSourceUnder: [
      "runtime/core/src/services/aibus/tools/catalog",
      "runtime/core/src/services/aibus/tools/authority",
    ],
    baseline: Object.freeze({ testLines: 2_602, sourceLines: 3_230 }),
  },
]);

function physicalLines(text) {
  if (text.length === 0) return 0;
  const newlineCount = text.match(/\n/g)?.length ?? 0;
  return newlineCount + (text.endsWith("\n") ? 0 : 1);
}

function linesIn(repositoryPaths) {
  return repositoryPaths.reduce((total, repositoryPath) => {
    const absolute = path.join(ROOT, repositoryPath);
    assert.ok(
      fs.statSync(absolute).isFile(),
      `agentic test-density input must be a file: ${repositoryPath}`,
    );
    return total + physicalLines(fs.readFileSync(absolute, "utf8"));
  }, 0);
}

function rustFilesUnder(repositoryPath) {
  const absolute = path.join(ROOT, repositoryPath);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) {
    return absolute.endsWith(".rs") ? [repositoryPath] : [];
  }
  const files = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.posix.join(repositoryPath, entry.name);
    if (entry.isDirectory()) files.push(...rustFilesUnder(child));
    if (entry.isFile() && entry.name.endsWith(".rs")) files.push(child);
  }
  return files.sort();
}

function validateLineageManifest(lineages) {
  const allPaths = lineages.flatMap((lineage) => [
    ...lineage.source,
    ...lineage.tests,
  ]);
  assert.equal(
    new Set(allPaths).size,
    allPaths.length,
    "an agentic density input may belong to exactly one lineage and role",
  );

  for (const lineage of lineages) {
    const listedSources = new Set(lineage.source);
    const listedTests = new Set(lineage.tests);
    for (const root of lineage.discoverSourceUnder) {
      for (const discovered of rustFilesUnder(root)) {
        if (listedTests.has(discovered) || /\/tests\.rs$/.test(discovered)) continue;
        assert.ok(
          listedSources.has(discovered),
          `${lineage.name} source is omitted from the density manifest: ${discovered}`,
        );
      }
    }
  }
}

function ratio({ testLines, sourceLines }) {
  assert.ok(testLines > 0, "agentic test lineage must contain tests");
  assert.ok(sourceLines > 0, "agentic test lineage must contain implementation");
  return testLines / sourceLines;
}

function assertDensityPreserved(name, current, baseline) {
  assert.ok(
    current.testLines * baseline.sourceLines >=
      baseline.testLines * current.sourceLines,
    `${name} test/source density regressed: current ${current.testLines}/${current.sourceLines} ` +
      `(${ratio(current).toFixed(6)}) is below baseline ` +
      `${baseline.testLines}/${baseline.sourceLines} (${ratio(baseline).toFixed(6)})`,
  );
}

test("agentic core preserves the measured pre-migration test/source density", (t) => {
  validateLineageManifest(LINEAGES);
  const currentLineages = LINEAGES.map((lineage) => ({
    name: lineage.name,
    testLines: linesIn(lineage.tests),
    sourceLines: linesIn(lineage.source),
    baseline: lineage.baseline,
  }));

  for (const lineage of currentLineages) {
    assertDensityPreserved(lineage.name, lineage, lineage.baseline);
    t.diagnostic(
      `${lineage.name}: ${lineage.testLines}/${lineage.sourceLines} = ` +
        ratio(lineage).toFixed(6),
    );
  }

  const current = currentLineages.reduce(
    (sum, lineage) => ({
      testLines: sum.testLines + lineage.testLines,
      sourceLines: sum.sourceLines + lineage.sourceLines,
    }),
    { testLines: 0, sourceLines: 0 },
  );
  const baseline = LINEAGES.reduce(
    (sum, lineage) => ({
      testLines: sum.testLines + lineage.baseline.testLines,
      sourceLines: sum.sourceLines + lineage.baseline.sourceLines,
    }),
    { testLines: 0, sourceLines: 0 },
  );
  assertDensityPreserved("combined agentic core", current, baseline);
  t.diagnostic(
    `combined agentic core: ${current.testLines}/${current.sourceLines} = ` +
      ratio(current).toFixed(6),
  );

  assert.deepEqual(baseline, { testLines: 7_311, sourceLines: 9_192 });
});

test("mutation fixture: adding untested implementation makes the density guard red", () => {
  const baseline = { testLines: 7_311, sourceLines: 9_192 };
  const untestedGrowth = { testLines: 7_311, sourceLines: 9_193 };
  assert.throws(
    () => assertDensityPreserved("mutated agentic core", untestedGrowth, baseline),
    /test\/source density regressed/,
  );
});

test("mutation fixture: an omitted extracted source makes the manifest guard red", () => {
  const fixture = [
    {
      ...LINEAGES[0],
      source: ["runtime/core/src/services/aibus/understand.rs"],
    },
    LINEAGES[1],
  ];
  assert.throws(
    () => validateLineageManifest(fixture),
    // Discovery reports alphabetically, so the first extracted module is the
    // one the guard names.
    /source is omitted from the density manifest: .*understand\/agentic\.rs/,
  );
});

test("mutation fixture: duplicate ownership cannot inflate the density", () => {
  const fixture = [
    {
      ...LINEAGES[0],
      tests: [
        "runtime/core/src/services/aibus/understand/tests.rs",
        "runtime/core/src/services/aibus/understand/tests.rs",
      ],
    },
    LINEAGES[1],
  ];
  assert.throws(
    () => validateLineageManifest(fixture),
    /exactly one lineage and role/,
  );
});
