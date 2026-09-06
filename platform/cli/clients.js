'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, BUILD_DIR, cosmosTestEnvironment, secureDirectory, isInsideSource, fail, info } = require('./context');
const { timedRun } = require('./timing');
const { validateHostToolchains } = require('./toolchain');

function ownDirectory(directory) {
  secureDirectory(directory);
  const real = fs.realpathSync(directory);
  if (real !== directory || fs.statSync(directory).uid !== process.getuid()) {
    throw new Error('Native client build directory must be an owned, unlinked directory');
  }
  return directory;
}

function clientCommand(args) {
  const [operation, platform, ...extra] = args;
  if (!['build', 'check'].includes(operation) || platform !== 'macos' || extra.length) {
    fail('usage: ./revival client build macos | ./revival client check macos', 64);
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    fail('The macOS client currently builds on an Apple Silicon Mac with the Apple developer tools.');
  }
  const packagePath = path.join(ROOT, 'clients', 'macos');
  if (!fs.existsSync(path.join(packagePath, 'Package.swift'))) {
    fail('Native client builds require the source checkout.');
  }
  if (isInsideSource(BUILD_DIR)) {
    fail('Native client build output must remain outside the source checkout.');
  }
  // XCTest is part of full Xcode. Keep this choice local to this build instead
  // of changing the workstation's global xcode-select setting.
  const developerDirectory = process.env.DEVELOPER_DIR || '/Applications/Xcode.app/Contents/Developer';
  if (!/^\/Applications\/Xcode(?:_[0-9.]+)?\.app\/Contents\/Developer$/u.test(developerDirectory) ||
      !fs.existsSync(path.join(developerDirectory, 'usr', 'bin', 'xcodebuild'))) {
    fail('Native macOS checks require full Xcode under /Applications; DEVELOPER_DIR may select an installed versioned Xcode app.');
  }
  const environment = { ...cosmosTestEnvironment(), DEVELOPER_DIR: developerDirectory };
  info(`[observed] native macOS developer tools: ${developerDirectory}`);
  validateHostToolchains({ includeRust: true, env: environment });
  timedRun('macOS Swift compiler', 'xcrun', ['swift', '--version'], { env: environment });
  const native = timedRun('macOS verified WebRTC inputs', 'python3', [
    path.join(ROOT, 'cosmos/native/prepare.py'), '--cache', path.join(BUILD_DIR, 'webrtc'),
  ], { env: environment, capture: true }).stdout.trim();
  if (!native.startsWith(path.join(BUILD_DIR, 'webrtc') + path.sep)) {
    throw new Error('Native inputs must remain in the verified external cache');
  }
  const buildEnvironment = { ...environment, LK_CUSTOM_WEBRTC: native };
  if (operation === 'check') {
    timedRun('native desktop core and bridge tests', 'cargo', [
      'test', '--locked', '--package', 'cosmos-surface-client',
      '--package', 'cosmos-surface-client-ffi',
    ], { cwd: path.join(ROOT, 'cosmos'), env: buildEnvironment });
  }
  timedRun('native desktop library', 'cargo', [
    'build', '--locked', '--package', 'cosmos-surface-client-ffi', '--lib',
  ], { cwd: path.join(ROOT, 'cosmos'), env: buildEnvironment });

  const base = ownDirectory(path.join(BUILD_DIR, 'macos-client'));
  const scratch = ownDirectory(path.join(BUILD_DIR, 'macos-client-swift'));
  const staging = fs.mkdtempSync(path.join(base, 'build-'));
  const libraryDirectory = path.join(staging, 'lib');
  fs.mkdirSync(libraryDirectory, { mode: 0o700 });
  const libraryName = 'libcosmos_surface_client_ffi.dylib';
  const library = path.join(libraryDirectory, libraryName);
  fs.copyFileSync(path.join(environment.CARGO_TARGET_DIR, 'debug', libraryName), library);
  timedRun('native library identity', 'install_name_tool', [
    '-id', `@rpath/${libraryName}`, library,
  ], { env: environment });
  timedRun('native development library signing', 'codesign', [
    '--force', '--sign', '-', '--identifier', 'dk.andersmadsen.cosmos.desktop.runtime', library,
  ], { env: environment });
  const swiftArguments = [
    '--package-path', packagePath, '--scratch-path', scratch, '--configuration', 'debug',
    '-Xlinker', `-L${libraryDirectory}`,
    '-Xlinker', '-rpath', '-Xlinker', '@executable_path/../Frameworks',
    ...(operation === 'check' ? ['-Xlinker', '-rpath', '-Xlinker', libraryDirectory] : []),
  ];
  const swiftEnvironment = { ...environment, DYLD_LIBRARY_PATH: libraryDirectory };
  timedRun('native macOS app compilation', 'xcrun', [
    'swift', 'build', ...swiftArguments,
  ], { env: swiftEnvironment });
  if (operation === 'check') {
    timedRun('native macOS client tests', 'xcrun', [
      'swift', 'test', ...swiftArguments,
    ], { env: swiftEnvironment });
    info('[implemented] native macOS compilation and tests passed; no app was launched or installed.');
    return;
  }
  const binaryDirectory = timedRun('native executable location', 'xcrun', [
    'swift', 'build', ...swiftArguments, '--show-bin-path',
  ], { env: swiftEnvironment, capture: true }).stdout.trim();
  if (!binaryDirectory.startsWith(scratch + path.sep)) {
    throw new Error('Swift output must remain in the external build directory');
  }
  const application = path.join(staging, 'Cosmos.app');
  const contents = path.join(application, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Frameworks'));
  fs.copyFileSync(path.join(binaryDirectory, 'CosmosDesktop'), path.join(contents, 'MacOS', 'Cosmos'));
  fs.chmodSync(path.join(contents, 'MacOS', 'Cosmos'), 0o755);
  fs.copyFileSync(library, path.join(contents, 'Frameworks', libraryName));
  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dk.andersmadsen.cosmos.desktop</string>
<key>CFBundleName</key><string>Cosmos</string>
<key>CFBundleExecutable</key><string>Cosmos</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>CFBundleVersion</key><string>0.2.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`);
  timedRun('native development app signing', 'codesign', [
    '--force', '--sign', '-', application,
  ], { env: environment });
  timedRun('native development app verification', 'codesign', [
    '--verify', '--strict', '--deep', application,
  ], { env: environment });
  info(`[implemented] development app: ${application}`);
  info('[observed] Ad-hoc signed local development build; distribution signing, notarization and device acceptance remain separate.');
}

module.exports = { clientCommand };
