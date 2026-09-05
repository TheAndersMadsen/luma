import { fields } from "./ambianceRuntime";
import { integer, record } from "./surfaces";

export const LOCAL_VOICE_APPROVAL = "approve-local-voice-intake-v1";
export const LOCAL_VOICE_FLOORS = ["shared_room", "near_user", "private", "sensitive"] as const;
export interface LocalVoicePolicy { sourceFloor: typeof LOCAL_VOICE_FLOORS[number] }
export interface LocalVoiceApproval { approvalRevision: number; revision: number; policy: LocalVoicePolicy | null }
export interface LocalVoiceInput {
  approval: typeof LOCAL_VOICE_APPROVAL;
  approvalRevision: number;
  expectedRevision: number;
  policy: LocalVoicePolicy | null;
}

function parsePolicy(value: unknown): LocalVoicePolicy | null {
  if (value === null) return null;
  const policy = record(value);
  fields(policy, ["sourceFloor"]);
  if (!LOCAL_VOICE_FLOORS.some(floor => floor === policy.sourceFloor)) throw new Error("invalid_local_voice_policy");
  return { sourceFloor: policy.sourceFloor as LocalVoicePolicy["sourceFloor"] };
}

export function parseLocalVoiceApproval(value: unknown): LocalVoiceApproval | null {
  const result = record(value);
  fields(result, ["approval"]);
  if (result.approval === null) return null;
  const approval = record(result.approval);
  fields(approval, ["approvalRevision", "revision", "policy"]);
  if (!integer(approval.approvalRevision, 1) || !integer(approval.revision, 1)) throw new Error("invalid_local_voice_approval");
  return { approvalRevision: approval.approvalRevision, revision: approval.revision, policy: parsePolicy(approval.policy) };
}

export function parseLocalVoiceInput(value: unknown): LocalVoiceInput {
  const input = record(value);
  fields(input, ["approval", "approvalRevision", "expectedRevision", "policy"]);
  if (input.approval !== LOCAL_VOICE_APPROVAL || !integer(input.approvalRevision, 1)
    || !integer(input.expectedRevision) || !Number.isSafeInteger(input.expectedRevision + 1)) throw new Error("invalid_local_voice_approval");
  return { approval: LOCAL_VOICE_APPROVAL, approvalRevision: input.approvalRevision,
    expectedRevision: input.expectedRevision, policy: parsePolicy(input.policy) };
}
