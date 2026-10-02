import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiMicChat } from "./AiMicChat";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { assistant: true, speech: true, model: "synthetic", tools: [] } }),
}));

// Synthetic streamed answer and deferred speech HTTP boundary. No provider/audio device.
const ANSWER = 'event: step\ndata: {"kind":"answer","name":"Respond","source":"server","text":"OS3 is still working. Ask again for an update."}\n\n';
class SyntheticAudio {
  static instances: SyntheticAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  constructor(public src: string) { SyntheticAudio.instances.push(this); }
}
let speechSignal: AbortSignal | undefined;
let resolveSpeech: (response: Response) => void;
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");

beforeEach(() => {
  SyntheticAudio.instances = [];
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  speechSignal = undefined;
  const speech = new Promise<Response>((resolve) => { resolveSpeech = resolve; });
  vi.stubGlobal("Audio", SyntheticAudio);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic-speech");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/assistant/stream") return new Response(ANSWER);
    if (url === "/api/assistant/speech") {
      speechSignal = init?.signal ?? undefined;
      return speech; // Intentionally can resolve after abort: stale completion must still be guarded.
    }
    throw new Error("Unmodeled fixture request");
  }));
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

async function ask() {
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Message Ai Mic" }), "What did OS3 find?");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/assistant/speech", expect.anything()));
  return user;
}
async function returnSpeech() {
  await act(async () => { resolveSpeech(new Response("synthetic mp3", { headers: { "content-type": "audio/mpeg" } })); });
}

describe("Ai Mic speech lifecycle", () => {
  it("discards deferred speech after collapse, even if the panel has reopened", async () => {
    const { rerender } = render(<AiMicChat active />);
    await ask();
    rerender(<AiMicChat active={false} />);
    rerender(<AiMicChat active />);
    await returnSpeech();
    expect(SyntheticAudio.instances).toHaveLength(0);
    expect(speechSignal?.aborted).toBe(true);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message Ai Mic" })).toBeEnabled());
  });

  it("turning Voice off cancels pending synthesis and retains the text answer", async () => {
    render(<AiMicChat />);
    const user = await ask();
    await user.click(screen.getByRole("button", { name: /Voice on/ }));
    await returnSpeech();
    expect(SyntheticAudio.instances).toHaveLength(0);
    expect(speechSignal?.aborted).toBe(true);
    expect(screen.getByText("OS3 is still working. Ask again for an update.")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message Ai Mic" })).toBeEnabled());
  });

  it("turning Voice off stops active playback and releases the composer", async () => {
    render(<AiMicChat />);
    const user = await ask();
    await returnSpeech();
    await waitFor(() => expect(SyntheticAudio.instances).toHaveLength(1));
    expect(screen.getByRole("textbox", { name: "Message Ai Mic" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Voice on/ }));
    expect(SyntheticAudio.instances[0]!.pause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-speech");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message Ai Mic" })).toBeEnabled());
  });
});
