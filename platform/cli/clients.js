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

const USAGE = 'usage: ./revival client (build | check) (macos | android) | ./revival client install android --serial SERIAL [--confirm]';

function clientCommand(args) {
  const [operation, platform, ...extra] = args;
  if (platform === 'android') {
    androidClient(operation, extra);
    return;
  }
  if (!['build', 'check'].includes(operation) || platform !== 'macos' || extra.length) {
    fail(USAGE, 64);
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
  // Keychain binds the installation identity to the application that created
  // it, so the app must keep one stable path and, across rebuilds, one stable
  // code identity. Ad-hoc signatures change with every build; an operator
  // supplies a Keychain code-signing identity to keep the identity readable.
  const signingIdentity = process.env.REVIVAL_MACOS_CODESIGN_IDENTITY?.trim() || '-';
  if (signingIdentity !== '-' && !/^[A-Za-z0-9 :().,+_-]{1,120}$/u.test(signingIdentity)) {
    fail('REVIVAL_MACOS_CODESIGN_IDENTITY must name a Keychain code-signing identity.');
  }
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
  // The isolated test home hides the login Keychain; a named identity is
  // resolved from the operator's real home. Ad-hoc signing needs no Keychain.
  const signingEnvironment = signingIdentity === '-'
    ? environment
    : { ...environment, HOME: require('node:os').homedir() };
  timedRun('native development app signing', 'codesign', [
    '--force', '--sign', signingIdentity, '--identifier', 'dk.andersmadsen.cosmos.desktop', application,
  ], { env: signingEnvironment });
  timedRun('native development app verification', 'codesign', [
    '--verify', '--strict', '--deep', application,
  ], { env: environment });
  // Replace the previous build at the same path so Keychain access control
  // lists that name this application keep matching.
  const installed = path.join(base, 'Cosmos.app');
  fs.rmSync(installed, { recursive: true, force: true });
  fs.renameSync(application, installed);
  fs.rmSync(staging, { recursive: true, force: true });
  for (const entry of fs.readdirSync(base)) {
    if (entry.startsWith('build-')) fs.rmSync(path.join(base, entry), { recursive: true, force: true });
  }
  info(`[implemented] development app: ${installed}`);
  info(signingIdentity === '-'
    ? '[observed] Ad-hoc signed local development build: every rebuild is a new application to Keychain, so a stored installation identity must be reset after rebuilding. Set REVIVAL_MACOS_CODESIGN_IDENTITY to a Keychain code-signing identity to keep it across rebuilds. Distribution signing, notarization and device acceptance remain separate.'
    : `[observed] Signed the local development build with "${signingIdentity}"; distribution signing, notarization and device acceptance remain separate.`);
}

function pinnedNdkVersion() {
  const contract = JSON.parse(fs.readFileSync(path.join(ROOT, 'platform/containers/pin-builder/toolchain.json'), 'utf8'));
  const version = contract?.toolchain?.android?.ndk;
  if (typeof version !== 'string' || !/^[0-9][0-9.]*$/u.test(version)) {
    throw new Error('pin-builder toolchain.json must pin the Android NDK version');
  }
  return version;
}

function androidHome(environment) {
  const home = environment.ANDROID_HOME || environment.ANDROID_SDK_ROOT;
  if (!home || !fs.existsSync(path.join(home, 'platform-tools'))) {
    fail('Android client builds need an Android SDK at ANDROID_HOME (platform-tools, platforms;android-35, build-tools;35.0.0).');
  }
  return home;
}

/// The Pixel/TV client compiles the same shared Rust library the macOS app
/// uses, cross-built with the NDK the Pin builder pins, and a Kotlin shell.
/// Nothing is generated inside the checkout; the APK is a development build.
function androidClient(operation, extra) {
  const install = operation === 'install';
  if (!['build', 'check', 'install'].includes(operation)) fail(USAGE, 64);
  let serial = null;
  let confirmed = false;
  if (install) {
    for (let index = 0; index < extra.length; index += 1) {
      if (extra[index] === '--serial' && /^[A-Za-z0-9._:-]{1,64}$/u.test(extra[index + 1] || '')) {
        serial = extra[index + 1];
        index += 1;
      } else if (extra[index] === '--confirm') {
        confirmed = true;
      } else {
        fail(USAGE, 64);
      }
    }
    if (!serial) fail('client install android requires --serial SERIAL from `adb devices`', 64);
  } else if (extra.length) {
    fail(USAGE, 64);
  }
  const projectPath = path.join(ROOT, 'clients', 'android');
  if (!fs.existsSync(path.join(projectPath, 'settings.gradle.kts'))) {
    fail('Native client builds require the source checkout.');
  }
  if (isInsideSource(BUILD_DIR)) {
    fail('Native client build output must remain outside the source checkout.');
  }
  const base = ownDirectory(path.join(BUILD_DIR, 'android-client'));
  const apk = path.join(base, 'Cosmos-debug.apk');
  if (install) {
    if (!fs.existsSync(apk)) fail(`Build the client first: ${apk} does not exist.`);
    const environment = cosmosTestEnvironment();
    info(`[plan] adb -s ${serial} install -r ${apk}`);
    if (!confirmed) {
      info('[plan] Pass --confirm to install this development build on exactly that device.');
      return;
    }
    timedRun('development APK installation', 'adb', ['-s', serial, 'install', '-r', apk], { env: environment });
    info(`[implemented] installed ${apk} on ${serial}; enrollment and Center approval remain explicit steps in the app.`);
    return;
  }
  const environment = cosmosTestEnvironment();
  validateHostToolchains({ includeRust: true, env: environment });
  const sdk = androidHome(environment);
  const ndk = path.join(sdk, 'ndk', pinnedNdkVersion());
  if (!fs.existsSync(path.join(ndk, 'source.properties'))) {
    fail(`Android NDK ${pinnedNdkVersion()} is required under ${path.join(sdk, 'ndk')} (the version the Pin builder pins).`);
  }
  const rustup = environment.RUSTUP_HOME || path.join(require('node:os').homedir(), '.rustup');
  const toolchains = fs.existsSync(path.join(rustup, 'toolchains')) ? fs.readdirSync(path.join(rustup, 'toolchains')) : [];
  if (!toolchains.some((name) => fs.existsSync(path.join(rustup, 'toolchains', name, 'lib', 'rustlib', 'aarch64-linux-android')))) {
    fail('Install the Android Rust target for the pinned toolchain: rustup target add aarch64-linux-android');
  }
  const native = timedRun('Android verified WebRTC inputs', 'python3', [
    path.join(ROOT, 'cosmos/native/prepare.py'), '--cache', path.join(BUILD_DIR, 'webrtc'), '--target', 'android-arm64',
  ], { env: environment, capture: true }).stdout.trim();
  if (!native.startsWith(path.join(BUILD_DIR, 'webrtc') + path.sep)) {
    throw new Error('Native inputs must remain in the verified external cache');
  }
  const buildEnvironment = { ...environment, LK_CUSTOM_WEBRTC: native, ANDROID_NDK_HOME: ndk, ANDROID_NDK_ROOT: ndk };
  timedRun('Android shared client library', 'cargo', [
    'ndk', '-t', 'arm64-v8a', '--platform', '29', 'build', '--locked', '--release',
    '--package', 'cosmos-surface-client-ffi', '--lib',
  ], { cwd: path.join(ROOT, 'cosmos'), env: buildEnvironment });
  const libraryName = 'libcosmos_surface_client_ffi.so';
  const jniLibs = path.join(base, 'jniLibs');
  fs.rmSync(jniLibs, { recursive: true, force: true });
  fs.mkdirSync(path.join(jniLibs, 'arm64-v8a'), { recursive: true, mode: 0o700 });
  fs.copyFileSync(
    path.join(environment.CARGO_TARGET_DIR, 'aarch64-linux-android', 'release', libraryName),
    path.join(jniLibs, 'arm64-v8a', libraryName),
  );
  const gradleBuild = path.join(base, 'gradle-build');
  const gradleArguments = [
    '--no-daemon', '--console=plain',
    '--project-cache-dir', path.join(base, 'gradle-project-cache'),
    `-PcosmosBuildDir=${gradleBuild}`,
    `-PcosmosJniLibs=${jniLibs}`,
    `-PcosmosWebrtcJar=${path.join(native, 'libwebrtc.jar')}`,
    `-Pkotlin.project.persistent.dir=${path.join(base, 'kotlin-persistent')}`,
  ];
  if (operation === 'check') {
    timedRun('Android client unit tests', 'sh', ['./gradlew', ...gradleArguments, 'testDebugUnitTest'], {
      cwd: projectPath, env: buildEnvironment,
    });
  }
  timedRun('Android client APK', 'sh', ['./gradlew', ...gradleArguments, 'assembleDebug'], {
    cwd: projectPath, env: buildEnvironment,
  });
  const built = path.join(gradleBuild, '_app', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!fs.existsSync(built)) throw new Error(`Gradle did not produce ${built}`);
  fs.copyFileSync(built, apk);
  if (operation === 'check') {
    info('[implemented] Android client library cross-compilation, unit tests and APK assembly passed; nothing was installed.');
    return;
  }
  info(`[implemented] development APK: ${apk}`);
  info('[observed] Debug-signed local build; distribution signing, Play or device acceptance remain separate. Install with ./revival client install android --serial SERIAL --confirm.');
}

module.exports = { clientCommand };
