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

type AssistantProfile = {
  name: string;
  provider: "openai-compatible" | "codex-subscription";
  base_url: string;
  api_key_configured: boolean;
  model: string;
  reasoning_effort: string | null;
  fast_mode: boolean;
  max_tokens: number;
};

const GATEWAY: AssistantProfile = {
  name: "Gateway",
  provider: "openai-compatible",
  base_url: "https://gateway.example.test/v1",
  api_key_configured: true,
  model: "gateway/default",
  reasoning_effort: null,
  fast_mode: false,
  max_tokens: 512,
};

const CODEX: AssistantProfile = {
  name: "Codex",
  provider: "codex-subscription",
  base_url: "",
  api_key_configured: false,
  model: "gpt-5.6-sol",
  reasoning_effort: "high",
  fast_mode: true,
  max_tokens: 1024,
};

function integrationsView(
  os3: Os3View,
  patch?: { serpapiConfigured?: boolean; profile?: string | null; profiles?: AssistantProfile[] },
) {
  const active = patch?.profiles?.find((profile) => profile.name === patch.profile);
  const view = {
    assistant: {
      provider: active?.provider ?? "openai-compatible",
      configured: true,
      base_url: active?.base_url ?? "https://openrouter.ai/api/v1",
      api_key_configured: active?.api_key_configured ?? true,
      model: active?.model ?? "openai/gpt-5.6-luna",
      reasoning_effort: active?.reasoning_effort ?? null,
      fast_mode: active?.fast_mode ?? false,
      max_tokens: active?.max_tokens ?? 512,
      codex: { available: false, connected: false, plan: null, email: null },
      profile: patch?.profile ?? null,
      profiles: patch?.profiles ?? [],
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

  it("switches profiles at once without retyping a URL or key, and saves edits with Save profile", async () => {
    const writes: Array<{ assistant: Record<string, unknown> }> = [];
    let profile: string | null = "Gateway";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { assistant: Record<string, unknown> };
        writes.push(body);
        profile = String(body.assistant.save_profile ?? body.assistant.load_profile);
      }
      return respond(integrationsView(OS3_OFF, { profile, profiles: [GATEWAY, CODEX] }));
    }));
    const user = userEvent.setup();
    render(<CosmosServicesCard operator />);

    await user.click(await screen.findByText("Assistant", { selector: "summary strong" }));
    const switcher = screen.getByLabelText(/^Profile(?! name)/);
    expect(switcher).toHaveValue("Gateway");
    // A saved profile needs no name field: its name is the one in the switcher.
    expect(screen.queryByLabelText(/^Profile name/)).toBeNull();
    expect(screen.getByLabelText(/^API base URL/)).toHaveValue("https://gateway.example.test/v1");
    expect(screen.getByLabelText(/^API key/)).toHaveAttribute("placeholder", "Saved. Leave blank to keep it");

    // Picking Codex switches the Pin to it; nothing is typed and nothing else is sent.
    await user.selectOptions(switcher, "Codex");
    await screen.findByText("Now using Codex. Your next request will use it.");
    expect(writes).toEqual([{ assistant: { load_profile: "Codex" } }]);
    expect(screen.getByLabelText(/^Profile(?! name)/)).toHaveValue("Codex");
    expect(screen.getByLabelText(/^Provider/)).toHaveValue("codex-subscription");
    expect(screen.getByLabelText(/^Model/)).toHaveValue("gpt-5.6-sol");
    expect(screen.getByLabelText(/^Reasoning effort/)).toHaveValue("high");
    expect(screen.getByLabelText(/^Speed/)).toHaveValue("fast");

    // Back to the gateway: its URL and key come with it, so Test is possible at once.
    await user.selectOptions(screen.getByLabelText(/^Profile(?! name)/), "Gateway");
    await screen.findByText("Now using Gateway. Your next request will use it.");
    expect(writes[1]).toEqual({ assistant: { load_profile: "Gateway" } });
    expect(screen.getByLabelText(/^API base URL/)).toHaveValue("https://gateway.example.test/v1");
    expect(screen.getByLabelText(/^API key/)).toHaveAttribute("placeholder", "Saved. Leave blank to keep it");
    expect(screen.getByRole("button", { name: "Test Assistant" })).toBeEnabled();

    // An edit is saved into the profile by its own button, keeping the stored key.
    await user.clear(screen.getByLabelText(/^Model/));
    await user.type(screen.getByLabelText(/^Model/), "gateway/fast");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText("Profile Gateway saved. Your next request will use it.");
    expect(writes[2]!.assistant).toMatchObject({
      load_profile: "Gateway",
      provider: "openai-compatible",
      base_url: "https://gateway.example.test/v1",
      model: "gateway/fast",
      save_profile: "Gateway",
    });
    expect(writes[2]!.assistant).not.toHaveProperty("api_key");
  });

  it("names unsaved settings, creates a new profile with its own key, and deletes one after confirming", async () => {
    const writes: Array<{ assistant?: Record<string, unknown> }> = [];
    let profiles: AssistantProfile[] = [];
    let profile: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { assistant?: Record<string, unknown> };
        writes.push(body);
        const assistant = body.assistant ?? {};
        if (typeof assistant.save_profile === "string") {
          profile = assistant.save_profile;
          profiles = [
            ...profiles.filter((saved) => saved.name !== profile),
            {
              ...GATEWAY,
              name: profile,
              base_url: String(assistant.base_url),
              model: String(assistant.model),
              api_key_configured: assistant.api_key !== "",
            },
          ];
        }
        if (typeof assistant.delete_profile === "string") {
          profiles = profiles.filter((saved) => saved.name !== assistant.delete_profile);
          profile = null;
        }
      }
      return respond(integrationsView(OS3_OFF, { profile, profiles }));
    }));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const user = userEvent.setup();
    render(<CosmosServicesCard operator />);

    // Settings from before profiles existed: shown as unsaved, with a name to give them.
    await user.click(await screen.findByText("Assistant", { selector: "summary strong" }));
    expect(screen.getByLabelText(/^Profile(?! name)/)).toHaveValue("");
    expect(screen.getByRole("option", { name: "Unsaved settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
    await user.type(screen.getByLabelText(/^Profile name/), "OpenRouter");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText("Profile OpenRouter saved. Your next request will use it.");
    expect(writes[0]!.assistant).toMatchObject({ save_profile: "OpenRouter", base_url: "https://openrouter.ai/api/v1" });
    expect(writes[0]!.assistant).not.toHaveProperty("load_profile");
    expect(writes[0]!.assistant).not.toHaveProperty("api_key");
    expect(await screen.findByLabelText(/^Profile(?! name)/)).toHaveValue("OpenRouter");
    expect(screen.queryByLabelText(/^Profile name/)).toBeNull();

    // New profile: a blank form that inherits nothing, saved only once it is named.
    await user.click(screen.getByRole("button", { name: "New profile" }));
    expect(screen.getByRole("option", { name: "New profile" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^API base URL/)).toHaveValue("");
    expect(screen.getByLabelText(/^API key/)).toHaveAttribute("placeholder", "Paste secret");
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test Assistant" })).toBeDisabled();
    // Saving another section meanwhile leaves the assistant alone and keeps the new form open.
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Settings saved. Your next request will use them.");
    expect(writes[1]).not.toHaveProperty("assistant");
    expect(screen.getByRole("option", { name: "New profile" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^API base URL/)).toHaveValue("");

    // A name another profile has is refused rather than overwriting it.
    await user.type(screen.getByLabelText(/^Profile name/), "OpenRouter");
    expect(screen.getByText("A profile with this name already exists.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
    await user.clear(screen.getByLabelText(/^Profile name/));
    await user.type(screen.getByLabelText(/^Profile name/), "Local");
    await user.type(screen.getByLabelText(/^API base URL/), "http://llm.local:8000/v1");
    await user.type(screen.getByLabelText(/^API key/), "local-key");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText("Profile Local saved. Your next request will use it.");
    expect(writes[2]!.assistant).toMatchObject({
      provider: "openai-compatible",
      base_url: "http://llm.local:8000/v1",
      api_key: "local-key",
      save_profile: "Local",
    });
    expect(writes[2]!.assistant).not.toHaveProperty("load_profile");
    expect(await screen.findByLabelText(/^Profile(?! name)/)).toHaveValue("Local");
    expect(screen.getByRole("option", { name: "OpenRouter" })).toBeInTheDocument();

    // Delete asks first, and leaves the settings in use as unsaved.
    await user.click(screen.getByRole("button", { name: "Delete Local" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(3);
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Delete Local" }));
    await screen.findByText("The profile Local was deleted.");
    expect(writes[3]).toEqual({ assistant: { delete_profile: "Local" } });
    expect(screen.getByLabelText(/^Profile(?! name)/)).toHaveValue("");
    expect(screen.getByLabelText(/^Profile name/)).toHaveValue("");
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
