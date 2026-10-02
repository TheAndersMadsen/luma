import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  FINISH_ONBOARDING_COMMAND,
  STOCK_SETUP_COMPLETE_COMMAND,
  type OnboardingTiming,
  type PinShellWithInput,
} from "@/lib/pin-setup";
import { OnboardingPasscodePanel } from "./OnboardingPasscodePanel";

const OK = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });

function instantTiming(): OnboardingTiming {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  };
}

function pinThatFinishes() {
  const commands: string[][] = [];
  const inputs: string[] = [];
  let reads = 0;
  const device: PinShellWithInput = {
    async shell(command) {
      commands.push([...command]);
      expect(command).toEqual(STOCK_SETUP_COMPLETE_COMMAND);
      reads += 1;
      return OK(reads < 3 ? "0\n" : "1\n");
    },
    async shellWithInput(command, input) {
      commands.push([...command]);
      inputs.push(await input.text());
      return OK();
    },
  };
  return { device, commands, inputs };
}

describe("OnboardingPasscodePanel", () => {
  it("hands four digits only to the connected Pin and clears the field immediately", async () => {
    const pin = pinThatFinishes();
    const changed = vi.fn();
    const user = userEvent.setup();

    render(
      <OnboardingPasscodePanel
        device={() => pin.device}
        onChanged={changed}
        timing={instantTiming()}
      />,
    );

    const field = screen.getByLabelText("Your four-digit Pin passcode");
    await user.type(field, "4821");
    await user.click(screen.getByRole("button", { name: "Finish setup on this Pin" }));

    expect(field).toHaveValue("");
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(pin.inputs).toEqual(["4821"]);
    expect(pin.commands[0]).toEqual(FINISH_ONBOARDING_COMMAND);
    for (const command of pin.commands) expect(command.join(" ")).not.toContain("4821");
    expect(pin.commands.slice(1)).toEqual([
      [...STOCK_SETUP_COMPLETE_COMMAND],
      [...STOCK_SETUP_COMPLETE_COMMAND],
      [...STOCK_SETUP_COMPLETE_COMMAND],
    ]);
  });

  it("rejects anything except four ASCII digits before contacting the Pin", async () => {
    const shell = vi.fn();
    const shellWithInput = vi.fn();
    const user = userEvent.setup();
    render(
      <OnboardingPasscodePanel
        device={() => ({ shell, shellWithInput })}
        onChanged={vi.fn()}
        timing={instantTiming()}
      />,
    );

    await user.type(screen.getByLabelText("Your four-digit Pin passcode"), "12a");
    await user.click(screen.getByRole("button", { name: "Finish setup on this Pin" }));

    expect(await screen.findByText("A passcode is exactly four digits.")).toBeInTheDocument();
    expect(shell).not.toHaveBeenCalled();
    expect(shellWithInput).not.toHaveBeenCalled();
  });
});
