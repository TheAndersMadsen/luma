import { fields } from "./ambianceRuntime";
import { integer, record } from "./surfaces";

export const SCREEN_CONTEXT_APPROVAL = "approve-screen-context-v1";
/** Screen text is read once for a private reply on the same device; it never reaches a shared surface. */
export const SCREEN_CONTEXT_CLASSES = ["private"] as const;
export interface ScreenContextPolicy { maximumClass: typeof SCREEN_CONTEXT_CLASSES[number] }
export interface ScreenContextApproval { approvalRevision: number; revision: number; policy: ScreenContextPolicy | null }
export interface ScreenContextInput {
  approval: typeof SCREEN_CONTEXT_APPROVAL;
  approvalRevision: number;
  expectedRevision: number;
  policy: ScreenContextPolicy | null;
}

function parsePolicy(value: unknown): ScreenContextPolicy | null {
  if (value === null) return null;
  const policy = record(value);
  fields(policy, ["maximumClass"]);
  if (!SCREEN_CONTEXT_CLASSES.some(name => name === policy.maximumClass)) throw new Error("invalid_screen_context_policy");
  return { maximumClass: policy.maximumClass as ScreenContextPolicy["maximumClass"] };
}

export function parseScreenContextApproval(value: unknown): ScreenContextApproval | null {
  const result = record(value);
  fields(result, ["approval"]);
  if (result.approval === null) return null;
  const approval = record(result.approval);
  fields(approval, ["approvalRevision", "revision", "policy"]);
  if (!integer(approval.approvalRevision, 1) || !integer(approval.revision, 1)) throw new Error("invalid_screen_context_approval");
  return { approvalRevision: approval.approvalRevision, revision: approval.revision, policy: parsePolicy(approval.policy) };
}

export function parseScreenContextInput(value: unknown): ScreenContextInput {
  const input = record(value);
  fields(input, ["approval", "approvalRevision", "expectedRevision", "policy"]);
  if (input.approval !== SCREEN_CONTEXT_APPROVAL || !integer(input.approvalRevision, 1)
    || !integer(input.expectedRevision) || !Number.isSafeInteger(input.expectedRevision + 1)) throw new Error("invalid_screen_context_approval");
  return { approval: SCREEN_CONTEXT_APPROVAL, approvalRevision: input.approvalRevision,
    expectedRevision: input.expectedRevision, policy: parsePolicy(input.policy) };
}
