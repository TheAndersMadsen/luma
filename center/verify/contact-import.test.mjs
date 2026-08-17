import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/contactImport.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function("exports", "module", javascript)(module.exports, module);
const { parseContactFile } = module.exports;

test("CSV import handles quoted cells and trust markers", () => {
  const contacts = parseContactFile(
    'Name,Phone,Email,Organization,Trusted\n"Ada, Countess",+451234,ada@example.com,Analytical Engines,yes\n',
    "contacts.csv",
  );
  assert.deepEqual(contacts, [{
    displayName: "Ada, Countess",
    phoneNumbers: ["+451234"],
    emails: ["ada@example.com"],
    organization: "Analytical Engines",
    trusted: true,
    emergency: false,
  }]);
});

test("vCard import preserves multiple phones and categories", () => {
  const contacts = parseContactFile(
    "BEGIN:VCARD\nVERSION:3.0\nFN:Grace Hopper\nTEL:+451\nTEL:+452\nEMAIL:grace@example.com\nORG:Navy\nCATEGORIES:trusted,emergency\nEND:VCARD\n",
    "contacts.vcf",
  );
  assert.equal(contacts[0].displayName, "Grace Hopper");
  assert.deepEqual(contacts[0].phoneNumbers, ["+451", "+452"]);
  assert.equal(contacts[0].trusted, true);
  assert.equal(contacts[0].emergency, true);
});
