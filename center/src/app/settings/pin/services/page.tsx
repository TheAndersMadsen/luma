"use client";

import { useEffect, useMemo, useState } from "react";
import type { UpdateSettingsRequest } from "@/lib/pin-device";
import {
  DeviceRequired,
  FormRow,
  PaneLoadState,
  PaneSection,
  SaveBar,
  ToggleRow,
} from "../_lib/PaneShell";
import { UnsavedChangesGuard } from "../_lib/UnsavedChangesGuard";
import { usePinPaneSession } from "../_lib/pinSession";
import { useDeviceSettings } from "../_lib/useDeviceSettings";
import styles from "../_lib/panes.module.css";

const SCOPE = "pin-communications-pane";

/** Device-only call and message policy. External providers are configured in Cosmos. */
export default function PinServicesPane() {
  const { client, connectionError, attachedWithoutServer } = usePinPaneSession();
  const controller = useDeviceSettings(SCOPE);
  const saved = controller.settings;
  const [trustAllContacts, setTrustAllContacts] = useState(false);
  const [allowAllInbound, setAllowAllInbound] = useState(false);

  useEffect(() => {
    if (!saved) return;
    setTrustAllContacts(saved.contacts?.trust_all_contacts ?? false);
    setAllowAllInbound(saved.contacts?.allow_all_inbound ?? false);
  }, [saved]);

  const request = useMemo<UpdateSettingsRequest | null>(() => {
    if (!saved) return null;
    const contacts: NonNullable<UpdateSettingsRequest["contacts"]> = {};
    if (trustAllContacts !== (saved.contacts?.trust_all_contacts ?? false)) {
      contacts.trust_all_contacts = trustAllContacts;
    }
    if (allowAllInbound !== (saved.contacts?.allow_all_inbound ?? false)) {
      contacts.allow_all_inbound = allowAllInbound;
    }
    return Object.keys(contacts).length > 0 ? { contacts } : null;
  }, [allowAllInbound, saved, trustAllContacts]);

  if (!client) {
    return (
      <DeviceRequired
        attachedWithoutServer={attachedWithoutServer}
        what="this Pin's call and message policy"
        connectionError={connectionError}
      />
    );
  }

  if (!saved) {
    return <PaneLoadState error={controller.loadError} onRetry={controller.reload} rows={2} />;
  }

  const saving = controller.saveStatus === "saving";
  return (
    <>
      <SaveBar
        status={controller.saveStatus}
        error={controller.saveError}
        dirty={request !== null}
        onSave={() => {
          if (request) void controller.save(request);
        }}
      />
      <fieldset className={styles.fieldset} disabled={saving} aria-busy={saving}>
        <PaneSection title="Calls and messages" testId="pin-services-contacts">
          <FormRow label="Trust all contacts">
            <ToggleRow
              ariaLabel="Trust all contacts"
              copy="Allow calls and messages from any saved contact."
              checked={trustAllContacts}
              onChange={setTrustAllContacts}
              disabled={allowAllInbound}
            />
          </FormRow>
          <FormRow
            label="Allow all inbound calls and messages"
            help="When this is on, the trusted-contacts setting no longer narrows anything."
          >
            <ToggleRow
              ariaLabel="Allow all inbound calls and messages"
              copy="Allow calls and messages from everyone, including people outside contacts."
              checked={allowAllInbound}
              onChange={setAllowAllInbound}
            />
          </FormRow>
        </PaneSection>
      </fieldset>
      <UnsavedChangesGuard when={request !== null} />
    </>
  );
}
