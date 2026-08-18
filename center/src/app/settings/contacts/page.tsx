import Link from "next/link";
import settings from "../settings.module.css";
import { ContactsView } from "./ContactsView";

export const metadata = { title: "Humane Center" };

export default function ContactsPage() {
  return (
    <>
      <ContactsView />

      {/*
        Which address book this is.

        Center now has two contacts panes over two unrelated stores: this one
        reads `humane.contacts.ContactsRPCService` at COSMOS_ENDPOINT_CONTACTS —
        the `contacts` service in the deployment — and /settings/pin/contacts
        reads the Pin's own SQLite table through Center's active Pin connection.
        The Pin runtime implements
        the same gRPC service against that local table, so the device answers
        from ITS book, not this one, and nothing propagates between them.

        Saying so here rather than only on the device pane is the point: a
        wearer who lands on this pane first has no way to discover the other
        one, and a contact added here that never appears on the Pin is the
        failure this note exists to pre-empt.
      */}
      <section className={settings.section} data-testid="contacts-authority">
        <div className={settings.sectionHeader}>
          <span className={settings.sectionTitle}>Contacts on the Pin itself</span>
        </div>
        <div className={settings.additionRow}>
          <span className={settings.additionRowText}>
            <span className={settings.additionRowDesc}>
              The contacts above live in your account on this server. The Pin also
              keeps its own address book on the device, and that is the one it
              answers calls and messages from. The two are not synced, so a contact
              you need on the Pin has to exist there too. Open the Pin contacts pane
              to see and edit it remotely, or over USB while the device is attached.
            </span>
          </span>
          <Link className={settings.additionLink} href="/settings/pin/contacts">
            Contacts on the Pin
          </Link>
        </div>
      </section>
    </>
  );
}
