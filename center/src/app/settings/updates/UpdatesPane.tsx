import settings from "../settings.module.css";
import styles from "./updates.module.css";
import controls from "@/components/controls.module.css";

import { CopyCommand } from "@/components/CopyCommand";
import { StatusMessage } from "@/components/Status";
import type { UpdateOverview } from "@/lib/contracts/updates";
import {
  AUTO_UPDATES_COMMAND,
  UPDATE_COMMAND,
  UPDATE_SOURCE_COMMAND,
  describeCheck,
  describeLastUpdate,
  describeNextStep,
  formatReleaseDate,
  formatReleaseMoment,
} from "@/lib/updatesPresentation";

function InfoRow({ title, value, detail, testId }: { title: string; value: React.ReactNode; detail?: React.ReactNode; testId?: string }) {
  return (
    <div className={settings.infoRowRoot}>
      <span className={settings.titleInfo}>{title}</span>
      <div className={settings.descWrapper}>
        <span className={settings.description} data-testid={testId}>{value}</span>
        {detail ? <span className={settings.muted}>{detail}</span> : null}
      </div>
    </div>
  );
}

/** Release notes are plain text from the release. Shown collapsed. */
function WhatsNew({ notes, testId }: { notes: string | null; testId: string }) {
  if (!notes?.trim()) return <span className={settings.muted}>No release notes.</span>;
  return (
    <details className={styles.notes} data-testid={testId}>
      <summary>What’s new</summary>
      <pre className={styles.notesBody}>{notes}</pre>
    </details>
  );
}

const TONE = { live: "info", info: "info", warning: "warning", danger: "danger" } as const;

/** The pane, from one server-resolved overview. Every field tolerates absence. */
export function UpdatesPane({ overview }: { overview: UpdateOverview }) {
  const { current, check, autoUpdates, source, lastUpdate } = overview;
  const published = formatReleaseDate(current.publishedAt);
  const checkSentence = describeCheck(check);
  const last = describeLastUpdate(lastUpdate);
  const checkedAt = "checkedAt" in check ? formatReleaseMoment(check.checkedAt) : null;

  return (
    <>
      <section className={settings.section} data-testid="updates-current">
        <div className={settings.sectionHeader}>
          <span className={settings.sectionTitle}>Luma on this server</span>
        </div>
        <InfoRow
          title="Version"
          testId="updates-current-version"
          value={current.version ? `Luma ${current.version}` : "Unknown"}
          detail={[current.tag, published ? `Published ${published}` : null].filter(Boolean).join(" · ") || "This server did not say when it was published."}
        />
        <InfoRow title="Release" value={current.release} detail="The exact build this Center runs." />
        {current.pinVersion ? (
          <InfoRow title="Pin apps" testId="updates-current-pin" value={current.pinVersion} detail="The Pin release this server offers to install." />
        ) : null}
        <div className={settings.infoRowRoot}>
          <span className={settings.titleInfo}>What’s new</span>
          <div className={settings.descWrapper}>
            <WhatsNew notes={current.notes} testId="updates-current-notes" />
          </div>
        </div>
      </section>

      <section className={settings.section} data-testid="updates-check">
        <div className={settings.sectionHeader}>
          <span className={settings.sectionTitle}>Updates</span>
          <form method="post" action="/api/admin/updates/check" className={styles.checkForm}>
            <button type="submit" className={controls.buttonSecondary} disabled={check.outcome === "source-unknown"}>
              Check now
            </button>
          </form>
        </div>
        <div className={styles.statusRow}>
          <StatusMessage tone={TONE[checkSentence.tone]} inline>
            <span data-testid="updates-check-sentence">{checkSentence.sentence}</span>
            {check.outcome === "update-available" && autoUpdates === "on" ? <> {describeNextStep(autoUpdates)}</> : null}
          </StatusMessage>
          {checkedAt ? <span className={settings.muted}>Last checked {checkedAt}.</span> : null}
        </div>
        {check.outcome === "update-available" && autoUpdates !== "on" ? (
          <div className={settings.infoRowRoot}>
            <span className={settings.titleInfo}>Install it</span>
            <div className={settings.descWrapper}>
              <CopyCommand command={UPDATE_COMMAND} label="update command" />
              <span className={settings.muted}>Run this on your server. Your Center may pause for a minute while it updates.</span>
            </div>
          </div>
        ) : null}
        {"latest" in check ? (
          <div className={settings.infoRowRoot}>
            <span className={settings.titleInfo}>Latest available</span>
            <div className={settings.descWrapper}>
              <span className={settings.description} data-testid="updates-latest-version">
                Luma {check.latest.version}
                {check.latest.pinVersion ? ` · Pin apps ${check.latest.pinVersion}` : ""}
              </span>
              {formatReleaseDate(check.latest.publishedAt) ? (
                <span className={settings.muted}>Published {formatReleaseDate(check.latest.publishedAt)}.</span>
              ) : null}
              <WhatsNew notes={check.latest.notes} testId="updates-latest-notes" />
            </div>
          </div>
        ) : null}
        <InfoRow
          title="Update source"
          testId="updates-source"
          value={source ?? "Not set"}
          detail={<>To change it, run <code className={styles.inlineCommand}>{UPDATE_SOURCE_COMMAND}</code> on your server.</>}
        />
        <InfoRow
          title="Automatic updates"
          testId="updates-auto"
          value={autoUpdates === "on" ? "On" : autoUpdates === "off" ? "Off" : "Unknown"}
          detail={
            <>
              {autoUpdates === "on"
                ? "New releases install themselves overnight. "
                : autoUpdates === "off"
                  ? "Updates wait for you to run them. "
                  : "This server did not say. "}
              To change it, run <code className={styles.inlineCommand}>{AUTO_UPDATES_COMMAND}</code> on your server.
            </>
          }
        />
      </section>

      <section className={settings.section} data-testid="updates-last">
        <div className={settings.sectionHeader}>
          <span className={settings.sectionTitle}>Last update</span>
        </div>
        <div className={styles.statusRow}>
          <StatusMessage tone={TONE[last.tone]} inline>
            <span data-testid="updates-last-sentence">{last.sentence}</span>
          </StatusMessage>
          {lastUpdate?.message ? <p className={settings.muted} data-testid="updates-last-message">{lastUpdate.message}</p> : null}
        </div>
      </section>
    </>
  );
}
