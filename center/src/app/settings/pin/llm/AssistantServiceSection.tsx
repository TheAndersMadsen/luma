import { useId } from "react";

import { SecretField } from "../_lib/SecretField";
import { FormRow, PaneSection, ToggleRow } from "../_lib/PaneShell";
import { LLM_PROVIDERS } from "../_lib/providerHealth";
import type { SettingsCapabilities } from "../_lib/settingsResponse";
import styles from "../_lib/panes.module.css";

const MODEL_SUGGESTIONS: Record<string, string[]> = {
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  openai: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
  anthropic: ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"],
  "openai-compatible": ["qwen3.7-max", "qwen3-max", "qwen3-coder-plus", "glm-5.2"],
  codex: ["gpt-5.6-sol"],
};

const MODEL_PLACEHOLDERS: Record<string, string> = {
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  "openai-compatible": "qwen3.7-max",
  codex: "gpt-5.6-sol",
};

const CUE_MODEL_PLACEHOLDERS: Record<string, string> = {
  codex: "gpt-5.3-codex-spark",
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-20250514",
  "openai-compatible": "",
};

export function AssistantServiceSection({
  provider,
  model,
  apiKey,
  baseUrl,
  progressCueModel,
  geminiGoogleSearch,
  capabilities,
  hasSavedApiKey,
  onProviderChange,
  onModelChange,
  onApiKeyChange,
  onBaseUrlChange,
  onProgressCueModelChange,
  onGeminiGoogleSearchChange,
}: {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  progressCueModel: string;
  geminiGoogleSearch: boolean;
  capabilities: SettingsCapabilities;
  hasSavedApiKey: boolean;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onProgressCueModelChange: (value: string) => void;
  onGeminiGoogleSearchChange: (value: boolean) => void;
}) {
  const providerId = useId();
  const modelId = useId();
  const cueModelId = useId();
  const baseUrlId = useId();
  const availableProviders = LLM_PROVIDERS.filter(
    (candidate) => candidate.value !== "codex" || capabilities.codex,
  );
  const showBaseUrl =
    provider === "openai-compatible" || (provider !== "codex" && baseUrl !== "");
  const showModel = provider !== "echo";
  const showApiKey = provider !== "echo" && provider !== "codex";

  return (
    <PaneSection title="Assistant service" testId="pin-llm-provider">
      <FormRow label="Service" htmlFor={providerId}>
        <select
          id={providerId}
          className={styles.select}
          value={provider}
          onChange={(event) => onProviderChange(event.target.value)}
        >
          {availableProviders.map((candidate) => (
            <option key={candidate.value} value={candidate.value}>
              {candidate.label}
            </option>
          ))}
        </select>
      </FormRow>

      {showModel ? (
        <FormRow label="Model" htmlFor={modelId}>
          <input
            id={modelId}
            className={styles.input}
            type="text"
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
            placeholder={MODEL_PLACEHOLDERS[provider] ?? "model-name"}
            list="pin-model-suggestions"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <datalist id="pin-model-suggestions">
            {(MODEL_SUGGESTIONS[provider] ?? []).map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        </FormRow>
      ) : null}

      {showModel && capabilities.progressCueModel ? (
        <FormRow
          label="Progress messages"
          htmlFor={cueModelId}
          help="Optional faster model for short status messages. Leave empty to use the main model."
        >
          <input
            id={cueModelId}
            className={styles.input}
            type="text"
            value={progressCueModel}
            onChange={(event) => onProgressCueModelChange(event.target.value)}
            placeholder={CUE_MODEL_PLACEHOLDERS[provider] ?? "fast-model"}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </FormRow>
      ) : null}

      {provider === "gemini" ? (
        <FormRow label="Google Search">
          <ToggleRow
            ariaLabel="Allow Gemini to use Google Search"
            copy="Let Gemini use Google Search. Google may charge for this usage."
            checked={geminiGoogleSearch}
            onChange={onGeminiGoogleSearchChange}
          />
        </FormRow>
      ) : null}

      {showApiKey ? (
        <FormRow label="API key" help="Stored on the Pin and never shown after saving.">
          <SecretField
            value={apiKey}
            onChange={onApiKeyChange}
            hasExisting={hasSavedApiKey}
            ariaLabel="Provider API key"
          />
        </FormRow>
      ) : null}

      {showBaseUrl ? (
        <FormRow label="Base URL" htmlFor={baseUrlId}>
          <input
            id={baseUrlId}
            className={styles.input}
            type="text"
            value={baseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            placeholder="https://api.example.com/v1"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </FormRow>
      ) : null}
    </PaneSection>
  );
}
