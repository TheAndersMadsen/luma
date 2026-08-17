"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  CodexDeviceCodeLoginResponse,
  CodexStatusResponse,
  UpdateSettingsRequest,
} from "@/lib/pin-device";
import { logError, logInfo } from "@/lib/pin-device";
import { StatusMessage } from "@/components/Status";
import settings from "../../settings.module.css";
import styles from "../_lib/panes.module.css";
import {
  DeviceRequired,
  PaneLoadState,
  SaveBar,
} from "../_lib/PaneShell";
import { UnsavedChangesGuard } from "../_lib/UnsavedChangesGuard";
import { usePinPaneSession } from "../_lib/pinSession";
import { PIN_QUERY_KEY } from "../PinDeviceProvider";
import { useDeviceSettings } from "../_lib/useDeviceSettings";
import {
  UNCHANGED_SECRET_EDIT,
  secretEditRequestValue,
  type SecretEdit,
} from "../_lib/settingsFormState";
import {
  validateCodexBridgeUrl,
  validatePublicCaPem,
} from "../_lib/codexBridgeSecurity";
import { summarizeProviderHealth } from "../_lib/providerHealth";
import { AssistantStatusSection } from "./AssistantStatusSection";
import { AssistantServiceSection } from "./AssistantServiceSection";
import {
  CodexSection,
  DEFAULT_CODEX_BRIDGE_URL,
  DEFAULT_CODEX_MODEL,
} from "./CodexSection";

/*
 * Assistant provider configuration — the bulk of "set up envs".
 *
 * Ported from the retired Setup SPA's `SettingsPage.tsx:1060-1495` plus
 * pages/providerHealth.ts and pages/codexBridgeSecurity.ts.
 *
 * Two things deserve a note.
 *
 * (1) The provider-status panel is judged against the SAVED settings, never the
 *     dirty form. An unsaved provider change has not reached the Pin, so
 *     reporting on it would describe a configuration the device is not running.
 *     It reads the last PROVIDER_HEALTH_PROMPT_WINDOW recorded turns because
 *     that is the ONLY end-to-end evidence the Pin already persists — a failed
 *     turn is stored as the assistant reply. Nothing here issues a test model
 *     call, and the module has no "healthy" verdict for exactly that reason.
 *     This read survives the SPA's Prompts tab being dropped.
 *
 * (2) The Codex bridge URL / token / CA fields are RESTORED here. The SPA kept
 *     them in state and in its request builder but never rendered an input for
 *     them, which made `describeCodexBridge`'s own remedy ("Set the Codex
 *     bridge URL and token below, then save") impossible to follow and left
 *     codexBridgeSecurity.ts validating nothing. They are gated on the server
 *     advertising the leaves, and both validators run before the save leaves
 *     the browser.
 */

/** Recent turns are only read to look for a persisted provider error. */
const PROVIDER_HEALTH_PROMPT_WINDOW = 5;

const SECRET_PATTERN = /^[\x21-\x7e]{32,512}$/;
const SCOPE = "pin-llm-pane";

export default function PinLlmPane() {
  const { client, connectionError, attachedWithoutServer } = usePinPaneSession();
  const controller = useDeviceSettings(SCOPE);
  const { settings: saved, capabilities } = controller;

  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [geminiGoogleSearch, setGeminiGoogleSearch] = useState(false);
  const [progressCueModel, setProgressCueModel] = useState("");
  const [codexBridgeUrl, setCodexBridgeUrl] = useState(DEFAULT_CODEX_BRIDGE_URL);
  const [codexBridgeTokenEdit, setCodexBridgeTokenEdit] =
    useState<SecretEdit>(UNCHANGED_SECRET_EDIT);
  const [codexBridgeCaEdit, setCodexBridgeCaEdit] =
    useState<SecretEdit>(UNCHANGED_SECRET_EDIT);
  const [codexProviderBaseUrl, setCodexProviderBaseUrl] = useState("");
  const [codexProviderModel, setCodexProviderModel] = useState("");
  const [codexProviderName, setCodexProviderName] = useState("");
  const [codexProviderWireApi, setCodexProviderWireApi] = useState("");
  const [codexProviderCueModel, setCodexProviderCueModel] = useState("");
  const [codexModelCatalogPath, setCodexModelCatalogPath] = useState("");
  const [codexProviderApiKeyEdit, setCodexProviderApiKeyEdit] =
    useState<SecretEdit>(UNCHANGED_SECRET_EDIT);

  const [codexStatus, setCodexStatus] = useState<CodexStatusResponse | null>(null);
  const [codexDeviceCode, setCodexDeviceCode] =
    useState<CodexDeviceCodeLoginResponse | null>(null);
  const [codexAction, setCodexAction] = useState<"idle" | "checking" | "signing-in">(
    "idle",
  );
  const [codexActionError, setCodexActionError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    setProvider(saved.llm.provider);
    setModel(saved.llm.model);
    setApiKey("");
    setBaseUrl(saved.llm.base_url ?? "");
    setGeminiGoogleSearch(saved.llm.gemini_google_search ?? false);
    setProgressCueModel(saved.llm.progress_cue_model?.trim() || "");
    setCodexBridgeUrl(saved.llm.codex_bridge_url?.trim() || DEFAULT_CODEX_BRIDGE_URL);
    setCodexBridgeTokenEdit(UNCHANGED_SECRET_EDIT);
    setCodexBridgeCaEdit(UNCHANGED_SECRET_EDIT);
    setCodexProviderBaseUrl(saved.llm.codex_provider_base_url?.trim() || "");
    setCodexProviderModel(saved.llm.codex_model?.trim() || "");
    setCodexProviderName(saved.llm.codex_provider_name?.trim() || "");
    setCodexProviderWireApi(saved.llm.codex_wire_api?.trim() || "");
    setCodexProviderCueModel(saved.llm.codex_cue_model?.trim() || "");
    setCodexModelCatalogPath(saved.llm.codex_model_catalog_path?.trim() || "");
    setCodexProviderApiKeyEdit(UNCHANGED_SECRET_EDIT);
    setCodexDeviceCode(null);
    setCodexActionError(null);
    setValidationError(null);
  }, [saved]);

  /*
   * The one end-to-end signal the Pin already persists. Never blocks the form:
   * a failure here leaves the panel saying "not read" rather than "no failures
   * found", which are different sentences.
   */
  const recentPromptsQuery = useQuery({
    queryKey: [PIN_QUERY_KEY, "provider-health", saved?.llm.provider ?? null],
    enabled: client !== null && saved !== null,
    retry: false,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      if (!client) throw new Error("No Pin is connected.");
      const page = await client.listActivity(
        "prompts",
        { limit: PROVIDER_HEALTH_PROMPT_WINDOW },
        signal,
      );
      return page.items;
    },
  });

  const checkCodexStatus = useCallback(
    async (signal?: AbortSignal) => {
      if (!client) return null;
      return client.getCodexStatus(signal);
    },
    [client],
  );

  // Auto-probe the bridge for a saved Codex provider, so the default reading is
  // not "Status not checked" while the bridge is the thing at fault.
  useEffect(() => {
    if (!client || !capabilities.codex) return;
    if (saved?.llm.provider !== "codex") return;
    const controllerSignal = new AbortController();
    void checkCodexStatus(controllerSignal.signal)
      .then((status) => {
        if (status) setCodexStatus(status);
      })
      .catch(() => {
        // A manual "Check status" surfaces the error text. A background probe
        // must not overwrite the panel with a Center-side message.
      });
    return () => controllerSignal.abort();
  }, [capabilities.codex, checkCodexStatus, client, saved]);

  // While a device-code sign-in is open, poll until Codex has persisted the
  // account record. A pending exchange can be briefly unavailable, so failures
  // are swallowed rather than ending the flow.
  useEffect(() => {
    if (!client || !codexDeviceCode) return;
    let cancelled = false;
    let inFlight = false;

    const refresh = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const status = await client.getCodexStatus();
        if (cancelled) return;
        setCodexStatus(status);
        if (status.ready) {
          setCodexDeviceCode(null);
          logInfo(SCOPE, "On-device Codex sign-in completed");
        }
      } catch {
        // Keep polling.
      } finally {
        inFlight = false;
      }
    };

    const timer = globalThis.setInterval(() => void refresh(), 3_000);
    return () => {
      cancelled = true;
      globalThis.clearInterval(timer);
    };
  }, [client, codexDeviceCode]);

  const isOriginalProvider = saved != null && provider === saved.llm.provider;

  const request = useMemo<UpdateSettingsRequest | null>(() => {
    if (!saved) return null;
    const llm: NonNullable<UpdateSettingsRequest["llm"]> = {};

    if (provider !== saved.llm.provider) llm.provider = provider;
    if (model !== saved.llm.model) llm.model = model;
    if (apiKey !== "") llm.api_key = apiKey;
    if (baseUrl !== (saved.llm.base_url ?? "")) llm.base_url = baseUrl;
    if (geminiGoogleSearch !== (saved.llm.gemini_google_search ?? false)) {
      llm.gemini_google_search = geminiGoogleSearch;
    }
    if (progressCueModel !== (saved.llm.progress_cue_model?.trim() || "")) {
      llm.progress_cue_model = progressCueModel;
    }
    if (
      codexBridgeUrl !==
      (saved.llm.codex_bridge_url?.trim() || DEFAULT_CODEX_BRIDGE_URL)
    ) {
      llm.codex_bridge_url = codexBridgeUrl;
    }
    const bridgeToken = secretEditRequestValue(codexBridgeTokenEdit);
    if (bridgeToken !== undefined) llm.codex_bridge_token = bridgeToken;
    const bridgeCa = secretEditRequestValue(codexBridgeCaEdit);
    if (bridgeCa !== undefined) llm.codex_bridge_ca_pem = bridgeCa;
    if (codexProviderBaseUrl !== (saved.llm.codex_provider_base_url?.trim() || "")) {
      llm.codex_provider_base_url = codexProviderBaseUrl;
    }
    if (codexProviderModel !== (saved.llm.codex_model?.trim() || "")) {
      llm.codex_model = codexProviderModel;
    }
    if (codexProviderName !== (saved.llm.codex_provider_name?.trim() || "")) {
      llm.codex_provider_name = codexProviderName;
    }
    if (codexProviderWireApi !== (saved.llm.codex_wire_api?.trim() || "")) {
      llm.codex_wire_api = codexProviderWireApi;
    }
    if (codexProviderCueModel !== (saved.llm.codex_cue_model?.trim() || "")) {
      llm.codex_cue_model = codexProviderCueModel;
    }
    if (
      codexModelCatalogPath !== (saved.llm.codex_model_catalog_path?.trim() || "")
    ) {
      llm.codex_model_catalog_path = codexModelCatalogPath;
    }
    const codexApiKey = secretEditRequestValue(codexProviderApiKeyEdit);
    if (codexApiKey !== undefined) llm.codex_api_key = codexApiKey;

    return Object.keys(llm).length > 0 ? { llm } : null;
  }, [
    apiKey,
    baseUrl,
    codexBridgeCaEdit,
    codexBridgeTokenEdit,
    codexBridgeUrl,
    codexModelCatalogPath,
    codexProviderApiKeyEdit,
    codexProviderBaseUrl,
    codexProviderCueModel,
    codexProviderModel,
    codexProviderName,
    codexProviderWireApi,
    geminiGoogleSearch,
    model,
    progressCueModel,
    provider,
    saved,
  ]);

  function handleProviderChange(next: string) {
    setProvider(next);
    setApiKey("");
    setCodexBridgeTokenEdit(UNCHANGED_SECRET_EDIT);
    if (next === "echo") {
      setModel("");
    } else if (next === "codex" && next !== saved?.llm.provider) {
      setModel(DEFAULT_CODEX_MODEL);
    } else if (saved) {
      setModel(next === saved.llm.provider ? saved.llm.model : "");
    }
    if (saved) {
      setBaseUrl(next === saved.llm.provider ? (saved.llm.base_url ?? "") : "");
      setGeminiGoogleSearch(
        next === "gemini" && next === saved.llm.provider
          ? (saved.llm.gemini_google_search ?? false)
          : false,
      );
    } else {
      setBaseUrl("");
      setGeminiGoogleSearch(false);
    }
  }

  async function handleSave() {
    if (!request?.llm) return;
    const llm = request.llm;

    if (
      llm.codex_bridge_token !== undefined &&
      llm.codex_bridge_token !== "" &&
      !SECRET_PATTERN.test(llm.codex_bridge_token)
    ) {
      setValidationError(
        "The Codex bridge token must be 32–512 visible ASCII characters with no spaces.",
      );
      return;
    }
    if (llm.codex_bridge_url !== undefined) {
      const bridgeUrlError = validateCodexBridgeUrl(llm.codex_bridge_url.trim());
      if (bridgeUrlError) {
        setValidationError(bridgeUrlError);
        return;
      }
    }
    if (llm.codex_bridge_ca_pem !== undefined && llm.codex_bridge_ca_pem !== "") {
      const caError = validatePublicCaPem(llm.codex_bridge_ca_pem);
      if (caError) {
        setValidationError(caError);
        return;
      }
    }

    setValidationError(null);
    if (await controller.save(request)) {
      void recentPromptsQuery.refetch();
    }
  }

  async function handleCheckCodexStatus() {
    if (!client || !capabilities.codex || codexAction !== "idle") return;
    setCodexAction("checking");
    setCodexActionError(null);
    setCodexDeviceCode(null);
    try {
      const status = await client.getCodexStatus();
      setCodexStatus(status);
      logInfo(SCOPE, "Codex runtime status checked", { state: status.state });
    } catch (error) {
      setCodexActionError("Could not check the on-device Codex runtime.");
      logError(SCOPE, "Codex runtime status check failed", error);
    } finally {
      setCodexAction("idle");
    }
  }

  async function handleStartCodexSignIn() {
    if (!client || !capabilities.codex || codexAction !== "idle") return;
    setCodexAction("signing-in");
    setCodexActionError(null);
    setCodexDeviceCode(null);
    try {
      const deviceCode = await client.startCodexDeviceCodeLogin();
      setCodexDeviceCode(deviceCode);
      setCodexStatus(null);
      logInfo(SCOPE, "Codex device sign-in started");
    } catch (error) {
      setCodexActionError("Could not start on-device ChatGPT sign-in.");
      logError(SCOPE, "Codex device sign-in failed", error);
    } finally {
      setCodexAction("idle");
    }
  }

  if (!client) {
    return (
      <DeviceRequired
        attachedWithoutServer={attachedWithoutServer}
        what="this Pin's assistant provider"
        connectionError={connectionError}
      />
    );
  }

  if (!saved) {
    return (
      <PaneLoadState
        error={controller.loadError}
        onRetry={controller.reload}
        rows={6}
      />
    );
  }

  const saving = controller.saveStatus === "saving";
  const showCodexBridge = capabilities.codex && provider === "codex";

  const codexBridgeSettingsDirty =
    codexBridgeUrl !== (saved.llm.codex_bridge_url?.trim() || DEFAULT_CODEX_BRIDGE_URL) ||
    codexBridgeTokenEdit.kind !== "unchanged" ||
    codexBridgeCaEdit.kind !== "unchanged" ||
    codexProviderBaseUrl !== (saved.llm.codex_provider_base_url?.trim() || "") ||
    codexProviderModel !== (saved.llm.codex_model?.trim() || "") ||
    codexProviderName !== (saved.llm.codex_provider_name?.trim() || "") ||
    codexProviderWireApi !== (saved.llm.codex_wire_api?.trim() || "") ||
    codexProviderCueModel !== (saved.llm.codex_cue_model?.trim() || "") ||
    codexModelCatalogPath !== (saved.llm.codex_model_catalog_path?.trim() || "") ||
    codexProviderApiKeyEdit.kind !== "unchanged";

  const providerHealth = summarizeProviderHealth({
    settings: saved,
    codexStatus,
    recentPrompts: recentPromptsQuery.data ?? null,
  });
  const formDiffersFromSaved =
    provider !== saved.llm.provider || model !== saved.llm.model;
  const recentPromptsError =
    recentPromptsQuery.isError
      ? "Recent activity couldn’t be checked."
      : null;

  return (
    <>
      <SaveBar
        status={controller.saveStatus}
        error={validationError ?? controller.saveError}
        dirty={request !== null}
        onSave={() => void handleSave()}
      />

      {validationError ? (
        <StatusMessage tone="danger">{validationError}</StatusMessage>
      ) : null}

      <AssistantStatusSection
        health={providerHealth}
        formDiffersFromSaved={formDiffersFromSaved}
        recentActivityError={recentPromptsError}
      />

      <fieldset
        className={styles.fieldset}
        disabled={saving}
        aria-busy={saving}
      >
        <AssistantServiceSection
          provider={provider}
          model={model}
          apiKey={apiKey}
          baseUrl={baseUrl}
          progressCueModel={progressCueModel}
          geminiGoogleSearch={geminiGoogleSearch}
          capabilities={capabilities}
          hasSavedApiKey={isOriginalProvider && saved.llm.has_api_key}
          onProviderChange={handleProviderChange}
          onModelChange={setModel}
          onApiKeyChange={setApiKey}
          onBaseUrlChange={setBaseUrl}
          onProgressCueModelChange={setProgressCueModel}
          onGeminiGoogleSearchChange={setGeminiGoogleSearch}
        />

        {showCodexBridge ? (
          <CodexSection
            saved={saved}
            capabilities={capabilities}
            status={codexStatus}
            deviceCode={codexDeviceCode}
            action={codexAction}
            actionError={codexActionError}
            settingsDirty={codexBridgeSettingsDirty}
            bridgeUrl={codexBridgeUrl}
            bridgeTokenEdit={codexBridgeTokenEdit}
            bridgeCaEdit={codexBridgeCaEdit}
            providerBaseUrl={codexProviderBaseUrl}
            providerModel={codexProviderModel}
            providerName={codexProviderName}
            providerWireApi={codexProviderWireApi}
            providerCueModel={codexProviderCueModel}
            modelCatalogPath={codexModelCatalogPath}
            providerApiKeyEdit={codexProviderApiKeyEdit}
            onCheckStatus={() => void handleCheckCodexStatus()}
            onStartSignIn={() => void handleStartCodexSignIn()}
            onBridgeUrlChange={setCodexBridgeUrl}
            onBridgeTokenEditChange={setCodexBridgeTokenEdit}
            onBridgeCaEditChange={setCodexBridgeCaEdit}
            onProviderBaseUrlChange={setCodexProviderBaseUrl}
            onProviderModelChange={setCodexProviderModel}
            onProviderNameChange={setCodexProviderName}
            onProviderWireApiChange={setCodexProviderWireApi}
            onProviderCueModelChange={setCodexProviderCueModel}
            onModelCatalogPathChange={setCodexModelCatalogPath}
            onProviderApiKeyEditChange={setCodexProviderApiKeyEdit}
          />
        ) : null}
      </fieldset>

      <section className={settings.section}>
        <div className={settings.additionRow}>
          <span className={settings.additionRowText}>
            <span className={settings.additionRowTitle}>Service keys</span>
            <span className={settings.additionRowDesc}>
              Weather, maps, speech and food-data credentials live on their own pane.
            </span>
          </span>
          <Link className={settings.additionLink} href="/settings/pin/services">
            Open
          </Link>
        </div>
      </section>

      <UnsavedChangesGuard when={request !== null} />
    </>
  );
}
