import { fields } from "./ambianceRuntime";
import { integer, record } from "./surfaces";

export const SPEECH_DISCLOSURE_APPROVAL = "approve-speech-provider-disclosure-v1";
export const SPEECH_REGION = /^[a-z0-9-]{1,32}$/;
export const PRIVACY_CLASSES = ["public", "shared_room", "near_user", "private", "sensitive"] as const;
export interface SpeechPolicy {
  provider: { provider: "azure_speech"; region: string };
  maximumClass: typeof PRIVACY_CLASSES[number];
  transcription: boolean;
  synthesis: boolean;
}
export interface SpeechApproval { approvalRevision: number; revision: number; policy: SpeechPolicy | null }
export interface SpeechDisclosureInput {
  approval: typeof SPEECH_DISCLOSURE_APPROVAL;
  approvalRevision: number;
  expectedRevision: number;
  policy: SpeechPolicy | null;
}

function parsePolicy(value: unknown): SpeechPolicy | null {
  if (value === null) return null;
  const policy = record(value);
  fields(policy, ["provider", "maximumClass", "transcription", "synthesis"]);
  const provider = record(policy.provider);
  fields(provider, ["provider", "region"]);
  if (provider.provider !== "azure_speech" || typeof provider.region !== "string" || !SPEECH_REGION.test(provider.region)
    || !PRIVACY_CLASSES.some(value => value === policy.maximumClass)
    || typeof policy.transcription !== "boolean" || typeof policy.synthesis !== "boolean"
    || !policy.transcription && !policy.synthesis) throw new Error("invalid_speech_policy");
  return { provider: { provider: "azure_speech", region: provider.region }, maximumClass: policy.maximumClass as SpeechPolicy["maximumClass"],
    transcription: policy.transcription, synthesis: policy.synthesis };
}

export function parseSpeechApproval(value: unknown): SpeechApproval | null {
  const result = record(value);
  fields(result, ["approval"]);
  if (result.approval === null) return null;
  const approval = record(result.approval);
  fields(approval, ["approvalRevision", "revision", "policy"]);
  if (!integer(approval.approvalRevision, 1) || !integer(approval.revision, 1)) throw new Error("invalid_speech_approval");
  return { approvalRevision: approval.approvalRevision, revision: approval.revision, policy: parsePolicy(approval.policy) };
}

export function parseSpeechDisclosureInput(value: unknown): SpeechDisclosureInput {
  const input = record(value);
  fields(input, ["approval", "approvalRevision", "expectedRevision", "policy"]);
  if (input.approval !== SPEECH_DISCLOSURE_APPROVAL || !integer(input.approvalRevision, 1)
    || !integer(input.expectedRevision) || !Number.isSafeInteger(input.expectedRevision + 1)) throw new Error("invalid_speech_approval");
  return { approval: SPEECH_DISCLOSURE_APPROVAL, approvalRevision: input.approvalRevision,
    expectedRevision: input.expectedRevision, policy: parsePolicy(input.policy) };
}
