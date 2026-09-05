import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CosmosServicesCard } from "./CosmosServicesCard";

const assistantStatus = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock("@/components/AiMicChat", () => ({
  useAssistantStatus: () => ({ data: assistantStatus.data }),
}));

describe("CosmosServicesCard", () => {
  beforeEach(() => {
    assistantStatus.data = undefined;
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("does not call healthy Cosmos services unavailable while their status is loading", () => {
    render(<CosmosServicesCard operator={false} />);

    expect(screen.queryAllByText("Unavailable")).toHaveLength(0);
    expect(screen.getAllByText("Checking…")).toHaveLength(5);
  });

  const configuredView = () => ({
    realtime: { provider: "openai-realtime", model: "gpt-realtime", upstream: null, max_output_tokens: 1024, configured: true, api_key_configured: true },
    assistant: { provider: "codex-subscription", configured: false, base_url: "https://openrouter.ai/api/v1", api_key_configured: true, model: "gpt-5.6-sol", reasoning_effort: null, fast_mode: false, max_tokens: 512, codex: { available: false, connected: false, plan: null, email: null } },
    search: { configured: false, searxng_base_url: null, serpapi_key_configured: false, perplexity_key_configured: false, perplexity_model: null, wolfram_configured: false, weather_configured: false },
    maps: { configured: false }, speech: { configured: false, azure_key_configured: false, azure_region: null, azure_voice: "en-US-AvaMultilingualNeural" },
    food: { configured: false, username_configured: false, password_configured: false },
  });

  it("provider selection clears staged credentials and never inherits the assistant key", async () => {
    const writes: { realtime: object; assistant: object }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      const view = configuredView();
      if (options?.method !== "PUT") return Response.json(view);
      const body = JSON.parse(options.body); writes.push(body);
      const { api_key, ...coordinates } = body.realtime;
      return Response.json({ ...view, realtime: { ...coordinates, configured: !!api_key, api_key_configured: !!api_key } });
    }));
    render(<CosmosServicesCard operator />);
    await screen.findByLabelText("Conversation API key");
    fireEvent.change(screen.getByLabelText("Conversation API key"), { target: { value: "old-staged-key" } });
    fireEvent.change(screen.getByLabelText(/Conversation provider/), { target: { value: "openrouter-text" } });
    expect(screen.getByLabelText("Conversation API key")).toHaveValue("");
    expect(screen.getByLabelText("Conversation model")).toHaveValue("openai/gpt-4.1-mini");
    fireEvent.click(screen.getByRole("button", { name: "Save Cosmos settings" }));
    await screen.findByText("Cosmos settings saved. New requests use them immediately.");
    expect(writes).toHaveLength(1);
    expect(writes[0].realtime).toEqual({ provider: "openrouter-text", model: "openai/gpt-4.1-mini", upstream: "openai", max_output_tokens: 1024, api_key: "" });
    expect(writes[0].assistant).not.toHaveProperty("api_key");
  });

  it.each(["lost", "mismatched"])("an %s response requires refresh and never claims a confirmed change", async outcome => {
    let writes = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      const view = configuredView();
      if (options?.method !== "PUT") return Response.json(view);
      writes++;
      if (outcome === "lost") throw new Error("Connection lost");
      return Response.json({ ...view, realtime: { ...view.realtime, model: "unexpected" } });
    }));
    render(<CosmosServicesCard operator />);
    await screen.findByLabelText("Conversation API key");
    fireEvent.click(screen.getByRole("button", { name: "Save Cosmos settings" }));
    await screen.findByRole("button", { name: "Refresh Cosmos settings" });
    expect(screen.queryByText("Cosmos settings saved. New requests use them immediately.")).toBeNull();
    expect(screen.getByRole("button", { name: "Save Cosmos settings" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save Cosmos settings" }));
    expect(writes).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh Cosmos settings" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save Cosmos settings" })).toBeEnabled());
  });
});
