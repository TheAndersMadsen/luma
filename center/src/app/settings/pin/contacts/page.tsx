import { redirect } from "next/navigation";

/*
 * The Pin's address book is the account's. Stock ironman syncs it from
 * `ContactsRPCService` (`ContactsService.getContactsStreamingWithPaging`),
 * which Cosmos serves and /settings/contacts edits.
 */
export default function Page() {
  redirect("/settings/contacts");
}
