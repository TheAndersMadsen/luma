import type { SpeechPolicy } from "@/lib/contracts/speechDisclosure";
import type { LookupPolicy } from "@/lib/contracts/lookupDisclosure";
import type { PrivateDisplayPolicy } from "@/lib/contracts/privateDisplay";
import type { ScreenContextPolicy } from "@/lib/contracts/screenContext";
import type { DeviceActionPolicy } from "@/lib/contracts/deviceActions";
import type { DeviceCommandPolicy } from "@/lib/contracts/deviceCommands";
import type { NativeSurface } from "@/lib/contracts/nativeSurfaces";
import {
  deviceActionsPermission, deviceCommandsPermission, lookupPermission, privatePermission,
  screenContextPermission, speechPermission, type Permission,
} from "./permissions";

/**
 * Approving a device again bumps its approval revision, and every owner
 * permission Cosmos holds for it is bound to the old one. They are dropped in
 * the same write. That is correct — a permission is granted against a posture,
 * and the posture changed — but it must never be a surprise, so this reads
 * them before the owner clicks and offers to put each back afterwards.
 */

/** The permissions a reapproval drops, in the order they must be put back: a class ceiling before anything capped by it. */
export const DROPPED = ["private", "screen", "speech", "web", "places", "acts", "tasks"] as const;
export type Dropped = typeof DROPPED[number];

export const DROPPED_TITLE: Record<Dropped, string> = {
  private: "Show private replies here",
  screen: "Use what’s on the screen",
  speech: "Speak replies",
  web: "Look things up on the web",
  places: "Find places",
  acts: "Let this device act",
  tasks: "Tasks on this device",
};

export interface HeldPolicies {
  private: PrivateDisplayPolicy | null;
  screen: ScreenContextPolicy | null;
  speech: SpeechPolicy | null;
  web: LookupPolicy | null;
  places: LookupPolicy | null;
  acts: DeviceActionPolicy | null;
  tasks: DeviceCommandPolicy | null;
}
export const NOTHING_HELD: HeldPolicies = { private: null, screen: null, speech: null, web: null, places: null, acts: null, tasks: null };

/** What one permission holds now, or nothing when it could not be read; an unreadable permission is never restored from a guess. */
async function held<S, P>(permission: Permission<S, P>, policy: (snapshot: S) => P | null | undefined, signal: AbortSignal): Promise<P | null> {
  try { return policy(await permission.read(signal)) ?? null; } catch { return null; }
}

/**
 * Everything the owner has granted this installation at its current approval
 * revision. Read before the reapproval, because after it there is nothing left
 * to read.
 */
export async function readHeldPolicies(row: NativeSurface, signal: AbortSignal): Promise<HeldPolicies> {
  const [privateDisplay, screen, speech, web, places, acts, tasks] = await Promise.all([
    held(privatePermission(row.surfaceId, row.revision), saved => saved?.policy, signal),
    held(screenContextPermission(row.surfaceId, row.revision), saved => saved?.policy, signal),
    held(speechPermission(row.surfaceId, row.revision), saved => saved?.policy, signal),
    held(lookupPermission("web", row.surfaceId, row.revision), saved => saved.approval?.policy, signal),
    held(lookupPermission("places", row.surfaceId, row.revision), saved => saved.approval?.policy, signal),
    held(deviceActionsPermission(row.surfaceId, row.revision), saved => saved?.policy, signal),
    held(deviceCommandsPermission(row.surfaceId, row.revision), saved => saved?.policy, signal),
  ]);
  return { private: privateDisplay, screen, speech, web, places, acts, tasks };
}

/** Which of them a reapproval would actually drop: the ones that are on. */
export const heldNames = (policies: HeldPolicies): Dropped[] => DROPPED.filter(name => policies[name] !== null);

export type RestoreOutcome = "restored" | "skipped" | "failed";
export interface RestoreStep { name: Dropped; title: string; outcome: RestoreOutcome }

async function put<S, P>(permission: Permission<S, P>, policy: P | null, signal: AbortSignal): Promise<RestoreOutcome> {
  if (policy === null) return "skipped";
  try {
    // The permission is written against a snapshot read at the NEW revision,
    // which is the whole point: nothing is carried over, it is granted again.
    const snapshot = await permission.read(signal);
    await permission.write(snapshot, policy, signal);
    return "restored";
  } catch { return "failed"; }
}

/**
 * Grants each dropped permission again at the value it had, one at a time and
 * in an order that never asks Cosmos to accept a class above a ceiling it has
 * not been given back yet. Each step is reported on its own; a failure stops
 * nothing, because these permissions do not depend on one another beyond that
 * one ordering.
 */
export async function restoreHeldPolicies(
  surfaceId: string, revision: number, policies: HeldPolicies, signal: AbortSignal,
  report: (step: RestoreStep) => void,
): Promise<RestoreStep[]> {
  const steps: RestoreStep[] = [];
  const permissions: { [K in Dropped]: () => Promise<RestoreOutcome> } = {
    private: () => put(privatePermission(surfaceId, revision), policies.private, signal),
    screen: () => put(screenContextPermission(surfaceId, revision), policies.screen, signal),
    speech: () => put(speechPermission(surfaceId, revision), policies.speech, signal),
    web: () => put(lookupPermission("web", surfaceId, revision), policies.web, signal),
    places: () => put(lookupPermission("places", surfaceId, revision), policies.places, signal),
    acts: () => put(deviceActionsPermission(surfaceId, revision), policies.acts, signal),
    tasks: () => put(deviceCommandsPermission(surfaceId, revision), policies.tasks, signal),
  };
  for (const name of DROPPED) {
    if (policies[name] === null) continue;
    const step: RestoreStep = { name, title: DROPPED_TITLE[name], outcome: await permissions[name]() };
    steps.push(step);
    report(step);
  }
  return steps;
}
