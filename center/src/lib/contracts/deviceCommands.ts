import { fields } from "./ambianceRuntime";
import { integer, record } from "./surfaces";
import { ACTION_CLASSES, boundedText, MAX_LABEL_BYTES, MAX_ROOT_PATH_BYTES, type ActionClass } from "./deviceActions";

/**
 * "Tasks on this device": the commands the owner authored for one macOS
 * installation. There are no parameters and no shell string — `argv` is a
 * fixed array fixed here, once, by a person — so nothing a model or a page
 * says can ever become an argument.
 */
export const DEVICE_COMMANDS_APPROVAL = "approve-device-command-v1";
/** The body limit the route already allows: an authored entry list fits no smaller one. */
export const DEVICE_COMMANDS_BYTES = 4096;
export const MAX_COMMAND_ENTRIES = 8;
export const MIN_ARGV = 1;
export const MAX_ARGV = 12;
export const MAX_ARGV_BYTES = 256;
export const MAX_ENTRY_ID_BYTES = 48;
export const MAX_BUDGET_MS = 900_000;

export interface CommandEntry {
  id: string;
  /** What a person reads in Center, on the confirm card, on the task card and in the ledger. */
  label: string;
  argv: string[];
  cwd: string;
  /** Whether running it changes files. A command that does is confirmed with device-owner authentication. */
  mutates: boolean;
  budgetMs: number;
}
export interface DeviceCommandPolicy {
  maximumClass: ActionClass;
  /** Whether a completed command's own output may be offered to a later turn's cognition, as a delimited untrusted block. */
  offerOutputToCognition: boolean;
  entries: CommandEntry[];
}
export interface DeviceCommandApproval { approvalRevision: number; revision: number; policy: DeviceCommandPolicy | null }
export interface DeviceCommandInput {
  approval: typeof DEVICE_COMMANDS_APPROVAL;
  approvalRevision: number;
  expectedRevision: number;
  policy: DeviceCommandPolicy | null;
}

const bytes = (value: string) => new TextEncoder().encode(value).length;
const token = (value: string, maximum: number) => value !== "" && bytes(value) <= maximum && /^[a-z0-9-]+$/.test(value);

/** One argv element: bounded, present, and free of control characters. There is no shell to quote for. */
export const validArgument = (value: string) => value !== "" && bytes(value) <= MAX_ARGV_BYTES && !/\p{Cc}/u.test(value);

export function validCommandEntry(entry: CommandEntry): boolean {
  return token(entry.id, MAX_ENTRY_ID_BYTES)
    && boundedText(entry.label, MAX_LABEL_BYTES)
    && Array.isArray(entry.argv) && entry.argv.length >= MIN_ARGV && entry.argv.length <= MAX_ARGV
    && entry.argv.every(validArgument)
    && entry.cwd.startsWith("/") && boundedText(entry.cwd, MAX_ROOT_PATH_BYTES) && !entry.cwd.split("/").includes("..")
    && !entry.argv[0].split("/").includes("..")
    && Number.isSafeInteger(entry.budgetMs) && entry.budgetMs >= 1 && entry.budgetMs <= MAX_BUDGET_MS;
}

export function validCommandPolicy(policy: DeviceCommandPolicy): boolean {
  return ACTION_CLASSES.some(name => name === policy.maximumClass)
    && policy.entries.length >= 1 && policy.entries.length <= MAX_COMMAND_ENTRIES
    && policy.entries.every(validCommandEntry)
    && new Set(policy.entries.map(entry => entry.id)).size === policy.entries.length;
}

/** The one refusal Cosmos makes that no bound here can predict, in the runtime's own words. */
export const SENSITIVE_LABEL_MESSAGE = "Rename this task: Cosmos treats that wording as too sensitive to route anywhere.";

function parseEntry(value: unknown): CommandEntry {
  const entry = record(value);
  fields(entry, ["id", "label", "argv", "cwd", "mutates", "budgetMs"]);
  if (typeof entry.id !== "string" || typeof entry.label !== "string" || typeof entry.cwd !== "string"
    || typeof entry.mutates !== "boolean" || !integer(entry.budgetMs, 1)) throw new Error("invalid_device_command_policy");
  // argv is an array or it is nothing. A string here would be a shell command,
  // which is the one shape this permission exists to make impossible.
  if (!Array.isArray(entry.argv) || entry.argv.length > MAX_ARGV
    || entry.argv.some(argument => typeof argument !== "string")) throw new Error("invalid_device_command_policy");
  return { id: entry.id, label: entry.label, argv: entry.argv as string[], cwd: entry.cwd, mutates: entry.mutates, budgetMs: entry.budgetMs };
}

function parsePolicy(value: unknown): DeviceCommandPolicy | null {
  if (value === null) return null;
  const input = record(value);
  fields(input, ["maximumClass", "offerOutputToCognition", "entries"]);
  if (!ACTION_CLASSES.some(name => name === input.maximumClass) || typeof input.offerOutputToCognition !== "boolean"
    || !Array.isArray(input.entries) || input.entries.length > MAX_COMMAND_ENTRIES) throw new Error("invalid_device_command_policy");
  const policy: DeviceCommandPolicy = {
    maximumClass: input.maximumClass as ActionClass,
    offerOutputToCognition: input.offerOutputToCognition,
    entries: input.entries.map(parseEntry),
  };
  if (!validCommandPolicy(policy)) throw new Error("invalid_device_command_policy");
  return policy;
}

export function parseDeviceCommandApproval(value: unknown): DeviceCommandApproval | null {
  const result = record(value);
  fields(result, ["approval"]);
  if (result.approval === null) return null;
  const approval = record(result.approval);
  fields(approval, ["approvalRevision", "revision", "policy"]);
  if (!integer(approval.approvalRevision, 1) || !integer(approval.revision, 1)) throw new Error("invalid_device_command_approval");
  return { approvalRevision: approval.approvalRevision, revision: approval.revision, policy: parsePolicy(approval.policy) };
}

export function parseDeviceCommandInput(value: unknown): DeviceCommandInput {
  const input = record(value);
  fields(input, ["approval", "approvalRevision", "expectedRevision", "policy"]);
  if (input.approval !== DEVICE_COMMANDS_APPROVAL || !integer(input.approvalRevision, 1)
    || !integer(input.expectedRevision) || !Number.isSafeInteger(input.expectedRevision + 1)) throw new Error("invalid_device_command_approval");
  if (bodyBytes(input) > DEVICE_COMMANDS_BYTES) throw new Error("device_command_body_too_large");
  return { approval: DEVICE_COMMANDS_APPROVAL, approvalRevision: input.approvalRevision,
    expectedRevision: input.expectedRevision, policy: parsePolicy(input.policy) };
}

/** What this write weighs on the wire. The route allows 4096 bytes and no more, so the editor says how much is left. */
export const bodyBytes = (input: unknown) => new TextEncoder().encode(JSON.stringify(input)).length;
