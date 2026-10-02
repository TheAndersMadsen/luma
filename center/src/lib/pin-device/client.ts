import type { PinTransport } from "./transport";
import type {
  CellularServiceStatusResponse,
  ConfirmSetupAcceptanceRequest,
  DeviceInfo,
  EsimEidResult,
  EsimProfilesResult,
  EsimRequestAcceptedResponse,
  EsimRequestRecord,
  EsimSnapshot,
  FeatureFlagsResponse,
  FitnessSession,
  FitnessSessionFile,
  FitnessSessionsResponse,
  HealthInfo,
  IrohTicketResponse,
  SetEnabledRequest,
  Settings,
  SetupAcceptanceResponse,
  SpotifySearchKind,
  SpotifySearchResponse,
  SpotifySettingsRequest,
  SpotifyStatusResponse,
  UpdateSettingsRequest,
  UpdateFeatureFlagsRequest,
  WifiSetEnabledResponse,
} from "./types";
import {
  normalizeFitnessSession,
  normalizeFitnessSessionsResponse,
  requireCanonicalFitnessSessionId,
  requireFitnessSessionFilename,
} from "./normalizers/fitness";
import {
  normalizeSpotifySearchResponse,
  normalizeSpotifyStatusResponse,
} from "./normalizers/spotify";

export class PinApiError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`Pin API ${status}: ${body}`);
    this.name = "PinApiError";
    this.status = status;
    this.body = body;
  }
}

export class AdminTokenRotationUncertainError extends Error {
  constructor(cause?: unknown) {
    super(
      "Setup could not determine whether the LAN admin token changed. Reconnect with the new token first, then the old token, or use USB to set it again.",
      { cause },
    );
    this.name = "AdminTokenRotationUncertainError";
  }
}

export class LanAdminAuthNotEnforcedError extends Error {
  constructor() {
    super(
      "This device does not enforce LAN admin authentication. Update it and connect over USB before using Setup over the network.",
    );
    this.name = "LanAdminAuthNotEnforcedError";
  }
}

const TOKEN_ROTATION_PROBE_TIMEOUT_MS = 5_000;

type TokenProbeResult = "accepted" | "rejected" | "unknown";

/**
 * Typed client for the Pin's REST API.
 *
 * In Center this is constructed WITHOUT an `adminToken`: every call rides the
 * `UsbAdbHttpTransport`, and the ADB socket itself is the authorization
 * boundary (the on-device `CenterUsbBridge` discards caller Authorization
 * headers and injects its own). The admin-token plumbing below is retained
 * because `updateSettings` is still how the LAN admin token is *rotated* from
 * the Pin server pane, and that write must keep its verification path.
 */
export class PinClient {
  readonly transport: PinTransport;
  private readonly onAdminTokenAccepted?: (token: string) => void;
  private adminToken: string | null;

  constructor(
    transport: PinTransport,
    adminToken?: string,
    onAdminTokenAccepted?: (token: string) => void,
  ) {
    this.transport = transport;
    this.adminToken = adminToken?.trim() || null;
    this.onAdminTokenAccepted = onAdminTokenAccepted;
  }

  get baseUrl(): string {
    return this.transport.baseUrl ?? "usb://device";
  }

  get mode() {
    return this.transport.mode;
  }

  private authorizedOptions(
    options?: RequestInit,
    token: string | null = this.adminToken,
  ): RequestInit | undefined {
    if (!token) {
      return options;
    }

    const headers = new Headers(options?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return { ...options, headers };
  }

  private async request<T>(
    path: string,
    options?: RequestInit,
    signal?: AbortSignal,
    onAccepted?: () => void,
  ): Promise<T> {
    const res = await this.transport.request(
      path,
      this.authorizedOptions(options),
      signal,
    );
    if (!res.ok) {
      throw new PinApiError(res.status, await res.text());
    }
    onAccepted?.();
    const text = await res.text();
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  /** Fail closed if a LAN server exposes a protected route without a token. */
  async verifyLanAdminAuth(signal?: AbortSignal): Promise<void> {
    if (this.mode !== "lan") return;

    const res = await this.transport.request("/api/device", undefined, signal);
    const status = res.status;
    await res.text().catch(() => "");
    if (status === 401) return;

    if (res.ok) {
      throw new LanAdminAuthNotEnforcedError();
    }
    throw new Error(
      `Could not verify LAN admin authentication (HTTP ${status}).`,
    );
  }

  private async probeAdminToken(token: string): Promise<TokenProbeResult> {
    try {
      const res = await this.transport.request(
        "/api/device",
        this.authorizedOptions(undefined, token),
        AbortSignal.timeout(TOKEN_ROTATION_PROBE_TIMEOUT_MS),
      );
      const result: TokenProbeResult = res.ok
        ? "accepted"
        : res.status === 401
          ? "rejected"
          : "unknown";
      await res.text().catch(() => "");
      return result;
    } catch {
      return "unknown";
    }
  }

  private async reconcileAdminTokenRotation(
    candidateToken: string,
    previousToken: string | null,
  ): Promise<"candidate" | "previous" | "unknown"> {
    if ((await this.probeAdminToken(candidateToken)) === "accepted") {
      return "candidate";
    }
    if (
      previousToken &&
      (await this.probeAdminToken(previousToken)) === "accepted"
    ) {
      return "previous";
    }
    return "unknown";
  }

  private acceptAdminToken(token: string) {
    this.adminToken = token;
    try {
      this.onAdminTokenAccepted?.(token);
    } catch {
      // Browser storage is best-effort and must never turn an accepted server
      // update into a failed settings request.
    }
  }

  private async reloadSettingsAfterTokenRotation(cause: unknown) {
    try {
      return await this.getSettings(
        AbortSignal.timeout(TOKEN_ROTATION_PROBE_TIMEOUT_MS),
      );
    } catch (reloadError) {
      throw new Error(
        "The new LAN admin token is active, but Setup could not reload settings. Reconnect using the new token.",
        { cause: new AggregateError([cause, reloadError]) },
      );
    }
  }

  async fetchLogs(
    kind: "server" | "logcat",
    options: { lines?: number; all?: boolean } = {},
  ): Promise<{ available: boolean; text: string }> {
    const params = new URLSearchParams();
    if (options.lines && options.lines > 0) {
      params.set("lines", String(options.lines));
    }
    if (kind === "server" && options.all === false) {
      params.set("all", "false");
    }

    const qs = params.toString();
    const res = await this.transport.request(
      `/api/logs/${kind}${qs ? `?${qs}` : ""}`,
      this.authorizedOptions({ headers: { Accept: "text/plain" } }),
    );
    const text = await res.text();

    if (res.status === 503) {
      return { available: false, text };
    }
    if (!res.ok) {
      throw new PinApiError(res.status, text);
    }

    return { available: true, text };
  }

  async health(signal?: AbortSignal) {
    // Health is intentionally public. Keeping this request unauthenticated
    // avoids disclosing the in-memory token before the LAN auth probe passes.
    const res = await this.transport.request("/api/health", undefined, signal);
    const text = await res.text();
    if (!res.ok) throw new PinApiError(res.status, text);
    return JSON.parse(text) as HealthInfo;
  }

  async getIrohTicket(signal?: AbortSignal): Promise<IrohTicketResponse> {
    const response = await this.request<unknown>("/api/iroh/ticket", undefined, signal);
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("The Pin returned an invalid remote-connection ticket.");
    }
    const value = response as Record<string, unknown>;
    const ticket = typeof value.ticket === "string" ? value.ticket : "";
    const nodeId = typeof value.node_id === "string" ? value.node_id.toLowerCase() : "";
    if (
      Object.keys(value).some((key) => !new Set(["ticket", "node_id"]).has(key)) ||
      !ticket ||
      ticket.length > 16 * 1024 ||
      !/^[!-~]+$/u.test(ticket) ||
      !/^[0-9a-f]{64}$/u.test(nodeId)
    ) {
      throw new Error("The Pin returned an invalid remote-connection ticket.");
    }
    return { ticket, node_id: nodeId };
  }

  async listFitnessSessions(
    signal?: AbortSignal,
  ): Promise<FitnessSessionsResponse> {
    const response = await this.request<unknown>(
      "/api/fitness/sessions",
      undefined,
      signal,
    );
    return normalizeFitnessSessionsResponse(response);
  }

  async getFitnessSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<FitnessSession> {
    const canonicalId = requireCanonicalFitnessSessionId(sessionId);
    const response = await this.request<unknown>(
      `/api/fitness/sessions/${canonicalId}`,
      undefined,
      signal,
    );
    return normalizeFitnessSession(response);
  }

  deleteFitnessSession(sessionId: string, signal?: AbortSignal) {
    const canonicalId = requireCanonicalFitnessSessionId(sessionId);
    return this.request<void>(
      `/api/fitness/sessions/${canonicalId}`,
      { method: "DELETE" },
      signal,
    );
  }

  clearFitnessSessions(signal?: AbortSignal) {
    return this.request<void>(
      "/api/fitness/sessions",
      { method: "DELETE" },
      signal,
    );
  }

  fitnessSessionFilePath(
    sessionId: string,
    filename: FitnessSessionFile["filename"],
  ) {
    const canonicalId = requireCanonicalFitnessSessionId(sessionId);
    const allowlistedFilename = requireFitnessSessionFilename(filename);
    return `/api/fitness/sessions/${canonicalId}/files/${encodeURIComponent(allowlistedFilename)}`;
  }

  fetchFitnessSessionFile(
    sessionId: string,
    filename: FitnessSessionFile["filename"],
    signal?: AbortSignal,
  ) {
    return this.fetchAsset(
      this.fitnessSessionFilePath(sessionId, filename),
      signal,
    );
  }

  getSettings(signal?: AbortSignal) {
    return this.request<Settings>("/api/settings", undefined, signal);
  }

  async updateSettings(s: UpdateSettingsRequest, signal?: AbortSignal) {
    const rotatedToken = s.server?.admin_token?.trim();
    const previousToken = this.adminToken;
    const isTokenRotation =
      Boolean(rotatedToken) && rotatedToken !== previousToken;
    const isLanTokenRotation =
      this.mode === "lan" && isTokenRotation;
    let responseAccepted = false;

    try {
      return await this.request<Settings>(
        "/api/settings",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(s),
        },
        signal,
        isTokenRotation
          ? () => {
              responseAccepted = true;
              this.acceptAdminToken(rotatedToken ?? "");
            }
          : undefined,
      );
    } catch (error) {
      if (!isLanTokenRotation) {
        throw error;
      }

      if (responseAccepted) {
        return this.reloadSettingsAfterTokenRotation(error);
      }

      const reconciliation = await this.reconcileAdminTokenRotation(
        rotatedToken ?? "",
        previousToken,
      );
      if (reconciliation === "candidate") {
        this.acceptAdminToken(rotatedToken ?? "");
        return this.reloadSettingsAfterTokenRotation(error);
      }
      if (reconciliation === "previous") {
        this.adminToken = previousToken;
        throw error;
      }

      throw new AdminTokenRotationUncertainError(error);
    }
  }

  async getSpotifyStatus(signal?: AbortSignal): Promise<SpotifyStatusResponse> {
    const response = await this.request<unknown>(
      "/api/spotify/status",
      undefined,
      signal,
    );
    return normalizeSpotifyStatusResponse(response);
  }

  private async mutateSpotifyStatus(
    path: string,
    options: RequestInit,
    signal?: AbortSignal,
  ): Promise<SpotifyStatusResponse | null> {
    const response = await this.request<unknown>(path, options, signal);
    return response === undefined
      ? null
      : normalizeSpotifyStatusResponse(response);
  }

  updateSpotifySettings(
    settings: SpotifySettingsRequest,
    signal?: AbortSignal,
  ) {
    return this.mutateSpotifyStatus(
      "/api/spotify/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      },
      signal,
    );
  }

  startSpotifyPairing(signal?: AbortSignal) {
    return this.mutateSpotifyStatus(
      "/api/spotify/pairing/start",
      { method: "POST" },
      signal,
    );
  }

  cancelSpotifyPairing(signal?: AbortSignal) {
    return this.mutateSpotifyStatus(
      "/api/spotify/pairing/cancel",
      { method: "POST" },
      signal,
    );
  }

  disconnectSpotifySession(signal?: AbortSignal) {
    return this.mutateSpotifyStatus(
      "/api/spotify/session",
      { method: "DELETE" },
      signal,
    );
  }

  async searchSpotify(
    query: string,
    kind: SpotifySearchKind = "track",
    signal?: AbortSignal,
  ): Promise<SpotifySearchResponse> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) throw new Error("Enter a song to search for.");
    const params = new URLSearchParams({ q: trimmedQuery, kind });
    const response = await this.request<unknown>(
      `/api/spotify/search?${params.toString()}`,
      undefined,
      signal,
    );
    return normalizeSpotifySearchResponse(response);
  }

  getFeatureFlags(signal?: AbortSignal) {
    return this.request<FeatureFlagsResponse>(
      "/api/feature-flags",
      undefined,
      signal,
    );
  }

  updateFeatureFlags(
    update: UpdateFeatureFlagsRequest,
    signal?: AbortSignal,
  ) {
    return this.request<FeatureFlagsResponse>(
      "/api/feature-flags",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      },
      signal,
    );
  }

  getCellularServiceStatus(signal?: AbortSignal) {
    return this.request<CellularServiceStatusResponse>(
      "/api/cellular/service-status",
      undefined,
      signal,
    );
  }

  setWifiEnabled(enabled: boolean, signal?: AbortSignal) {
    return this.request<WifiSetEnabledResponse>(
      "/api/wifi/set-enabled",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled } satisfies SetEnabledRequest),
      },
      signal,
    );
  }

  getEsimState(signal?: AbortSignal) {
    return this.request<EsimSnapshot>("/api/esim/state", undefined, signal);
  }

  getEsimRequest(requestId: string, signal?: AbortSignal) {
    return this.request<EsimRequestRecord>(
      `/api/esim/requests/${encodeURIComponent(requestId)}`,
      undefined,
      signal,
    );
  }

  getEsimProfiles(signal?: AbortSignal) {
    return this.request<EsimProfilesResult>(
      "/api/esim/get-profiles",
      { method: "PUT" },
      signal,
    );
  }

  getEsimEid(signal?: AbortSignal) {
    return this.request<EsimEidResult>(
      "/api/esim/get-eid",
      { method: "PUT" },
      signal,
    );
  }

  enableEsimProfile(iccid: string, signal?: AbortSignal) {
    return this.request<EsimRequestAcceptedResponse>(
      "/api/esim/enable-profile",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ iccid }),
      },
      signal,
    );
  }

  disableEsimProfile(iccid: string, signal?: AbortSignal) {
    return this.request<EsimRequestAcceptedResponse>(
      "/api/esim/disable-profile",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ iccid }),
      },
      signal,
    );
  }

  setEsimNickname(iccid: string, nickname: string, signal?: AbortSignal) {
    return this.request<EsimRequestAcceptedResponse>(
      "/api/esim/set-nickname",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ iccid, nickname }),
      },
      signal,
    );
  }

  deleteEsimProfile(iccid: string, signal?: AbortSignal) {
    return this.request<EsimRequestAcceptedResponse>(
      "/api/esim/delete-profile",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ iccid }),
      },
      signal,
    );
  }

  downloadVerifyEnableEsim(activationCode: string, signal?: AbortSignal) {
    return this.request<EsimRequestAcceptedResponse>(
      "/api/esim/download-verify-enable",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activation_code: activationCode }),
      },
      signal,
    );
  }

  getDevice(signal?: AbortSignal) {
    return this.request<DeviceInfo>("/api/device", undefined, signal);
  }

  getSetupAcceptance(signal?: AbortSignal) {
    return this.request<SetupAcceptanceResponse>(
      "/api/setup/acceptance",
      undefined,
      signal,
    );
  }

  confirmSetupAcceptance(
    request: ConfirmSetupAcceptanceRequest,
    signal?: AbortSignal,
  ) {
    return this.request<SetupAcceptanceResponse>(
      "/api/setup/acceptance",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
      signal,
    );
  }

  async fetchAsset(path: string, signal?: AbortSignal) {
    const res = await this.transport.request(
      path,
      this.authorizedOptions(),
      signal,
    );
    if (!res.ok) {
      throw new PinApiError(res.status, await res.text());
    }
    return res.blob();
  }

  async openStream(path: string, signal?: AbortSignal) {
    const res = await this.transport.request(
      path,
      this.authorizedOptions(),
      signal,
    );
    if (!res.ok) {
      throw new PinApiError(res.status, await res.text());
    }
    const body = res.body;
    if (!body) {
      throw new Error(`Response body is missing for ${path}`);
    }
    return body;
  }

  async disconnect() {
    await (this.transport.disconnect?.() ?? Promise.resolve());
  }
}
