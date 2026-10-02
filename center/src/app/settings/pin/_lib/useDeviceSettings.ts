"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateSettingsRequest } from "@/lib/pin-device";
import { logError, logInfo } from "@/lib/pin-device";
import {
  NO_OPTIONAL_SETTINGS_CAPABILITIES,
  filterSettingsRequestByCapabilities,
  normalizeSettingsResponse,
  type NormalizedSettings,
  type SettingsCapabilities,
} from "./settingsResponse";
import { changedSettingFields } from "./settingsFormState";
import { pinClientIdentity, usePinPaneSession } from "./pinSession";
import { deviceErrorMessage } from "./deviceErrorPresentation";
import { PIN_QUERY_KEY } from "../PinDeviceProvider";

/*
 * GET/PUT /api/settings, once, for the Pin-local panes (server and
 * diagnostics).
 *
 * The endpoint is one document, so the panes MUST share one cache entry: two
 * independent copies could let one pane save a stale device document over a
 * change from another pane.
 * React Query gives that for free, the mutation writes the server's own
 * response back into the cache, and every mounted pane re-derives from it.
 *
 * The cache key carries a per-client identity so a second Pin connected in the
 * same browser tab can never be shown the first Pin's configuration. That is a
 * privacy boundary, not a freshness optimisation. It is also prefixed with
 * PIN_QUERY_KEY, which is what the provider invalidates whenever the device
 * pushes an event, so a setting changed on the Pin itself lands here without
 * any polling of our own.
 */

export interface DeviceSettingsSnapshot {
  settings: NormalizedSettings;
  capabilities: SettingsCapabilities;
}

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface DeviceSettingsController {
  /** Null until the Pin has answered, or while no Pin is connected. */
  settings: NormalizedSettings | null;
  capabilities: SettingsCapabilities;
  isLoading: boolean;
  loadError: string | null;
  reload: () => void;
  /** True when the Pin says persisted listener settings differ from the run. */
  restartRequired: boolean;
  saveStatus: SaveStatus;
  saveError: string | null;
  /**
   * Send a partial update. Leaves the Pin does not advertise are stripped
   * first, so a pane can never report "Saved" for a field an older server
   * silently ignored.
   */
  save: (request: UpdateSettingsRequest) => Promise<boolean>;
  clearSaveState: () => void;
}

export function useDeviceSettings(scope: string): DeviceSettingsController {
  const { client } = usePinPaneSession();
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => [PIN_QUERY_KEY, "settings", pinClientIdentity(client)] as const,
    [client],
  );

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const query = useQuery<DeviceSettingsSnapshot>({
    queryKey,
    enabled: client !== null,
    // The device is the authority and there is no push channel for settings,
    // so a pane switch re-reads rather than trusting a minutes-old copy.
    staleTime: 15_000,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!client) throw new Error("No Pin is connected.");
      logInfo(scope, "Loading device settings");
      const response = await client.getSettings(signal);
      return normalizeSettingsResponse(response);
    },
  });

  const mutation = useMutation({
    mutationFn: async (request: UpdateSettingsRequest) => {
      if (!client) throw new Error("No Pin is connected.");
      const response = await client.updateSettings(request);
      return normalizeSettingsResponse(response);
    },
  });

  const capabilities = query.data?.capabilities ?? NO_OPTIONAL_SETTINGS_CAPABILITIES;

  const save = useCallback(
    async (request: UpdateSettingsRequest): Promise<boolean> => {
      if (!client) {
        setSaveError("No Pin is connected.");
        setSaveStatus("error");
        return false;
      }

      const filtered = filterSettingsRequestByCapabilities(request, capabilities);
      if (Object.keys(filtered).length === 0) {
        // Every leaf was stripped: the connected Pin does not understand any of
        // them. Saying "Saved" here is the exact lie this branch prevents.
        setSaveError(
          "This Pin's server does not support any of the changed settings. Update the device over USB first.",
        );
        setSaveStatus("error");
        return false;
      }

      if (savedTimer.current) clearTimeout(savedTimer.current);
      setSaveStatus("saving");
      setSaveError(null);

      // Field NAMES only, never values. See changedSettingFields.
      const changedFields = changedSettingFields(filtered);
      logInfo(scope, "Saving device settings", { changedFields });

      try {
        const next = await mutation.mutateAsync(filtered);
        queryClient.setQueryData(queryKey, next);
        setSaveStatus("saved");
        savedTimer.current = setTimeout(() => setSaveStatus("idle"), 3_000);
        logInfo(scope, "Device settings saved", { changedFields });
        return true;
      } catch (error) {
        const message = deviceErrorMessage(error, "Couldn’t save these settings.");
        logError(scope, "Failed to save device settings", error, {
          changedFields,
        });
        setSaveError(message);
        setSaveStatus("error");
        return false;
      }
    },
    [capabilities, client, mutation, queryClient, queryKey, scope],
  );

  const clearSaveState = useCallback(() => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setSaveStatus("idle");
    setSaveError(null);
  }, []);

  return {
    settings: query.data?.settings ?? null,
    capabilities,
    isLoading: client !== null && query.isLoading,
    loadError: query.isError
      ? deviceErrorMessage(query.error, "Couldn’t load these settings.")
      : null,
    reload: () => void query.refetch(),
    restartRequired: query.data?.settings.restart_required === true,
    saveStatus,
    saveError,
    save,
    clearSaveState,
  };
}
