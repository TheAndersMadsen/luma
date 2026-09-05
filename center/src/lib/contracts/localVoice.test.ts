// @vitest-environment node
import { expect, it } from "vitest";
import { LOCAL_VOICE_APPROVAL, LOCAL_VOICE_FLOORS, parseLocalVoiceApproval, parseLocalVoiceInput } from "./localVoice";

const input = { approval: LOCAL_VOICE_APPROVAL, approvalRevision: 2, expectedRevision: 3, policy: { sourceFloor: "shared_room" } };
const approval = { approvalRevision: 2, revision: 4, policy: input.policy };

it("local voice accepts only explicit permitted floors or revocation, independently of cloud speech", () => {
  for (const policy of [...LOCAL_VOICE_FLOORS.map(sourceFloor => ({ sourceFloor })), null]) {
    expect(parseLocalVoiceInput({ ...input, policy })).toEqual({ ...input, policy });
    expect(parseLocalVoiceApproval({ approval: { ...approval, policy } })).toEqual({ ...approval, policy });
  }
  expect(parseLocalVoiceApproval({ approval: null })).toBeNull();
  for (const policy of [undefined, {}, [], { sourceFloor: "public" }, { sourceFloor: "shared_room", provider: "azure_speech" },
    { sourceFloor: "private", privateRoom: true }, { sourceFloor: 1 }]) {
    expect(() => parseLocalVoiceInput({ ...input, policy })).toThrow();
    expect(() => parseLocalVoiceApproval({ approval: { ...approval, policy } })).toThrow();
  }
});

it("local voice rejects extra or missing authority and unrepresentable revisions", () => {
  const { policy: _policy, ...missing } = input;
  for (const invalid of [null, [], missing, { ...input, approval: "approve-speech-provider-disclosure-v1" }, { ...input, accountId: "other" },
    { ...input, approvalRevision: 0 }, { ...input, expectedRevision: -1 }, { ...input, expectedRevision: 1.5 },
    { ...input, expectedRevision: Number.MAX_SAFE_INTEGER }, { ...input, approvalRevision: Number.MAX_SAFE_INTEGER + 1 }]) {
    expect(() => parseLocalVoiceInput(invalid)).toThrow();
  }
  for (const invalid of [{}, { approval: undefined }, { approval: null, secret: "hidden" }]) {
    expect(() => parseLocalVoiceApproval(invalid)).toThrow();
  }
  for (const invalid of [{ ...approval, revision: 0 }, { ...approval, revision: 1.5 }, { ...approval, approvalRevision: 0 },
    { ...approval, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...approval, token: "hidden" }]) {
    expect(() => parseLocalVoiceApproval({ approval: invalid })).toThrow();
  }
});
