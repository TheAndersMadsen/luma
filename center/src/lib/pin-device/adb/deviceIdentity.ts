import type { AdbSessionTransport } from "./transport";
import { isRecognizedAiPin } from "@/lib/pin-install/domain/recognition";

export interface DeviceIdentity {
  readonly manufacturer: string;
  readonly model: string;
  readonly product: string;
  readonly buildFingerprint: string;
  readonly recognizedAiPin: boolean;
}

function trimProperty(value: string) {
  return value.trim();
}

export async function getDeviceIdentity(
  transport: AdbSessionTransport,
): Promise<DeviceIdentity> {
  const [manufacturerResult, modelResult, productResult, buildFingerprintResult] =
    await Promise.all([
      transport.shell(["getprop", "ro.product.manufacturer"]),
      transport.shell(["getprop", "ro.product.model"]),
      transport.shell(["getprop", "ro.product.device"]),
      transport.shell(["getprop", "ro.build.fingerprint"]),
    ]);

  const manufacturer = trimProperty(manufacturerResult.stdout);
  const model = trimProperty(modelResult.stdout);
  const product = trimProperty(productResult.stdout);
  const buildFingerprint = trimProperty(buildFingerprintResult.stdout);

  return {
    manufacturer,
    model,
    product,
    buildFingerprint,
    recognizedAiPin: isRecognizedAiPin({
      manufacturer,
      model,
    }),
  };
}
