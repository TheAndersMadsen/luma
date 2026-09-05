import { parseAdmission, parseFrame, parseRoomConnection, publicText, ROOM_PAYLOAD_BYTES,
  type BrowserControl, type RenderCommand, type RoomConnection, type Stamp } from "./contracts/ambianceRuntime";
import type { SurfaceConnection } from "./contracts/surfaces";
import { createBrowserRoom, type BrowserRoom } from "./browserRoom";

const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
  byte => byte.toString(16).padStart(2, "0")).join("");

/** One approved tab, one room boot epoch, one ordered stream of exact retries. */
export class BrowserRuntime {
  private connection: SurfaceConnection | null = null;
  private controller: AbortController | null = null;
  private room: BrowserRoom | null = null;
  private bootstrap: RoomConnection | null = null;
  private generation = 0;
  private sequence = 0;
  private received = 0;
  private visibilityEpoch = 0;
  private visible = false;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private current: RenderCommand | null = null;
  private turn: { turnId: string; generation: number } | null = null;
  private blockedIncarnation: string | null = null;
  private retired = new Set<string>();
  private receipts = new Map<number, string>();
  private acknowledged = new Set<string>();
  private acknowledging = new Set<string>();
  private outgoing: Promise<unknown> = Promise.resolve();
  private incoming: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private incomingPending = 0;
  private failureHandler: ((incarnation: string) => void) | undefined;
  constructor(readonly surfaceId: string, private render: (command: RenderCommand | null) => void,
    private status: (message: string) => void, private roomFactory = createBrowserRoom) {}
  onFailure(handler: (incarnation: string) => void) { this.failureHandler = handler; }
  private retire(actionId: string) {
    if (this.retired.size >= 32) this.retired.delete(this.retired.values().next().value!);
    this.retired.add(actionId);
  }
  private clearFrame() {
    if (this.current) this.retire(this.current.actionId);
    clearTimeout(this.expiry); this.current = null;
    this.acknowledged.clear(); this.acknowledging.clear(); this.render(null);
  }
  stop() {
    this.generation++; this.visibilityEpoch++; this.visible = false;
    this.controller?.abort(); this.controller = null;
    this.room?.close(); this.room = null; this.connection = null; this.bootstrap = null;
    this.clearFrame(); this.turn = null; this.receipts.clear(); this.retired.clear();
    this.outgoing = Promise.resolve(); this.incoming = Promise.resolve(); this.pending = 0; this.incomingPending = 0;
    this.status("");
  }
  async start(connection: SurfaceConnection) {
    if (this.blockedIncarnation === connection.incarnation) throw new Error("fenced_incarnation");
    if (this.connection?.incarnation === connection.incarnation) throw new Error("already_started");
    this.stop(); this.connection = connection; this.controller = new AbortController();
    this.sequence = 0; this.received = 0;
    const generation = this.generation; const epoch = crypto.randomUUID();
    try {
      const response = await fetch("/api/runtime/room", {
        method: "POST", headers: { "content-type": "application/json", "x-cosmos-surface-token": connection.token },
        body: JSON.stringify({ surfaceId: this.surfaceId, incarnation: connection.incarnation, epoch }),
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(22000)]), cache: "no-store",
      });
      if (!response.ok) throw new Error("room_unavailable");
      const bootstrap = parseRoomConnection(await response.json(), window.location.origin);
      this.active(generation);
      if (bootstrap.epoch !== epoch) throw new Error("wrong_epoch");
      this.bootstrap = bootstrap;
      const room = this.roomFactory(); this.room = room;
      await room.connect(bootstrap, payload => this.receive(payload, generation), () => {
        if (generation === this.generation) this.fail("Runtime connection unavailable. Approve again to reconnect.");
      });
      this.active(generation);
      this.status("Ready for public text requests.");
    } catch (error) {
      if (generation === this.generation) this.fail("Runtime connection unavailable. Approve again to reconnect.");
      throw error;
    }
  }
  private active(generation: number) {
    if (generation !== this.generation || !this.connection || this.connection.expiresAt <= Date.now()
      || this.controller?.signal.aborted) throw new Error("inactive");
  }
  private fail(message: string) {
    const incarnation = this.connection?.incarnation;
    this.blockedIncarnation = incarnation ?? null; this.stop();
    if (incarnation) this.failureHandler?.(incarnation);
    this.status(message);
  }
  private send(message: { kind: "input"; text: string } | { kind: "control"; control: BrowserControl }, instanceId = crypto.randomUUID()) {
    const generation = this.generation; const room = this.room; const bootstrap = this.bootstrap;
    if (!room || !bootstrap || this.pending >= 16) return Promise.reject(new Error("busy_or_inactive"));
    const stamp: Stamp = { epoch: bootstrap.epoch, sequence: ++this.sequence, instanceId };
    const payload = JSON.stringify({ ...message, stamp });
    if (!Number.isSafeInteger(stamp.sequence) || new TextEncoder().encode(payload).length > ROOM_PAYLOAD_BYTES) return Promise.reject(new Error("invalid_request"));
    this.pending++;
    const visibilityEpoch = this.visibilityEpoch;
    const task = this.outgoing.then(async () => {
      const deadline = Date.now() + 8000;
      let ambiguous = 0;
      for (let attempt = 0; attempt < 20; attempt++) {
        this.active(generation);
        if ((message.kind === "input" || message.control.kind === "acknowledge") &&
          (!this.visible || document.visibilityState !== "visible" || visibilityEpoch !== this.visibilityEpoch)) throw new Error("hidden");
        try {
          const result = await room.invoke(payload);
          this.active(generation);
          return parseAdmission(result, message.kind === "input" ? instanceId : undefined);
        } catch (error) {
          this.active(generation);
          const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
          // Presence may take three seconds to reach the SFU's ordinary peers.
          // A lost response retries the exact stamp once; it never reissues a turn.
          if (Date.now() >= deadline || (code !== 1429 && (!([1501, 1502, 1505].includes(Number(code))) || ambiguous++ >= 1))) throw error;
          await new Promise<void>((resolve, reject) => {
            const signal = this.controller!.signal;
            const aborted = () => { clearTimeout(timer); reject(new Error("inactive")); };
            const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, 250);
            signal.addEventListener("abort", aborted, { once: true });
          });
        }
      }
      throw new Error("admission_timeout");
    }).finally(() => { if (generation === this.generation) this.pending--; });
    this.outgoing = task.catch(() => {});
    return task;
  }
  /** Hiding clears local output before waiting for durable room admission. */
  hide() { this.visible = false; this.visibilityEpoch++; this.clearFrame(); }
  async visibility(visible: boolean) {
    const generation = this.generation;
    if (!visible) this.hide();
    const visibilityEpoch = this.visibilityEpoch;
    await this.send({ kind: "control", control: { kind: "state", visible } });
    this.active(generation);
    if (visible && visibilityEpoch === this.visibilityEpoch) this.visible = true;
  }
  private receive(payload: string, generation: number): Promise<string> {
    if (this.incomingPending >= 16) return Promise.reject(new Error("busy"));
    this.incomingPending++;
    const task = this.incoming.then(async () => {
      this.active(generation);
      const frame = parseFrame(payload);
      if (frame.stamp.epoch !== this.bootstrap?.runtimeEpoch) throw new Error("wrong_runtime_epoch");
      const hash = await digest(payload); this.active(generation);
      const duplicate = this.receipts.get(frame.stamp.sequence);
      if (frame.stamp.sequence <= this.received) {
        if (duplicate !== hash) throw new Error("stale_or_changed_frame");
      } else {
        const visibilityEpoch = this.visibilityEpoch;
        if (frame.kind === "render") {
          const command = frame.command;
          if (!this.visible || document.visibilityState !== "visible" || command.surfaceId !== this.surfaceId
            || command.incarnation !== this.connection?.incarnation || command.expiresAt <= Date.now()
            || command.expiresAt > Date.now() + 60000 || this.retired.has(command.actionId)) throw new Error("ineligible_render");
          const contentDigest = await digest(command.content.text); this.active(generation);
          if (!this.visible || document.visibilityState !== "visible" || visibilityEpoch !== this.visibilityEpoch) throw new Error("hidden");
          if (contentDigest !== command.contentDigest) throw new Error("digest_mismatch");
          if (this.current?.actionId === command.actionId) throw new Error("changed_action_stamp");
          this.clearFrame(); this.current = command;
          this.expiry = setTimeout(() => { if (generation === this.generation) this.clearFrame(); }, command.expiresAt - Date.now());
          this.render(command);
        } else {
          this.retire(frame.actionId);
          if (this.current?.actionId === frame.actionId) this.clearFrame();
        }
        this.received = frame.stamp.sequence;
        if (this.receipts.size >= 32) this.receipts.delete(this.receipts.keys().next().value!);
        this.receipts.set(frame.stamp.sequence, hash);
      }
      return JSON.stringify({ version: 1, kind: "received", stamp: frame.stamp });
    }).finally(() => { if (generation === this.generation) this.incomingPending--; });
    this.incoming = task.catch(() => {});
    return task;
  }
  /** Called only after the exact escaped text commits to the visible DOM. */
  async committed(command: RenderCommand) {
    if (this.current !== command || this.acknowledged.has(command.actionId) || this.acknowledging.has(command.actionId) || command.expiresAt <= Date.now()) return;
    const generation = this.generation; const visibilityEpoch = this.visibilityEpoch;
    this.acknowledging.add(command.actionId);
    try {
      const { actionId, turnId, generation: actionGeneration, channel, contentDigest } = command;
      await this.send({ kind: "control", control: { kind: "acknowledge", actionId, turnId, generation: actionGeneration, channel, contentDigest } }, actionId);
      if (generation !== this.generation || this.current !== command || visibilityEpoch !== this.visibilityEpoch || command.expiresAt <= Date.now()) return;
      this.acknowledged.add(command.actionId); this.status("Display acknowledgment recorded by Cosmos.");
    } catch {
      if (generation === this.generation && this.current === command) this.fail("Display acknowledgment could not be confirmed.");
    } finally { if (generation === this.generation) this.acknowledging.delete(command.actionId); }
  }
  async input(text: string) {
    if (!publicText(text)) { this.status("Use a shorter public text request (up to 4000 UTF-8 bytes)."); return; }
    const generation = this.generation; this.status("Waiting for Cosmos…");
    try {
      const result = await this.send({ kind: "input", text });
      if (generation !== this.generation) return;
      this.turn = { turnId: result.turnId as string, generation: result.generation as number };
      this.status("Request accepted. Waiting for an eligible display.");
    } catch { if (generation === this.generation) this.status("Request could not be confirmed. No completion is claimed."); }
  }
  async cancel() {
    if (!this.turn) return;
    const turn = this.turn; const generation = this.generation; this.clearFrame();
    try {
      await this.send({ kind: "control", control: { kind: "cancel", ...turn } });
      if (generation === this.generation && this.turn === turn) { this.turn = null; this.status("Cancellation recorded by Cosmos."); }
    } catch { if (generation === this.generation) this.status("Cancellation could not be confirmed."); }
  }
}
