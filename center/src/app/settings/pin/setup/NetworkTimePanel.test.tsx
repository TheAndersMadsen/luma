import type { AnchorHTMLAttributes, ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JOIN_WIFI_COMMAND, type PinSetupNetworkFacts } from "@/lib/pin-setup";
import { OK, fakeDevice } from "../../../../../verify/fixtures/fake-pin-device.mjs";
import { NetworkTimePanel } from "./NetworkTimePanel";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const NOW = Date.UTC(2026, 8, 23, 12, 0);
const STUCK = Date.UTC(2025, 1, 18, 15, 43);

const STATUS = "cmd wifi status";
const CONNECTIVITY = "dumpsys connectivity | grep NetworkAgentInfo";
const CLOCK = "date +%s%3N";
const ON_HOME = OK('Wifi is enabled\nWifi is connected to "Home"\n');
const VALIDATED = OK(
  "  NetworkAgentInfo{network{100}  ni{WIFI CONNECTED extra: } Score(60 ; Policies : TRANSPORT_PRIMARY&IS_VALIDATED)  everValidated lastValidated\n",
);
const SCAN = OK(
  [
    "    BSSID              Frequency      RSSI           Age(sec)     SSID                                 Flags",
    "  aa:bb:cc:dd:ee:01       5805    -42(0:-42)          3.178    Home                                 [WPA2-PSK-CCMP][ESS]",
    "  aa:bb:cc:dd:ee:02       2412    -60(0:-60)          3.100    Cafe Guest                           [ESS]",
  ].join("\n"),
);

function facts(overrides: Partial<PinSetupNetworkFacts> = {}): PinSetupNetworkFacts {
  return {
    state: "read",
    wifiEnabled: true,
    wifiNetwork: null,
    online: false,
    transport: null,
    pinTimeEpochMs: STUCK,
    clockSkewMs: STUCK - NOW,
    detail: null,
    ...overrides,
  };
}

/** Waits that pass instantly, so a test never sleeps for real. */
function instantTiming() {
  let current = NOW;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

type Handlers = Parameters<typeof fakeDevice>[0];

function pinOverUsb(handlers: Handlers) {
  const device = fakeDevice(handlers) as ReturnType<typeof fakeDevice> & {
    inputs: string[];
    shellWithInput: (command: string | readonly string[], input: Blob) => Promise<unknown>;
  };
  device.inputs = [];
  device.shellWithInput = async (command, input) => {
    device.inputs.push(await input.text());
    return device.shell(command);
  };
  return device;
}

/** Center's clock, from the Date header of /api/version. */
function stubCenterClock() {
  const request = vi.fn(async () =>
    new Response("{}", { headers: { date: new Date(NOW).toUTCString() } }),
  );
  vi.stubGlobal("fetch", request);
  return request;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NetworkTimePanel", () => {
  it("joins the network the owner picks, sending the password only to the Pin", async () => {
    const password = "correct horse battery";
    const device = pinOverUsb({
      "cmd wifi start-scan": OK(""),
      "cmd wifi list-scan-results": SCAN,
      [JOIN_WIFI_COMMAND]: OK("Connection initiated \n"),
      [STATUS]: ON_HOME,
      [CONNECTIVITY]: VALIDATED,
      [CLOCK]: [OK(`${STUCK}\n`), OK(`${NOW + 100}\n`)],
    });
    const request = stubCenterClock();
    const onChanged = vi.fn();
    const user = userEvent.setup();

    render(
      <NetworkTimePanel
        network={facts()}
        device={() => device as never}
        onChanged={onChanged}
        timing={instantTiming()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Home/ }));
    await user.type(screen.getByLabelText("Wi-Fi password"), password);
    await user.click(screen.getByRole("button", { name: "Join network" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(device.inputs).toEqual([`Home\nwpa2\nno\n${password}\n`]);
    for (const command of device.commands as string[]) {
      expect(command).not.toContain(password);
    }
    for (const [url, init] of request.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).toBe("/api/version");
      expect(JSON.stringify(init ?? {})).not.toContain(password);
    }
    expect(screen.getByLabelText("Wi-Fi password")).toHaveValue("");
  });
});
