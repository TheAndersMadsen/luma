import { StatusMessage } from "@/components/Status";
import { formatActivityTimestamp } from "../_lib/activityTimestamp";
import { PaneSection } from "../_lib/PaneShell";
import type { ProviderHealthSummary } from "../_lib/providerHealth";
import styles from "../_lib/panes.module.css";

export function AssistantStatusSection({
  health,
  formDiffersFromSaved,
  recentActivityError,
}: {
  health: ProviderHealthSummary;
  formDiffersFromSaved: boolean;
  recentActivityError: string | null;
}) {
  return (
    <PaneSection title="Assistant status" testId="pin-llm-health">
      <div className={styles.formRow}>
        <p className={styles.formHelp}>
          Based on saved settings and recent activity from this Pin.
        </p>
        <StatusMessage tone={health.tone}>
          <strong>{health.headline}</strong>
          <br />
          {health.detail}
          {health.evidenceAt && health.verdict === "failing" ? (
            <>
              <br />
              Last failure {formatActivityTimestamp(health.evidenceAt)}.
            </>
          ) : null}
          <br />
          <strong>Action:</strong> {health.nextStep}
        </StatusMessage>
      </div>

      <details className={styles.advancedSettings}>
        <summary>Connection details</summary>
        <div className={styles.advancedSettingsBody}>
          <dl className={styles.factList}>
            <dt>Service</dt>
            <dd>{health.configured.providerLabel}</dd>
            <dt>Model</dt>
            <dd>{health.configured.effectiveModel ?? "None"}</dd>
            <dt>Route</dt>
            <dd>{health.configured.routedThrough}</dd>
            <dt>Credentials</dt>
            <dd>
              {health.configured.credentialRequirement}{" "}
              {health.configured.credentialPresent === true
                ? "Stored on Pin."
                : health.configured.credentialPresent === false
                  ? "Not stored."
                  : "Status unavailable."}
            </dd>
            {health.bridge ? (
              <>
                <dt>Codex connection</dt>
                <dd>
                  {health.bridge.label}. {health.bridge.detail}
                </dd>
              </>
            ) : null}
          </dl>

          {formDiffersFromSaved ? (
            <p className={styles.formHelp}>Status reflects the saved settings.</p>
          ) : null}

          {recentActivityError ? (
            <p className={styles.formHelp}>{recentActivityError}</p>
          ) : null}
        </div>
      </details>
    </PaneSection>
  );
}
