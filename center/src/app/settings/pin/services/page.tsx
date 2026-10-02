import { redirect } from "next/navigation";

/*
 * Who may call the Pin is each contact's Trusted setting: stock
 * `CallUtils.callIsTrustedOrLeased` reads it from the synced address book.
 * /settings/contacts edits it.
 */
export default function Page() {
  redirect("/settings/contacts");
}
