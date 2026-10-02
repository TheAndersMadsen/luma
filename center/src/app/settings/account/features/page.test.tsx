import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Feature } from "@/lib/contracts/features";
import FeaturesPage from "./page";

const delayedMountSync = vi.hoisted(() => ({ enabled: false, callbacks: [] as Array<() => void> }));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useEffect: (effect: () => void | (() => void), dependencies?: import("react").DependencyList) =>
      react.useEffect(() => {
        if (delayedMountSync.enabled && dependencies?.length === 1 && dependencies[0] === "3") {
          delayedMountSync.callbacks.push(() => { effect(); });
          return;
        }
        return effect();
      }, dependencies),
  };
});

vi.mock("next/navigation", () => ({ usePathname: () => "/settings/account/features", useRouter: () => ({ push: vi.fn() }) }));

function feature(name: string, patch: Partial<Feature> = {}): Feature {
  return { name, editable: true, label: name, description: "Technical provider description.", category: "Everyday Pin", evidence: "derived", delivery: "next_sync", type: "bool", default: false, effective: false, overridden: false, ...patch } as Feature;
}

function fixture(initial: Feature[], delivery = "device_fetched") {
  let features = initial;
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  let fail = false;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.method) return Response.json(features);
    const body = JSON.parse(String(init.body));
    writes.push({ method: init.method, body });
    if (fail) return Response.json({ error: "This feature couldn’t be saved." }, { status: 503 });
    features = features.map((flag) => flag.name === body.name
      ? { ...flag, effective: init.method === "DELETE" ? flag.default : body.value, overridden: init.method !== "DELETE" }
      : flag);
    return Response.json({ delivery });
  }));
  return { writes, failNext: () => { fail = true; } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delayedMountSync.enabled = false;
  delayedMountSync.callbacks = [];
});

describe("Pin feature warnings and saved choices", () => {
  it("reports a queued update without claiming the Pin fetched it", async () => {
    const user = userEvent.setup();
    fixture([feature("music_interstitials_enabled")], "push_queued");
    render(<FeaturesPage />);
    await user.click(await screen.findByRole("switch"));
    expect(await screen.findByText("Saved. Update requested.")).toBeVisible();
    expect(screen.queryByText("Saved. Your Pin has the latest setting.")).not.toBeInTheDocument();
  });
  it("describes the actual stock gesture and phone prerequisites", async () => {
    fixture([
      feature("vision_custom_gesture_enabled"),
      feature("quick_actions_remapping_enabled"),
      feature("cmu_ultra_enabled"),
      feature("vision_actions_enabled"),
    ]);
    render(<FeaturesPage />);
    expect(await screen.findByText("Tap, then hold to ask about what your camera sees.")).toBeVisible();
    expect(screen.getByText("Choose what a two-finger hold does.")).toBeVisible();
    expect(screen.getByText("Use eligible notifications from a paired iPhone.")).toBeVisible();
    expect(screen.getByText("Save rules for what your Pin sees, such as “if you see… then…”.")).toBeVisible();
  });
  it("shows Touchcode as always available while restoring an ignored old choice", async () => {
    const user = userEvent.setup();
    const f = fixture([feature("touchcode_enabled", { editable: false, default: true, effective: true, overridden: true })]);
    render(<FeaturesPage />);
    expect(await screen.findByText("Always available")).toBeVisible();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restore default" }));
    expect(f.writes).toEqual([{ method: "DELETE", body: { name: "touchcode_enabled" } }]);
    expect(await screen.findByText("Always available")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Restore default" })).not.toBeInTheDocument();
  });
  it("shows consent and data warnings without exposing technical descriptions in the main rows", async () => {
    const user = userEvent.setup();
    fixture([
      feature("vision_actions_enabled", { delivery: "next_sync_restart", warning: "Experimental and ineffective until camera-to-cloud consent is acknowledged. Restart Ironman for stock Add/Clear/Count grammar." }),
      feature("fitness_tracker_enabled", { warning: "Sensitive health/activity data. Restart Ironman to rebuild the full stock voice catalog." }),
      feature("fitness_tracker_extra_data_enabled", { warning: "Sensitive and high-volume. Requires Fitness tracker and takes full effect on the next session." }),
      feature("touchcode_enabled", { editable: false, default: true, effective: true }),
      feature("network_reset_enabled", { warning: "Destructive surface. This flag exposes the UI but never executes a reset by itself." }),
    ]);
    render(<FeaturesPage />);
    expect(await screen.findByText("Requires permission to use camera images.")).toBeVisible();
    expect(screen.getByText("Records sensitive activity and location data.")).toBeVisible();
    expect(screen.getByText("Includes motion and location data. Requires Fitness tracking.")).toBeVisible();
    expect(screen.getByText("Always available")).toBeVisible();
    expect(screen.getByText("This shows the reset option; it does not reset your Pin.")).toBeVisible();
    expect(screen.getAllByText("Restart recommended")).toHaveLength(1);
    const technical = screen.getByText(/Restart Ironman for stock Add/u);
    expect(technical).not.toBeVisible();
    const details = technical.closest("details")!;
    await user.click(within(details).getByText("More details"));
    expect(technical).toBeVisible();
  });

  it("keeps exact toggle and restore requests and leaves the saved value after a refused change", async () => {
    const user = userEvent.setup();
    const f = fixture([feature("vision_actions_enabled", { warning: "Requires camera consent." })]);
    render(<FeaturesPage />);
    const control = await screen.findByRole("switch");
    await user.click(control);
    expect(await screen.findByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect(f.writes[0]).toEqual({ method: "PUT", body: { name: "vision_actions_enabled", value: true } });
    await user.click(screen.getByRole("button", { name: "Restore default" }));
    expect(await screen.findByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(f.writes[1]).toEqual({ method: "DELETE", body: { name: "vision_actions_enabled" } });
    f.failNext();
    await user.click(screen.getByRole("switch"));
    expect(await screen.findByText("This feature couldn’t be saved.")).toBeVisible();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("keeps seconds in the editor and milliseconds on the unchanged wire", async () => {
    const user = userEvent.setup();
    const f = fixture([feature("touchcode_timeout_millis", { type: "int", default: 3000, effective: 3000 })]);
    render(<FeaturesPage />);
    const input = await screen.findByRole("textbox", { name: "Touchcode timeout in seconds" });
    expect(input).toHaveValue("3");
    await user.clear(input);
    expect(input).toHaveValue("");
    await user.type(input, "4");
    expect(input).toHaveValue("4");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(f.writes[0]).toEqual({ method: "PUT", body: { name: "touchcode_timeout_millis", value: 4000 } });
    expect(await screen.findByRole("textbox", { name: "Touchcode timeout in seconds" })).toHaveValue("4");
  });
  it("preserves a cleared timeout when initial saved-value synchronization arrives late", async () => {
    delayedMountSync.enabled = true;
    const user = userEvent.setup();
    const f = fixture([feature("touchcode_timeout_millis", { type: "int", default: 3000, effective: 3000 })]);
    render(<FeaturesPage />);
    const input = await screen.findByRole("textbox", { name: "Touchcode timeout in seconds" });
    expect(input).toHaveValue("3");
    // The input is in the DOM at commit. Its passive effect runs a tick later.
    await waitFor(() => expect(delayedMountSync.callbacks).toHaveLength(1));
    await user.clear(input);
    expect(input).toHaveValue("");
    act(() => { delayedMountSync.callbacks.splice(0).forEach((callback) => callback()); });
    expect(input).toHaveValue("");
    await user.type(input, "4");
    expect(input).toHaveValue("4");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(f.writes[0]).toEqual({ method: "PUT", body: { name: "touchcode_timeout_millis", value: 4000 } });
    expect(await screen.findByRole("textbox", { name: "Touchcode timeout in seconds" })).toHaveValue("4");
  });

});
