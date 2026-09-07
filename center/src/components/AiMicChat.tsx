"use client";

import { useQuery } from "@tanstack/react-query";
import { BrowserDisplay } from "./BrowserDisplay";
import { StatusChip } from "./Status";

/** Advisory provider readiness; all browser interaction uses BrowserDisplay. */

/** What this deployment reports about the assistant behind the mic. */
export type AssistantToolStatus = { name: string; live: boolean; needs: string };

export type AssistantStatus = {
  assistant: boolean;
  speech: boolean;
  /** Provider readiness is separate from the browser runtime's availability. */
  browser_runtime?: "unavailable" | "public_text";
  model: string;
  provider_authority: "cosmos" | "unknown";
  tools: AssistantToolStatus[];
};

/**
 * The assistant's readiness. Shared query key, so the chat, the floating
 * panel's header and the /talk page all read ONE fetch — and all say the same
 * thing about it.
 */
export function useAssistantStatus() {
  return useQuery({
    queryKey: ["assistant-status"],
    queryFn: async (): Promise<AssistantStatus> => {
      const res = await fetch("/api/assistant/status", { cache: "no-store" }).catch(() => null);
      const body = res ? ((await res.json().catch(() => null)) as Partial<AssistantStatus> | null) : null;
      const runtime = await fetch("/api/runtime/status", { cache: "no-store" }).then(async response => response.ok ? response.json() : null).catch(() => null);
      if (!body) {
        return {
          assistant: false,
          speech: false,
          model: "unreachable",
          provider_authority: "unknown",
          tools: [],
        };
      }
      const tools = Array.isArray(body.tools)
        ? body.tools.flatMap((tool) =>
            tool &&
            typeof tool.name === "string" &&
            typeof tool.live === "boolean" &&
            typeof tool.needs === "string"
              ? [{ name: tool.name, live: tool.live, needs: tool.needs }]
              : [],
          )
        : [];
      return {
        assistant: Boolean(body.assistant),
        speech: Boolean(body.speech),
        browser_runtime: runtime?.version === 1 && runtime?.textInputConfigured === true && runtime?.approvedSurfaceRequired === true ? "public_text" : "unavailable",
        model: typeof body.model === "string" ? body.model : "unknown",
        provider_authority: body.provider_authority === "cosmos" ? "cosmos" : "unknown",
        tools,
      };
    },
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * That same readiness, said out loud.
 *
 * This component already fetched it and spent it on a `title` attribute — so a
 * mic that could not possibly answer looked exactly like one that could. Three
 * different situations, three different sentences: it works, it isn't
 * answering, this deployment has no model at all.
 */
export function AssistantStatusChip({ className }: { className?: string }) {
  const { data } = useAssistantStatus();
  if (!data) return null;

  if (data.browser_runtime === "unavailable") {
    return <StatusChip tone="off" label="Browser runtime unavailable"
      detail="Browser assistant runtime is unavailable. Provider configuration is unchanged."
      className={className} />;
  }
  if (data.browser_runtime === "public_text") {
    return <StatusChip tone="live" label="Browser replies available" detail="Turn on Show replies in this browser to ask Cosmos here. Speech and private memories stay off in a browser." className={className} />;
  }
  if (data.assistant) {
    return (
      <StatusChip
        tone="live"
        label="Assistant ready"
        detail={data.speech ? "Spoken replies are on." : "Text replies are available."}
        className={className}
      />
    );
  }
  if (data.model === "unreachable") {
    return (
      <StatusChip
        tone="degraded"
        label="Assistant unavailable"
        detail="Try again shortly."
        className={className}
      />
    );
  }
  return (
    <StatusChip
      tone="off"
      label="Set up Assistant"
      detail="Choose an assistant service in Settings."
      className={className}
    />
  );
}

export function AiMicChat({ active = true }: { autoListen?: boolean; active?: boolean }) {
  return <BrowserDisplay active={active} />;
}
