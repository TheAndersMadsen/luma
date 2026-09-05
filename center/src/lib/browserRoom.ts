import { Room, RoomEvent, RpcError } from "livekit-client";
import { ROOM_METHOD, type RoomConnection } from "./contracts/ambianceRuntime";

/** The only browser SDK boundary. Application authority stays in Cosmos. */
export interface BrowserRoom {
  connect(connection: RoomConnection, receive: (payload: string) => Promise<string>, lost: () => void): Promise<void>;
  invoke(payload: string): Promise<string>;
  close(): void;
}
export function createBrowserRoom(): BrowserRoom {
  const room = new Room({ reconnectPolicy: { nextRetryDelayInMs: () => null }, disconnectOnPageLeave: true });
  let stopped = false;
  let runtime = "";
  const close = () => { if (!stopped) { stopped = true; void room.disconnect().catch(() => {}); } };
  return {
    async connect(connection, receive, lost) {
      runtime = connection.runtimeParticipant;
      const fail = () => { if (!stopped) { close(); lost(); } };
      for (const event of [RoomEvent.Disconnected, RoomEvent.Reconnecting, RoomEvent.SignalReconnecting]) room.on(event, fail);
      room.on(RoomEvent.ParticipantDisconnected, peer => { if (peer.identity === runtime) fail(); });
      room.registerRpcMethod(ROOM_METHOD, async data => {
        if (stopped || data.callerIdentity !== runtime) throw new RpcError(1403, "invalid_runtime");
        try { return await receive(data.payload); }
        catch { throw new RpcError(1400, "invalid_frame"); }
      });
      await room.connect(connection.url, connection.token, { autoSubscribe: false, websocketTimeout: 10000, peerConnectionTimeout: 10000 });
      if (stopped || room.localParticipant.identity !== connection.participant) { close(); throw new Error("wrong_participant"); }
    },
    invoke(payload) {
      if (stopped || !runtime) return Promise.reject(new Error("disconnected"));
      return room.localParticipant.performRpc({ destinationIdentity: runtime, method: ROOM_METHOD, payload, responseTimeout: 3000 });
    },
    close,
  };
}
