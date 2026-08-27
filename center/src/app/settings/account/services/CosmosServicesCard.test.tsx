import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CosmosServicesCard } from "./CosmosServicesCard";

const assistantStatus = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock("@/components/AiMicChat", () => ({
  useAssistantStatus: () => ({ data: assistantStatus.data }),
}));

describe("CosmosServicesCard", () => {
  beforeEach(() => {
    assistantStatus.data = undefined;
  });

  it("does not call healthy Cosmos services unavailable while their status is loading", () => {
    render(<CosmosServicesCard operator={false} />);

    expect(screen.queryAllByText("Unavailable")).toHaveLength(0);
    expect(screen.getAllByText("Checking…")).toHaveLength(5);
  });
});
