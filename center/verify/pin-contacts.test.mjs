/*
 * The device-local contacts pane and the pure module underneath it.
 *
 * Two things are worth holding here, and neither is about rendering.
 *
 * The first is DATA LOSS. `updateContact` is a whole-record PUT that the
 * device turns into `upsert_contact`, which rewrites the row and both child
 * tables from what it was handed. There is no merge on either side. So a draft
 * that silently omits a field is a draft that erases it, and the favourite
 * toggle — which is a full PUT wearing a one-field costume — must be built from
 * the record the pane read, never from whatever is sitting in the open editor.
 * Both properties are asserted below because both are invisible in review.
 *
 * The second is WHICH STORE. Center now has two contacts panes over two
 * unrelated databases: /settings/contacts reads Cosmos's principal-keyed store
 * through CARRY_ENDPOINT_CONTACTS, and /settings/pin/contacts reads the Pin's
 * own SQLite over USB. Nothing syncs between them, and a wearer who edits the
 * wrong one sees a save succeed and no change on the device. Both panes must
 * therefore name their store and point at the other one; the source assertions
 * at the end are what stop that from being quietly dropped.
 */

// Registers the resolve hook that lets these `src/` modules reach their own
// extensionless siblings and `@/lib/…` aliases under Node's type stripping.
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const QUERY = "?pin-contacts-test";
const root = new URL("../", import.meta.url);
const source = (file) => readFile(new URL(file, root), "utf8");

const {
  EMPTY_DEVICE_CONTACT_DRAFT,
  deviceContactDraftError,
  deviceContactFromDraft,
  deviceContactLabel,
  deviceContactMatches,
  deviceContactWithFavorite,
  draftFromDeviceContact,
  splitDeviceContactValues,
} = await import(`../src/app/settings/pin/_lib/deviceContacts.ts${QUERY}`);

const ADA = {
  id: "contact-1",
  name: { first_name: "Ada", last_name: "Lovelace", nickname: "", display_name: "" },
  emails: [{ value: "ada@example.test", type: "work" }],
  phone_numbers: [{ value: "+45 11 22 33 44", type: "mobile" }],
  trusted: true,
  emergency: false,
  internal_favorite: false,
  temporary: false,
  contact_source: "stock-import",
  organization: "Analytical Engines",
  modified_at: 1_700_000_000_000,
};

test("a contact's label follows the order the device itself sorts by", () => {
  assert.equal(deviceContactLabel(ADA), "Ada Lovelace");
  assert.equal(
    deviceContactLabel({ ...ADA, name: { ...ADA.name, display_name: "  Ada L.  " } }),
    "Ada L.",
  );
  assert.equal(
    deviceContactLabel({ name: { nickname: "Countess" } }),
    "Countess",
  );
  // The final fallback is prose, not the id: a UUID in a name column reads as a
  // bug, and the pane shows the id separately anyway.
  assert.equal(deviceContactLabel({ id: "d290f1ee-6c54-4b01" }), "Unnamed contact");
});

test("multi-value fields round-trip through the shared | convention", () => {
  assert.deepEqual(splitDeviceContactValues(" a@b.test |  c@d.test |  | "), [
    "a@b.test",
    "c@d.test",
  ]);
  const draft = draftFromDeviceContact({
    ...ADA,
    emails: [{ value: "a@b.test" }, { value: "c@d.test" }],
  });
  assert.equal(draft.emails, "a@b.test | c@d.test");
  assert.deepEqual(splitDeviceContactValues(draft.emails), ["a@b.test", "c@d.test"]);
});

test("a saved record replaces the whole contact, including its emptied fields", () => {
  // Clearing the organisation and every phone number must SEND those clearings,
  // because the device rewrites the row from this body. A builder that omitted
  // them would leave the old values in place and make the save look ignored.
  const cleared = deviceContactFromDraft(
    { ...draftFromDeviceContact(ADA), organization: "", phoneNumbers: "", trusted: false },
    ADA,
  );
  assert.deepEqual(cleared.phone_numbers, []);
  assert.equal(cleared.organization, undefined);
  assert.equal(cleared.trusted, false);
  assert.equal(cleared.id, ADA.id);
  assert.deepEqual(cleared.name, {
    first_name: "Ada",
    last_name: "Lovelace",
    nickname: "",
    display_name: "",
  });

  // Provenance is carried through rather than reconstructed: relabelling a
  // stock-imported contact as something this pane created would be a lie about
  // where the data came from.
  assert.equal(cleared.contact_source, "stock-import");
  assert.equal(deviceContactFromDraft(draftFromDeviceContact(ADA)).contact_source, undefined);

  // A new contact carries no id, so the device mints one instead of upserting
  // over an existing row.
  const created = deviceContactFromDraft({
    ...EMPTY_DEVICE_CONTACT_DRAFT,
    displayName: "New Person",
  });
  assert.equal("id" in created, false);
});

test("the favourite toggle is built from the stored record, not the open draft", () => {
  // The star is a whole-record PUT. If it were derived from the editor draft,
  // one click would commit every half-typed edit sitting next to it.
  const starred = deviceContactWithFavorite(ADA, true);
  assert.equal(starred.internal_favorite, true);
  assert.equal(starred.organization, ADA.organization);
  assert.deepEqual(starred.phone_numbers, ADA.phone_numbers);
  assert.equal(ADA.internal_favorite, false, "the stored record must not be mutated");
  assert.equal(deviceContactWithFavorite(starred, false).internal_favorite, false);

  // The flag survives an edit round trip rather than being reset to false by a
  // form that does not know about it.
  assert.equal(draftFromDeviceContact(starred).favorite, true);
  assert.equal(
    deviceContactFromDraft(draftFromDeviceContact(starred), starred).internal_favorite,
    true,
  );
});

test("draft validation states the device's own rule before the device rejects it", () => {
  assert.equal(deviceContactDraftError(draftFromDeviceContact(ADA)), null);
  // Name OR email OR phone — matching `validate_contact` in
  // pin/runtime/core/src/db/contacts.rs.
  assert.match(
    deviceContactDraftError(EMPTY_DEVICE_CONTACT_DRAFT),
    /name, an email address, or a phone number/,
  );
  assert.equal(
    deviceContactDraftError({ ...EMPTY_DEVICE_CONTACT_DRAFT, phoneNumbers: "+4511223344" }),
    null,
  );
  assert.match(
    deviceContactDraftError({
      ...EMPTY_DEVICE_CONTACT_DRAFT,
      displayName: "Ada",
      emails: "not-an-address",
    }),
    /@/,
  );
});

test("search covers every field the pane puts on screen", () => {
  for (const query of ["", "  ", "LOVELACE", "analytical", "ada@example", "11 22"]) {
    assert.equal(deviceContactMatches(ADA, query), true, query);
  }
  assert.equal(deviceContactMatches(ADA, "babbage"), false);
});

test("the device contacts pane says which store it is and guards the rebuild", async () => {
  const pane = await source("src/app/settings/pin/contacts/page.tsx");

  // Every uncalled client method this pane exists to wire up.
  for (const method of [
    "listContacts",
    "getContact",
    "createContact",
    "updateContact",
    "deleteContact",
    "clientResetContacts",
  ]) {
    assert.match(pane, new RegExp(`\\.${method}\\(`), `${method} has no call site`);
  }

  /*
   * Deleting one contact confirms; the rebuild needs an explicit acknowledgement
   * FIRST and a confirm after it, so there is no single-click path to it.
   *
   * Each confirm is asserted inside the function it guards rather than as one
   * `globalThis.confirm(` anywhere in the file. Those are two different
   * irreversible operations on the device, and a single file-wide match is
   * satisfied by either one of them — so dropping the gate from `deleteContact`
   * would leave this test green while a click destroyed a contact.
   */
  const body = (name) => {
    const start = pane.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, `${name} is missing from the pane`);
    const rest = pane.slice(start + 1);
    const end = rest.indexOf("\n  async function ");
    return end === -1 ? rest : rest.slice(0, end);
  };

  assert.match(body("deleteContact"), /globalThis\.confirm\(/);
  assert.match(body("clientReset"), /globalThis\.confirm\(/);
  assert.match(pane, /resetAcknowledged/);
  assert.match(pane, /disabled=\{mutating \|\| !resetAcknowledged\}/);
  assert.match(pane, /!resetAcknowledged\) return/);

  // The consequence is stated as what actually happens. `client-reset` does not
  // delete the rows this pane shows — Penumbra's hook wipes the STOCK contacts
  // database and re-syncs it from them (pin/hook/.../ContactsHooks.kt) — so
  // copy claiming this pane's list is erased would be wrong, and copy calling
  // it harmless would be worse.
  assert.match(pane, /not<\/strong> listed above is deleted/);
  assert.match(pane, /re-sync/);
  assert.doesNotMatch(pane, /delete every contact on this pane/i);

  // The favourite toggle called out as missing when this surface was audited.
  assert.match(pane, /internal_favorite/);
  assert.match(pane, /Unfavourite/);
});

test("both contacts panes name their store and point at the other one", async () => {
  const [devicePane, accountPane, registry] = await Promise.all([
    source("src/app/settings/pin/contacts/page.tsx"),
    source("src/app/settings/contacts/page.tsx"),
    source("src/app/settings/settingsRegistry.ts"),
  ]);

  assert.match(devicePane, /href="\/settings\/contacts"/);
  assert.match(accountPane, /href="\/settings\/pin\/contacts"/);
  // Neither may describe itself as simply "Contacts" while the other exists.
  assert.match(devicePane, /Contacts on this Pin/);
  assert.match(accountPane, /contacts above live in your account/i);
  assert.match(accountPane, /not synced/);

  // Registered in the information architecture, and distinguishable there: the
  // device pane sits under the "On this Pin" group and the account pane under
  // "Ai Pin", so two rows both reading "Contacts" are never ambiguous. The nav
  // label used to carry the store itself; the group header carries it now, and
  // the assertions above already require each PANE to name its own store and
  // link to the other, which is where a wearer is when they delete.
  assert.match(registry, /href: "\/settings\/pin\/contacts"/);
  assert.match(registry, /PIN_DEVICE_DATA_GROUP = "On this Pin"/);
  assert.match(registry, /title: "Contacts on Pin"/);
  assert.match(registry, /href: "\/settings\/contacts"/);
  assert.match(registry, /title: "Contacts"/);
});
