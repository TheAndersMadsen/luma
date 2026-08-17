/*
 * The configuration surface's wire shapes, re-exported from the module that
 * defines them rather than restated here.
 *
 * `import type` is erased at compile time, so nothing from `src/server` reaches
 * the browser bundle — and the alternative, a hand-copied union, is a copy that
 * drifts. These are not the console's own view models the way `Overview` is:
 * they are the exact objects `/api/admin/configuration` serializes, and a
 * console rendering a `writable` or `state` member the server no longer emits
 * would be rendering a promise nothing keeps.
 */
export type {
  ConfigurationConstraint,
  ConfigurationInventory,
  ConfigurationSettingState,
  ConfigurationState,
} from "@/server/configuration";
export type { ConfigurationProposalState } from "@/server/configurationProposals";

export type Overview = {
  enrollment: {
    open: boolean;
    provisioning_configured: boolean;
    duc_ca_configured: boolean;
    pincode: string;
    keyless: boolean;
    user_id: string;
    display_name: string;
  };
  persistence: { notes: number | null; memories: number | null; contacts: number | null };
  persistenceProvenance?: Record<"notes" | "memories" | "contacts", {
    state: "live" | "absent" | "degraded";
    degraded?: string | null;
  }>;
  provisioned_devices: number;
  onboarding: { endpoint: string; authority: string };
};

export type Bundle = {
  device_id: string;
  subject: string;
  certificate_pem: string;
  private_key_pem: string;
  ca_certificate_pem: string;
  pincode: string;
  onboarding: { endpoint: string; authority: string };
};

export type ProvisionedDevice = {
  device_id: string;
  product: string;
  subject: string;
  provisioned_at_unix: number;
};
