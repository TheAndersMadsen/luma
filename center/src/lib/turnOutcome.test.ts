// @vitest-environment node
import { expect, it } from "vitest";
import { TURN_STATES, type TurnState } from "./contracts/ambianceRuntime";
import { describeTurn, devices, statusText } from "./turnOutcome";

const status = (state: TurnState, platform: string | null = "macos") =>
  ({ state, surface: platform === null ? null : { platform }, privacy: "shared_room" as const });

it("says every turn state a device can reach, in the same two-part line the clients show", () => {
  // Every state the runtime can send has words here; a missing one would read
  // as "Cannot confirm" for a turn that was going fine.
  expect(TURN_STATES).toEqual(["working", "waiting", "confirming", "acting", "shown", "spoken", "done", "refused", "nowhere", "unknown"]);
  expect(statusText(describeTurn(status("working")))).toBe("Working");
  expect(statusText(describeTurn(status("waiting")))).toBe("Waiting for a device · Waiting for your Mac");
  // A command is waiting for a person at the device that would carry it out.
  expect(statusText(describeTurn(status("confirming")))).toBe("Waiting for you · Confirm it on your Mac");
  expect(statusText(describeTurn(status("confirming", null)))).toBe("Waiting for you · Confirm it on the device that would do it");
  // Acting claims nothing: a device accepting a command is not an outcome.
  expect(statusText(describeTurn(status("acting")))).toBe("Working · Working on your Mac");
  expect(statusText(describeTurn(status("acting", null)))).toBe("Working · A device is working on it");
  expect(statusText(describeTurn(status("shown")))).toBe("Completed · Shown on your Mac");
  expect(statusText(describeTurn(status("spoken")))).toBe("Completed · Spoken on your Mac");
  expect(statusText(describeTurn(status("done")))).toBe("Completed · Done on your Mac");
  // A refusal is "Not done", never "Cannot confirm": the origin never learns why.
  expect(statusText(describeTurn(status("refused")))).toBe("Not done · Nothing happened on your Mac");
  expect(statusText(describeTurn(status("nowhere")))).toBe("Cannot confirm · Nothing could show or say the reply. It was not sent again.");
  expect(statusText(describeTurn(status("unknown")))).toBe("Cannot confirm");
  // No state names an operation, a reason or which device of a kind it was.
  for (const state of TURN_STATES) {
    const line = statusText(describeTurn(status(state)));
    for (const forbidden of ["private", "policy", "refused because", "action."]) expect(line).not.toContain(forbidden);
  }
});

it("counts devices of one kind rather than repeating the same sentence", () => {
  expect(devices("browser", 1)).toBe("a browser");
  expect(devices("browser", 3)).toBe("3 browsers");
  expect(devices("macos", 2)).toBe("2 Macs");
  expect(devices("android_tv", 2)).toBe("2 TVs");
  expect(devices("pin", 2)).toBe("2 Ai Pins");
  expect(devices(null, 1)).toBe("a device");
  expect(devices("watch", 4)).toBe("4 devices");
});
