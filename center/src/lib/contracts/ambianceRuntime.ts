import { integer, record, UUID } from "./surfaces";
import { parsePlaceAttribution } from "../placeAttribution";

export const ROOM_METHOD = "cosmos.coordinate.v1";
export const ROOM_PAYLOAD_BYTES = 12288;
export const PLACES_CONTENT_BYTES = 8192;
export interface Stamp { epoch: string; sequence: number; instanceId: string }
export interface RoomConnection {
  version: 1; url: string; token: string; participant: string;
  runtimeParticipant: "runtime"; runtimeEpoch: string; epoch: string;
}
export interface PlacesContent {
  kind: "places"; query: string;
  items: { placeId: string; name: string; address: string; sourceUrl: string | null }[];
  attributions: string[];
}
export type RenderContent = { kind: "text"; text: string } | PlacesContent;
export interface RenderCommand {
  version: 1; actionId: string; turnId: string; generation: number;
  surfaceId: string; incarnation: string; channel: "visual.card";
  contentDigest: string; content: RenderContent; expiresAt: number;
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
function placeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && /\P{White_Space}/u.test(value)
    && new TextEncoder().encode(value).length <= maximum && !/\p{Cc}/u.test(value)
    && !Array.from(value).some(character => { const code = character.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; });
}
function placeSource(value: unknown): value is string | null {
  if (value === null) return true;
  if (!placeText(value, 2048) || /[\p{White_Space}\\]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && (url.hostname === "maps.google.com" || url.hostname === "www.google.com"
        && (url.pathname === "/maps" || url.pathname.startsWith("/maps/")));
  } catch { return false; }
}
function parseContent(value: unknown): RenderContent {
  const content = record(value);
  if (content.kind === "text") {
    fields(content, ["kind", "text"]);
    if (!publicText(content.text)) throw new Error("invalid_content");
  } else if (content.kind === "places") {
    fields(content, ["kind", "query", "items", "attributions"]);
    if (!placeText(content.query, 512) || !Array.isArray(content.items) || content.items.length > 4
      || !Array.isArray(content.attributions) || content.attributions.length > 16
      || new TextEncoder().encode(JSON.stringify(content)).length > PLACES_CONTENT_BYTES) throw new Error("invalid_place_content");
    for (const value of content.items) {
      const item = record(value); fields(item, ["placeId", "name", "address", "sourceUrl"]);
      if (!placeText(item.placeId, 1024) || /\p{White_Space}/u.test(item.placeId)
        || !placeText(item.name, 256) || !placeText(item.address, 512) || !placeSource(item.sourceUrl)) throw new Error("invalid_place_item");
    }
    for (const attribution of content.attributions) {
      if (typeof attribution !== "string") throw new Error("invalid_place_attribution");
      // Unsupported credit must reject the card, never become omitted credit.
      parsePlaceAttribution(attribution);
    }
  } else throw new Error("invalid_content");
  return content as unknown as RenderContent;
}
/** Existing text hashes remain byte-for-byte; Places bind every raw credit. */
export function renderContentPayload(content: RenderContent): string {
  return content.kind === "text" ? content.text : JSON.stringify([
    "cosmos.place-address-card", 1, content.query,
    content.items.map(item => [item.placeId, item.name, item.address, item.sourceUrl]), content.attributions,
  ]);
}
export function parseCommand(value: unknown): RenderCommand {
  const c = record(value);
  fields(c, ["version", "actionId", "turnId", "generation", "surfaceId", "incarnation", "channel", "contentDigest", "content", "expiresAt"]);
  if (c.version !== 1 || ![c.actionId, c.turnId, c.surfaceId, c.incarnation].every(id)
    || !integer(c.generation, 1) || !integer(c.expiresAt, 1) || c.channel !== "visual.card"
    || typeof c.contentDigest !== "string" || !/^[a-f0-9]{64}$/.test(c.contentDigest)) throw new Error("invalid_proof");
  parseContent(c.content);
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
