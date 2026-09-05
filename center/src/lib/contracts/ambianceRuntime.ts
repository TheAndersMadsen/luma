import { integer, record, UUID } from "./surfaces";

export type RuntimeOperation = "poll" | "ack" | "input";
export interface RenderCommand {
  version: 1; actionId: string; turnId: string; generation: number;
  surfaceId: string; incarnation: string; channel: "visual.card";
  contentDigest: string; content: { kind: "text"; text: string }; expiresAt: number;
}
export function fields(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).length !== names.length || names.some(name => !(name in value))) throw new Error("invalid_fields");
}
export function parseRuntimeRequest(value: unknown, operation: RuntimeOperation) {
  const body = record(value);
  fields(body, ["surfaceId", "incarnation", ...(operation === "input" ? ["text"] : operation === "ack" ? ["actionId", "turnId", "generation", "channel", "contentDigest"] : [])]);
  for (const key of ["surfaceId", "incarnation", ...(operation === "ack" ? ["actionId", "turnId"] : [])]) {
    if (typeof body[key] !== "string" || !UUID.test(body[key])) throw new Error("invalid_id");
  }
  if (operation === "input" && (typeof body.text !== "string" || !body.text.trim() || new TextEncoder().encode(body.text).length > 4000)) throw new Error("invalid_text");
  if (operation === "ack" && (!integer(body.generation, 1) || body.channel !== "visual.card" || typeof body.contentDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.contentDigest))) throw new Error("invalid_proof");
  return body;
}
export function parseCommand(value: unknown): RenderCommand {
  const c = record(value);
  fields(c, ["version", "actionId", "turnId", "generation", "surfaceId", "incarnation", "channel", "contentDigest", "content", "expiresAt"]);
  const { version, content, expiresAt, ...proof } = c;
  parseRuntimeRequest(proof, "ack");
  const text = record(content); fields(text, ["kind", "text"]);
  if (version !== 1 || !integer(expiresAt, 1) || text.kind !== "text" || typeof text.text !== "string" || !text.text.trim() || new TextEncoder().encode(text.text).length > 4000) throw new Error("invalid_command");
  return c as unknown as RenderCommand;
}
export function commandProof(command: RenderCommand) {
  const { version: _version, content: _content, expiresAt: _expiresAt, ...proof } = command;
  return proof;
}
export function parsePoll(value: unknown): { commands: RenderCommand[]; clear: string[] } {
  const result = record(value); fields(result, ["commands", "clear"]);
  if (!Array.isArray(result.commands) || result.commands.length > 1 || !Array.isArray(result.clear) || result.clear.length > 32 || result.clear.some(id => typeof id !== "string" || !UUID.test(id))) throw new Error("invalid_poll");
  return { commands: result.commands.map(parseCommand), clear: result.clear as string[] };
}
