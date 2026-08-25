import { describe, expect, it } from "vitest";

import { assistantCompletionMessage } from "./AiMicChat";

describe("assistantCompletionMessage", () => {
  it("directs device actions to the physical Ai Pin", () => {
    expect(assistantCompletionMessage([{ kind: "action", source: "device" }])).toBe(
      "This action is only available on your Ai Pin.",
    );
  });

  it("attributes an answerless server turn to Cosmos", () => {
    expect(assistantCompletionMessage([{ kind: "action", source: "server" }])).toBe(
      "Cosmos did not return a reply. Try again.",
    );
  });
});
