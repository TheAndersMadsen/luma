import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const route = await readFile(new URL("../src/app/api/contacts/route.ts", import.meta.url), "utf8");
const source = await readFile(new URL("../src/server/domain/contacts.ts", import.meta.url), "utf8");

/*
 * A stand-in Cosmos contacts workload, spoken to over the real wire contract
 * with the same proto-loader options Center uses, so what reaches
 * `UpdateContacts` is exactly what Center serializes.
 */
const WIRE = fileURLToPath(new URL("../../contracts/wire", import.meta.url));
const definition = protoLoader.loadSync("humane/contacts.proto", {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [WIRE],
});
const { humane } = grpc.loadPackageDefinition(definition);

const book = new Map();
/** What Cosmos relays in `encrypted_contacts`: contacts it cannot open. */
const sealed = [];
const calls = [];
let nextId = 1;
const server = new grpc.Server();
server.addService(humane.contacts.ContactsRPCService.service, {
  GetContacts(call, done) {
    calls.push({ method: "GetContacts", request: call.request });
    // As Cosmos does: a sealed contact cannot match a search term.
    const unfiltered = !call.request.searchTerm.trim();
    done(null, { contacts: [...book.values()], encryptedContacts: unfiltered ? sealed : [] });
  },
  CreateContacts(call, done) {
    calls.push({ method: "CreateContacts", request: call.request });
    const contacts = call.request.contacts.map((contact) => {
      const stored = { ...contact, id: `contact-${nextId++}`, version: 1 };
      book.set(stored.id, stored);
      return stored;
    });
    done(null, { contacts });
  },
  UpdateContacts(call, done) {
    calls.push({ method: "UpdateContacts", request: call.request });
    for (const contact of call.request.contacts) book.set(contact.id, contact);
    done(null, {});
  },
  DeleteContacts(call, done) {
    calls.push({ method: "DeleteContacts", request: call.request });
    for (const id of call.request.ids) book.delete(id);
    done(null, {});
  },
});
const port = await new Promise((resolve, reject) =>
  server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, bound) =>
    error ? reject(error) : resolve(bound),
  ),
);

process.env.COSMOS_ENDPOINT_CONTACTS = `127.0.0.1:${port}`;
process.env.COSMOS_CONTRACTS_DIR = WIRE;
process.env.COSMOS_PRINCIPAL = "U:contact-crud-test";
const { createContacts, updateContact } = await import(
  "../src/server/domain/contacts.ts?contact-crud"
);

test.after(() => server.forceShutdown());

/** A contact the Pin created: first name only, leased, with cloud-only fields set. */
function seedPinContact() {
  book.clear();
  sealed.length = 0;
  calls.length = 0;
  const stored = {
    id: "pin-contact",
    version: 3,
    name: { firstName: "Ada", lastName: "", nickname: "", displayName: "" },
    phoneNumbers: [{ value: "+4511", type: "" }],
    emails: [],
    telephoneNumbers: ["+4599"],
    socialHandles: [{ socialProvider: "SLACK", socialProviderAttributes: [{ type: "USER_ID", value: "U123" }] }],
    contactActions: [{ id: "action-1", message: "hello" }],
    trusted: true,
    temporary: false,
    emergency: false,
    internalFavorite: true,
    contactSource: { name: "import:vcard" },
    lastUsedAt: { seconds: "1700000000", nanos: 5 },
    modifiedAt: { seconds: "1700000100", nanos: 0 },
    organization: null,
  };
  book.set(stored.id, stored);
  return stored;
}

function draft(overrides = {}) {
  return {
    firstName: "Ada",
    lastName: "",
    nickname: "",
    displayName: "",
    phoneNumbers: [{ value: "+4511", type: "" }],
    emails: [],
    organization: null,
    trusted: true,
    emergency: false,
    favorite: true,
    source: null,
    ...overrides,
  };
}

test("editing a nickname preserves internal_favorite, temporary and contact_source", async () => {
  seedPinContact();
  book.get("pin-contact").temporary = true;

  const result = await updateContact("pin-contact", draft({ nickname: "Addie", favorite: true }));
  assert.equal(result.state, "live");
  assert.equal(result.data, true);

  const update = calls.find((call) => call.method === "UpdateContacts");
  assert.ok(update, "the edit reaches UpdateContacts");
  const [sent] = update.request.contacts;
  assert.equal(sent.id, "pin-contact");
  assert.equal(sent.name.nickname, "Addie");
  assert.equal(sent.name.firstName, "Ada", "first name survives");
  assert.equal(sent.internalFavorite, true);
  assert.equal(sent.temporary, true, "a lease stays a lease");
  assert.deepEqual(sent.contactSource, { name: "import:vcard" });
  // Fields the pane never shows ride through the whole-record update.
  assert.deepEqual(sent.telephoneNumbers, ["+4599"]);
  assert.equal(sent.socialHandles[0].socialProvider, "SLACK");
  assert.equal(sent.socialHandles[0].socialProviderAttributes[0].value, "U123");
  assert.deepEqual(sent.contactActions, [{ id: "action-1", message: "hello" }]);
  assert.equal(sent.lastUsedAt.seconds, "1700000000");
  // A blank display name is derived, because the Pin's dialer shows it first.
  assert.equal(sent.name.displayName, "Ada");
});

test("a partial edit never wipes the name or the favourite", async () => {
  seedPinContact();
  await updateContact("pin-contact", draft({ lastName: "Lovelace" }));
  const stored = book.get("pin-contact");
  assert.equal(stored.name.firstName, "Ada");
  assert.equal(stored.name.lastName, "Lovelace");
  assert.equal(stored.name.displayName, "Ada Lovelace");
  assert.equal(stored.internalFavorite, true);
});

test("create writes the structured name, typed values and import source", async () => {
  book.clear();
  calls.length = 0;
  const result = await createContacts([
    draft({ firstName: "Grace", lastName: "Hopper", nickname: "", favorite: false, source: "import:csv",
      phoneNumbers: [{ value: "+4522", type: "mobile" }] }),
  ]);
  assert.equal(result.state, "live");
  assert.equal(result.data, 1);
  const [sent] = calls.find((call) => call.method === "CreateContacts").request.contacts;
  assert.deepEqual(sent.name, { firstName: "Grace", lastName: "Hopper", nickname: "", displayName: "Grace Hopper" });
  assert.deepEqual(sent.phoneNumbers, [{ value: "+4522", type: "mobile" }]);
  assert.deepEqual(sent.contactSource, { name: "import:csv" });
  assert.equal(sent.internalFavorite, false);
  assert.equal(sent.trusted, true);
});

test("contacts route exposes bounded same-origin CRUD", () => {
  assert.match(route, /export async function POST/);
  assert.match(route, /export async function PUT/);
  assert.match(route, /export async function DELETE/);
  assert.match(route, /MAX_BATCH = 500/);
  assert.match(route, /isSameOriginRequest/);
  assert.match(route, /status: 404/, "an edit of a deleted contact says so");
});

test("CRUD maps onto the stock Contacts service methods", () => {
  for (const method of ["GetContacts", "CreateContacts", "UpdateContacts", "DeleteContacts"]) {
    assert.match(source, new RegExp(`"${method}"`));
  }
});
