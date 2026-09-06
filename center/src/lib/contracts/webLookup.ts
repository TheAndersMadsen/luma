import { integer, record, UUID } from "./surfaces";

export const WEB_LOOKUP_APPROVAL = "approve-web-lookup-disclosure-v1";
export const WEB_LOOKUP_INPUT_BYTES = 4096;
export const WEB_LOOKUP_RESPONSE_BYTES = 8192;

export interface WebLookupProvider {
  provider: "searxng" | "serp_api";
  endpoint: string;
  configurationDigest: string;
}
export interface WebLookupPolicy { provider: WebLookupProvider; maximumClass: "shared_room" }
export interface WebLookupApproval { approvalRevision: number; revision: number; policy: WebLookupPolicy | null }
export interface WebLookupBinding { approvalRevision: number; incarnation: string | null }
export interface WebLookupInput {
  approval: typeof WEB_LOOKUP_APPROVAL;
  approvalRevision: number;
  approvalIncarnation: string | null;
  expectedRevision: number;
  policy: WebLookupPolicy | null;
}
export interface WebLookupState { approval: WebLookupApproval | null; providers: WebLookupProvider[]; binding: WebLookupBinding }

function fields(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new Error("invalid_web_lookup_fields");
}

function incarnation(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length !== 36 || !UUID.test(value)
    || value === "00000000-0000-0000-0000-000000000000") throw new Error("invalid_web_lookup_incarnation");
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

export function parseWebLookupProvider(value: unknown): WebLookupProvider {
  const provider = record(value);
  fields(provider, ["provider", "endpoint", "configurationDigest"]);
  if ((provider.provider !== "searxng" && provider.provider !== "serp_api") || !endpoint(provider.endpoint)
    || typeof provider.configurationDigest !== "string" || provider.configurationDigest.length !== 64
    || !/^[0-9a-f]{64}$/.test(provider.configurationDigest)) throw new Error("invalid_web_lookup_provider");
  return { provider: provider.provider, endpoint: provider.endpoint, configurationDigest: provider.configurationDigest };
}

export function parseWebLookupPolicy(value: unknown): WebLookupPolicy | null {
  if (value === null) return null;
  const policy = record(value);
  fields(policy, ["provider", "maximumClass"]);
  if (policy.maximumClass !== "shared_room") throw new Error("invalid_web_lookup_policy");
  return { provider: parseWebLookupProvider(policy.provider), maximumClass: "shared_room" };
}

export function parseWebLookupInput(value: unknown): WebLookupInput {
  const input = record(value);
  fields(input, ["approval", "approvalRevision", "approvalIncarnation", "expectedRevision", "policy"]);
  if (input.approval !== WEB_LOOKUP_APPROVAL || !integer(input.approvalRevision, 1)
    || !integer(input.expectedRevision) || !Number.isSafeInteger(input.expectedRevision + 1)) throw new Error("invalid_web_lookup_approval");
  return { approval: WEB_LOOKUP_APPROVAL, approvalRevision: input.approvalRevision,
    approvalIncarnation: incarnation(input.approvalIncarnation), expectedRevision: input.expectedRevision,
    policy: parseWebLookupPolicy(input.policy) };
}

export function parseWebLookupState(value: unknown): WebLookupState {
  const state = record(value);
  fields(state, ["approval", "providers", "binding"]);
  const bindingValue = record(state.binding);
  fields(bindingValue, ["approvalRevision", "incarnation"]);
  if (!integer(bindingValue.approvalRevision, 1)) throw new Error("invalid_web_lookup_binding");
  const binding = { approvalRevision: bindingValue.approvalRevision, incarnation: incarnation(bindingValue.incarnation) };
  if (!Array.isArray(state.providers) || state.providers.length > 2) throw new Error("invalid_web_lookup_providers");
  const providers = Array.from(state.providers, parseWebLookupProvider);
  if (new Set(providers.map(provider => provider.provider)).size !== providers.length) throw new Error("invalid_web_lookup_providers");
  if (state.approval === null) return { approval: null, providers, binding };
  const approval = record(state.approval);
  fields(approval, ["approvalRevision", "revision", "policy"]);
  if (!integer(approval.approvalRevision, 1) || !integer(approval.revision, 1)
    || approval.approvalRevision > binding.approvalRevision
    || binding.incarnation === null && approval.approvalRevision !== binding.approvalRevision) throw new Error("invalid_web_lookup_approval");
  return { approval: { approvalRevision: approval.approvalRevision, revision: approval.revision,
    policy: parseWebLookupPolicy(approval.policy) }, providers, binding };
}
