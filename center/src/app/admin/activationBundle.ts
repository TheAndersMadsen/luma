import type { Bundle } from "./AdminTypes";

/** The one file accepted by `pin activate --credential-file`. */
export function createActivationBundleJson(bundle: Bundle): string {
  return `${JSON.stringify({
    device_id: bundle.device_id,
    certificate_pem: bundle.certificate_pem,
    private_key_pem: bundle.private_key_pem,
    ca_certificate_pem: bundle.ca_certificate_pem,
    root_certificate_pem: bundle.root_certificate_pem,
  }, null, 2)}\n`;
}
