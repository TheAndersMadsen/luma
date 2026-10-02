import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const {
  decompileStock,
  ensureJadxArchive,
  jadxDockerArgs,
  jadxPin,
  parseStockArgs,
  stockFrameworkJars,
  stockPackagePaths,
  stockReferencePaths,
} = require("../../cli/stock.js");

// Shaped like `pm list packages -f` on a stock Pin with Luma installed.
const PACKAGES = [
  "package:/system/priv-app/ironman/ironman.apk=hu.ma.ne.ironman",
  "package:/system/priv-app/krypto/krypto.apk=hu.ma.ne.krypto",
  "package:/system/app/humane_clock/humane_clock.apk=humane.experience.clock",
  "package:/system_ext/priv-app/humane.connectivity.esimlpa/humane.connectivity.esimlpa.apk=humane.connectivity.esimlpa",
  "package:/system/priv-app/Settings/Settings.apk=com.android.settings",
  "package:/data/app/com.penumbraos.hook-injected/base.apk=com.penumbraos.hook",
  "package:/data/app/humane.experience.clock-1/base.apk=humane.experience.clock",
].join("\r\n");
const FRAMEWORK = "framework.jar\nhumane_location_lib.jar\nhumane_grandcentral_lib.jar\nservices.jar\n";
const FINGERPRINT = "qti/atoll/atoll:12/SKQ1.230401.001/101.000470.45.20:user/release-keys";
const ARCHIVE_BYTES = Buffer.from("fixture jadx release archive");

function fixturePin() {
  return Object.freeze({
    version: "9.9.9",
    url: "https://example.invalid/jadx-9.9.9.zip",
    size: ARCHIVE_BYTES.length,
    sha256: crypto.createHash("sha256").update(ARCHIVE_BYTES).digest("hex"),
    jar: "lib/jadx-9.9.9-all.jar",
    image: `example/jdk:17@sha256:${"a".repeat(64)}`,
  });
}

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "luma-stock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fakeAdb(calls) {
  return (args) => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "get-state") return { status: 0, stdout: "device\n", stderr: "" };
    if (key === "shell pm list packages -f") return { status: 0, stdout: PACKAGES, stderr: "" };
    if (key === "shell ls /system/framework") return { status: 0, stdout: FRAMEWORK, stderr: "" };
    if (key === "shell getprop ro.build.fingerprint") return { status: 0, stdout: `${FINGERPRINT}\n`, stderr: "" };
    if (args[0] === "pull" && args.length === 3) {
      fs.writeFileSync(args[2], `stock bytes of ${args[1]}`);
      return { status: 0, stdout: "1 file pulled", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected adb call: ${key}` };
  };
}

// Plays the container: writes a Java tree into the mounted /out as jadx would.
function fakeDocker(invocations, exitFor = () => 0) {
  return (args) => {
    invocations.push(args);
    const outputDirectory = /^type=bind,src=(.+),dst=\/out$/u.exec(args.find((value) => value.endsWith(",dst=/out")))[1];
    const [name, file] = args.slice(-2);
    const status = exitFor(file);
    if (status === 0 || status === 3) {
      fs.mkdirSync(path.join(outputDirectory, name, "sources", "humane"), { recursive: true });
      fs.writeFileSync(path.join(outputDirectory, name, "sources", "humane", "Fixture.java"), `class Fixture {} // ${file}\n`);
    }
    return { status, signal: null };
  };
}

function dependencies(directory, overrides = {}) {
  return {
    paths: stockReferencePaths(path.join(directory, "data")),
    toolsDirectory: path.join(directory, "data", "build", "stock-tools"),
    pin: fixturePin(),
    download: async (_url, destination) => fs.writeFileSync(destination, ARCHIVE_BYTES, { flag: "wx" }),
    platform: "linux/arm64",
    user: "1000:1000",
    log: () => {},
    prepare: (paths) => fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 }),
    ...overrides,
  };
}

test("arguments take exactly one source and an exact serial", () => {
  assert.deepEqual(parseStockArgs(["decompile", "--from-device", "1H4MPA42290039"]), {
    source: "device",
    serial: "1H4MPA42290039",
  });
  assert.deepEqual(parseStockArgs(["decompile", "--apk-dir", "/stock"]), {
    source: "directory",
    directory: path.resolve("/stock"),
  });
  for (const args of [
    [],
    ["decompile"],
    ["decompile", "--from-device"],
    ["decompile", "--from-device", "bad serial"],
    ["decompile", "--from-device", "A", "--apk-dir", "/stock"],
    ["decompile", "--output", "/elsewhere"],
    ["pull", "--apk-dir", "/stock"],
  ]) {
    assert.throws(() => parseStockArgs(args), /usage|exact adb serial/u, JSON.stringify(args));
  }
});

test("only stock Humane packages on the system partitions and humane framework jars are selected", () => {
  assert.deepEqual(stockPackagePaths(PACKAGES), [
    "/system/priv-app/ironman/ironman.apk",
    "/system/priv-app/krypto/krypto.apk",
    "/system/app/humane_clock/humane_clock.apk",
    "/system_ext/priv-app/humane.connectivity.esimlpa/humane.connectivity.esimlpa.apk",
  ]);
  assert.deepEqual(stockFrameworkJars(FRAMEWORK), [
    "/system/framework/humane_location_lib.jar",
    "/system/framework/humane_grandcentral_lib.jar",
  ]);
});

test("toolchain.json pins jadx by version, size, and SHA-256 and runs it in the builder JDK image", () => {
  const contract = JSON.parse(fs.readFileSync(path.join(root, "platform/containers/pin-builder/toolchain.json"), "utf8"));
  const pin = jadxPin();
  assert.match(pin.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(pin.url, `https://github.com/skylot/jadx/releases/download/v${pin.version}/jadx-${pin.version}.zip`);
  assert.match(pin.sha256, /^[0-9a-f]{64}$/u);
  assert.ok(Number.isSafeInteger(pin.size) && pin.size > 0);
  assert.equal(pin.image, `${contract.toolchain.jdk.image}@${contract.toolchain.jdk.imageIndexDigest}`);
});

test("the jadx container has no network, a read-only root, and read-only inputs", () => {
  const pin = fixturePin();
  const args = jadxDockerArgs(pin, {
    archive: "/cache/stock-tools/jadx-9.9.9.zip",
    input: "/data/stock-reference/apks/ironman.apk",
    output: "/data/stock-reference/decompiled.partial",
    platform: "linux/arm64",
    user: "501:20",
  });
  const text = args.join(" ");
  assert.match(text, /--network none/u);
  assert.match(text, /--read-only/u);
  assert.match(text, /--platform linux\/arm64/u);
  assert.ok(args.includes("type=bind,src=/cache/stock-tools/jadx-9.9.9.zip,dst=/tools/jadx.zip,readonly"));
  assert.ok(args.includes("type=bind,src=/data/stock-reference/apks/ironman.apk,dst=/stock/ironman.apk,readonly"));
  assert.ok(args.includes("type=bind,src=/data/stock-reference/decompiled.partial,dst=/out"));
  assert.ok(args.includes(pin.image));
  assert.deepEqual(args.slice(-2), ["ironman", "ironman.apk"]);
  assert.ok(!text.includes(root), "the source tree is never mounted");
});

test("the jadx archive is verified before use and a cached verified copy is reused", async (t) => {
  const directory = workspace(t);
  const pin = fixturePin();
  let downloads = 0;
  const download = async (_url, destination) => {
    downloads += 1;
    fs.writeFileSync(destination, ARCHIVE_BYTES, { flag: "wx" });
  };
  const archive = await ensureJadxArchive(pin, directory, { download, log: () => {} });
  assert.equal(fs.readFileSync(archive, "utf8"), ARCHIVE_BYTES.toString());
  await ensureJadxArchive(pin, directory, { download, log: () => {} });
  assert.equal(downloads, 1);

  const tampered = path.join(workspace(t), "tools");
  await assert.rejects(
    ensureJadxArchive(pin, tampered, {
      download: async (_url, destination) => fs.writeFileSync(destination, "tampered"),
      log: () => {},
    }),
    /does not match toolchain\.json/u,
  );
  assert.deepEqual(fs.readdirSync(tampered), [], "an unverified download is never kept");
});

test("--from-device pulls read-only, decompiles each file, and records provenance outside the source tree", async (t) => {
  const directory = workspace(t);
  const adbCalls = [];
  const invocations = [];
  const deps = dependencies(directory, {
    adb: fakeAdb(adbCalls),
    docker: fakeDocker(invocations, (file) => (file === "ironman.apk" ? 3 : 0)),
  });
  const manifest = await decompileStock({ source: "device", serial: "SERIAL" }, deps);

  const readOnly = new Set(["get-state", "shell pm list packages -f", "shell ls /system/framework", "shell getprop ro.build.fingerprint"]);
  for (const call of adbCalls) {
    assert.ok(readOnly.has(call.join(" ")) || call[0] === "pull", `adb call is read-only: ${call.join(" ")}`);
  }
  const pulled = fs.readdirSync(deps.paths.apks).sort();
  assert.deepEqual(pulled, [
    "humane.connectivity.esimlpa.apk",
    "humane_clock.apk",
    "humane_grandcentral_lib.jar",
    "humane_location_lib.jar",
    "ironman.apk",
    "krypto.apk",
  ]);
  assert.equal(invocations.length, pulled.length);
  for (const name of ["ironman", "krypto", "humane_location_lib"]) {
    assert.ok(fs.existsSync(path.join(deps.paths.decompiled, name, "sources", "humane", "Fixture.java")), name);
  }
  assert.equal(fs.existsSync(`${deps.paths.decompiled}.partial`), false);
  assert.equal(fs.existsSync(`${deps.paths.apks}.partial`), false);

  const written = JSON.parse(fs.readFileSync(deps.paths.manifest, "utf8"));
  assert.deepEqual(written, manifest);
  assert.equal(written.buildFingerprint, FINGERPRINT);
  assert.equal(written.jadx.version, "9.9.9");
  const ironman = written.inputs.find((entry) => entry.file === "ironman.apk");
  assert.equal(ironman.devicePath, "/system/priv-app/ironman/ironman.apk");
  assert.equal(ironman.jadxExit, 3);
  assert.equal(
    ironman.sha256,
    crypto.createHash("sha256").update("stock bytes of /system/priv-app/ironman/ironman.apk").digest("hex"),
  );
  assert.ok(!JSON.stringify(written).includes("SERIAL"), "the manifest does not record the device serial");
});

test("--apk-dir decompiles the stock files in that directory without touching a device", async (t) => {
  const directory = workspace(t);
  const stock = path.join(directory, "held");
  fs.mkdirSync(stock);
  fs.writeFileSync(path.join(stock, "krypto.apk"), "stock krypto");
  fs.writeFileSync(path.join(stock, "humane_ota_manager_lib.jar"), "stock jar");
  fs.writeFileSync(path.join(stock, "notes.txt"), "not an input");
  const invocations = [];
  const deps = dependencies(directory, {
    adb: () => assert.fail("--apk-dir never calls adb"),
    docker: fakeDocker(invocations),
  });
  // An earlier --from-device run of another firmware build.
  fs.mkdirSync(deps.paths.apks, { recursive: true });
  fs.writeFileSync(path.join(deps.paths.apks, "ironman.apk"), "another build's ironman");
  const manifest = await decompileStock({ source: "directory", directory: stock }, deps);
  assert.deepEqual(manifest.inputs.map((entry) => entry.file), ["humane_ota_manager_lib.jar", "krypto.apk"]);
  assert.equal(manifest.buildFingerprint, null);
  assert.ok(manifest.inputs.every((entry) => entry.devicePath === null && entry.jadxExit === 0));

  // apks/ holds exactly the decompiled inputs, owner-only, because the
  // evidence tests hash apks/ before they trust decompiled/.
  assert.deepEqual(fs.readdirSync(deps.paths.apks).sort(), ["humane_ota_manager_lib.jar", "krypto.apk"]);
  for (const entry of manifest.inputs) {
    const copy = path.join(deps.paths.apks, entry.file);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(copy)).digest("hex"), entry.sha256, entry.file);
    assert.equal(fs.statSync(copy).mode & 0o777, 0o600, entry.file);
  }
  assert.equal(fs.existsSync(`${deps.paths.apks}.partial`), false);
  assert.equal(fs.readFileSync(path.join(stock, "krypto.apk"), "utf8"), "stock krypto", "the held files are untouched");
});

test("a jadx failure keeps the previous reference and reports the partial output", async (t) => {
  const directory = workspace(t);
  const stock = path.join(directory, "held");
  fs.mkdirSync(stock);
  fs.writeFileSync(path.join(stock, "ironman.apk"), "stock ironman");
  fs.writeFileSync(path.join(stock, "krypto.apk"), "stock krypto");
  const deps = dependencies(directory, {
    docker: fakeDocker([], (file) => (file === "krypto.apk" ? 1 : 0)),
  });
  fs.mkdirSync(path.join(deps.paths.decompiled, "previous"), { recursive: true });
  await assert.rejects(
    decompileStock({ source: "directory", directory: stock }, deps),
    /jadx failed on krypto\.apk \(exit 1\); partial output is in .*decompiled\.partial/u,
  );
  assert.ok(fs.existsSync(path.join(deps.paths.decompiled, "previous")));
  assert.equal(fs.existsSync(deps.paths.manifest), false);
});

test("a failed --from-device run keeps the previous pulled APKs, decompile, and manifest together", async (t) => {
  const directory = workspace(t);
  const deps = dependencies(directory, {
    adb: fakeAdb([]),
    docker: fakeDocker([], (file) => (file === "krypto.apk" ? 1 : 0)),
  });
  fs.mkdirSync(deps.paths.apks, { recursive: true });
  fs.writeFileSync(path.join(deps.paths.apks, "previous.apk"), "previous stock bytes");
  fs.mkdirSync(path.join(deps.paths.decompiled, "previous"), { recursive: true });
  fs.writeFileSync(deps.paths.manifest, "{\"previous\":true}\n");
  await assert.rejects(
    decompileStock({ source: "device", serial: "SERIAL" }, deps),
    /jadx failed on krypto\.apk/u,
  );
  assert.deepEqual(fs.readdirSync(deps.paths.apks), ["previous.apk"]);
  assert.deepEqual(fs.readdirSync(deps.paths.decompiled), ["previous"]);
  assert.equal(fs.readFileSync(deps.paths.manifest, "utf8"), "{\"previous\":true}\n");
});

test("inputs that would overwrite each other are refused before any pull or jadx run", async (t) => {
  const directory = workspace(t);
  for (const names of [["humane_location.apk", "humane_location.jar"], ["Krypto.apk", "krypto.jar"]]) {
    const stock = fs.mkdtempSync(path.join(directory, "held-"));
    for (const name of names) fs.writeFileSync(path.join(stock, name), "stock bytes");
    await assert.rejects(
      decompileStock({ source: "directory", directory: stock }, dependencies(directory, {
        docker: () => assert.fail("refused before running jadx"),
      })),
      /would overwrite each other/u,
      names.join(" + "),
    );
  }

  const calls = [];
  const adb = fakeAdb(calls);
  const deviceWithCaseClash = (args) => (args.join(" ") === "shell pm list packages -f"
    ? { status: 0, stdout: `${PACKAGES}\npackage:/system/app/Ironman/Ironman.apk=humane.experience.ironman`, stderr: "" }
    : adb(args));
  await assert.rejects(
    decompileStock({ source: "device", serial: "SERIAL" }, dependencies(directory, {
      adb: deviceWithCaseClash,
      docker: () => assert.fail("refused before running jadx"),
    })),
    /ironman\.apk and \/system\/app\/Ironman\/Ironman\.apk would overwrite each other/u,
  );
  assert.ok(!calls.some((call) => call[0] === "pull"), "nothing is pulled");
});

test("the stock reference, jadx cache, and APK directory must all be outside the source tree", async (t) => {
  const directory = workspace(t);
  const refuse = (options, overrides) => assert.rejects(
    decompileStock(options, dependencies(directory, {
      adb: () => assert.fail("refused before touching a device"),
      docker: () => assert.fail("refused before running jadx"),
      ...overrides,
    })),
    /must be outside the source tree/u,
  );
  await refuse({ source: "device", serial: "SERIAL" }, { paths: stockReferencePaths(path.join(root, "stock-data")) });
  await refuse({ source: "device", serial: "SERIAL" }, { toolsDirectory: path.join(root, "stock-tools") });
  await refuse({ source: "directory", directory: path.join(root, "pin") }, {});
  assert.equal(fs.existsSync(path.join(root, "stock-data")), false);
  assert.equal(fs.existsSync(path.join(root, "stock-tools")), false);
});

test("the default reference is created owner-only inside a data directory marked for Luma", (t) => {
  const directory = workspace(t);
  const data = path.join(directory, "custom-data");
  const script = `
const { prepareStockDirectories, stockReferencePaths } = require(${JSON.stringify(path.join(root, "platform/cli/stock.js"))});
const { BUILD_DIR } = require(${JSON.stringify(path.join(root, "platform/cli/context.js"))});
prepareStockDirectories(stockReferencePaths(), require("node:path").join(BUILD_DIR, "stock-tools"));
`;
  const env = {
    ...process.env,
    LUMA_DATA_DIR: data,
    LUMA_CONFIG_DIR: path.join(directory, "config"),
    LUMA_SECRETS_DIR: path.join(directory, "config", "secrets"),
  };
  for (const name of ["LUMA_BUILD_DIR", "LUMA_ENV_FILE"]) delete env[name];
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const created of [data, path.join(data, "stock-reference"), path.join(data, "build", "stock-tools")]) {
    assert.equal(fs.statSync(created).mode & 0o777, 0o700, created);
  }
  // `setup` later accepts this non-default data directory only with the marker.
  assert.equal(fs.statSync(path.join(data, ".luma-managed")).mode & 0o777, 0o600);
});

test("the operator contract and help register stock decompile as a local mutation", () => {
  const contract = JSON.parse(fs.readFileSync(path.join(root, "contracts/operator-setup.json"), "utf8"));
  const command = contract.commands.find((entry) => entry.id === "stock.decompile");
  assert.ok(command, "stock.decompile is in the contract");
  assert.deepEqual(command.tokens, ["stock", "decompile"]);
  assert.equal(command.effect, "local-mutation");
  assert.equal(command.documentationAnchor, "README.md#stock-reference");

  const luma = (...args) => spawnSync(process.execPath, [path.join(root, "luma"), ...args], { cwd: root, encoding: "utf8" });
  const help = luma("stock", "decompile", "--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--from-device SERIAL/u);
  assert.match(help.stdout, /Humane’s code/u);
  assert.match(help.stdout, /Safety: local mutation only/u);
  assert.match(luma("--help").stdout, /^ {2}stock\s/mu);

  const usage = luma("stock", "decompile");
  assert.equal(usage.status, 64);
  assert.match(usage.stderr, /usage: \.\/luma stock decompile --from-device SERIAL \| --apk-dir DIR/u);
});
