import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const clients = require("../../cli/clients.js");
const spec = require("../../cli/command-spec.js");

test("Linux client builder image is pinned like the Cosmos image and cross-compiles on the host", () => {
  const dockerfile = fs.readFileSync(path.join(root, "platform/containers/linux-client/Dockerfile"), "utf8");
  const cosmos = fs.readFileSync(path.join(root, "cosmos/Dockerfile"), "utf8");
  const pinned = /rust:1\.91\.1-trixie@sha256:[0-9a-f]{64}/u;
  assert.match(dockerfile, pinned);
  assert.equal(dockerfile.match(pinned)[0], cosmos.match(pinned)[0], "the client builder must use the Cosmos Rust image digest");
  assert.match(dockerfile, /^ARG BUILDARCH$/mu);
  assert.match(dockerfile, /^ARG CLIENT_ARCH=amd64$/mu);
  assert.match(dockerfile, /RUN bash \/opt\/cosmos-native\/linux-toolchain\.sh "\$\{BUILDARCH\}" "\$\{CLIENT_ARCH\}"/u);
  assert.doesNotMatch(dockerfile, /COPY (?:crates|Cargo|\.\.)/u, "the checkout is mounted at run time, never baked in");
  const script = fs.readFileSync(path.join(root, "platform/containers/linux-client/build.sh"), "utf8");
  assert.match(script, /cargo build --locked --release --package cosmos-surface-client-ffi --lib --target "\$rust_target"/u);
  assert.match(script, /rust_target=x86_64-unknown-linux-gnu/u);
  assert.match(script, /CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc/u);
  assert.match(script, /PKG_CONFIG_ALLOW_CROSS=1/u);
  assert.match(script, /python3 native\/prepare\.py --cache \/opt\/webrtc --target linux-x64/u);
  assert.match(dockerfile, /^RUN install -d -m 1777 \/opt\/webrtc$/mu);

  const build = clients.linuxBuilderBuildInvocation("fixture:image", "arm64");
  assert.equal(build.command, "docker");
  assert.deepEqual(build.args.slice(0, 3), ["build", "--platform", "linux/arm64"]);
  assert.ok(build.args.includes("CLIENT_ARCH=amd64"));
  assert.equal(build.args.at(-1), path.join(root, "cosmos", "native"));
  assert.equal(clients.linuxBuilderBuildInvocation("fixture:image", "x64").args[2], "linux/amd64");
  assert.throws(() => clients.linuxBuilderBuildInvocation("fixture:image", "ia32"), /host architecture/u);
  assert.match(clients.linuxBuilderFingerprint("arm64"), /^[0-9a-f]{64}$/u);
  assert.notEqual(clients.linuxBuilderFingerprint("arm64"), clients.linuxBuilderFingerprint("x64"));
});

test("Linux client build mounts the checkout read-only and keeps every output external", () => {
  const directories = clients.linuxDirectories("/external/linux-client");
  assert.equal(directories.archive, "/external/linux-client/cosmos-linux-x86_64.tar.gz");
  const run = clients.linuxBuilderRunInvocation(directories, "fixture:image", "x64", 1000, 1001);
  assert.equal(run.command, "docker");
  assert.deepEqual(run.args.slice(0, 5), ["run", "--rm", "--init", "--platform", "linux/amd64"]);
  assert.deepEqual(run.args.slice(5, 7), ["--user", "1000:1001"]);
  assert.ok(run.args.includes("--read-only"));
  assert.ok(run.args.includes(`type=bind,src=${root},dst=/workspace,readonly`));
  assert.ok(run.args.includes("type=bind,src=/external/linux-client/state,dst=/state"));
  assert.ok(run.args.includes("type=bind,src=/external/linux-client/cache,dst=/cache"));
  assert.ok(run.args.includes(`type=volume,src=${clients.LINUX_WEBRTC_VOLUME},dst=/opt/webrtc`));
  assert.ok(!run.args.some((argument) => argument.includes("dst=/opt/webrtc,readonly")));
  assert.ok(run.args.includes("type=bind,src=/external/linux-client/out,dst=/out"));
  assert.equal(run.args.at(-1), "fixture:image");
  assert.ok(!run.args.some((argument) => argument.includes("--privileged")));
});

test("Linux client archive ships the app, library, installer and optional examples only", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-linux-client-"));
  try {
    const library = path.join(temporary, "libcosmos_surface_client_ffi.so");
    fs.writeFileSync(library, "not-an-elf-fixture");
    const cache = path.join(root, "clients/linux/cosmos_linux/__pycache__");
    assert.equal(fs.existsSync(cache), false, "the checkout must not carry bytecode caches");
    const staging = path.join(temporary, "stage");
    fs.mkdirSync(staging);
    const entries = clients.stageLinuxArchive(path.join(root, "clients/linux"), library, staging);
    for (const expected of [
      "cosmos_linux/__main__.py", "cosmos_linux/app.py", "cosmos_linux/controller.py", "cosmos_linux/native.py",
      "cosmos_linux/qml/Main.qml", "cosmos_linux/qml/CosmosPanel.qml", "cosmos_linux/qml/CosmosWaveform.qml",
      "cosmos_linux/assets/nebula-bottom.png", "libcosmos_surface_client_ffi.so", "requirements.txt",
      "install-user.sh", "integration/hyprland-0.53-0.54.conf", "integration/waybar-module.jsonc",
      "icons/hicolor/scalable/apps/dk.andersmadsen.cosmos.linux.svg",
    ]) {
      assert.ok(entries.includes(expected), `${expected} missing from ${entries.join(", ")}`);
    }
    assert.ok(!entries.some((entry) => entry.includes("__pycache__") || entry.endsWith(".pyc") || entry.startsWith("tests/")));
    const stagedRoot = path.join(staging, clients.LINUX_ARCHIVE_ROOT);
    assert.equal(fs.statSync(path.join(stagedRoot, "install-user.sh")).mode & 0o111, 0o111);
    assert.equal(fs.readFileSync(path.join(stagedRoot, "libcosmos_surface_client_ffi.so"), "utf8"), "not-an-elf-fixture");
    const requirements = fs.readFileSync(path.join(stagedRoot, "requirements.txt"), "utf8");
    for (const dependency of ["PySide6>=6.8,<7", "cryptography", "secretstorage", "segno"]) {
      assert.match(requirements, new RegExp(`^${dependency.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "mu"));
    }
    const installer = fs.readFileSync(path.join(stagedRoot, "install-user.sh"), "utf8");
    assert.match(installer, /Refusing to overwrite existing path/u);
    assert.doesNotMatch(installer, /\bsudo\b/u);
    assert.match(installer, /-m venv/u);
    assert.doesNotMatch(installer, /hyprland\.conf|waybar\/config/u, "the installer never edits compositor or bar configuration");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Linux client commands are in the operator contract with honest help", () => {
  for (const tokens of [["client", "build", "linux"], ["client", "check", "linux"]]) {
    const found = spec.findCommand(tokens);
    assert.ok(found, tokens.join(" "));
    assert.equal(found.command.effect, "local-mutation");
    assert.equal(found.command.confirmationRequired, false);
    assert.equal(found.command.documentationAnchor, "README.md#development");
  }
  const buildHelp = spec.renderHelp(["client", "build", "linux"]);
  assert.match(buildHelp, /Docker/u);
  assert.match(buildHelp, /cosmos-linux-x86_64\.tar\.gz/u);
  assert.match(buildHelp, /Does not install, launch or enroll/u);
  const checkHelp = spec.renderHelp(["client", "check", "linux"]);
  assert.match(checkHelp, /No Docker/u);
  assert.match(checkHelp, /Python 3\.11/u);
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /\.\/revival client build linux/u);
  assert.match(readme, /\.\/revival client check linux/u);
  assert.match(readme, /software (?:P-256 )?key/iu);
});
