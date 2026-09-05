// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseCommand, parseRoomRequest, parseRoomConnection, parseFrame, publicText } from "./ambianceRuntime";
import { roomConnection, runtimeEpoch } from "../browserRoom.test-support";
it("browser runtime wire bounds match the canonical contract", () => {
  const contract = JSON.parse(readFileSync(new URL("../../../../contracts/ambiance-runtime.json", import.meta.url), "utf8"));
  expect(contract.limits.textBytes).toBe(4000); expect(contract.limits.ackDeadlineMs).toBe(3000); expect(contract.limits.displayLifetimeMs).toBe(60000);
  const proof = { surfaceId: "11111111-1111-1111-1111-111111111111", incarnation: "22222222-2222-2222-2222-222222222222" };
  expect(publicText("é".repeat(2000))).toBe(true);
  expect(publicText("é".repeat(2001))).toBe(false);
  expect(() => parseRoomRequest({ ...proof, epoch: runtimeEpoch })).not.toThrow();
  expect(() => parseRoomRequest({ ...proof, epoch: runtimeEpoch, trust: 2 })).toThrow();
  expect(() => parseCommand({ ...proof, version: 1, actionId: proof.surfaceId, turnId: proof.incarnation, generation: 1, channel: "visual.card", contentDigest: "a".repeat(64), expiresAt: 1, content: { kind: "html", text: "<script/>" } })).toThrow();
});
it("accepts only exact room fields and the configured same-origin signal path", () => {
  const valid = roomConnection(runtimeEpoch);
  expect(parseRoomConnection(valid, "https://center.test")).toEqual(valid);
  for (const url of ["wss://other.test/livekit", "ws://center.test/livekit", "wss://center.test/livekit/",
    "wss://center.test/livekit?token=x", "wss://user@center.test/livekit", "wss://center.test/rtc"]) {
    expect(() => parseRoomConnection({ ...valid, url }, "https://center.test")).toThrow();
  }
  expect(() => parseRoomConnection({ ...valid, owner: "other" }, "https://center.test")).toThrow();
  expect(() => parseFrame(JSON.stringify({ version: 1, kind: "clear", actionId: runtimeEpoch,
    stamp: { epoch: runtimeEpoch, sequence: Number.MAX_SAFE_INTEGER + 1, instanceId: runtimeEpoch } }))).toThrow();
});
