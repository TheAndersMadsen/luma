// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseCommand, parseRuntimeRequest } from "./ambianceRuntime";
it("browser runtime wire bounds match the canonical contract", () => {
  const contract = JSON.parse(readFileSync(new URL("../../../../contracts/ambiance-runtime.json", import.meta.url), "utf8"));
  expect(contract.limits.textBytes).toBe(4000); expect(contract.limits.ackDeadlineMs).toBe(3000); expect(contract.limits.displayLifetimeMs).toBe(60000);
  const proof = { surfaceId: "11111111-1111-1111-1111-111111111111", incarnation: "22222222-2222-2222-2222-222222222222" };
  expect(() => parseRuntimeRequest({ ...proof, text: "é".repeat(2000) }, "input")).not.toThrow();
  expect(() => parseRuntimeRequest({ ...proof, text: "é".repeat(2001) }, "input")).toThrow();
  expect(() => parseCommand({ ...proof, version: 1, actionId: proof.surfaceId, turnId: proof.incarnation, generation: 1, channel: "visual.card", contentDigest: "a".repeat(64), expiresAt: 1, content: { kind: "html", text: "<script/>" } })).toThrow();
});
