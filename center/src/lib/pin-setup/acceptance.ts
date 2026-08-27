const STORAGE_KEY = "ai-pin-revival.setup-acceptance.v1";
const MAX_REMEMBERED_PINS = 16;

export interface SetupAcceptanceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function setupAcceptanceIdentity(
  serial: string | null,
  releaseVersion: string | null,
  edgeIpv4: string | null,
): string | null {
  const values = [serial?.trim().toUpperCase(), releaseVersion?.trim(), edgeIpv4?.trim()];
  if (values.some((value) => !value || value.length > 128)) return null;
  return JSON.stringify(values);
}

function rememberedIdentities(storage: SetupAcceptanceStorage): string[] {
  const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length <= 512,
  );
}

export function loadSetupAcceptance(
  storage: SetupAcceptanceStorage,
  identity: string,
): boolean {
  try {
    return rememberedIdentities(storage).includes(identity);
  } catch {
    return false;
  }
}

export function saveSetupAcceptance(
  storage: SetupAcceptanceStorage,
  identity: string,
): boolean {
  try {
    const remembered = rememberedIdentities(storage).filter((entry) => entry !== identity);
    remembered.push(identity);
    storage.setItem(STORAGE_KEY, JSON.stringify(remembered.slice(-MAX_REMEMBERED_PINS)));
    return true;
  } catch {
    return false;
  }
}
