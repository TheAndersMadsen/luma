import settings from "../settings.module.css";
import { ContactsView } from "./ContactsView";

export const metadata = { title: "Humane Center" };

export default function ContactsPage() {
  return (
    <>
      <ContactsView />

      {/*
        This is the address book the Pin uses. Stock ironman delta-syncs it from
        `humane.contacts.ContactsRPCService` (Cosmos), and the stock dialer
        rejects a ringing call unless the caller is trusted or leased
        (`CallManager.shouldSendToVoicemail` → `CallUtils.callIsTrustedOrLeased`;
        a lease is the one-day temporary contact the Pin makes for a number it
        called or texted).
      */}
      <section className={settings.section} data-testid="contacts-pin-sync">
        <div className={settings.additionRow}>
          <span className={settings.additionRowText}>
            <span className={settings.additionRowDesc}>
              Your Pin syncs these contacts. Calls from people who aren&rsquo;t trusted go to
              voicemail, unless you called or texted them in the last day.
            </span>
          </span>
        </div>
      </section>
    </>
  );
}
