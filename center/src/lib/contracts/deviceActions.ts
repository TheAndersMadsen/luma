import { fields } from "./ambianceRuntime";
import { integer, record } from "./surfaces";
import type { ActionChannel } from "./nativeSurfaces";

/**
 * "Let this device act": the owner's statement of what one installation may be
 * asked to open, where it may route to, and which media providers it may play.
 *
 * Every bound is the runtime's own (`cosmos/crates/cosmos/src/ambiance/action.rs`),
 * checked here as well so a refusal is a sentence the owner can act on instead
 * of a 400 from a route.
 */
export const DEVICE_ACTIONS_APPROVAL = "approve-device-actions-v1";
/** The body limit the route already allows. */
export const DEVICE_ACTIONS_BYTES = 2048;
/** Classes an action policy may name. `sensitive` reaches no screen at all, so it is not one of them. */
export const ACTION_CLASSES = ["public", "shared_room", "near_user", "private"] as const;
export type ActionClass = typeof ACTION_CLASSES[number];

export const MAX_HOSTS = 16;
export const MAX_APPS = 8;
export const MAX_ROOTS = 4;
export const MAX_ROOT_PATH_BYTES = 256;
export const MAX_LABEL_BYTES = 120;
export const MAX_ROOT_ID_BYTES = 32;
export const MAX_PROVIDERS = 4;
export const ROUTE_APPS = ["google_maps"] as const;
export type RouteApp = typeof ROUTE_APPS[number];

export interface AppEntry { id: string; label: string }
export interface RootEntry { id: string; label: string; path: string }
export interface OpenPolicy { hosts: string[]; apps: AppEntry[]; roots: RootEntry[] }
export interface DeviceActionPolicy {
  maximumClass: ActionClass;
  open?: OpenPolicy;
  route?: { app: RouteApp };
  play?: { providers: string[] };
}
export interface DeviceActionApproval { approvalRevision: number; revision: number; policy: DeviceActionPolicy | null }
export interface DeviceActionInput {
  approval: typeof DEVICE_ACTIONS_APPROVAL;
  approvalRevision: number;
  expectedRevision: number;
  policy: DeviceActionPolicy | null;
}

const bytes = (value: string) => new TextEncoder().encode(value).length;
/** Bounded text with no control characters, measured the way the runtime measures it. */
export const boundedText = (value: string, maximum: number) =>
  value.trim() !== "" && bytes(value) <= maximum && !/\p{Cc}/u.test(value);
const token = (value: string, maximum: number) => value !== "" && bytes(value) <= maximum && /^[a-z0-9-]+$/.test(value);
const ascending = (values: string[]) => values.every((value, index) => index === 0 || values[index - 1] < value);
const distinct = (values: string[]) => new Set(values).size === values.length;

/** A bare lowercase host the owner declared: no scheme, port, userinfo or path. */
export function declaredHost(value: string): boolean {
  return value !== "" && bytes(value) <= 253 && value === value.toLowerCase()
    && !value.startsWith(".") && !value.endsWith(".") && !value.includes("..")
    && value.includes(".") && /^[a-z0-9.-]+$/.test(value);
}
/** An application id a client can resolve: a bundle id, a package name or a desktop id. */
export function applicationId(value: string): boolean {
  return value !== "" && bytes(value) <= 128 && !value.startsWith(".") && !value.endsWith(".")
    && /^[A-Za-z0-9._-]+$/.test(value);
}
/** A directory the owner declared, named by an id both ends of a handoff must share. */
export function rootPath(value: string): boolean {
  return value.startsWith("/") && boundedText(value, MAX_ROOT_PATH_BYTES) && !value.split("/").includes("..");
}
export function providerId(value: string): boolean {
  return value !== "" && bytes(value) <= 32 && /^[a-z0-9_-]+$/.test(value);
}

/** Whether a policy is one Cosmos will accept. Shape only: which channels this installation may hold is decided where it is written. */
export function validActionPolicy(policy: DeviceActionPolicy): boolean {
  if (!ACTION_CLASSES.some(name => name === policy.maximumClass)) return false;
  if (policy.open) {
    const { hosts, apps, roots } = policy.open;
    if (hosts.length > MAX_HOSTS || !hosts.every(declaredHost) || !ascending(hosts)) return false;
    if (apps.length > MAX_APPS || !apps.every(app => applicationId(app.id) && boundedText(app.label, MAX_LABEL_BYTES))) return false;
    if (roots.length > MAX_ROOTS || !roots.every(root => token(root.id, MAX_ROOT_ID_BYTES)
      && boundedText(root.label, MAX_LABEL_BYTES) && rootPath(root.path))) return false;
    if (!distinct(apps.map(app => app.id)) || !distinct(roots.map(root => root.id))) return false;
    if (!hosts.length && !apps.length && !roots.length) return false;
  }
  if (policy.play) {
    const { providers } = policy.play;
    if (providers.length < 1 || providers.length > MAX_PROVIDERS || !providers.every(providerId) || !ascending(providers)) return false;
  }
  return Boolean(policy.open || policy.route || policy.play);
}

/** The action channels one policy opens, so the card can say what it currently allows. */
export function policyChannels(policy: DeviceActionPolicy | null): ActionChannel[] {
  if (!policy) return [];
  return [...(policy.open ? ["action.open" as const] : []), ...(policy.route ? ["action.route" as const] : []),
    ...(policy.play ? ["action.play" as const] : [])];
}

function parseOpen(value: unknown): OpenPolicy {
  const open = record(value);
  if (Object.keys(open).some(key => !["hosts", "apps", "roots"].includes(key))) throw new Error("invalid_device_action_policy");
  const list = (input: unknown, limit: number): unknown[] => {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > limit) throw new Error("invalid_device_action_policy");
    return input;
  };
  const hosts = list(open.hosts, MAX_HOSTS).map(host => {
    if (typeof host !== "string") throw new Error("invalid_device_action_policy");
    return host;
  });
  const apps = list(open.apps, MAX_APPS).map(value => {
    const app = record(value); fields(app, ["id", "label"]);
    if (typeof app.id !== "string" || typeof app.label !== "string") throw new Error("invalid_device_action_policy");
    return { id: app.id, label: app.label };
  });
  const roots = list(open.roots, MAX_ROOTS).map(value => {
    const root = record(value); fields(root, ["id", "label", "path"]);
    if (typeof root.id !== "string" || typeof root.label !== "string" || typeof root.path !== "string") throw new Error("invalid_device_action_policy");
    return { id: root.id, label: root.label, path: root.path };
  });
  return { hosts, apps, roots };
}

function parsePolicy(value: unknown): DeviceActionPolicy | null {
  if (value === null) return null;
  const input = record(value);
  if (Object.keys(input).some(key => !["maximumClass", "open", "route", "play"].includes(key))) throw new Error("invalid_device_action_policy");
  if (!ACTION_CLASSES.some(name => name === input.maximumClass)) throw new Error("invalid_device_action_policy");
  const policy: DeviceActionPolicy = { maximumClass: input.maximumClass as ActionClass };
  if (input.open !== undefined) policy.open = parseOpen(input.open);
  if (input.route !== undefined) {
    const route = record(input.route); fields(route, ["app"]);
    if (!ROUTE_APPS.some(app => app === route.app)) throw new Error("invalid_device_action_policy");
    policy.route = { app: route.app as RouteApp };
  }
  if (input.play !== undefined) {
    const play = record(input.play); fields(play, ["providers"]);
    if (!Array.isArray(play.providers) || play.providers.length > MAX_PROVIDERS
      || play.providers.some(provider => typeof provider !== "string")) throw new Error("invalid_device_action_policy");
    policy.play = { providers: play.providers as string[] };
  }
  if (!validActionPolicy(policy)) throw new Error("invalid_device_action_policy");
  return policy;
}

export function parseDeviceActionApproval(value: unknown): DeviceActionApproval | null {
  const result = record(value);
  fields(result, ["approval"]);
  if (result.approval === null) return null;
  const approval = record(result.approval);
  fields(approval, ["approvalRevision", "revision", "policy"]);
  if (!integer(approval.approvalRevision, 1) || !integer(approval.revision, 1)) throw new Error("invalid_device_action_approval");
  return { approvalRevision: approval.approvalRevision, revision: approval.revision, policy: parsePolicy(approval.policy) };
}

export function parseDeviceActionInput(value: unknown): DeviceActionInput {
  const input = record(value);
  fields(input, ["approval", "approvalRevision", "expectedRevision", "policy"]);
  if (input.approval !== DEVICE_ACTIONS_APPROVAL || !integer(input.approvalRevision, 1)
    || !integer(input.expectedRevision) || !Number.isSafeInteger(input.expectedRevision + 1)) throw new Error("invalid_device_action_approval");
  return { approval: DEVICE_ACTIONS_APPROVAL, approvalRevision: input.approvalRevision,
    expectedRevision: input.expectedRevision, policy: parsePolicy(input.policy) };
}
