import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CosmosServicesCard } from "./CosmosServicesCard";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings/account/services", useRouter: () => ({ push: vi.fn() }) }));

vi.mock("@/components/AiMicChat", () => ({
  useAssistantStatus: () => ({ data: undefined }),
}));

type Os3View = {
  enabled: boolean;
  configured: boolean;
  session_cookie_configured: boolean;
  status:
    | "not_configured"
    | "untested"
    | "connected"
    | "sign_in_expired"
    | "blocked"
    | "no_instance"
    | "socket_refused"
    | "unavailable"
    | "dropped"
    | "timed_out";
  butler_name: string | null;
  checked_at_ms: number | null;
  last_used_at_ms: number | null;
};

const OS3_OFF: Os3View = {
  enabled: false,
  configured: false,
  session_cookie_configured: false,
  status: "not_configured",
  butler_name: null,
  checked_at_ms: null,
  last_used_at_ms: null,
};

const OS3_SAVED: Os3View = {
  ...OS3_OFF,
  enabled: true,
  configured: true,
  session_cookie_configured: true,
  status: "untested",
};

function integrationsView(os3: Os3View, patch?: { serpapiConfigured?: boolean }) {
  const view = {
    assistant: {
      provider: "openai-compatible",
      configured: true,
      base_url: "https://openrouter.ai/api/v1",
      api_key_configured: true,
      model: "openai/gpt-5.6-luna",
      reasoning_effort: null,
      fast_mode: false,
      max_tokens: 512,
      codex: { available: false, connected: false, plan: null, email: null },
    },
    search: {
      configured: false,
      searxng_base_url: null,
      serpapi_key_configured: false,
      perplexity_key_configured: false,
      perplexity_model: null,
      wolfram_configured: false,
      weather_configured: false,
    },
    maps: { configured: false },
    speech: { configured: false, azure_key_configured: false, azure_region: null, azure_voice: "en-US-AvaMultilingualNeural" },
    food: { configured: false, username_configured: false, password_configured: false },
    os3,
  };
  if (patch?.serpapiConfigured) {
    view.search = { ...view.search, serpapi_key_configured: true };
  }
  return view;
}

function respond(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

describe("CosmosServicesCard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps OS3 off until the owner enables it and sends its cookie only as a write-only secret", async () => {
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const write = init?.method === "PUT";
      if (write) writes.push(JSON.parse(String(init?.body)));
      return respond(integrationsView(write ? OS3_SAVED : OS3_OFF));
    }));
    const user = userEvent.setup();
    render(<CosmosServicesCard operator />);

    await user.click(await screen.findByText("OS3 (Rabbit)", { selector: "summary strong" }));
    const useOs3 = await screen.findByRole("switch", { name: "Use OS3" });
    expect(useOs3).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Test OS3" })).toBeDisabled();
    // What the owner must know before pasting the cookie.
    expect(screen.getByText(/This is your full Rabbit sign-in; treat it like a password\./)).toBeInTheDocument();

    await user.click(useOs3);
    const field = screen.getByText("OS3 session cookie").closest("div");
    const cookie = field?.querySelector("input");
    expect(cookie).toHaveAttribute("type", "password");
    await user.type(cookie!, "session=example");
    expect(screen.getByRole("button", { name: "Test OS3" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Settings saved. Your next request will use them.");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ os3: { enabled: true, session_cookie: "session=example" } });
    expect(screen.getByRole("switch", { name: "Use OS3" })).toHaveAttribute("aria-checked", "true");
    expect(cookie).toHaveValue("");
    expect(cookie).toHaveAttribute("placeholder", "Saved. Leave blank to keep it");
  });

  it("locks OS3 cookie and enable controls while a save is pending", async () => {
    let completeWrite!: (response: Response) => void;
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));
        return new Promise<Response>((resolve) => { completeWrite = resolve; });
      }
      return respond(integrationsView(OS3_OFF));
    }));
    const user = userEvent.setup();
    render(<CosmosServicesCard operator />);
    await user.click(await screen.findByText("OS3 (Rabbit)", { selector: "summary strong" }));
    const enabled = screen.getByRole("switch", { name: "Use OS3" });
    const cookie = screen.getByText("OS3 session cookie").closest("div")!.querySelector("input")!;
    await user.click(enabled);
    await user.type(cookie, "session=first-synthetic");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(cookie).toBeDisabled();
    expect(enabled).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test OS3" })).toBeDisabled();
    await user.type(cookie, "next-synthetic");
    await user.click(enabled);
    expect(cookie).toHaveValue("session=first-synthetic");
    expect(enabled).toHaveAttribute("aria-checked", "true");
    completeWrite(respond(integrationsView(OS3_SAVED)));
    await screen.findByText("Settings saved. Your next request will use them.");
    expect(writes).toEqual([expect.objectContaining({ os3: { enabled: true, session_cookie: "session=first-synthetic" } })]);
    expect(enabled).toHaveAttribute("aria-checked", "true");
    expect(enabled).toBeEnabled();
    expect(cookie).toHaveValue("");
    expect(cookie).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("keeps a configured key when a typed draft is cleared", async () => {
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") writes.push(JSON.parse(String(init.body)));
      return respond(integrationsView(OS3_OFF, { serpapiConfigured: true }));
    }));
    const user = userEvent.setup();
    render(<CosmosServicesCard operator />);

    await user.click(await screen.findByText("Search & maps", { selector: "summary strong" }));
    await screen.findByText("SerpAPI key");
    const input = screen.getByText("SerpAPI key").closest("div")!.querySelector("input")!;
    expect(input).toHaveAttribute("placeholder", "Saved. Leave blank to keep it");

    await user.type(input, "abc");
    expect(input).toHaveAttribute("placeholder", "Paste secret");
    await user.clear(input);
    expect(input).toHaveAttribute("placeholder", "Saved. Leave blank to keep it");

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Settings saved. Your next request will use them.");
    expect(writes).toHaveLength(1);
    expect((writes[0] as { search: Record<string, unknown> }).search).not.toHaveProperty("serpapi_key");
  });

  it("removes a configured key only through Remove, and Keep undoes it", async () => {
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") writes.push(JSON.parse(String(init.body)));
      return respond(integrationsView(OS3_OFF, { serpapiConfigured: true }));
    }));
    const user = userEvent.setup();
    render(<CosmosServicesCard operator />);

    await user.click(await screen.findByText("Search & maps", { selector: "summary strong" }));
    await screen.findByText("SerpAPI key");
    const field = () => screen.getByText("SerpAPI key").closest("div")!;
    const input = field().querySelector("input")!;

    await user.click(within(field()).getByRole("button", { name: "Remove" }));
    expect(input).toHaveAttribute("placeholder", "Will be removed when saved");
    await user.click(within(field()).getByRole("button", { name: "Keep" }));
    expect(input).toHaveAttribute("placeholder", "Saved. Leave blank to keep it");

    await user.click(within(field()).getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Settings saved. Your next request will use them.");
    expect(writes).toHaveLength(1);
    expect((writes[0] as { search: Record<string, unknown> }).search).toMatchObject({ serpapi_key: "" });
  });

  it("names each secret field so a screen reader announces it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(integrationsView(OS3_OFF))));
    render(<CosmosServicesCard operator />);

    expect(await screen.findByLabelText(/^API key/)).toHaveAttribute("type", "password");
    expect(screen.getByLabelText(/^Azure Speech key/)).toHaveAttribute("type", "password");
  });

  it("offers Try again when the first read fails, and loads the settings on retry", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return calls === 1 ? respond({ error: "Cosmos is unreachable." }, 502) : respond(integrationsView(OS3_OFF));
    }));
    const user = userEvent.setup();
    render(<CosmosServicesCard operator />);

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("Cosmos is unreachable.");
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("asks the operator to sign in again when the session expired", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond({ error: "Not authenticated." }, 401)));
    render(<CosmosServicesCard operator />);

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(
      "Your session expired, so your Cosmos settings couldn’t be read.",
    );
    expect(within(notice).getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/login");
  });
});
