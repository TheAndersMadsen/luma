export type ProvisioningOverview = {
  enrollment: {
    open: boolean;
    provisioning_configured: boolean;
    duc_ca_configured: boolean;
    pincode: string;
    keyless: boolean;
    user_id: string;
    display_name: string;
  };
  onboarding: { endpoint: string; authority: string };
  device_edge_ipv4: string | null;
  device_status_endpoint: string | null;
};

export type ActivationBundle = {
  device_id: string;
  subject: string;
  certificate_pem: string;
  private_key_pem: string;
  ca_certificate_pem: string;
  root_certificate_pem: string;
  pincode: string;
  onboarding: { endpoint: string; authority: string };
};
