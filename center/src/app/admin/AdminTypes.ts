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
  device_edge_ipv4: string | null;
  device_status_endpoint: string | null;
};

export type Bundle = {
  device_id: string;
  subject: string;
  certificate_pem: string;
  private_key_pem: string;
  ca_certificate_pem: string;
  root_certificate_pem: string;
  pincode: string;
  onboarding: { endpoint: string; authority: string };
};

export type ProvisionedDevice = {
  device_id: string;
  product: string;
  subject: string;
  provisioned_at_unix: number;
};
