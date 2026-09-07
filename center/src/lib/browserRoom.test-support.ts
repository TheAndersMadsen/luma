import { vi } from "vitest";
import type { BrowserRoom } from "./browserRoom";
import type { RenderCommand, RoomConnection, Stamp, TurnStatus } from "./contracts/ambianceRuntime";

export const incarnation = "22222222-2222-2222-2222-222222222222";
export const runtimeEpoch = "55555555-5555-5555-5555-555555555555";
export function roomConnection(epoch: string): RoomConnection {
  return { version: 1, url: "wss://center.test/livekit", token: "e30.e30.c2ln",
    participant: "66666666-6666-6666-6666-666666666666", runtimeParticipant: "runtime", runtimeEpoch, epoch };
}
export class TestRoom implements BrowserRoom {
  receive!: (payload: string) => Promise<string>;
  lost!: () => void;
  connect = vi.fn(async (_connection: RoomConnection, receive: (payload: string) => Promise<string>, lost: () => void) => {
    this.receive = receive; this.lost = lost;
  });
  invoke = vi.fn(async (payload: string) => {
    const request = JSON.parse(payload);
    return JSON.stringify(request.kind === "input" ? { version: 1, kind: "admitted", duplicate: false,
      turnId: request.stamp.instanceId, generation: 1 } : { version: 1, kind: "accepted", duplicate: false });
  });
  close = vi.fn();
  frame(command: RenderCommand, sequence = 1, epoch = runtimeEpoch) {
    return JSON.stringify({ version: 1, kind: "render", stamp: { epoch, sequence, instanceId: command.actionId }, command });
  }
  clear(actionId: string, sequence = 2) {
    const stamp: Stamp = { epoch: runtimeEpoch, sequence, instanceId: crypto.randomUUID() };
    return this.receive(JSON.stringify({ version: 1, kind: "clear", stamp, actionId }));
  }
  status(status: Partial<TurnStatus> & Pick<TurnStatus, "turnId" | "state">, sequence = 2) {
    const stamp: Stamp = { epoch: runtimeEpoch, sequence, instanceId: crypto.randomUUID() };
    return this.receive(JSON.stringify({ version: 1, kind: "status", stamp,
      status: { version: 1, generation: 1, surface: null, privacy: "shared_room", ...status } }));
  }
  messages() { return this.invoke.mock.calls.map(([payload]) => JSON.parse(payload)); }
}
