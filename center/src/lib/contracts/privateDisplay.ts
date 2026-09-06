import { fields } from "./ambianceRuntime";
import { integer, record } from "./surfaces";

export const PRIVATE_DISPLAY_APPROVAL = "approve-private-display-v1";
/** Classes a personal device may be allowed to show; sensitive content has no display ceiling. */
export const PRIVATE_DISPLAY_CLASSES = ["near_user", "private"] as const;
export interface PrivateDisplayPolicy { maximumClass: typeof PRIVATE_DISPLAY_CLASSES[number] }
export interface PrivateDisplayApproval { approvalRevision: number; revision: number; policy: PrivateDisplayPolicy | null }
export interface PrivateDisplayInput {
  approval: typeof PRIVATE_DISPLAY_APPROVAL;
  approvalRevision: number;
  expectedRevision: number;
  policy: PrivateDisplayPolicy | null;
}

function parsePolicy(value: unknown): PrivateDisplayPolicy | null {
  if (value === null) return null;
  const policy = record(value);
  fields(policy, ["maximumClass"]);
  if (!PRIVATE_DISPLAY_CLASSES.some(name => name === policy.maximumClass)) throw new Error("invalid_private_display_policy");
  return { maximumClass: policy.maximumClass as PrivateDisplayPolicy["maximumClass"] };
}

export function parsePrivateDisplayApproval(value: unknown): PrivateDisplayApproval | null {
  const result = record(value);
  fields(result, ["approval"]);
  if (result.approval === null) return null;
  const approval = record(result.approval);
  fields(approval, ["approvalRevision", "revision", "policy"]);
  if (!integer(approval.approvalRevision, 1) || !integer(approval.revision, 1)) throw new Error("invalid_private_display_approval");
  return { approvalRevision: approval.approvalRevision, revision: approval.revision, policy: parsePolicy(approval.policy) };
}

export function parsePrivateDisplayInput(value: unknown): PrivateDisplayInput {
  const input = record(value);
  fields(input, ["approval", "approvalRevision", "expectedRevision", "policy"]);
  if (input.approval !== PRIVATE_DISPLAY_APPROVAL || !integer(input.approvalRevision, 1)
    || !integer(input.expectedRevision) || !Number.isSafeInteger(input.expectedRevision + 1)) throw new Error("invalid_private_display_approval");
  return { approval: PRIVATE_DISPLAY_APPROVAL, approvalRevision: input.approvalRevision,
    expectedRevision: input.expectedRevision, policy: parsePolicy(input.policy) };
}
