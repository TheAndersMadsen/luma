import { useCallback, useEffect, useRef, useState } from "react";
import { exact } from "@/lib/contracts/surfaces";
import { SPEECH_DISCLOSURE_APPROVAL, parseSpeechApproval, type SpeechApproval, type SpeechPolicy } from "@/lib/contracts/speechDisclosure";
import { LOOKUP_SERVICES, parseLookupState, type LookupPolicy, type LookupProvider, type LookupService, type LookupState } from "@/lib/contracts/lookupDisclosure";
import { PRIVATE_DISPLAY_APPROVAL, parsePrivateDisplayApproval, type PrivateDisplayApproval, type PrivateDisplayPolicy } from "@/lib/contracts/privateDisplay";
import { SCREEN_CONTEXT_APPROVAL, parseScreenContextApproval, type ScreenContextApproval, type ScreenContextPolicy } from "@/lib/contracts/screenContext";
import { LOCAL_VOICE_APPROVAL, parseLocalVoiceApproval, type LocalVoiceApproval, type LocalVoicePolicy } from "@/lib/contracts/localVoice";
import { DEVICE_ACTIONS_APPROVAL, parseDeviceActionApproval, type DeviceActionApproval, type DeviceActionPolicy } from "@/lib/contracts/deviceActions";
import { DEVICE_COMMANDS_APPROVAL, parseDeviceCommandApproval, type DeviceCommandApproval, type DeviceCommandPolicy } from "@/lib/contracts/deviceCommands";

const TIMEOUT = 10000;

/** One owner permission on one surface: a bounded read and a revision-checked write. */
export interface Permission<S, P> {
  read(signal: AbortSignal): Promise<S>;
  /** Writes against a snapshot the owner has read. The confirmed reply must echo the exact policy at the next revision. */
  write(snapshot: S, policy: P | null, signal: AbortSignal): Promise<S>;
}

async function get(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store", signal });
  signal.throwIfAborted();
  if (!response.ok) throw new Error("unavailable");
  const body: unknown = await response.json();
  signal.throwIfAborted();
  return body;
}
/**
 * Cosmos answered a definite no. The write did not commit, so the snapshot the
 * owner read is still current and they can change the input and try again
 * without a fresh read — unlike a lost reply, which may have committed.
 */
export class PermissionRefused extends Error {
  constructor(readonly status: number) { super("refused"); }
}
async function post(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", signal, body: JSON.stringify(body) });
  signal.throwIfAborted();
  if (!response.ok) {
    if (response.status === 400 || response.status === 403) throw new PermissionRefused(response.status);
    throw new Error("unconfirmed");
  }
  const result: unknown = await response.json();
  signal.throwIfAborted();
  return result;
}

/** Spoken shared replies only: synthesis on, microphone transcription off. */
export const speechPolicy = (region: string): SpeechPolicy =>
  ({ provider: { provider: "azure_speech", region }, maximumClass: "shared_room", transcription: false, synthesis: true });

export function speechPermission(surfaceId: string, approvalRevision: number): Permission<SpeechApproval | null, SpeechPolicy> {
  const path = `/api/surfaces/${surfaceId}/speech-disclosure`;
  return {
    async read(signal) {
      const saved = parseSpeechApproval(await get(path, signal));
      if (saved && saved.approvalRevision !== approvalRevision) throw new Error("approval_changed");
      return saved;
    },
    async write(snapshot, policy, signal) {
      const expectedRevision = snapshot?.revision ?? 0;
      const saved = parseSpeechApproval(await post(path, { approval: SPEECH_DISCLOSURE_APPROVAL, approvalRevision, expectedRevision, policy }, signal));
      if (!saved || saved.approvalRevision !== approvalRevision || saved.revision !== expectedRevision + 1 || !exact(saved.policy, policy)) throw new Error("approval_mismatch");
      return saved;
    },
  };
}

export const PRIVATE_POLICY: PrivateDisplayPolicy = { maximumClass: "private" };

export function privatePermission(surfaceId: string, approvalRevision: number): Permission<PrivateDisplayApproval | null, PrivateDisplayPolicy> {
  const path = `/api/surfaces/${surfaceId}/private-display`;
  return {
    async read(signal) {
      const saved = parsePrivateDisplayApproval(await get(path, signal));
      if (saved && saved.approvalRevision !== approvalRevision) throw new Error("approval_changed");
      return saved;
    },
    async write(snapshot, policy, signal) {
      const expectedRevision = snapshot?.revision ?? 0;
      const saved = parsePrivateDisplayApproval(await post(path, { approval: PRIVATE_DISPLAY_APPROVAL, approvalRevision, expectedRevision, policy }, signal));
      if (!saved || saved.approvalRevision !== approvalRevision || saved.revision !== expectedRevision + 1 || !exact(saved.policy, policy)) throw new Error("approval_mismatch");
      return saved;
    },
  };
}

export const SCREEN_CONTEXT_POLICY: ScreenContextPolicy = { maximumClass: "private" };

/** Screen text may be read once for a private reply on the same device; TVs and browsers never hold it. */
export function screenContextPermission(surfaceId: string, approvalRevision: number): Permission<ScreenContextApproval | null, ScreenContextPolicy> {
  const path = `/api/surfaces/${surfaceId}/screen-context`;
  return {
    async read(signal) {
      const saved = parseScreenContextApproval(await get(path, signal));
      if (saved && saved.approvalRevision !== approvalRevision) throw new Error("approval_changed");
      return saved;
    },
    async write(snapshot, policy, signal) {
      const expectedRevision = snapshot?.revision ?? 0;
      const saved = parseScreenContextApproval(await post(path, { approval: SCREEN_CONTEXT_APPROVAL, approvalRevision, expectedRevision, policy }, signal));
      if (!saved || saved.approvalRevision !== approvalRevision || saved.revision !== expectedRevision + 1 || !exact(saved.policy, policy)) throw new Error("approval_mismatch");
      return saved;
    },
  };
}

/** Voice heard by the Pin is recognized on the owner's own server, so the floor it may carry is shared-room speech. */
export const LOCAL_VOICE_POLICY: LocalVoicePolicy = { sourceFloor: "shared_room" };

/** Spoken requests taken on one Pin. Separate from the cloud speech provider permission and from pairing. */
export function localVoicePermission(surfaceId: string, approvalRevision: number): Permission<LocalVoiceApproval | null, LocalVoicePolicy> {
  const path = `/api/devices/runtime/${surfaceId}/local-voice`;
  return {
    async read(signal) {
      const saved = parseLocalVoiceApproval(await get(path, signal));
      if (saved && saved.approvalRevision !== approvalRevision) throw new Error("approval_changed");
      return saved;
    },
    async write(snapshot, policy, signal) {
      const expectedRevision = snapshot?.revision ?? 0;
      const saved = parseLocalVoiceApproval(await post(path, { approval: LOCAL_VOICE_APPROVAL, approvalRevision, expectedRevision, policy }, signal));
      if (!saved || saved.approvalRevision !== approvalRevision || saved.revision !== expectedRevision + 1 || !exact(saved.policy, policy)) throw new Error("approval_mismatch");
      return saved;
    },
  };
}

/**
 * "Let this device act": what one installation may be asked to open, whether it
 * may route to a place, and which media providers it may play. Cosmos refuses
 * an operation this installation's approved manifest never declared, and caps
 * the class by that installation's own private-display ceiling.
 */
export function deviceActionsPermission(surfaceId: string, approvalRevision: number): Permission<DeviceActionApproval | null, DeviceActionPolicy> {
  const path = `/api/surfaces/${surfaceId}/device-actions`;
  return {
    async read(signal) {
      const saved = parseDeviceActionApproval(await get(path, signal));
      if (saved && saved.approvalRevision !== approvalRevision) throw new Error("approval_changed");
      return saved;
    },
    async write(snapshot, policy, signal) {
      const expectedRevision = snapshot?.revision ?? 0;
      const saved = parseDeviceActionApproval(await post(path, { approval: DEVICE_ACTIONS_APPROVAL, approvalRevision, expectedRevision, policy }, signal));
      if (!saved || saved.approvalRevision !== approvalRevision || saved.revision !== expectedRevision + 1 || !exact(saved.policy, policy)) throw new Error("approval_mismatch");
      return saved;
    },
  };
}

/**
 * "Tasks on this device": the commands the owner authored for one macOS
 * installation. `argv` is a fixed array written here by a person; there is no
 * shell string and no parameter, so nothing a model or a page says can become
 * an argument.
 */
export function deviceCommandsPermission(surfaceId: string, approvalRevision: number): Permission<DeviceCommandApproval | null, DeviceCommandPolicy> {
  const path = `/api/surfaces/${surfaceId}/device-commands`;
  return {
    async read(signal) {
      const saved = parseDeviceCommandApproval(await get(path, signal));
      if (saved && saved.approvalRevision !== approvalRevision) throw new Error("approval_changed");
      return saved;
    },
    async write(snapshot, policy, signal) {
      const expectedRevision = snapshot?.revision ?? 0;
      const saved = parseDeviceCommandApproval(await post(path, { approval: DEVICE_COMMANDS_APPROVAL, approvalRevision, expectedRevision, policy }, signal));
      if (!saved || saved.approvalRevision !== approvalRevision || saved.revision !== expectedRevision + 1 || !exact(saved.policy, policy)) throw new Error("approval_mismatch");
      return saved;
    },
  };
}

/** A native surface's lookup binding names its exact approval and has no browser incarnation. */
export function lookupPermission(service: LookupService, surfaceId: string, approvalRevision: number): Permission<LookupState, LookupPolicy> {
  const definition = LOOKUP_SERVICES[service];
  const path = `/api/surfaces/${surfaceId}/${definition.path}`;
  return {
    async read(signal) {
      const saved = parseLookupState(service, await get(path, signal));
      if (saved.binding.approvalRevision !== approvalRevision) throw new Error("approval_changed");
      if (saved.binding.incarnation !== null) throw new Error("invalid_binding");
      return saved;
    },
    async write(snapshot, policy, signal) {
      if (policy ? !snapshot.providers.some(provider => exact(provider, policy.provider)) : !snapshot.approval?.policy) throw new Error("invalid_change");
      const expectedRevision = snapshot.approval?.revision ?? 0;
      const binding = snapshot.binding;
      const saved = parseLookupState(service, await post(path, { approval: definition.approval, approvalRevision: binding.approvalRevision,
        approvalIncarnation: binding.incarnation, expectedRevision, policy }, signal));
      if (!saved.approval || saved.approval.approvalRevision !== binding.approvalRevision || saved.binding.incarnation !== binding.incarnation
        || saved.binding.approvalRevision !== binding.approvalRevision || saved.approval.revision !== expectedRevision + 1
        || !exact(saved.approval.policy, policy)) throw new Error("approval_mismatch");
      return saved;
    },
  };
}

export const lookupPolicy = (provider: LookupProvider): LookupPolicy => ({ provider, maximumClass: "shared_room" });

/** The recorded lookup provider, only while it is still one of the configured providers; a stale grant authorizes nothing. */
export function activeLookupProvider(state: LookupState | undefined): LookupProvider | null {
  const recorded = state?.approval?.policy?.provider;
  return recorded && state.providers.some(provider => exact(provider, recorded)) ? recorded : null;
}

export type PermissionFailure = "unavailable" | "changed" | "unconfirmed" | "refused";
/** Decides the write from the snapshot it will be written against, or explains why none is needed. */
export type Change<S, P> = (snapshot: S) => { policy: P | null } | { skip: string };
export type Outcome = { result: "confirmed" } | { result: "skipped"; reason: string } | { result: "failed"; failure: PermissionFailure };

export interface PermissionState<S, P> {
  snapshot: S | undefined;
  busy: boolean;
  failure: PermissionFailure | null;
  message: string;
  load(): Promise<void>;
  /** Writes against the snapshot last read, or reads first when `fresh`. */
  commit(change: Change<S, P>, confirmation: string, fresh?: boolean): Promise<Outcome>;
}

const readFailure = (error: unknown): PermissionFailure => error instanceof Error && error.message === "approval_changed" ? "changed" : "unavailable";

/**
 * Owner permission state with one rule: no write without a read. The snapshot
 * is read when the device mounts; a rejected or lost write clears it so the
 * next write needs a fresh read, because the lost request may have committed.
 */
export function usePermission<S, P>(permission: Permission<S, P>, enabled = true): PermissionState<S, P> {
  const [snapshot, setSnapshotState] = useState<S | undefined>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PermissionFailure | null>(null);
  const [message, setMessage] = useState("");
  const current = useRef<S | undefined>(undefined);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const setSnapshot = useCallback((value: S | undefined) => { current.current = value; setSnapshotState(value); }, []);
  const begin = useCallback(() => {
    const controller = new AbortController(); active.current = controller;
    return { epoch: generation.current, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT)]) };
  }, []);
  const load = useCallback(async () => {
    generation.current++; active.current?.abort(); active.current = null;
    setSnapshot(undefined); setFailure(null); setMessage(""); setBusy(true);
    const { epoch, signal } = begin();
    try {
      const saved = await permission.read(signal);
      if (epoch === generation.current) setSnapshot(saved);
    } catch (error) {
      if (epoch === generation.current) setFailure(readFailure(error));
    } finally { if (epoch === generation.current) { active.current = null; setBusy(false); } }
  }, [begin, permission, setSnapshot]);
  const commit = useCallback(async (change: Change<S, P>, confirmation: string, fresh = false): Promise<Outcome> => {
    if (active.current || !fresh && current.current === undefined) return { result: "failed", failure: "unavailable" };
    const { epoch, signal } = begin();
    setBusy(true); setMessage(""); setFailure(null);
    try {
      let base: S;
      if (fresh) {
        try { base = await permission.read(signal); } catch (error) {
          const failed = readFailure(error);
          if (epoch === generation.current) { setSnapshot(undefined); setFailure(failed); }
          return { result: "failed", failure: failed };
        }
      } else base = current.current as S;
      if (epoch !== generation.current) return { result: "failed", failure: "unavailable" };
      const next = change(base);
      if ("skip" in next) { setSnapshot(base); return { result: "skipped", reason: next.skip }; }
      const saved = await permission.write(base, next.policy, signal);
      if (epoch !== generation.current) return { result: "failed", failure: "unavailable" };
      setSnapshot(saved); setMessage(confirmation);
      return { result: "confirmed" };
    } catch (error) {
      // A definite no changed nothing, so the snapshot the owner read is still
      // current and the next attempt needs no fresh read.
      if (error instanceof PermissionRefused) {
        if (epoch === generation.current) setFailure("refused");
        return { result: "failed", failure: "refused" };
      }
      // A timed-out or lost write may have committed. Only a fresh read can say.
      const failed: PermissionFailure = error instanceof Error && error.message === "approval_changed" ? "changed" : "unconfirmed";
      if (epoch === generation.current) { setSnapshot(undefined); setFailure(failed); }
      return { result: "failed", failure: failed };
    } finally { if (epoch === generation.current) { active.current = null; setBusy(false); } }
  }, [begin, permission, setSnapshot]);
  useEffect(() => {
    if (enabled) void load();
    return () => { generation.current++; active.current?.abort(); active.current = null; };
  }, [enabled, load]);
  return { snapshot, busy, failure, message, load, commit };
}
