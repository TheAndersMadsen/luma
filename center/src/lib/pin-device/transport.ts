/**
 * Transport contract for the Pin's REST API.
 *
 * Ported from the standalone Setup SPA. The plaintext LAN transport
 * (`FetchPinTransport`) is deliberately NOT carried over: from Center's HTTPS
 * origin it is double-blocked by `connect-src 'self'` and by browser
 * mixed-content rules, and it was the only thing that required a long-lived Pin
 * admin token in browser storage.
 *
 * `RemoteFetchPinTransport` IS carried over: it targets Center's own origin
 * (the iroh tunnel in `pin/runtime/core/src/remote_center/`), so it is
 * same-origin, CSP-legal, and still a live capability.
 */
export interface PinResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  readonly headers?: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface PinTransport {
  readonly mode: "lan" | "usb" | "remote";
  readonly baseUrl: string | null;
  request(path: string, options?: RequestInit, signal?: AbortSignal): Promise<PinResponseLike>;
  assetUrl(path: string): string | null;
  disconnect?(): Promise<void>;
}

/**
 * Same-origin transport for when Center is served *by* the Pin over the iroh
 * tunnel (e.g. behind Cloudflare Access at a public URL). Unlike the LAN
 * transport it does not send an admin token or the Private-Network-Access hint,
 * and it forwards credentials so the edge-auth (Access) cookie rides along.
 */
export class RemoteFetchPinTransport implements PinTransport {
  readonly mode = "remote" as const;
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  request(path: string, options?: RequestInit, signal?: AbortSignal): Promise<PinResponseLike> {
    return fetch(`${this.baseUrl}${path}`, {
      ...options,
      signal,
      credentials: "same-origin",
    });
  }

  assetUrl(path: string) {
    return `${this.baseUrl}${path}`;
  }
}

export class BufferedPinResponse implements PinResponseLike {
  readonly ok: boolean;
  readonly headers: Headers;
  readonly status: number;
  readonly statusText: string;
  private readonly payload: Uint8Array;

  constructor(
    status: number,
    statusText: string,
    headers: HeadersInit | Headers,
    payload: Uint8Array,
  ) {
    this.status = status;
    this.statusText = statusText;
    this.ok = status >= 200 && status < 300;
    this.headers = headers instanceof Headers ? headers : new Headers(headers);
    this.payload = payload;
  }

  async text() {
    return new TextDecoder().decode(this.payload);
  }

  async json() {
    return JSON.parse(await this.text()) as unknown;
  }

  async blob() {
    return new Blob([await this.arrayBuffer()], {
      type: this.headers.get("content-type") ?? undefined,
    });
  }

  async arrayBuffer() {
    return this.payload.buffer.slice(
      this.payload.byteOffset,
      this.payload.byteOffset + this.payload.byteLength,
    ) as ArrayBuffer;
  }

  get body() {
    const payload = this.payload;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
  }
}
