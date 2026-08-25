"use client";

import { StatusChip, type StatusTone } from "@/components/Status";
import { useAssistantStatus, type AssistantStatus } from "@/components/AiMicChat";
import settings from "../../settings.module.css";
import styles from "./services.module.css";

type ServiceState = {
  name: string;
  detail: string;
  ready: (status: AssistantStatus) => boolean;
};

const SERVICES: readonly ServiceState[] = [
  {
    name: "Assistant",
    detail: "Language-model requests and tool orchestration",
    ready: (status) => status.assistant,
  },
  {
    name: "Web search",
    detail: "Current results through the server search profile",
    ready: (status) => status.tools.some((tool) => tool.name === "web_search" && tool.live),
  },
  {
    name: "Maps & places",
    detail: "Nearby search, reverse geocoding and directions",
    ready: (status) => status.tools.some((tool) => tool.name === "nearby" && tool.live),
  },
  {
    name: "Speech",
    detail: "Cloud transcription and spoken responses",
    ready: (status) => status.speech,
  },
];

function chip(status: AssistantStatus | undefined, ready: boolean): {
  tone: StatusTone;
  label: string;
} {
  if (!status || status.model === "unreachable") {
    return { tone: "degraded", label: "Unavailable" };
  }
  return ready
    ? { tone: "live", label: "Ready" }
    : { tone: "off", label: "Needs setup" };
}

export function CosmosServicesCard() {
  const { data: status } = useAssistantStatus();
  const cosmos = status?.provider_authority === "cosmos";
  const overall = chip(status, Boolean(cosmos && SERVICES.every((service) => service.ready(status!))));

  return (
    <section className={settings.section} data-testid="cosmos-services-card">
      <div className={settings.sectionHeader}>
        <span className={settings.sectionTitle}>Cosmos</span>
      </div>

      <div className={styles.serviceHead}>
        <span className={styles.cosmosMark} aria-hidden="true">✦</span>
        <span className={styles.serviceCopy}>
          <strong>Server services</strong>
          <span>Assistant, search, maps and speech run on your Cosmos server.</span>
        </span>
        <StatusChip tone={overall.tone} label={overall.label} />
      </div>

      <div className={styles.settingsForm}>
        {SERVICES.map((service) => {
          const state = chip(status, Boolean(cosmos && status && service.ready(status)));
          return (
            <div className={styles.settingRow} key={service.name}>
              <span>
                <strong>{service.name}</strong>
                <small>{service.detail}</small>
              </span>
              <StatusChip tone={state.tone} label={state.label} />
            </div>
          );
        })}
      </div>

      <div className={styles.providerNote}>
        <strong>One provider authority</strong>
        <span>
          Provider credentials remain in the server&rsquo;s external configuration. Your Ai Pin
          receives only the Cosmos endpoint, trust root and its own device identity when it is
          activated; no search, maps, assistant or speech key is copied to the device.
        </span>
      </div>
    </section>
  );
}
