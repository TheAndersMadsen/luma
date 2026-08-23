#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const REQUIRED_ENV_NAMES = Object.freeze([
  "PIN_SIGNING_STORE_FILE",
  "PIN_SIGNING_STORE_PASSWORD",
  "PIN_SIGNING_KEY_ALIAS",
  "PIN_SIGNING_KEY_PASSWORD",
]);
export const PASSWORD_ENV_NAME = "PIN_SIGNING_SETUP_PASSWORD";
export const DEFAULT_ALIAS = "pin-fork";
export const KEYSTORE_MODE = 0o600;
export const ENV_FILE_MODE = 0o600;

const configRoot = resolve(
  process.env.REVIVAL_CONFIG_DIR ??
    resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "ai-pin-revival"),
);
const secretsRoot = resolve(process.env.REVIVAL_SECRETS_DIR ?? resolve(configRoot, "secrets"));
export const DEFAULT_KEYSTORE_PATH = resolve(secretsRoot, "pin/operator-signing.keystore");
export const DEFAULT_ENV_FILE_PATH = resolve(secretsRoot, "pin/signing.env");

export function generatePassword(byteLength = 32) {
  if (!Number.isInteger(byteLength) || byteLength < 16) {
    throw new Error("password entropy must be at least 16 bytes");
  }
  return randomBytes(byteLength).toString("base64url");
}

export function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function renderEnvFile(values) {
  for (const name of REQUIRED_ENV_NAMES) {
    if (typeof values[name] !== "string" || values[name].trim() === "") {
      throw new Error(`${name} must be a non-blank string`);
    }
  }
  if (!isAbsolute(values.PIN_SIGNING_STORE_FILE)) {
    throw new Error("PIN_SIGNING_STORE_FILE must be absolute");
  }
  if (values.PIN_SIGNING_STORE_PASSWORD !== values.PIN_SIGNING_KEY_PASSWORD) {
    throw new Error("PKCS12 requires identical store and key passwords");
  }
  return [
    "# Pin release signing inputs. Keep this file private.",
    ...REQUIRED_ENV_NAMES.map((name) => `export ${name}=${shellSingleQuote(values[name])}`),
    "",
  ].join("\n");
}

export function parseCliArgs(argv) {
  const options = {
    keystorePath: DEFAULT_KEYSTORE_PATH,
    envFilePath: DEFAULT_ENV_FILE_PATH,
    alias: DEFAULT_ALIAS,
    force: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") options.force = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (["--keystore", "--env-out", "--alias"].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a value`);
      if (argument === "--keystore") options.keystorePath = resolve(value);
      else if (argument === "--env-out") options.envFilePath = resolve(value);
      else options.alias = value;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/u.test(options.alias)) throw new Error("alias contains unsafe characters");
  if (options.keystorePath === options.envFilePath) throw new Error("keystore and env file must differ");
  return Object.freeze(options);
}

export function buildKeytoolArgs({ keystorePath, alias }) {
  return [
    "-genkeypair",
    "-keystore", keystorePath,
    "-storetype", "PKCS12",
    "-alias", alias,
    "-keyalg", "RSA",
    "-keysize", "4096",
    "-validity", "10000",
    "-dname", "CN=Ai Pin Revival, OU=Pin, O=Ai Pin Revival",
    "-noprompt",
  ];
}

async function runKeytool(args, password) {
  await new Promise((accept, reject) => {
    const child = spawn("keytool", args, { stdio: ["pipe", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { errorText += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) accept();
      else reject(new Error(errorText.trim() || `keytool exited ${code}`));
    });
    child.stdin.end(`${password}\n${password}\n`);
  });
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseCliArgs(argv);
  if (options.dryRun) {
    process.stdout.write(`keystore: ${options.keystorePath}\nenvironment: ${options.envFilePath}\n`);
    return options;
  }

  const existing = (await Promise.all([
    pathExists(options.keystorePath),
    pathExists(options.envFilePath),
  ])).some(Boolean);
  if (existing && !options.force) {
    throw new Error("signing material already exists; use --force to replace it");
  }
  if (options.force) {
    await Promise.all([
      rm(options.keystorePath, { force: true }),
      rm(options.envFilePath, { force: true }),
    ]);
  }
  await Promise.all([
    mkdir(dirname(options.keystorePath), { recursive: true, mode: 0o700 }),
    mkdir(dirname(options.envFilePath), { recursive: true, mode: 0o700 }),
  ]);

  const password = environment[PASSWORD_ENV_NAME] || generatePassword();
  const temporaryKeystore = `${options.keystorePath}.${process.pid}.tmp`;
  const temporaryEnv = `${options.envFilePath}.${process.pid}.tmp`;
  try {
    await runKeytool(buildKeytoolArgs({ ...options, keystorePath: temporaryKeystore }), password);
    await chmod(temporaryKeystore, KEYSTORE_MODE);
    await writeFile(temporaryEnv, renderEnvFile({
      PIN_SIGNING_STORE_FILE: options.keystorePath,
      PIN_SIGNING_STORE_PASSWORD: password,
      PIN_SIGNING_KEY_ALIAS: options.alias,
      PIN_SIGNING_KEY_PASSWORD: password,
    }), { flag: "wx", mode: ENV_FILE_MODE });
    await rename(temporaryKeystore, options.keystorePath);
    await rename(temporaryEnv, options.envFilePath);
  } finally {
    await Promise.all([
      rm(temporaryKeystore, { force: true }),
      rm(temporaryEnv, { force: true }),
    ]);
  }

  process.stdout.write(`wrote ${options.keystorePath}\nwrote ${options.envFilePath}\n`);
  return options;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`setup-signing-key: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
