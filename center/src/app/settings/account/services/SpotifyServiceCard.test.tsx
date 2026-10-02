import { act, fireEvent, render,screen, waitFor } from "@testing-library/react";
import { afterEach,expect,it,vi } from "vitest";
import { SpotifyServiceCard } from "./SpotifyServiceCard";

afterEach(() => vi.unstubAllGlobals());

const readyStatus = {
  active_provider: "spotify", enabled: true, experimental_acknowledged: true,
  state: "ready", device_name: "Fixture Pin", engine_ready: true,
  providers: {
    youtube_music: { configured: true, state: "not_connected", ad_filtering: "pear_newpipe" },
    tidal: { configured: false, state: "not_configured" },
    apple_music: { configured: true, state: "not_connected" },
  },
};

it("lets the owner select Apple Music to link its account while playback stays unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(readyStatus)));
  render(<SpotifyServiceCard />);
  const option = await screen.findByRole("option", { name: /Apple Music/ });
  expect(option).not.toBeDisabled();
});

it("switching provider cancels its search and cannot show the previous provider's tracks", async () => {
  // Failure modes: provider props change while the old lookup remains mounted,
  // and its late answer becomes the new provider's search result.
  let completeSearch!: (response: Response) => void;
  let searchSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    if (String(input).includes("/music/search")) {
      searchSignal = init?.signal;
      return new Promise<Response>((resolve) => { completeSearch = resolve; });
    }
    return Response.json({ ...readyStatus, active_provider: "youtube_music",
      providers: { ...readyStatus.providers,
        youtube_music: { configured: true, state: "connected", ad_filtering: "pear_newpipe" },
        tidal: { configured: true, state: "connected" },
      },
    });
  }));
  render(<SpotifyServiceCard />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Find a song" }), { target: { value: "old query" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "tidal" } });
  await act(async () => completeSearch(Response.json({ items: [{ id: "old-id", title: "Old provider track", artists: [] }] })));
  expect(screen.queryByText("Old provider track")).not.toBeInTheDocument();
  expect(searchSignal?.aborted).toBe(true);
  expect(screen.getByRole("textbox", { name: "Find a song" })).toHaveValue("");
});

it("retries a failed MusicKit script and completes the account handoff", async () => {
  // Failure modes: a failed script remains in the DOM, a retry waits for an
  // event which already happened, or a linked account enables Pin playback.
  const source = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
  let linked = false;
  const authorize = vi.fn().mockResolvedValue("synthetic-user-token");
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    if (String(input) === "/api/settings/services/music/apple") {
      if (init?.method === "POST") { linked = true; return Response.json({ ok: true }); }
      return Response.json({ developer_token: "synthetic-developer-token" });
    }
    return Response.json({ ...readyStatus, providers: { ...readyStatus.providers,
      apple_music: { configured: true, state: linked ? "connected_playback_runtime_required" : "not_connected" },
    } });
  }));
  render(<SpotifyServiceCard />);
  fireEvent.change(await screen.findByRole("combobox"), { target: { value: "apple_music" } });
  await waitFor(() => expect(document.querySelector(`script[src="${source}"]`)).not.toBeNull());
  const failed = document.querySelector(`script[src="${source}"]`)!;
  fireEvent.error(failed);
  await new Promise((resolve) => setTimeout(resolve, 0));
  fireEvent.click(screen.getByRole("button", { name: "Connect Apple Music" }));
  await waitFor(() => expect(document.querySelector(`script[src="${source}"]`)).not.toBe(failed));
  const replacement = document.querySelector(`script[src="${source}"]`)!;
  window.MusicKit = {
    configure: () => ({ authorize, storefrontId: "us" }),
    getInstance: () => ({ authorize }),
  };
  fireEvent.load(replacement);
  expect((await screen.findAllByText("Your Apple Music account is connected. Playback on the Pin isn’t supported yet.")).length).toBeGreaterThan(0);
  expect(authorize).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  replacement.remove();
  delete window.MusicKit;
});

for (const payload of [
  { state: "ready" },
  { active_provider: "spotify", enabled: "true", experimental_acknowledged: true, state: "ready", device_name: "Fixture Pin", engine_ready: true },
  { active_provider: "spotify", enabled: true, experimental_acknowledged: true, state: "ready", device_name: "Fixture Pin", engine_ready: true, providers: { tidal: { state: "made-up" } } },
]) {
  it("shows an unreadable status instead of presenting malformed service data as connected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
    render(<SpotifyServiceCard />);
    expect(await screen.findByText(/unreadable response/i)).toBeInTheDocument();
    expect(screen.queryByText("Spotify is ready on your Pin.")).not.toBeInTheDocument();
  });
}
