// @vitest-environment node
import { expect, it } from "vitest";
import {
  bodyBytes, DEVICE_COMMANDS_APPROVAL, DEVICE_COMMANDS_BYTES, MAX_ARGV, MAX_ARGV_BYTES, MAX_BUDGET_MS,
  MAX_COMMAND_ENTRIES, parseDeviceCommandApproval, parseDeviceCommandInput, SENSITIVE_LABEL_MESSAGE,
  validCommandEntry, validCommandPolicy, type CommandEntry, type DeviceCommandPolicy,
} from "./deviceCommands";

const ENTRY: CommandEntry = {
  id: "project-tests", label: "Project tests", argv: ["./revival", "check", "cosmos"],
  cwd: "/Users/owner/Projects/app", mutates: true, budgetMs: 900_000,
};
const POLICY: DeviceCommandPolicy = { maximumClass: "private", offerOutputToCognition: false, entries: [ENTRY] };
const input = (policy: DeviceCommandPolicy | null) =>
  ({ approval: DEVICE_COMMANDS_APPROVAL, approvalRevision: 7, expectedRevision: 3, policy });
const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ ...ENTRY, id: `task-${index}` }));

it("carries the route's raised body limit and round-trips one authored entry", () => {
  expect(DEVICE_COMMANDS_APPROVAL).toBe("approve-device-command-v1");
  expect(DEVICE_COMMANDS_BYTES).toBe(4096);
  expect(parseDeviceCommandInput(input(POLICY))).toEqual(input(POLICY));
  expect(parseDeviceCommandInput(input(null))).toEqual(input(null));
  expect(parseDeviceCommandApproval({ approval: { approvalRevision: 7, revision: 4, policy: POLICY } }))
    .toEqual({ approvalRevision: 7, revision: 4, policy: POLICY });
  expect(parseDeviceCommandApproval({ approval: null })).toBeNull();
});

it("refuses an argv that is not a fixed array, because a string there would be a shell command", () => {
  for (const argv of ["./revival check cosmos", { 0: "./revival" }, null, undefined] as unknown[]) {
    expect(() => parseDeviceCommandInput(input({ ...POLICY, entries: [{ ...ENTRY, argv: argv as string[] }] })), String(argv))
      .toThrow("invalid_device_command_policy");
  }
  // An array is still bounded, present, and free of control characters.
  expect(validCommandEntry({ ...ENTRY, argv: [] })).toBe(false);
  expect(validCommandEntry({ ...ENTRY, argv: Array.from({ length: MAX_ARGV + 1 }, () => "x") })).toBe(false);
  expect(validCommandEntry({ ...ENTRY, argv: ["./revival", ""] })).toBe(false);
  expect(validCommandEntry({ ...ENTRY, argv: ["./revival", "a".repeat(MAX_ARGV_BYTES + 1)] })).toBe(false);
  expect(validCommandEntry({ ...ENTRY, argv: ["./revival", "check\ncosmos"] })).toBe(false);
  // argv[0] cannot climb out of the folder the owner named.
  expect(validCommandEntry({ ...ENTRY, argv: ["../../bin/sh"] })).toBe(false);
  expect(validCommandEntry({ ...ENTRY, cwd: "/Users/owner/../root" })).toBe(false);
  expect(validCommandEntry({ ...ENTRY, cwd: "Projects" })).toBe(false);
});

it("refuses an over-cap entry list, a repeated short name and an out-of-range budget", () => {
  expect(validCommandPolicy({ ...POLICY, entries: entries(MAX_COMMAND_ENTRIES) })).toBe(true);
  expect(validCommandPolicy({ ...POLICY, entries: entries(MAX_COMMAND_ENTRIES + 1) })).toBe(false);
  expect(() => parseDeviceCommandInput(input({ ...POLICY, entries: entries(MAX_COMMAND_ENTRIES + 1) }))).toThrow("invalid_device_command_policy");
  expect(validCommandPolicy({ ...POLICY, entries: [] })).toBe(false);
  expect(validCommandPolicy({ ...POLICY, entries: [ENTRY, { ...ENTRY, label: "Twice" }] })).toBe(false);
  for (const budgetMs of [0, -1, MAX_BUDGET_MS + 1, 1.5]) {
    expect(validCommandEntry({ ...ENTRY, budgetMs }), String(budgetMs)).toBe(false);
  }
  for (const id of ["Project-Tests", "project tests", ""]) expect(validCommandEntry({ ...ENTRY, id }), id).toBe(false);
  expect(validCommandEntry({ ...ENTRY, label: "  " })).toBe(false);
  expect(validCommandPolicy({ ...POLICY, maximumClass: "sensitive" as "private" })).toBe(false);
});

it("refuses a write the route's own 4096-byte limit would drop", () => {
  const fat = { ...POLICY, entries: entries(MAX_COMMAND_ENTRIES).map(entry => ({ ...entry, argv: Array.from({ length: MAX_ARGV }, () => "a".repeat(MAX_ARGV_BYTES)) })) };
  expect(bodyBytes(input(fat))).toBeGreaterThan(DEVICE_COMMANDS_BYTES);
  expect(() => parseDeviceCommandInput(input(fat))).toThrow("device_command_body_too_large");
  expect(bodyBytes(input(POLICY))).toBeLessThan(DEVICE_COMMANDS_BYTES);
});

it("names the one refusal no bound here can predict in the runtime's own words", () => {
  // A sensitive label is refused where it is written, because a permanently
  // unrunnable task is indistinguishable from a missing capability.
  expect(SENSITIVE_LABEL_MESSAGE).toBe("Rename this task: Cosmos treats that wording as too sensitive to route anywhere.");
  // The shape of such an entry is perfectly legal here; only Cosmos can judge it.
  expect(validCommandEntry({ ...ENTRY, label: "Export my medical records" })).toBe(true);
});

it("rejects a request that is not exactly this approval at a bound revision", () => {
  for (const bad of [
    { ...input(POLICY), approval: "approve-device-actions-v1" },
    { ...input(POLICY), approvalRevision: 0 },
    { ...input(POLICY), extra: true },
    input({ ...POLICY, confirm: false } as DeviceCommandPolicy),
    input({ maximumClass: "private", entries: [ENTRY] } as DeviceCommandPolicy),
    input({ ...POLICY, entries: [{ ...ENTRY, never: true }] } as unknown as DeviceCommandPolicy),
  ]) {
    expect(() => parseDeviceCommandInput(bad), JSON.stringify(bad)).toThrow();
  }
});
