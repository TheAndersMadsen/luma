import { integer, record, UUID } from "./surfaces";

export const LOOKUP_SERVICES = {
  web: { path: "web-lookup", approval: "approve-web-lookup-disclosure-v1", providers: ["searxng", "serp_api"] },
  places: { path: "places-lookup", approval: "approve-places-lookup-disclosure-v1", providers: ["google_places"] },
} as const;
export type LookupService = keyof typeof LOOKUP_SERVICES;
export const LOOKUP_INPUT_BYTES = 4096;
export const LOOKUP_RESPONSE_BYTES = 8192;

export interface LookupProvider {
  provider: typeof LOOKUP_SERVICES[LookupService]["providers"][number];
  endpoint: string;
  configurationDigest: string;
}
export interface LookupPolicy { provider: LookupProvider; maximumClass: "shared_room" }
export interface LookupApproval { approvalRevision: number; revision: number; policy: LookupPolicy | null }
export interface LookupBinding { approvalRevision: number; incarnation: string | null }
export interface LookupInput {
  approval: typeof LOOKUP_SERVICES[LookupService]["approval"];
  approvalRevision: number;
  approvalIncarnation: string | null;
  expectedRevision: number;
  policy: LookupPolicy | null;
}
export interface LookupState { approval: LookupApproval | null; providers: LookupProvider[]; binding: LookupBinding }

function fields(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new Error("invalid_lookup_fields");
}

function incarnation(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length !== 36 || !UUID.test(value)
    || value === "00000000-0000-0000-0000-000000000000") throw new Error("invalid_lookup_incarnation");
  return value.toLowerCase();
}

function endpoint(value: unknown): value is string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 1024 || /[\s\\?#]/.test(value)
    || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname
      && !url.username && !url.password && !url.search && !url.hash && url.href === value;
  } catch {
    return false;
  }
}

export function parseLookupProvider(service: LookupService, value: unknown): LookupProvider {
  const provider = record(value);
  fields(provider, ["provider", "endpoint", "configurationDigest"]);
  const kind = LOOKUP_SERVICES[service].providers.find(candidate => candidate === provider.provider);
  if (!kind || !endpoint(provider.endpoint)
    || typeof provider.configurationDigest !== "string" || provider.configurationDigest.length !== 64
    || !/^[0-9a-f]{64}$/.test(provider.configurationDigest)) throw new Error("invalid_lookup_provider");
  return { provider: kind, endpoint: provider.endpoint, configurationDigest: provider.configurationDigest };
}

export function parseLookupPolicy(service: LookupService, value: unknown): LookupPolicy | null {
  if (value === null) return null;
  const policy = record(value);
  fields(policy, ["provider", "maximumClass"]);
  if (policy.maximumClass !== "shared_room") throw new Error("invalid_lookup_policy");
  return { provider: parseLookupProvider(service, policy.provider), maximumClass: "shared_room" };
}

export function parseLookupInput(service: LookupService, value: unknown): LookupInput {
  const input = record(value);
  const approval = LOOKUP_SERVICES[service].approval;
  fields(input, ["approval", "approvalRevision", "approvalIncarnation", "expectedRevision", "policy"]);
  if (input.approval !== approval || !integer(input.approvalRevision, 1)
    || !integer(input.expectedRevision) || !Number.isSafeInteger(input.expectedRevision + 1)) throw new Error("invalid_lookup_approval");
  return { approval, approvalRevision: input.approvalRevision,
    approvalIncarnation: incarnation(input.approvalIncarnation), expectedRevision: input.expectedRevision,
    policy: parseLookupPolicy(service, input.policy) };
}

export function parseLookupState(service: LookupService, value: unknown): LookupState {
  const state = record(value);
  fields(state, ["approval", "providers", "binding"]);
  const bindingValue = record(state.binding);
  fields(bindingValue, ["approvalRevision", "incarnation"]);
  if (!integer(bindingValue.approvalRevision, 1)) throw new Error("invalid_lookup_binding");
  const binding = { approvalRevision: bindingValue.approvalRevision, incarnation: incarnation(bindingValue.incarnation) };
  if (!Array.isArray(state.providers) || state.providers.length > LOOKUP_SERVICES[service].providers.length) throw new Error("invalid_lookup_providers");
  const providers = Array.from(state.providers, provider => parseLookupProvider(service, provider));
  if (new Set(providers.map(provider => provider.provider)).size !== providers.length) throw new Error("invalid_lookup_providers");
  if (state.approval === null) return { approval: null, providers, binding };
  const approval = record(state.approval);
  fields(approval, ["approvalRevision", "revision", "policy"]);
  if (!integer(approval.approvalRevision, 1) || !integer(approval.revision, 1)
    || approval.approvalRevision > binding.approvalRevision
    || binding.incarnation === null && approval.approvalRevision !== binding.approvalRevision) throw new Error("invalid_lookup_approval");
  return { approval: { approvalRevision: approval.approvalRevision, revision: approval.revision,
    policy: parseLookupPolicy(service, approval.policy) }, providers, binding };
}
