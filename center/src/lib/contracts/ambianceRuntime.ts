import { integer, record, UUID } from "./surfaces";

export const ROOM_METHOD = "cosmos.coordinate.v1";
export const ROOM_PAYLOAD_BYTES = 12288;
export interface Stamp { epoch: string; sequence: number; instanceId: string }
export interface RoomConnection {
  version: 1; url: string; token: string; participant: string;
  runtimeParticipant: "runtime"; runtimeEpoch: string; epoch: string;
}
export interface RenderCommand {
  version: 1; actionId: string; turnId: string; generation: number;
  surfaceId: string; incarnation: string; channel: "visual.card";
  contentDigest: string; content: { kind: "text"; text: string }; expiresAt: number;
}
export type RuntimeFrame = { version: 1; kind: "render"; stamp: Stamp; command: RenderCommand }
  | { version: 1; kind: "clear"; stamp: Stamp; actionId: string };
export type BrowserControl = { kind: "state"; visible: boolean }
  | { kind: "cancel"; turnId: string; generation: number }
  | { kind: "acknowledge"; actionId: string; turnId: string; generation: number; channel: "visual.card"; contentDigest: string };
export function fields(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).length !== names.length || names.some(name => !(name in value))) throw new Error("invalid_fields");
}
function id(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value) && value !== "00000000-0000-0000-0000-000000000000";
}
export function parseRoomRequest(value: unknown) {
  const body = record(value); fields(body, ["surfaceId", "incarnation", "epoch"]);
  if (![body.surfaceId, body.incarnation, body.epoch].every(id)) throw new Error("invalid_id");
  return body;
}
export function parseRoomConnection(value: unknown, origin: string): RoomConnection {
  const c = record(value);
  fields(c, ["version", "url", "token", "participant", "runtimeParticipant", "runtimeEpoch", "epoch"]);
  if (c.version !== 1 || c.runtimeParticipant !== "runtime" || ![c.participant, c.runtimeEpoch, c.epoch].every(id)
    || typeof c.token !== "string" || c.token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(c.token)
    || typeof c.url !== "string" || c.url.length > 2048) throw new Error("invalid_room");
  const page = new URL(origin); const url = new URL(c.url);
  const sameOrigin = page.protocol === "https:" && url.href === `wss://${page.host}/livekit`;
  const loopback = page.protocol === "http:" && page.hostname === "127.0.0.1" && url.href === "ws://127.0.0.1:7880/";
  if (!sameOrigin && !loopback) throw new Error("invalid_room_origin");
  return c as unknown as RoomConnection;
}
export function publicText(text: unknown): text is string {
  return typeof text === "string" && !!text.trim() && new TextEncoder().encode(text).length <= 4000;
}
export function parseCommand(value: unknown): RenderCommand {
  const c = record(value);
  fields(c, ["version", "actionId", "turnId", "generation", "surfaceId", "incarnation", "channel", "contentDigest", "content", "expiresAt"]);
  if (c.version !== 1 || ![c.actionId, c.turnId, c.surfaceId, c.incarnation].every(id)
    || !integer(c.generation, 1) || !integer(c.expiresAt, 1) || c.channel !== "visual.card"
    || typeof c.contentDigest !== "string" || !/^[a-f0-9]{64}$/.test(c.contentDigest)) throw new Error("invalid_proof");
  const content = record(c.content); fields(content, ["kind", "text"]);
  if (content.kind !== "text" || !publicText(content.text)) throw new Error("invalid_content");
  return c as unknown as RenderCommand;
}
export function parseFrame(payload: string): RuntimeFrame {
  if (new TextEncoder().encode(payload).length > ROOM_PAYLOAD_BYTES) throw new Error("oversized_frame");
  const frame = record(JSON.parse(payload));
  if (frame.version !== 1 || !["render", "clear"].includes(String(frame.kind))) throw new Error("invalid_frame");
  fields(frame, ["version", "kind", "stamp", frame.kind === "render" ? "command" : "actionId"]);
  const stamp = record(frame.stamp); fields(stamp, ["epoch", "sequence", "instanceId"]);
  if (!id(stamp.epoch) || !id(stamp.instanceId) || !integer(stamp.sequence, 1)) throw new Error("invalid_stamp");
  if (frame.kind === "render") {
    const command = parseCommand(frame.command);
    if (command.actionId !== stamp.instanceId) throw new Error("wrong_instance");
  } else if (!id(frame.actionId)) throw new Error("invalid_clear");
  return frame as unknown as RuntimeFrame;
}
export function parseAdmission(payload: string, turnId?: string) {
  if (new TextEncoder().encode(payload).length > 1024) throw new Error("oversized_admission");
  const response = record(JSON.parse(payload));
  fields(response, turnId ? ["version", "kind", "turnId", "generation", "duplicate"] : ["version", "kind", "duplicate"]);
  if (response.version !== 1 || typeof response.duplicate !== "boolean" ||
    response.kind !== (turnId ? "admitted" : "accepted") ||
    (turnId && (response.turnId !== turnId || !integer(response.generation, 1)))) throw new Error("invalid_admission");
  return response;
}
