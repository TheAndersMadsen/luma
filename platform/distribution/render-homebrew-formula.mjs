#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const TOKENS = Object.freeze(["HOMEPAGE", "SHA256", "URL", "VERSION"]);

function fail(message) {
  throw new Error(message);
}

function validateHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be an https URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    /[\u0000-\u001f\u007f"'\\]/.test(value)
  ) {
    fail(`${label} must be an https URL without credentials or unsafe characters`);
  }
  return value;
}

export async function renderFormula({ template, output, homepage, sha256, url, version }) {
  validateHttpsUrl(homepage, "--homepage");
  validateHttpsUrl(url, "--url");
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail("--sha256 must be a lowercase SHA-256 digest");
  if (!/^[0-9A-Za-z](?:[0-9A-Za-z.-]{0,62}[0-9A-Za-z])?$/.test(version) || version.includes("..")) {
    fail("invalid --version");
  }

  let formula = await readFile(template, "utf8");
  const values = { HOMEPAGE: homepage, SHA256: sha256, URL: url, VERSION: version };
  for (const token of TOKENS) {
    const marker = `@@${token}@@`;
    if (!formula.includes(marker)) fail(`formula template is missing ${marker}`);
    formula = formula.replaceAll(marker, values[token]);
  }
  if (/@@[A-Z0-9_]+@@/.test(formula)) fail("formula template contains an unknown token");
  await writeFile(output, formula, { flag: "wx" });
}

function parseCli(argv) {
  const options = {};
  const names = {
    "--template": "template",
    "--output": "output",
    "--homepage": "homepage",
    "--sha256": "sha256",
    "--url": "url",
    "--version": "version",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = names[argument];
    if (!key) fail(`unknown option: ${argument}`);
    if (options[key] !== undefined) fail(`${argument} may only be specified once`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
    options[key] = value;
    index += 1;
  }
  for (const key of Object.values(names)) {
    if (!options[key]) fail(`missing --${key}`);
  }
  return options;
}

if (resolve(process.argv[1] ?? "") === resolve(SCRIPT_PATH)) {
  renderFormula(parseCli(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`homebrew formula: ${error.message}\n`);
    process.exitCode = 1;
  });
}
