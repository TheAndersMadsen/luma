import type { Settings, UpdateSettingsRequest } from "@/lib/pin-device";

type LocalServerSettings = Pick<
  Settings["server"],
  "admin_token_auth" | "display_name" | "lan_dashboard_enabled"
>;

export interface NormalizedSettings {
  restart_required?: boolean;
  server: LocalServerSettings;
  contacts?: Settings["contacts"];
  dev?: Settings["dev"];
}

export interface SettingsCapabilities {
  adminTokenAuth: boolean;
  lanDashboard: boolean;
}

export const NO_OPTIONAL_SETTINGS_CAPABILITIES: SettingsCapabilities = {
  adminTokenAuth: false,
  lanDashboard: false,
};

export class InvalidSettingsResponseError extends Error {
  constructor(path: string, expected: string) {
    super(`Invalid settings response: ${path} must be ${expected}`);
    this.name = "InvalidSettingsResponseError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidSettingsResponseError(path, "an object");
  }
  return value as Record<string, unknown>;
}

function optionalRecord(
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  return Object.hasOwn(root, key) ? record(root[key], `settings.${key}`) : undefined;
}

function optionalBoolean(
  source: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  if (!Object.hasOwn(source, key) || source[key] === null) return undefined;
  if (typeof source[key] !== "boolean") {
    throw new InvalidSettingsResponseError(`${path}.${key}`, "a boolean");
  }
  return source[key];
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  if (!Object.hasOwn(source, key) || source[key] === null) return undefined;
  if (typeof source[key] !== "string") {
    throw new InvalidSettingsResponseError(`${path}.${key}`, "a string");
  }
  return source[key];
}

/**
 * Keep Center's device boundary deliberately small. Provider configuration and
 * assistant behavior belong to Cosmos, even if an older Pin response still
 * contains those retired sections.
 */
export function normalizeSettingsResponse(input: unknown): {
  settings: NormalizedSettings;
  capabilities: SettingsCapabilities;
} {
  const root = record(input, "settings");
  const server = record(root.server, "settings.server");
  const contacts = optionalRecord(root, "contacts");
  const dev = optionalRecord(root, "dev");
  const adminTokenAuth = optionalBoolean(server, "admin_token_auth", "settings.server") === true;
  const lanDashboard = Object.hasOwn(server, "lan_dashboard_enabled");

  return {
    settings: {
      restart_required: optionalBoolean(root, "restart_required", "settings"),
      server: {
        admin_token_auth: adminTokenAuth,
        display_name: optionalString(server, "display_name", "settings.server"),
        lan_dashboard_enabled: optionalBoolean(
          server,
          "lan_dashboard_enabled",
          "settings.server",
        ),
      },
      ...(contacts
        ? {
            contacts: {
              trust_all_contacts: optionalBoolean(
                contacts,
                "trust_all_contacts",
                "settings.contacts",
              ),
              allow_all_inbound: optionalBoolean(
                contacts,
                "allow_all_inbound",
                "settings.contacts",
              ),
            },
          }
        : {}),
      ...(dev
        ? {
            dev: {
              apk_install_enabled: optionalBoolean(
                dev,
                "apk_install_enabled",
                "settings.dev",
              ),
            },
          }
        : {}),
    },
    capabilities: { adminTokenAuth, lanDashboard },
  };
}

/** Permit only Pin-local settings; provider and prompt writes are Cosmos-owned. */
export function filterSettingsRequestByCapabilities(
  request: UpdateSettingsRequest,
  capabilities: SettingsCapabilities,
): UpdateSettingsRequest {
  const filtered: UpdateSettingsRequest = {};

  if (request.server) {
    const server: NonNullable<UpdateSettingsRequest["server"]> = {};
    if (request.server.display_name !== undefined) {
      server.display_name = request.server.display_name;
    }
    if (capabilities.adminTokenAuth && request.server.admin_token !== undefined) {
      server.admin_token = request.server.admin_token;
    }
    if (capabilities.lanDashboard && request.server.lan_dashboard_enabled !== undefined) {
      server.lan_dashboard_enabled = request.server.lan_dashboard_enabled;
    }
    if (Object.keys(server).length > 0) filtered.server = server;
  }

  if (request.contacts) {
    const contacts: NonNullable<UpdateSettingsRequest["contacts"]> = {};
    if (request.contacts.trust_all_contacts !== undefined) {
      contacts.trust_all_contacts = request.contacts.trust_all_contacts;
    }
    if (request.contacts.allow_all_inbound !== undefined) {
      contacts.allow_all_inbound = request.contacts.allow_all_inbound;
    }
    if (Object.keys(contacts).length > 0) filtered.contacts = contacts;
  }

  if (request.dev?.apk_install_enabled !== undefined) {
    filtered.dev = { apk_install_enabled: request.dev.apk_install_enabled };
  }

  return filtered;
}
