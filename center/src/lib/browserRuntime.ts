import { commandProof, parsePoll, type RenderCommand } from "./contracts/ambianceRuntime";
import type { SurfaceConnection } from "./contracts/surfaces";
class RuntimeRequestError extends Error { constructor(readonly status: number) { super("runtime_unavailable"); } }

/** One mounted renderer. No global state, storage, history, or independent queue. */
export class BrowserRuntime {
  private connection: SurfaceConnection | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private current: RenderCommand | null = null;
  private blockedIncarnation: string | null = null;
  private expired = new Set<string>();
  private acknowledged = new Set<string>();
  private acknowledging = new Set<string>();
  private failureHandler: ((incarnation: string) => void) | undefined;
  constructor(readonly surfaceId: string, private render: (command: RenderCommand | null) => void, private status: (message: string) => void) {}
  onFailure(handler: (incarnation: string) => void) { this.failureHandler = handler; }
  stop() {
    this.generation++; this.controller?.abort(); this.controller = null; this.connection = null;
    clearTimeout(this.timer); clearTimeout(this.expiry); this.current = null;
    this.acknowledged.clear(); this.acknowledging.clear(); this.expired.clear(); this.render(null); this.status("");
  }
  start(connection: SurfaceConnection) {
    if (this.blockedIncarnation === connection.incarnation) return;
    if (this.connection?.incarnation === connection.incarnation) return;
    this.stop(); this.connection = connection; this.controller = new AbortController();
    this.status("Ready for public text requests."); void this.poll(this.generation);
  }
  private fail(message: string) {
    const incarnation = this.connection?.incarnation;
    this.blockedIncarnation = incarnation ?? null; this.stop();
    if (incarnation) this.failureHandler?.(incarnation);
    this.status(message);
  }
  private async request(operation: "poll" | "ack" | "input", extra: Record<string, unknown> = {}) {
    const connection = this.connection; const controller = this.controller;
    if (!connection || !controller || connection.expiresAt <= Date.now() || document.visibilityState !== "visible") throw new Error("inactive");
    const response = await fetch(`/api/runtime/${operation}`, {
      method: "POST", headers: { "content-type": "application/json", "x-cosmos-surface-token": connection.token },
      body: JSON.stringify({ surfaceId: this.surfaceId, incarnation: connection.incarnation, ...extra }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(operation === "input" ? 30000 : operation === "ack" ? 1000 : 5000)]), cache: "no-store",
    });
    if (!response.ok) throw new RuntimeRequestError(response.status);
    return response.json();
  }
  private async poll(generation: number) {
    try {
      const poll = parsePoll(await this.request("poll"));
      if (generation !== this.generation) return;
      if (poll.commands.length > 1) throw new Error("multiple_active_frames");
      if (this.current && (poll.clear.includes(this.current.actionId) || !poll.commands.some(command => command.actionId === this.current?.actionId))) { this.current = null; clearTimeout(this.expiry); this.render(null); }
      for (const command of poll.commands) {
        if (command.surfaceId !== this.surfaceId || command.incarnation !== this.connection?.incarnation) throw new Error("wrong_connection");
        if (command.expiresAt <= Date.now() || this.expired.has(command.actionId)) continue;
        const bytes = new TextEncoder().encode(command.content.text);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
        if (generation !== this.generation) return;
        if (digest !== command.contentDigest) throw new Error("digest_mismatch");
        if (this.current?.actionId === command.actionId) {
          if (this.current.contentDigest !== command.contentDigest || this.current.turnId !== command.turnId || this.current.generation !== command.generation) throw new Error("changed_action");
          continue;
        }
        this.current = command; this.acknowledged.clear(); this.acknowledging.clear();
        clearTimeout(this.expiry);
        this.expiry = setTimeout(() => { if (generation === this.generation) {
          if (this.expired.size >= 32) this.expired.delete(this.expired.values().next().value!);
          this.expired.add(command.actionId); this.current = null; this.render(null);
        } }, Math.min(command.expiresAt - Date.now(), 60000));
        this.render(command);
      }
      this.timer = setTimeout(() => { void this.poll(generation); }, 500);
    } catch {
      if (generation === this.generation) this.fail("Runtime connection unavailable. Approve again to reconnect.");
    }
  }
  /** Called only by the component's layout effect, after its exact text commits. */
  async committed(command: RenderCommand) {
    if (this.current !== command || this.acknowledged.has(command.actionId) || this.acknowledging.has(command.actionId) || command.expiresAt <= Date.now()) return;
    const generation = this.generation; this.acknowledging.add(command.actionId);
    try {
      let result;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (generation !== this.generation || this.current !== command || command.expiresAt <= Date.now()) return;
        try { result = await this.request("ack", commandProof(command)); break; }
        catch (error) {
          if (attempt === 1 || error instanceof RuntimeRequestError && error.status < 500) throw error;
          // An ambiguous lost response retries this same already committed DOM
          // proof. It never requests a second action or re-renders content.
        }
      }
      if (generation !== this.generation || this.current !== command) return;
      if (result?.acknowledged !== true) throw new Error("uncommitted_ack");
      this.acknowledged.add(command.actionId); this.status("Display acknowledgment recorded by Cosmos.");
    } catch {
      if (generation === this.generation && this.current === command) this.fail("Display acknowledgment could not be confirmed.");
    } finally { if (generation === this.generation) this.acknowledging.delete(command.actionId); }
  }
  async input(text: string) {
    if (!text.trim() || new TextEncoder().encode(text).length > 4000) { this.status("Use a shorter public text request (up to 4000 UTF-8 bytes)."); return; }
    const generation = this.generation;
    this.status("Waiting for Cosmos…");
    try {
      const result = await this.request("input", { text });
      if (generation !== this.generation) return;
      if (result?.accepted !== true) throw new Error("uncommitted_input");
      this.status("Request accepted. Waiting for an eligible display.");
    } catch { if (generation === this.generation) this.status("Request could not be confirmed. No completion is claimed."); }
  }
}
