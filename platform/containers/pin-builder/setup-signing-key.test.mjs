#!/usr/bin/env node

// Host-side tests for the signing-key generator. No device, no build, no
// network, and no real signing key: every case that touches the filesystem
// works inside a per-test temp directory, and the only case that would invoke
// keytool is the one asserting that it refuses before invoking it.
//
// Each test is written so that a specific way of getting this wrong turns it
// red. The dangerous mistakes here are silent ones — a password reaching a log,
// a keystore landing somewhere committable, an overwrite that reads as success
// — so the assertions target those directly rather than the happy path.

import { deepStrictEqual, match, notStrictEqual, ok, strictEqual, throws } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DEFAULT_ALIAS,
  DEFAULT_ENV_FILE_PATH,
  DEFAULT_KEYSTORE_PATH,
  ENV_FILE_MODE,
  KEYSTORE_MODE,
  PASSWORD_ENV_NAME,
  REDACTION,
  REQUIRED_ENV_NAMES,
  SECRET_DIRECTORY_MODE,
  assertRedacted,
  backupIsVerified,
  backupPathFor,
  backupTargetVerdict,
  buildKeytoolArgs,
  buildKeytoolListArgs,
  certificateFingerprintFromKeytoolList,
  formatBackupRestoreGuidance,
  formatKeytoolUnavailable,
  generatePassword,
  isInsideDirectory,
  missingBackups,
  modeIsOwnerOnly,
  parseCliArgs,
  partialSigningEnvWarning,
  redact,
  refusalReason,
  renderEnvFile,
  secretVariants,
  shellSingleQuote,
  writeSecretFile,
  writeTargetVerdict,
} from "./setup-signing-key.mjs";

const run = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./setup-signing-key.mjs", import.meta.url));
const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../pin");

// A fixture, not a secret: it never leaves this process tree and never reaches
// a real keystore. Shaped to be awkward on purpose — a quote, a dollar sign, a
// regex metacharacter and a command substitution — because the naive
// implementations of quoting and redaction each fail on exactly one of those.
const FIXTURE_PASSWORD = `fixture-p'w$(echo no).A+B`;

const temporaryDirectories = [];
async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "setup-signing-key-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
after(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Run the CLI with a controlled environment.
 *
 * The parent shell on a maintainer's workstation may already export the real
 * PIN_SIGNING_* set; inheriting it would make these tests pass or fail for
 * reasons that have nothing to do with the code.
 */
async function runCli(args, extraEnvironment = {}) {
  const environment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...extraEnvironment,
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [scriptPath, ...args], {
      env: environment,
      cwd: repositoryRoot,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The contract the build actually reads
// ---------------------------------------------------------------------------

test("the rendered env file carries all four required variable names", () => {
  const rendered = renderEnvFile({
    PIN_SIGNING_STORE_FILE: "/absolute/pin-fork.keystore",
    PIN_SIGNING_STORE_PASSWORD: FIXTURE_PASSWORD,
    PIN_SIGNING_KEY_ALIAS: "pin-fork",
    PIN_SIGNING_KEY_PASSWORD: FIXTURE_PASSWORD,
  });

  // Names, not values. These four are what runtime/android/build.gradle.kts:16-19,
  // hook/payload and hook/loader resolve; a typo in any one of them puts the build in
  // the partial state that throws during Gradle configuration.
  deepStrictEqual(REQUIRED_ENV_NAMES.slice(), [
    "PIN_SIGNING_STORE_FILE",
    "PIN_SIGNING_STORE_PASSWORD",
    "PIN_SIGNING_KEY_ALIAS",
    "PIN_SIGNING_KEY_PASSWORD",
  ]);
  for (const name of REQUIRED_ENV_NAMES) {
    match(rendered, new RegExp(`^export ${name}=`, "m"), `${name} must be exported`);
  }
  // Exported, not merely assigned: `source`-ing a file of bare assignments
  // leaves the values invisible to the Gradle child process.
  strictEqual(rendered.split("\n").filter((line) => line.startsWith("export ")).length, 4);
});

test("renderEnvFile refuses a blank value, a relative store path, or mismatched PKCS12 passwords", () => {
  const base = {
    PIN_SIGNING_STORE_FILE: "/absolute/pin-fork.keystore",
    PIN_SIGNING_STORE_PASSWORD: FIXTURE_PASSWORD,
    PIN_SIGNING_KEY_ALIAS: "pin-fork",
    PIN_SIGNING_KEY_PASSWORD: FIXTURE_PASSWORD,
  };
  // Blank counts as absent in the build (`takeIf(String::isNotBlank)`), so a
  // blank value is a partial set wearing a complete set's clothes.
  throws(() => renderEnvFile({ ...base, PIN_SIGNING_KEY_ALIAS: "   " }), /must be a non-blank string/);
  // A relative path resolves against the repository root via rootProject.file,
  // not the shell's cwd (runtime/android/build.gradle.kts:186).
  throws(() => renderEnvFile({ ...base, PIN_SIGNING_STORE_FILE: "secrets/x.keystore" }), /absolute path/);
  // PKCS12 has one password; two different values fail in a way that reads
  // like keystore corruption.
  throws(() => renderEnvFile({ ...base, PIN_SIGNING_KEY_PASSWORD: "other" }), /identical/);
});

test("the rendered env file survives `source` with an awkward password", async () => {
  const directory = await scratch();
  const envFile = join(directory, "pin-signing.env");
  await writeSecretFile(
    envFile,
    renderEnvFile({
      PIN_SIGNING_STORE_FILE: join(directory, "pin-fork.keystore"),
      PIN_SIGNING_STORE_PASSWORD: FIXTURE_PASSWORD,
      PIN_SIGNING_KEY_ALIAS: "pin-fork",
      PIN_SIGNING_KEY_PASSWORD: FIXTURE_PASSWORD,
    }),
  );

  // Round-tripped through a real shell, because the failure mode of bad
  // quoting is not a syntax error — it is a password that silently becomes a
  // different string, producing a signing failure nobody can explain.
  const { stdout } = await run("sh", [
    "-c",
    '. "$1" >/dev/null 2>&1 && printf %s "$PIN_SIGNING_STORE_PASSWORD"',
    "sh",
    envFile,
  ]);
  strictEqual(stdout, FIXTURE_PASSWORD);
});

test("shellSingleQuote escapes an embedded single quote", () => {
  strictEqual(shellSingleQuote("plain"), "'plain'");
  strictEqual(shellSingleQuote("a'b"), `'a'\\''b'`);
});

test("secretVariants covers the shell-escaped encoding of a secret", () => {
  // A password with no quote has exactly one form.
  deepStrictEqual(secretVariants("simple"), ["simple"]);
  // One with a quote has two, and the second is the one that leaks: `a'b`
  // appears in the env file as `a'\''b`, which does not contain `a'b`.
  deepStrictEqual(secretVariants("a'b"), ["a'b", `a'\\''b`]);
  ok(!`a'\\''b`.includes("a'b"), "the escaped form really does hide the literal");
  deepStrictEqual(secretVariants(""), []);
  deepStrictEqual(secretVariants(null), []);
});

// ---------------------------------------------------------------------------
// Passwords never reach argv or output
// ---------------------------------------------------------------------------

test("the keytool args never embed a plaintext password", () => {
  const args = buildKeytoolArgs({ keystorePath: "/tmp/example/pin-fork.keystore", alias: "pin-fork" });

  // The whole point of the dry-run being printable is that this argv is not
  // sensitive. argv is world-readable through `ps` while keytool runs, so a
  // password here would leak to every process on the host, printed or not.
  ok(!args.includes("-storepass"), "argv must not carry -storepass");
  ok(!args.includes("-keypass"), "argv must not carry -keypass");
  ok(!args.includes("-signerkeypass"), "argv must not carry -signerkeypass");
  for (const argument of args) {
    ok(!argument.includes(FIXTURE_PASSWORD), `argv leaked a password: ${argument}`);
    ok(!/pass/i.test(argument), `suspicious password-ish argv entry: ${argument}`);
  }
  ok(args.includes("-storetype") && args[args.indexOf("-storetype") + 1] === "PKCS12");
  ok(args.includes("-keystore") && args[args.indexOf("-keystore") + 1] === "/tmp/example/pin-fork.keystore");

  strictEqual(buildKeytoolListArgs({ keystorePath: "/k", alias: "a" }).includes("-storepass"), false);
});

test("redact removes the password from arbitrary text", () => {
  const noisy = [
    `Enter keystore password: ${FIXTURE_PASSWORD}`,
    `export PIN_SIGNING_STORE_PASSWORD='${FIXTURE_PASSWORD}'`,
    `...and again ${FIXTURE_PASSWORD} at the end`,
  ].join("\n");

  const cleaned = redact(noisy, [FIXTURE_PASSWORD]);
  ok(!cleaned.includes(FIXTURE_PASSWORD), "every occurrence must be removed");
  strictEqual(cleaned.split(REDACTION).length - 1, 3, "all three occurrences must be replaced");
  // The password contains `$`, `(`, `)`, `+` and `.` — a regex built without
  // escaping matches nothing here and would silently leak.
  match(cleaned, /Enter keystore password: \[REDACTED\]/);

  // Blank and non-string entries must not turn into a regex that matches
  // everything.
  strictEqual(redact("untouched", ["", null, undefined]), "untouched");
});

test("assertRedacted fails closed when a secret survived", () => {
  strictEqual(assertRedacted("clean text", [FIXTURE_PASSWORD]), "clean text");
  throws(() => assertRedacted(`leaked ${FIXTURE_PASSWORD}`, [FIXTURE_PASSWORD]), /still contains a secret/);
});

test("generatePassword produces distinct high-entropy shell-safe values", () => {
  const first = generatePassword();
  const second = generatePassword();
  notStrictEqual(first, second);
  ok(first.length >= 40, `expected a long password, got ${first.length} characters`);
  match(first, /^[A-Za-z0-9_-]+$/, "base64url keeps it safe through any shell or terminal");
  throws(() => generatePassword(8), /at least 16 bytes/);
});

// ---------------------------------------------------------------------------
// Never overwrite key material
// ---------------------------------------------------------------------------

test("an existing path is refused without --force and allowed with it", () => {
  strictEqual(refusalReason([], false), null, "a clean slate proceeds");
  strictEqual(refusalReason([], true), null);

  const refusal = refusalReason(["/keys/pin-fork.keystore"], false);
  ok(refusal !== null, "an existing keystore must refuse");
  match(refusal, /\/keys\/pin-fork\.keystore/, "the refusal must name the path");
  // The consequence, not just the rule: this is the sentence that stops
  // someone from reaching for --force reflexively.
  match(refusal, /upgraded in place/);
  match(refusal, /--force/, "the refusal must say what the escape hatch is");

  strictEqual(refusalReason(["/keys/pin-fork.keystore"], true), null, "--force clears the refusal");
});

test("--force still refuses anything that was not backed up first", () => {
  const existing = ["/keys/pin-fork.keystore", "/repo/secrets/pin-signing.env"];

  // Nothing backed up at all.
  deepStrictEqual(missingBackups(existing, []), existing);

  // A backup that was attempted but did not verify by digest is not a backup.
  deepStrictEqual(
    missingBackups(existing, [
      { source: "/keys/pin-fork.keystore", backup: "/keys/pin-fork.keystore.backup-x", verified: false },
      { source: "/repo/secrets/pin-signing.env", backup: "/repo/secrets/pin-signing.env.backup-x", verified: true },
    ]),
    ["/keys/pin-fork.keystore"],
  );

  // Both verified: the write may proceed.
  deepStrictEqual(
    missingBackups(existing, existing.map((source) => ({ source, backup: `${source}.bak`, verified: true }))),
    [],
  );
});

test("backupIsVerified only accepts a real matching digest", () => {
  const digest = "a".repeat(64);
  ok(backupIsVerified(digest, digest));
  ok(!backupIsVerified(digest, "b".repeat(64)), "a different backup is not a backup");
  // A missing or malformed digest must never read as verified. `undefined ===
  // undefined` is true, which is exactly how a skipped hash would have
  // certified a backup that was never taken.
  ok(!backupIsVerified(undefined, undefined));
  ok(!backupIsVerified(null, null));
  ok(!backupIsVerified("", ""));
  ok(!backupIsVerified("short", "short"));
  ok(!backupIsVerified("A".repeat(64), "A".repeat(64)), "digests are compared in one canonical form");
});

test("backupPathFor keeps the backup beside the original", () => {
  strictEqual(
    backupPathFor("/keys/pin-fork.keystore", "2026-07-28T12:34:56.789Z"),
    "/keys/pin-fork.keystore.backup-2026-07-28T12-34-56-789Z",
  );
});

test("an existing keystore without --force is refused by the CLI, and nothing is written", async () => {
  const directory = await scratch();
  const keystorePath = join(directory, "pin-fork.keystore");
  const envFilePath = join(directory, "pin-signing.env");
  await writeFile(keystorePath, "pretend this is irreplaceable key material\n");

  // A real (non-dry) run. If the guard were broken this would call keytool and
  // clobber the file above — which is why the assertion checks the bytes, not
  // just the exit code.
  const result = await runCli(
    ["--keystore", keystorePath, "--env-out", envFilePath, "--alias", "pin-fork"],
    { [PASSWORD_ENV_NAME]: FIXTURE_PASSWORD },
  );

  strictEqual(result.code, 2, "an existing keystore must fail closed");
  match(result.stderr, /refusing to overwrite existing signing material/);
  match(result.stderr, /upgraded in place/);
  strictEqual(
    await readFile(keystorePath, "utf8"),
    "pretend this is irreplaceable key material\n",
    "the existing keystore must be byte-identical afterwards",
  );
  strictEqual(await exists(envFilePath), false, "no env file may appear on a refused run");
  ok(!result.stdout.includes(FIXTURE_PASSWORD) && !result.stderr.includes(FIXTURE_PASSWORD));
});

test("an existing env file alone is enough to refuse", async () => {
  const directory = await scratch();
  const keystorePath = join(directory, "pin-fork.keystore");
  const envFilePath = join(directory, "pin-signing.env");
  await writeFile(envFilePath, "export PIN_SIGNING_STORE_FILE='/somewhere/else'\n");

  const result = await runCli([
    "--keystore",
    keystorePath,
    "--env-out",
    envFilePath,
  ], { [PASSWORD_ENV_NAME]: FIXTURE_PASSWORD });

  strictEqual(result.code, 2);
  match(result.stderr, new RegExp(envFilePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  strictEqual(await exists(keystorePath), false, "no keystore may be generated on a refused run");
});

// ---------------------------------------------------------------------------
// --dry-run writes nothing
// ---------------------------------------------------------------------------

test("--dry-run prints the plan, writes nothing, and never prints the password", async () => {
  const directory = await scratch();
  const keystorePath = join(directory, "pin-fork.keystore");
  const envFilePath = join(directory, "pin-signing.env");

  const result = await runCli(
    ["--dry-run", "--keystore", keystorePath, "--env-out", envFilePath, "--alias", "pin-fork"],
    { [PASSWORD_ENV_NAME]: FIXTURE_PASSWORD },
  );

  strictEqual(result.code, 0, result.stderr);

  // Nothing written. This is the property that makes --dry-run safe to run in
  // CI and safe to run twice.
  strictEqual(await exists(keystorePath), false, "--dry-run must not create the keystore");
  strictEqual(await exists(envFilePath), false, "--dry-run must not create the env file");

  const output = `${result.stdout}${result.stderr}`;
  // The password was supplied, so it is a real string this process held. If it
  // appears anywhere in the output, the redaction is not working.
  ok(!output.includes(FIXTURE_PASSWORD), "--dry-run must not print the password");
  // And not in its shell-escaped form either. This is the leak that actually
  // happened while writing this script: `a'b` is written to the env file as
  // `a'\''b`, so a literal substring filter matched nothing and passed the
  // characters straight through. Same secret, different encoding.
  for (const variant of secretVariants(FIXTURE_PASSWORD)) {
    ok(!output.includes(variant), `--dry-run leaked a password encoding: ${variant}`);
  }
  ok(secretVariants(FIXTURE_PASSWORD).length === 2, "the fixture must exercise the escaped form");
  match(output, /\[REDACTED\]/, "the password position must be shown as redacted, not omitted");

  // "print exactly what it would do": both paths, the keytool argv, and the
  // four variable names.
  ok(output.includes(keystorePath), "the keystore path must be printed");
  ok(output.includes(envFilePath), "the env file path must be printed");
  match(output, /keytool -genkeypair/);
  match(output, /-storetype PKCS12/);
  for (const name of REQUIRED_ENV_NAMES) {
    ok(output.includes(name), `${name} must appear in the dry-run plan`);
  }
  match(output, /nothing was written/);
});

test("--dry-run over an existing keystore reports the refusal instead of performing it", async () => {
  const directory = await scratch();
  const keystorePath = join(directory, "pin-fork.keystore");
  await writeFile(keystorePath, "existing\n");

  const result = await runCli(
    ["--dry-run", "--keystore", keystorePath, "--env-out", join(directory, "pin-signing.env")],
    { [PASSWORD_ENV_NAME]: FIXTURE_PASSWORD },
  );

  // Exit 0: a dry run that reports "this would refuse" has done its job. The
  // refusal itself must still be visible.
  strictEqual(result.code, 0, result.stderr);
  match(result.stdout, /would REFUSE/);
  strictEqual(await readFile(keystorePath, "utf8"), "existing\n");
});

// ---------------------------------------------------------------------------
// Gitignore gate
// ---------------------------------------------------------------------------

test("a non-ignored in-worktree target refuses loudly", () => {
  const inside = join(repositoryRoot, "scripts/leaked.keystore");

  const notIgnored = writeTargetVerdict(inside, { repositoryRoot, isIgnored: false });
  strictEqual(notIgnored.allowed, false);
  match(notIgnored.reason, /NOT gitignored/);
  match(notIgnored.detail, /security incident/);
  // A helper that quietly widens .gitignore would convert a refusal into a
  // committed key, so the refusal has to say it will not.
  match(notIgnored.detail, /will not edit \.gitignore/);

  // Unknown is not permission. `git check-ignore` returns 128 for paths it
  // cannot resolve, and treating that as "ignored" is how key material ends up
  // staged.
  const unknown = writeTargetVerdict(inside, { repositoryRoot, isIgnored: null });
  strictEqual(unknown.allowed, false);
  match(unknown.reason, /could not be proven/);

  strictEqual(writeTargetVerdict(inside, { repositoryRoot, isIgnored: true }).allowed, true);
});

test("a target outside the worktree is allowed without consulting Git", () => {
  const outside = writeTargetVerdict("/var/tmp/elsewhere/pin-fork.keystore", {
    repositoryRoot,
    isIgnored: null,
  });
  strictEqual(outside.allowed, true);
  match(outside.reason, /outside the repository worktree/);

  // Both canonical defaults are deliberately outside the worktree.
  strictEqual(isInsideDirectory(DEFAULT_KEYSTORE_PATH, repositoryRoot), false);
  strictEqual(isInsideDirectory(DEFAULT_ENV_FILE_PATH, repositoryRoot), false);
  match(DEFAULT_ENV_FILE_PATH, /ai-pin-revival[/\\]secrets[/\\]pin[/\\]signing\.env$/);
});

test("a relative target is refused before any path check runs", () => {
  strictEqual(writeTargetVerdict("relative/pin-fork.keystore", { repositoryRoot, isIgnored: true }).allowed, false);
});

test("the CLI refuses a keystore aimed at a tracked location in this repository", async () => {
  // The real Git check, not an injected one.
  //
  // Deliberately extension-less: `.gitignore:46` ignores `*.keystore`
  // ANYWHERE, so `scripts/x.keystore` is already covered and would prove
  // nothing. A newcomer who types `--keystore ./mykey` gets no such backstop,
  // and that is the case this has to catch.
  const target = join(repositoryRoot, "scripts/should-never-exist-key-material");
  const result = await runCli(["--dry-run", "--keystore", target], {
    [PASSWORD_ENV_NAME]: FIXTURE_PASSWORD,
  });

  strictEqual(result.code, 2, "a committable keystore path must fail closed even in --dry-run");
  match(result.stderr, /security incident/);
  strictEqual(await exists(target), false);
});

// ---------------------------------------------------------------------------
// File modes
// ---------------------------------------------------------------------------

test("the declared modes are owner-only", () => {
  strictEqual(ENV_FILE_MODE, 0o600);
  strictEqual(KEYSTORE_MODE, 0o600);
  strictEqual(SECRET_DIRECTORY_MODE, 0o700);
  ok(modeIsOwnerOnly(0o600));
  ok(modeIsOwnerOnly(0o700));
  ok(!modeIsOwnerOnly(0o640), "group-readable is not owner-only");
  ok(!modeIsOwnerOnly(0o604), "world-readable is not owner-only");
  // keytool leaves a fresh store at 0644 (measured), which is exactly why the
  // script chmods afterwards rather than trusting the tool.
  ok(!modeIsOwnerOnly(0o644));
});

test("writeSecretFile lands at 0600 even under a permissive umask", async () => {
  const directory = await scratch();
  const target = join(directory, "nested", "pin-signing.env");
  await writeSecretFile(target, "export PIN_SIGNING_KEY_ALIAS='pin-fork'\n");

  const fileStat = await stat(target);
  strictEqual(fileStat.mode & 0o777, ENV_FILE_MODE);
  ok(modeIsOwnerOnly(fileStat.mode & 0o777));

  const parentStat = await stat(join(directory, "nested"));
  ok(modeIsOwnerOnly(parentStat.mode & 0o777), "the parent directory must not be readable by others");
});

// ---------------------------------------------------------------------------
// End to end, in a temp directory
// ---------------------------------------------------------------------------

// The only test that generates a real key. It stays inside a temp directory
// that `after()` removes, uses a fixture password, and produces a throwaway
// self-signed certificate that never touches the repository or a device.
//
// It exists because every other test here is host-only, and host-only tests
// cannot tell whether the password channel actually works: keytool has no
// -storepass:env form, so the password goes in on stdin, and getting that wrong
// hangs on the first prompt rather than failing. It also covers the chmod that
// no pure helper can — keytool leaves a fresh store at 0644.
const keytoolAvailable = await (async () => {
  try {
    await run("keytool", ["-help"]);
    return true;
  } catch {
    return false;
  }
})();

test(
  "end to end: generates a 0600 PKCS12 keystore, a 0600 env file, and prints no password",
  // An explicit skip, not a silent pass. A host without a JDK should say so
  // rather than report a green it did not earn.
  { skip: keytoolAvailable ? false : "keytool is not on PATH (no JDK)" },
  async () => {
    const directory = await scratch();
    const keystorePath = join(directory, "pin-fork.keystore");
    const envFilePath = join(directory, "pin-signing.env");

    const result = await runCli(
      [
        "--keystore",
        keystorePath,
        "--env-out",
        envFilePath,
        "--alias",
        "pin-fork",
        // Short validity keeps the fixture obviously disposable. The real
        // default is 10000 days.
        "--validity",
        "30",
      ],
      { [PASSWORD_ENV_NAME]: FIXTURE_PASSWORD },
    );

    strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);

    // Both artifacts exist and are owner-only. keytool writes 0644; if the
    // chmod were dropped this assertion is the only thing that notices.
    const keystoreStat = await stat(keystorePath);
    strictEqual(keystoreStat.mode & 0o777, KEYSTORE_MODE, "keytool leaves 0644; the script must fix it");
    const envStat = await stat(envFilePath);
    strictEqual(envStat.mode & 0o777, ENV_FILE_MODE);

    // The env file is complete and usable: all four names, and the store path
    // absolute so rootProject.file() resolves it the same from any directory.
    const envContents = await readFile(envFilePath, "utf8");
    for (const name of REQUIRED_ENV_NAMES) {
      match(envContents, new RegExp(`^export ${name}=`, "m"));
    }
    match(envContents, new RegExp(`^export PIN_SIGNING_STORE_FILE='${keystorePath}'$`, "m"));

    // The password reached keytool (proving the stdin channel works) but never
    // reached any output stream, in any encoding.
    const output = `${result.stdout}${result.stderr}`;
    for (const variant of secretVariants(FIXTURE_PASSWORD)) {
      ok(!output.includes(variant), "the run leaked a password encoding");
    }

    // A fingerprint was read back from the generated certificate, which also
    // proves the alias is present and the store password round-tripped.
    match(result.stdout, /Certificate SHA-256[\s\S]*?\n {2}[0-9a-f]{64}\n/);

    // The honest compatibility warning and the next command, not a build.
    match(result.stdout, /NEW package identity/);
    match(result.stdout, /d8a64e1c3a1afdc340c4b86feaacb88e2d81d66972afbd58e743b7c5b8d1cbdb/);
    match(result.stdout, /Next command:/);
    match(result.stdout, /source /);
    match(result.stdout, /:runtime:android:assembleRelease/);
    ok(!/^Task :/m.test(result.stdout), "the script must not run Gradle itself");
  },
);

test(
  "end to end: the generated keystore actually opens with the generated env values",
  { skip: keytoolAvailable ? false : "keytool is not on PATH (no JDK)" },
  async () => {
    const directory = await scratch();
    const keystorePath = join(directory, "pin-fork.keystore");
    const envFilePath = join(directory, "pin-signing.env");

    const generated = await runCli(
      ["--keystore", keystorePath, "--env-out", envFilePath, "--alias", "pin-fork", "--validity", "30"],
      { [PASSWORD_ENV_NAME]: FIXTURE_PASSWORD },
    );
    strictEqual(generated.code, 0, generated.stderr);

    // Source the file the way a developer would, then open the store with the
    // values it exported. This is the assertion that the four variables are
    // not merely well-named but correct: a wrong alias, a mangled password, or
    // a mismatched PKCS12 key password all fail here and nowhere else.
    const { stdout } = await run("sh", [
      "-c",
      [
        '. "$1" >/dev/null 2>&1',
        'printf "%s\\n" "$PIN_SIGNING_STORE_PASSWORD" |',
        '  keytool -list -keystore "$PIN_SIGNING_STORE_FILE" -alias "$PIN_SIGNING_KEY_ALIAS" 2>&1',
      ].join("\n"),
      "sh",
      envFilePath,
    ]);

    match(stdout, /PrivateKeyEntry/, "the alias must resolve to a private key with the exported password");
    ok(!stdout.includes(FIXTURE_PASSWORD), "keytool must not echo the password back");
  },
);

test(
  "end to end: --force backs the old bytes up, verified, before replacing them",
  { skip: keytoolAvailable ? false : "keytool is not on PATH (no JDK)" },
  async () => {
    const directory = await scratch();
    const keystorePath = join(directory, "pin-fork.keystore");
    const envFilePath = join(directory, "pin-signing.env");
    const originalKeystore = "irreplaceable key material\n";
    const originalEnv = "export PIN_SIGNING_STORE_FILE='/old/path'\n";
    await writeFile(keystorePath, originalKeystore);
    await writeFile(envFilePath, originalEnv);

    const result = await runCli(
      ["--force", "--keystore", keystorePath, "--env-out", envFilePath, "--validity", "30"],
      { [PASSWORD_ENV_NAME]: FIXTURE_PASSWORD },
    );
    strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);

    // Both originals survive, byte for byte, in a backup beside them. This is
    // the entire justification for --force existing at all: the escape hatch
    // is "move it aside", never "delete it".
    const backups = (await readdir(directory)).filter((name) => name.includes(".backup-"));
    strictEqual(backups.length, 2, `expected two backups, got ${backups.join(", ")}`);
    const backedUpContents = await Promise.all(
      backups.sort().map((name) => readFile(join(directory, name), "utf8")),
    );
    deepStrictEqual(backedUpContents.sort(), [originalEnv, originalKeystore].sort());

    // And the new material really did replace the old.
    notStrictEqual(await readFile(keystorePath, "utf8"), originalKeystore);
    match(await readFile(envFilePath, "utf8"), /^export PIN_SIGNING_KEY_PASSWORD=/m);
    match(result.stdout, /backed up /);
  },
);

// ---------------------------------------------------------------------------
// A failed keytool must never be a lost keystore
// ---------------------------------------------------------------------------

test("formatBackupRestoreGuidance names every backup and the command that restores it", () => {
  const guidance = formatBackupRestoreGuidance([
    { source: "/keys/pin-fork.keystore", backup: "/keys/pin-fork.keystore.backup-x", verified: true },
    { source: "/repo/secrets/pin-signing.env", backup: "/repo/secrets/pin-signing.env.backup-x", verified: true },
  ]);

  ok(guidance !== null);
  // The path is the whole point: after --force this file is the ONLY remaining
  // copy of the key, and an error that does not name it is an error that loses
  // it.
  match(guidance, /\/keys\/pin-fork\.keystore\.backup-x/);
  match(guidance, /\/repo\/secrets\/pin-signing\.env\.backup-x/);
  // And a command, not a hint. Single-quoted, so a path with a space or a
  // quote in it survives being pasted.
  match(guidance, /mv '\/keys\/pin-fork\.keystore\.backup-x' '\/keys\/pin-fork\.keystore'/);

  // Nothing verified means nothing to point at; an unverified entry is not a
  // backup and must never be advertised as one.
  strictEqual(formatBackupRestoreGuidance([]), null);
  strictEqual(formatBackupRestoreGuidance(undefined), null);
  strictEqual(
    formatBackupRestoreGuidance([
      { source: "/keys/k", backup: "/keys/k.backup-x", verified: false },
    ]),
    null,
  );
});

test("formatKeytoolUnavailable states that nothing was touched", () => {
  const message = formatKeytoolUnavailable("ENOENT");
  match(message, /ENOENT/);
  match(message, /NOTHING was written, moved or removed/);
  match(message, /JDK/, "the reader has to be told what supplies keytool");
});

test("--force refuses before deleting anything when keytool is not on PATH", async () => {
  const directory = await scratch();
  const keystorePath = join(directory, "pin-fork.keystore");
  const envFilePath = join(directory, "pin-signing.env");
  const originalKeystore = "irreplaceable key material\n";
  const originalEnv = "export PIN_SIGNING_STORE_FILE='/old/path'\n";
  await writeFile(keystorePath, originalKeystore);
  await writeFile(envFilePath, originalEnv);

  // An empty PATH is the cheapest honest way to make keytool unavailable. node
  // itself is invoked by absolute path, so only the child lookups are affected.
  const result = await runCli(
    ["--force", "--keystore", keystorePath, "--env-out", envFilePath],
    { [PASSWORD_ENV_NAME]: FIXTURE_PASSWORD, PATH: "/nonexistent" },
  );

  strictEqual(result.code, 2, `${result.stdout}\n${result.stderr}`);
  match(result.stderr, /keytool cannot be run/);

  // THE ASSERTION. Without the preflight the originals are removed first and
  // keytool fails afterwards, so these two lines go red — which is exactly the
  // failure this check exists to prevent.
  strictEqual(await readFile(keystorePath, "utf8"), originalKeystore);
  strictEqual(await readFile(envFilePath, "utf8"), originalEnv);
  // And no backup was needed, because nothing was ever moved.
  deepStrictEqual(
    (await readdir(directory)).filter((name) => name.includes(".backup-")),
    [],
  );
});

test(
  "when keytool fails after --force, the error names the backups and how to restore them",
  { skip: keytoolAvailable ? false : "keytool is not on PATH (no JDK)" },
  async () => {
    const directory = await scratch();
    const keystorePath = join(directory, "pin-fork.keystore");
    const envFilePath = join(directory, "pin-signing.env");
    const originalKeystore = "irreplaceable key material\n";
    const originalEnv = "export PIN_SIGNING_STORE_FILE='/old/path'\n";
    await writeFile(keystorePath, originalKeystore);
    await writeFile(envFilePath, originalEnv);

    // keytool is present and usable, so the preflight passes, the originals are
    // backed up and removed — and THEN keytool fails, because this subject is
    // not a valid X.500 name ("keytool error: java.io.IOException: Incorrect
    // AVA format", exit 1, no keystore produced). That is the exact shape of
    // the real accident: a bad --dname or a wrong JDK after the point of no
    // return.
    const result = await runCli(
      [
        "--force",
        "--keystore",
        keystorePath,
        "--env-out",
        envFilePath,
        "--dname",
        "not a valid dname",
        "--validity",
        "30",
      ],
      { [PASSWORD_ENV_NAME]: FIXTURE_PASSWORD },
    );

    strictEqual(result.code, 2, `${result.stdout}\n${result.stderr}`);
    match(result.stderr, /keytool failed/);

    // The originals really are gone from their own paths...
    strictEqual(await exists(keystorePath), false, "the --force delete must have happened");
    // ...and survive, byte for byte, in backups.
    const backups = (await readdir(directory)).filter((name) => name.includes(".backup-"));
    strictEqual(backups.length, 2, `expected two backups, got ${backups.join(", ")}`);
    const contents = await Promise.all(
      backups.map((name) => readFile(join(directory, name), "utf8")),
    );
    deepStrictEqual(contents.sort(), [originalEnv, originalKeystore].sort());

    // THE ASSERTION: the failure message names those files. Without it the user
    // is told "keytool failed" and has no way to know the only copy of their
    // signing key is now sitting under a name they never chose.
    for (const name of backups) {
      ok(
        result.stderr.includes(join(directory, name)),
        `the keytool failure must name ${name}; got:\n${result.stderr}`,
      );
    }
    match(result.stderr, /mv '/, "the message must carry a restore command, not just a path");

    // Still no password, on either stream, in any encoding.
    const output = `${result.stdout}${result.stderr}`;
    for (const variant of secretVariants(FIXTURE_PASSWORD)) {
      ok(!output.includes(variant), "the failure path leaked a password encoding");
    }
  },
);

// ---------------------------------------------------------------------------
// Reporting and CLI surface
// ---------------------------------------------------------------------------

test("certificateFingerprintFromKeytoolList normalises to 64 lower-case hex digits", () => {
  // Shape taken from real `keytool -list -v` output on this host (a tab, the
  // label, then colon-separated upper-case bytes); the digits themselves are a
  // synthetic fixture, not any real certificate.
  const listing = [
    "Alias name: pin-fork",
    "Entry type: PrivateKeyEntry",
    "\t SHA256: 0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF",
  ].join("\n");

  strictEqual(
    certificateFingerprintFromKeytoolList(listing),
    "0a1b2c3d4e5f60718293a4b5c6d7e8f900112233445566778899aabbccddeeff",
  );
  strictEqual(certificateFingerprintFromKeytoolList("no fingerprint here"), null);
  // A truncated fingerprint must be reported as absent, never as a short
  // digest somebody might compare against the frozen signer.
  strictEqual(certificateFingerprintFromKeytoolList("SHA256: AA:BB:CC"), null);
});

test("partialSigningEnvWarning names only the variables, never their values", () => {
  strictEqual(partialSigningEnvWarning({}), null, "an empty environment is not partial");
  strictEqual(
    partialSigningEnvWarning(Object.fromEntries(REQUIRED_ENV_NAMES.map((name) => [name, "x"]))),
    null,
    "a complete set is not partial",
  );

  const warning = partialSigningEnvWarning({ PIN_SIGNING_KEY_ALIAS: "pin-fork", PIN_SIGNING_STORE_PASSWORD: FIXTURE_PASSWORD });
  ok(warning !== null);
  match(warning, /PIN_SIGNING_STORE_FILE/);
  match(warning, /PIN_SIGNING_KEY_PASSWORD/);
  ok(!warning.includes(FIXTURE_PASSWORD), "the warning must not echo a value");
  // Blank counts as absent in the build, so it must count as absent here.
  strictEqual(partialSigningEnvWarning({ PIN_SIGNING_KEY_ALIAS: "  " }), null);
});

test("parseCliArgs defaults, resolves paths, and rejects nonsense", () => {
  const defaults = parseCliArgs([]);
  strictEqual(defaults.dryRun, false);
  strictEqual(defaults.force, false);
  strictEqual(defaults.alias, DEFAULT_ALIAS);
  strictEqual(defaults.keystorePath, DEFAULT_KEYSTORE_PATH);
  strictEqual(defaults.envFilePath, DEFAULT_ENV_FILE_PATH);

  const parsed = parseCliArgs(["--dry-run", "--force", "--alias", "other", "--validity", "365"]);
  strictEqual(parsed.dryRun, true);
  strictEqual(parsed.force, true);
  strictEqual(parsed.alias, "other");
  strictEqual(parsed.validityDays, 365);

  throws(() => parseCliArgs(["--nope"]), /unknown argument/);
  throws(() => parseCliArgs(["--keystore"]), /requires a value/);
  throws(() => parseCliArgs(["--validity", "0"]), /positive integer/);
  throws(() => parseCliArgs(["--alias", " "]), /must not be blank/);
});

test("--help documents the four names and does not build, install, or commit", async () => {
  const result = await runCli(["--help"]);
  strictEqual(result.code, 0, result.stderr);
  for (const name of REQUIRED_ENV_NAMES) ok(result.stdout.includes(name));
  match(result.stdout, /does not build, install, commit, or touch a device/);
  // The override must not be one of the four, or setting it would itself
  // create the partial-input state that breaks every Gradle task.
  ok(!REQUIRED_ENV_NAMES.includes(PASSWORD_ENV_NAME));
  ok(result.stdout.includes(PASSWORD_ENV_NAME));
});

test("a backup is refused when its own path is not gitignored", () => {
  // THE REGRESSION THIS PINS: the write gate was applied to the keystore but
  // not to its backup. A .gitignore rule matches the ORIGINAL name, so
  // `*.keystore` covers `mykey.keystore` and leaves `mykey.keystore.backup-<ts>`
  // exposed — `--force` then wrote a private key to a path `git add -A` stages.
  const repositoryRoot = "/repo";
  const inside = "/repo/mykey.keystore";
  const stamp = "2026-07-28T12:34:56.789Z";

  // The backup path is what must be judged, and Git reports IT as not ignored.
  const refused = backupTargetVerdict(inside, stamp, { repositoryRoot, isIgnored: false });
  strictEqual(refused.allowed, false, "a non-ignored backup path must be refused");

  // Same source, but the backup path itself is proven ignored -> allowed.
  const allowed = backupTargetVerdict(inside, stamp, { repositoryRoot, isIgnored: true });
  strictEqual(allowed.allowed, true);

  // An unknown ignore status is not permission.
  const unknown = backupTargetVerdict(inside, stamp, { repositoryRoot, isIgnored: undefined });
  strictEqual(unknown.allowed, false, "unproven ignore status must not grant permission");

  // Outside the worktree needs no ignore rule at all.
  const outside = backupTargetVerdict("/home/u/.pin-keys/pin-fork.keystore", stamp, {
    repositoryRoot,
    isIgnored: false,
  });
  strictEqual(outside.allowed, true);
});
