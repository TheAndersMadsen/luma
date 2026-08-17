import { useId } from "react";

import type {
  CodexDeviceCodeLoginResponse,
  CodexStatusResponse,
} from "@/lib/pin-device";
import { StatusMessage } from "@/components/Status";
import { FormRow, PaneSection } from "../_lib/PaneShell";
import { SecretField } from "../_lib/SecretField";
import {
  UNCHANGED_SECRET_EDIT,
  secretEditFromInput,
  secretEditInputValue,
  type SecretEdit,
} from "../_lib/settingsFormState";
import { describeCodexBridge } from "../_lib/providerHealth";
import type {
  NormalizedSettings,
  SettingsCapabilities,
} from "../_lib/settingsResponse";
import styles from "../_lib/panes.module.css";

export const DEFAULT_CODEX_BRIDGE_URL = "http://127.0.0.1:8765";
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

export function CodexSection({
  saved,
  capabilities,
  status,
  deviceCode,
  action,
  actionError,
  settingsDirty,
  bridgeUrl,
  bridgeTokenEdit,
  bridgeCaEdit,
  providerBaseUrl,
  providerModel,
  providerName,
  providerWireApi,
  providerCueModel,
  modelCatalogPath,
  providerApiKeyEdit,
  onCheckStatus,
  onStartSignIn,
  onBridgeUrlChange,
  onBridgeTokenEditChange,
  onBridgeCaEditChange,
  onProviderBaseUrlChange,
  onProviderModelChange,
  onProviderNameChange,
  onProviderWireApiChange,
  onProviderCueModelChange,
  onModelCatalogPathChange,
  onProviderApiKeyEditChange,
}: {
  saved: NormalizedSettings;
  capabilities: SettingsCapabilities;
  status: CodexStatusResponse | null;
  deviceCode: CodexDeviceCodeLoginResponse | null;
  action: "idle" | "checking" | "signing-in";
  actionError: string | null;
  settingsDirty: boolean;
  bridgeUrl: string;
  bridgeTokenEdit: SecretEdit;
  bridgeCaEdit: SecretEdit;
  providerBaseUrl: string;
  providerModel: string;
  providerName: string;
  providerWireApi: string;
  providerCueModel: string;
  modelCatalogPath: string;
  providerApiKeyEdit: SecretEdit;
  onCheckStatus: () => void;
  onStartSignIn: () => void;
  onBridgeUrlChange: (value: string) => void;
  onBridgeTokenEditChange: (value: SecretEdit) => void;
  onBridgeCaEditChange: (value: SecretEdit) => void;
  onProviderBaseUrlChange: (value: string) => void;
  onProviderModelChange: (value: string) => void;
  onProviderNameChange: (value: string) => void;
  onProviderWireApiChange: (value: string) => void;
  onProviderCueModelChange: (value: string) => void;
  onModelCatalogPathChange: (value: string) => void;
  onProviderApiKeyEditChange: (value: SecretEdit) => void;
}) {
  const bridgeUrlId = useId();
  const bridgeCaId = useId();
  const providerBaseUrlId = useId();
  const providerModelId = useId();
  const providerNameId = useId();
  const providerWireApiId = useId();
  const providerCueModelId = useId();
  const catalogId = useId();
  const description = describeCodexBridge(status, {
    customProviderActive: saved.llm.codex_custom_active === true,
  });

  return (
    <PaneSection title="On-device Codex" testId="pin-llm-codex">
      <div className={styles.formRow}>
        <p className={styles.formHelp}>
          Sign in once with ChatGPT. Your Pin keeps the sign-in and can use Codex
          without a companion computer.
        </p>
      </div>

      <FormRow label="ChatGPT sign-in">
        <div className={styles.actionRow}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onCheckStatus}
            disabled={action !== "idle" || settingsDirty}
          >
            {action === "checking" ? "Checking…" : "Check status"}
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onStartSignIn}
            disabled={action !== "idle" || settingsDirty}
          >
            {action === "signing-in" ? "Starting…" : "Start ChatGPT sign-in"}
          </button>
        </div>
        <p className={styles.formHelp} aria-live="polite">
          {description.label}. {description.detail}
          {settingsDirty ? " Save settings before checking." : ""}
        </p>
        {deviceCode ? (
          <div className={styles.subpanelRow} aria-live="polite">
            <span className={styles.subpanelTitle}>Complete ChatGPT sign-in</span>
            <p className={styles.formHelp}>
              Open the sign-in page and enter code <code>{deviceCode.user_code}</code>.
            </p>
            <a
              className={styles.quietButton}
              href={deviceCode.verification_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open ChatGPT sign-in
            </a>
          </div>
        ) : null}
        {actionError ? <StatusMessage tone="danger">{actionError}</StatusMessage> : null}
      </FormRow>

      <details className={styles.advancedSettings}>
        <summary>Advanced connection settings</summary>
        <div className={styles.advancedSettingsBody}>
          <FormRow
            label="Bridge URL"
            htmlFor={bridgeUrlId}
            help="Address used by the Pin to reach Codex."
          >
            <input
              id={bridgeUrlId}
              className={styles.input}
              type="text"
              value={bridgeUrl}
              onChange={(event) => onBridgeUrlChange(event.target.value)}
              placeholder={DEFAULT_CODEX_BRIDGE_URL}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </FormRow>

          <FormRow label="Bridge token" help="Must match the token used by the Codex connection.">
            <SecretField
              value={secretEditInputValue(bridgeTokenEdit)}
              onChange={(value) => onBridgeTokenEditChange(secretEditFromInput(value))}
              hasExisting={saved.llm.has_codex_bridge_token === true}
              placeholder="Enter the Codex bridge token"
              ariaLabel="Codex bridge token"
            />
            {saved.llm.has_codex_bridge_token === true && bridgeTokenEdit.kind !== "clear" ? (
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => onBridgeTokenEditChange({ kind: "clear" })}
              >
                Clear stored token
              </button>
            ) : null}
            {bridgeTokenEdit.kind === "clear" ? (
              <div className={styles.actionRow}>
                <span className={styles.formHelp}>
                  The stored bridge token will be cleared when you save.
                </span>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => onBridgeTokenEditChange(UNCHANGED_SECRET_EDIT)}
                >
                  Undo
                </button>
              </div>
            ) : null}
          </FormRow>

          {capabilities.codexCustomCa ? (
            <FormRow
              label="Bridge CA certificate"
              htmlFor={bridgeCaId}
              help="Optional certificate for a private HTTPS connection."
            >
              <textarea
                id={bridgeCaId}
                className={styles.textarea}
                rows={6}
                value={secretEditInputValue(bridgeCaEdit)}
                onChange={(event) =>
                  onBridgeCaEditChange(secretEditFromInput(event.target.value))
                }
                placeholder={
                  saved.llm.has_codex_bridge_ca
                    ? "A certificate is stored. Paste a replacement, or clear it below."
                    : "-----BEGIN CERTIFICATE-----"
                }
                spellCheck={false}
              />
              {saved.llm.has_codex_bridge_ca && bridgeCaEdit.kind !== "clear" ? (
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => onBridgeCaEditChange({ kind: "clear" })}
                >
                  Clear stored certificate
                </button>
              ) : null}
              {bridgeCaEdit.kind === "clear" ? (
                <div className={styles.actionRow}>
                  <span className={styles.formHelp}>
                    The stored certificate will be cleared when you save.
                  </span>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => onBridgeCaEditChange(UNCHANGED_SECRET_EDIT)}
                  >
                    Undo
                  </button>
                </div>
              ) : null}
            </FormRow>
          ) : null}

          {capabilities.codexCustomProvider ? (
            <>
              <FormRow
                label="Provider base URL"
                htmlFor={providerBaseUrlId}
                help="Address of an OpenAI-compatible service."
              >
                <input
                  id={providerBaseUrlId}
                  className={styles.input}
                  type="text"
                  value={providerBaseUrl}
                  onChange={(event) => onProviderBaseUrlChange(event.target.value)}
                  placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </FormRow>

              <FormRow
                label="Model name"
                htmlFor={providerModelId}
                help="Exact model identifier used by the service."
              >
                <input
                  id={providerModelId}
                  className={styles.input}
                  type="text"
                  value={providerModel}
                  onChange={(event) => onProviderModelChange(event.target.value)}
                  placeholder="qwen-turbo"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </FormRow>

              <FormRow
                label="Provider name"
                htmlFor={providerNameId}
                help="Internal service name. Leave unchanged unless required."
              >
                <input
                  id={providerNameId}
                  className={styles.input}
                  type="text"
                  value={providerName}
                  onChange={(event) => onProviderNameChange(event.target.value)}
                  placeholder="dashscope"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </FormRow>

              <FormRow label="Wire API" htmlFor={providerWireApiId} help='Use "responses" unless the service requires "chat".'>
                <input
                  id={providerWireApiId}
                  className={styles.input}
                  type="text"
                  value={providerWireApi}
                  onChange={(event) => onProviderWireApiChange(event.target.value)}
                  placeholder="responses"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </FormRow>

              <FormRow
                label="Progress model"
                htmlFor={providerCueModelId}
                help="Optional model for short status messages."
              >
                <input
                  id={providerCueModelId}
                  className={styles.input}
                  type="text"
                  value={providerCueModel}
                  onChange={(event) => onProviderCueModelChange(event.target.value)}
                  placeholder="(falls back to model name)"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </FormRow>

              <FormRow
                label="Model catalog path"
                htmlFor={catalogId}
                help="Optional on-device catalog file."
              >
                <input
                  id={catalogId}
                  className={styles.input}
                  type="text"
                  value={modelCatalogPath}
                  onChange={(event) => onModelCatalogPathChange(event.target.value)}
                  placeholder="/data/local/tmp/qwen-catalog.json"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </FormRow>

              <FormRow label="Provider API key" help="Stored on the Pin and never shown after saving.">
                <SecretField
                  value={secretEditInputValue(providerApiKeyEdit)}
                  onChange={(value) => onProviderApiKeyEditChange(secretEditFromInput(value))}
                  hasExisting={saved.llm.has_codex_api_key ?? false}
                  ariaLabel="Codex provider API key"
                />
              </FormRow>
            </>
          ) : null}
        </div>
      </details>
    </PaneSection>
  );
}
