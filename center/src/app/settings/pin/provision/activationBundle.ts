import type { ActivationBundle } from "./types";

/** The one file accepted by `pin activate --credential-file`. */
export function createActivationBundleJson(
  bundle: ActivationBundle,
  deviceStatusEndpoint: string,
): string {
  return `${JSON.stringify({
    device_id: bundle.device_id,
    certificate_pem: bundle.certificate_pem,
    private_key_pem: bundle.private_key_pem,
    ca_certificate_pem: bundle.ca_certificate_pem,
    root_certificate_pem: bundle.root_certificate_pem,
    device_status_endpoint: deviceStatusEndpoint,
  }, null, 2)}\n`;
}

export function activationCommands(deviceId: string, edgeIpv4: string | null) {
  const credentialFile = `cosmos-activation-${deviceId}.json`;
  const credentialPath = `~/.config/ai-pin-revival/${credentialFile}`;
  const edge = edgeIpv4 ?? "SERVER_PUBLIC_IPV4";
  const plan = `./revival pin activate --serial PIN_SERIAL --credential-file ${credentialPath} --edge-ipv4 ${edge}`;
  return {
    credentialFile,
    credentialPath,
    plan,
    confirm: `${plan} --confirm`,
    status: "./revival pin activate status --serial PIN_SERIAL",
  } as const;
}
