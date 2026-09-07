// @vitest-environment node
import { expect, it } from "vitest";
import { parseScreenContextApproval, parseScreenContextInput, SCREEN_CONTEXT_APPROVAL } from "./screenContext";

const approval = { approvalRevision: 3, revision: 2, policy: { maximumClass: "private" } };
const input = { approval: SCREEN_CONTEXT_APPROVAL, approvalRevision: 3, expectedRevision: 1, policy: { maximumClass: "private" } };

it("accepts only the private screen-context policy, an explicit null, and exact fields", () => {
  expect(parseScreenContextApproval({ approval })).toEqual(approval);
  expect(parseScreenContextApproval({ approval: { ...approval, policy: null } })).toEqual({ ...approval, policy: null });
  expect(parseScreenContextApproval({ approval: null })).toBeNull();
  for (const bad of [{}, { approval: {} }, { approval: { ...approval, extra: true } }, { approval: { ...approval, revision: 0 } },
    { approval: { ...approval, policy: {} } }, { approval: { ...approval, policy: { maximumClass: "shared_room" } } },
    { approval: { ...approval, policy: { maximumClass: "near_user" } } }, { approval: { ...approval, policy: { maximumClass: "sensitive" } } },
    { approval: { ...approval, policy: { maximumClass: "private", surfaces: [] } } }, { approval, more: 1 }]) {
    expect(() => parseScreenContextApproval(bad), JSON.stringify(bad)).toThrow();
  }
});

it("owner input names the exact approval, the approval revision and the revision it was read at", () => {
  expect(parseScreenContextInput(input)).toEqual(input);
  expect(parseScreenContextInput({ ...input, expectedRevision: 0, policy: null })).toEqual({ ...input, expectedRevision: 0, policy: null });
  for (const bad of [{ ...input, approval: "approve-private-display-v1" }, { ...input, approvalRevision: 0 }, { ...input, expectedRevision: -1 },
    { ...input, expectedRevision: Number.MAX_SAFE_INTEGER }, { ...input, policy: { maximumClass: "shared_room" } }, { ...input, policy: undefined },
    { ...input, surfaceId: "11111111-1111-1111-1111-111111111111" }]) {
    expect(() => parseScreenContextInput(bad), JSON.stringify(bad)).toThrow();
  }
});
