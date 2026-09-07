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
/** A short numbered list the owner can answer by number; Cosmos assigns ids "1".."8" in list order. */
export interface ChoicesContent {
  kind: "choices"; title: string;
  items: { id: string; title: string; detail: string }[];
}
export type RenderContent = { kind: "text"; text: string } | PlacesContent | ChoicesContent;
export interface RenderCommand {
  version: 1; actionId: string; turnId: string; generation: number;
  surfaceId: string; incarnation: string; channel: "visual.card";
  contentDigest: string; content: RenderContent; expiresAt: number;
  /** The class the runtime routed this card at; a browser only ever receives shared-room cards. */
  privacy: PrivacyClass;
}
export const PRIVACY_CLASSES = ["public", "shared_room", "near_user", "private", "sensitive"] as const;
export type PrivacyClass = typeof PRIVACY_CLASSES[number];
export const TURN_STATES = ["working", "waiting", "confirming", "acting", "shown", "spoken", "done", "refused", "nowhere", "unknown"] as const;
export type TurnState = typeof TURN_STATES[number];
/**
 * A kind of approved surface one request named for itself. It is weighed among
 * the surfaces that could already take the reply: it never makes a blocked one
 * eligible, and Cosmos still moves the reply when that kind cannot take it.
 */
export const ROUTING_TARGETS = ["browser", "macos", "linux", "android", "android_tv"] as const;
export type RoutingTarget = typeof ROUTING_TARGETS[number];
/** Where one turn stands, content-free: the runtime names a kind of device, never text or a device ID. */
export interface TurnStatus {
  version: 1; turnId: string; generation: number; state: TurnState;
  surface: { platform: string } | null; privacy: PrivacyClass;
}
export type RuntimeFrame = { version: 1; kind: "render"; stamp: Stamp; command: RenderCommand }
  | { version: 1; kind: "clear"; stamp: Stamp; actionId: string }
  | { version: 1; kind: "status"; stamp: Stamp; status: TurnStatus };
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
  } else if (content.kind === "choices") {
    fields(content, ["kind", "title", "items"]);
    if (!placeText(content.title, 120) || !Array.isArray(content.items) || content.items.length < 2 || content.items.length > 8) throw new Error("invalid_choice_content");
    for (const [index, value] of content.items.entries()) {
      const item = record(value); fields(item, ["id", "title", "detail"]);
      if (item.id !== String(index + 1) || !placeText(item.title, 80) || item.detail !== "" && !placeText(item.detail, 200)) throw new Error("invalid_choice_item");
    }
  } else throw new Error("invalid_content");
  return content as unknown as RenderContent;
}
/** Existing text hashes remain byte-for-byte; Places bind every raw credit; choices bind id, title and detail in order. */
export function renderContentPayload(content: RenderContent): string {
  if (content.kind === "text") return content.text;
  if (content.kind === "choices") return JSON.stringify(["cosmos.choice-list", 1, content.title, content.items.map(item => [item.id, item.title, item.detail])]);
  return JSON.stringify([
    "cosmos.place-address-card", 1, content.query,
    content.items.map(item => [item.placeId, item.name, item.address, item.sourceUrl]), content.attributions,
  ]);
}
function parseStatus(value: unknown): TurnStatus {
  const status = record(value);
  fields(status, ["version", "turnId", "generation", "state", "surface", "privacy"]);
  if (status.version !== 1 || !id(status.turnId) || !integer(status.generation, 1) || !TURN_STATES.some(name => name === status.state)
    || !PRIVACY_CLASSES.some(name => name === status.privacy)) throw new Error("invalid_status");
  if (status.surface !== null) {
    const surface = record(status.surface); fields(surface, ["platform"]);
    if (typeof surface.platform !== "string" || !/^[a-z][a-z_]{0,31}$/.test(surface.platform)) throw new Error("invalid_status");
  }
  return status as unknown as TurnStatus;
}
export function parseCommand(value: unknown): RenderCommand {
  const c = record(value);
  fields(c, ["version", "actionId", "turnId", "generation", "surfaceId", "incarnation", "channel", "contentDigest", "content", "expiresAt", "privacy"]);
  if (c.version !== 1 || ![c.actionId, c.turnId, c.surfaceId, c.incarnation].every(id)
    || !integer(c.generation, 1) || !integer(c.expiresAt, 1) || c.channel !== "visual.card"
    || !PRIVACY_CLASSES.some(name => name === c.privacy) || c.privacy === "near_user" || c.privacy === "private" || c.privacy === "sensitive"
    || typeof c.contentDigest !== "string" || !/^[a-f0-9]{64}$/.test(c.contentDigest)) throw new Error("invalid_proof");
  parseContent(c.content);
  return c as unknown as RenderCommand;
}
export function parseFrame(payload: string): RuntimeFrame {
  if (new TextEncoder().encode(payload).length > ROOM_PAYLOAD_BYTES) throw new Error("oversized_frame");
  const frame = record(JSON.parse(payload));
  if (frame.version !== 1 || !["render", "clear", "status"].includes(String(frame.kind))) throw new Error("invalid_frame");
  fields(frame, ["version", "kind", "stamp", frame.kind === "render" ? "command" : frame.kind === "clear" ? "actionId" : "status"]);
  const stamp = record(frame.stamp); fields(stamp, ["epoch", "sequence", "instanceId"]);
  if (!id(stamp.epoch) || !id(stamp.instanceId) || !integer(stamp.sequence, 1)) throw new Error("invalid_stamp");
  if (frame.kind === "render") {
    const command = parseCommand(frame.command);
    if (command.actionId !== stamp.instanceId) throw new Error("wrong_instance");
  } else if (frame.kind === "status") parseStatus(frame.status);
  else if (!id(frame.actionId)) throw new Error("invalid_clear");
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
