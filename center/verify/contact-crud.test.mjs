import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("../src/app/api/contacts/route.ts", import.meta.url), "utf8");
const source = await readFile(new URL("../src/server/source.ts", import.meta.url), "utf8");
const view = await readFile(new URL("../src/app/settings/contacts/ContactsView.tsx", import.meta.url), "utf8");

test("contacts route exposes bounded same-origin CRUD", () => {
  assert.match(route, /export async function POST/);
  assert.match(route, /export async function PUT/);
  assert.match(route, /export async function DELETE/);
  assert.match(route, /MAX_BATCH = 500/);
  assert.match(route, /isSameOriginRequest/);
});

test("CRUD maps onto the stock Contacts service methods", () => {
  for (const method of ["CreateContacts", "UpdateContacts", "DeleteContacts"]) {
    assert.match(source, new RegExp(`"${method}"`));
  }
});

test("wearer UI offers add, edit, delete, CSV and vCard import", () => {
  assert.match(view, /Add contact/);
  assert.match(view, /Import/);
  assert.match(view, /\.csv,\.vcf,\.vcard/);
  assert.match(view, />Edit</);
  assert.match(view, />Delete</);
  assert.doesNotMatch(view, /Google, Apple or Microsoft/);
});
