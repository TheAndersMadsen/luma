import { parseConnection, parseSurface, record, SURFACE_APPROVAL, type SurfaceConnection } from "@/lib/contracts/surfaces";
import type { BrowserRuntime } from "@/lib/browserRuntime";

export type TabStatus = "inactive" | "approving" | "pending" | "visible" | "hidden" | "lost" | "expired";

/** One mounted tab, one memory-only capability. Visibility is not occupancy. */
export class SurfaceTab {
  readonly surfaceId: string;
  private connection: SurfaceConnection | null = null;
  private generation = 0;
  private desired: boolean | null = null;
  private sending = false;
  private interval: ReturnType<typeof setInterval> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private visible = false;

  constructor(private notify: (status: TabStatus) => void, private changed: () => void, readonly runtime: BrowserRuntime) {
    this.surfaceId = runtime.surfaceId;
    runtime.onFailure(incarnation => {
      if (this.disposed || this.connection?.incarnation !== incarnation) return;
      const connection = this.clear();
      this.notify("lost"); this.changed();
      if (connection) void this.release(connection);
    });
  }

  private clear() {
    this.visible = false; this.runtime.stop();
    const previous = this.connection;
    this.connection = null;
    this.generation++;
    this.desired = null;
    this.sending = false;
    clearInterval(this.interval);
    clearTimeout(this.expiry);
    return previous;
  }
  private async release(connection: SurfaceConnection) {
    try {
      await fetch(`/api/surfaces/${this.surfaceId}/leave`, {
        method: "POST", headers: { "content-type": "application/json", "x-cosmos-surface-token": connection.token },
        body: JSON.stringify({ incarnation: connection.incarnation }),
        signal: AbortSignal.timeout(8000), keepalive: true,
      });
    } catch { /* Lost network is bounded by Cosmos's lease, not claimed successful. */ }
  }
  async approve() {
    if (this.disposed) return;
    const previous = this.clear();
    if (previous) void this.release(previous);
    const generation = this.generation;
    this.notify("approving");
    try {
      const response = await fetch("/api/surfaces", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ surfaceId: this.surfaceId, approval: SURFACE_APPROVAL }),
        signal: AbortSignal.timeout(12000), cache: "no-store",
      });
      if (!response.ok) throw new Error("approval_failed");
      const body = record(await response.json());
      const connection = parseConnection(body.connection);
      if (generation !== this.generation || this.disposed) { void this.release(connection); return; }
      const surface = parseSurface(body.surface);
      if (surface.surfaceId !== this.surfaceId || connection.expiresAt <= Date.now()) throw new Error("expired_approval");
      this.connection = connection;
      this.expiry = setTimeout(() => { this.clear(); this.notify("expired"); this.changed(); }, Math.min(connection.expiresAt - Date.now(), 3600000));
      await this.runtime.start(connection);
      if (generation !== this.generation || this.disposed) return;
      this.interval = setInterval(() => this.visibility(document.visibilityState === "visible"), 15000);
      this.visibility(document.visibilityState === "visible");
      this.changed();
    } catch {
      if (generation === this.generation && !this.disposed) { this.clear(); this.notify("lost"); this.changed(); }
    }
  }
  visibility(visible: boolean) {
    if (!this.connection || this.disposed) return;
    this.desired = visible;
    // A routine visible heartbeat does not dismiss healthy current output.
    if (!visible) { this.visible = false; this.runtime.hide(); }
    if (!this.visible) this.notify("pending");
    void this.flush();
  }
  private async flush() {
    if (this.sending || !this.connection) return;
    const generation = this.generation;
    this.sending = true;
    try {
      while (this.desired !== null && generation === this.generation) {
        const visible = this.desired;
        this.desired = null;
        await this.runtime.visibility(visible);
        if (generation !== this.generation) return;
        if (this.desired === null) {
          this.visible = visible;
          this.notify(visible ? "visible" : "hidden");
        }
      }
    } catch {
      if (generation === this.generation && !this.disposed) {
        this.clear(); this.notify("lost"); this.changed();
      }
    } finally { if (generation === this.generation) this.sending = false; }
  }
  leave() {
    const connection = this.clear();
    if (!this.disposed) this.notify("inactive");
    if (connection) void this.release(connection).then(() => { if (!this.disposed) this.changed(); });
  }
  dispose() { this.disposed = true; this.leave(); }
}
