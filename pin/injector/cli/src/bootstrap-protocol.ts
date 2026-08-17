/**
 * @module bootstrap-protocol
 *
 * Bootstrap transaction validation, status parsing, and verified stage execution.
 *
 * This module defines the exact contract between the host CLI and the on-device
 * exploit module for bootstrapping the PenumbraOS installer package. It validates
 * transaction parameters, parses exploit status messages, and orchestrates the
 * two-stage bootstrap with verified system_server PID transitions.
 *
 * ## Bootstrap transactions
 *
 * A bootstrap transaction is a cryptographically-bound agreement between the host
 * CLI and the exploit module. Every transaction has:
 *
 * - A 32-character hex transaction ID (used in filenames, status tracking, and
 *   SharedPreferences persistence)
 * - A mode: fresh, replace, or rollback
 * - A controlled /data/app/ directory name matching strict patterns
 * - A staged APK path bound to the transaction ID
 *
 * ## Why validation is strict
 *
 * The exploit grants write access to /data/system (which contains packages.xml).
 * A compromised or buggy host could redirect the exploit to write arbitrary data
 * into package settings. Every field is validated on both sides (CLI here,
 * BootstrapContract.kt on device) to prevent path traversal, transaction ID
 * injection, mode confusion, and staged APK path manipulation.
 *
 * ## Transaction lifecycle
 *
 * stage1_started -> stage1_ready -> [system_server restart] ->
 * stage2_started -> stage2_committed -> [system_server restart] ->
 * verification complete
 *
 * For recovery (resuming orphan sessions), only stage2 is run.
 * For rollback, the final phase is rollback_committed.
 *
 * ## Verified stage execution
 *
 * runVerifiedBootstrapStage proves both durable stage completion AND an actual
 * system_server process transition. This prevents the CLI from proceeding if
 * the exploit reported success but system_server never actually crashed (which
 * would mean the fake sessions were never reloaded or packages-backup.xml was
 * never read).
 */

import * as path from "node:path";

const TRANSACTION_ID = /^[a-f0-9]{32}$/;
const APP_DIR_NAME = /^com\.penumbraos\.systeminjector-(?:injected|replacement-[a-f0-9]{12}|rollback-[a-f0-9]{12})$/;
const ACTIVE_APP_DIR_NAME = /^com\.penumbraos\.systeminjector-(?:injected|replacement-[a-f0-9]{12}|rollback-[a-f0-9]{12})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REMOTE_INSTALLER_APK = /^\/data\/local\/tmp\/installer-[a-f0-9]{32}\.apk$/;
const EXPLOIT_PACKAGE = "com.penumbraos.systeminjector.exploit";
const USER_ZERO_APP_UID = /^1\d{4}$/;

export type BootstrapMode = "fresh" | "replace" | "rollback";

export type BootstrapPhase =
  | "stage1_started"
  | "stage1_ready"
  | "stage2_started"
  | "stage2_committed"
  | "rollback_committed"
  | "failed";

export interface BootstrapStatus {
  transactionId: string;
  phase: BootstrapPhase;
  detail: string;
}

export interface BootstrapTransactionSpec {
  mode: BootstrapMode;
  transactionId: string;
  targetAppDir: string;
  apkPath?: string;
  expectedCurrentCodePath?: string;
  replacementCodePath?: string;
}

export interface RecoveryStage2Spec extends BootstrapTransactionSpec {
  mode: "replace";
  systemSessionId: number;
  targetSessionId: number;
  orphanInstallerUid: number;
  orphanCreatedMillis: number;
  expectedCurrentSha256: string;
  replacementSha256: string;
}

export interface RecoveryRollbackSpec {
  transactionId: string;
  systemSessionId: number;
  orphanInstallerUid: number;
  orphanCreatedMillis: number;
  priorCodePath: string;
  possibleReplacementCodePath: string;
  expectedPriorSha256: string;
}

export interface OrphanBootstrapSessionPair {
  systemSessionId: number;
  targetSessionId: number;
  installerUid: number;
  createdMillis: number;
  targetAppDir: string;
  targetCodePath: string;
}

/** Build the exact same transaction payload for both exploit stages. */
export function buildBootstrapTransactionExtras(
  transaction: BootstrapTransactionSpec
): Record<string, string> {
  requireTransactionId(transaction.transactionId);
  const targetCodePath = appDirToCodePath(transaction.targetAppDir);
  const extras: Record<string, string> = {
    transaction_id: transaction.transactionId,
    mode: transaction.mode,
    target_app_dir: transaction.targetAppDir,
  };

  if (!transaction.apkPath || !REMOTE_INSTALLER_APK.test(transaction.apkPath)) {
    throw new Error(`${transaction.mode} bootstrap requires a controlled staged APK path`);
  }
  if (transaction.apkPath !== `/data/local/tmp/installer-${transaction.transactionId}.apk`) {
    throw new Error("Staged APK path does not match the bootstrap transaction");
  }
  extras.apk_path = transaction.apkPath;

  if (transaction.mode === "fresh") {
    if (
      transaction.targetAppDir !== "com.penumbraos.systeminjector-injected" ||
      transaction.expectedCurrentCodePath !== undefined ||
      transaction.replacementCodePath !== undefined
    ) {
      throw new Error("Invalid fresh bootstrap transaction");
    }
  } else {
    const requiredTargetPrefix = transaction.mode === "replace"
      ? "com.penumbraos.systeminjector-replacement-"
      : "com.penumbraos.systeminjector-rollback-";
    if (!transaction.targetAppDir.startsWith(requiredTargetPrefix)) {
      throw new Error(`Invalid ${transaction.mode} transaction target directory`);
    }
    if (!transaction.expectedCurrentCodePath || !transaction.replacementCodePath) {
      throw new Error(`${transaction.mode} transaction requires both controlled code paths`);
    }
    const current = requireInjectorCodePath(transaction.expectedCurrentCodePath);
    const replacement = requireInjectorCodePath(transaction.replacementCodePath);
    if (current === replacement) {
      throw new Error(`${transaction.mode} transaction code paths must be distinct`);
    }
    if (transaction.mode === "replace" && replacement !== targetCodePath) {
      throw new Error("Replacement transaction does not target its new app directory");
    }
    if (
      transaction.mode === "rollback" &&
      (targetCodePath === current || targetCodePath === replacement)
    ) {
      throw new Error("Rollback transaction requires a fresh restore directory");
    }
    extras.expected_current_code_path = current;
    extras.replacement_code_path = replacement;
  }
  return extras;
}

/** Build the separately-gated payload for resuming an already-created stage-1 pair. */
export function buildRecoveryStage2Extras(
  recovery: RecoveryStage2Spec
): Record<string, string> {
  const extras = buildBootstrapTransactionExtras(recovery);
  if (
    !Number.isSafeInteger(recovery.systemSessionId) ||
    recovery.systemSessionId <= 0 ||
    !Number.isSafeInteger(recovery.targetSessionId) ||
    recovery.targetSessionId !== recovery.systemSessionId + 1
  ) {
    throw new Error("Recovery requires one positive, consecutive PackageInstaller session pair");
  }
  if (
    !Number.isSafeInteger(recovery.orphanInstallerUid) ||
    !USER_ZERO_APP_UID.test(String(recovery.orphanInstallerUid))
  ) {
    throw new Error("Recovery requires the original user-0 application UID");
  }
  if (!Number.isSafeInteger(recovery.orphanCreatedMillis) || recovery.orphanCreatedMillis <= 0) {
    throw new Error("Recovery requires the original positive session creation timestamp");
  }
  const expectedCurrentSha256 = requireSha256(recovery.expectedCurrentSha256);
  const replacementSha256 = requireSha256(recovery.replacementSha256);
  if (expectedCurrentSha256 === replacementSha256) {
    throw new Error("Recovery candidate must differ from the active injector artifact");
  }
  return {
    ...extras,
    recovery_system_session_id: String(recovery.systemSessionId),
    recovery_target_session_id: String(recovery.targetSessionId),
    recovery_installer_uid: String(recovery.orphanInstallerUid),
    recovery_created_millis: String(recovery.orphanCreatedMillis),
    expected_current_sha256: expectedCurrentSha256,
    replacement_sha256: replacementSha256,
  };
}

/** Build a fresh status/transaction namespace for system-session-only rollback. */
export function buildRecoveryRollbackExtras(
  rollback: RecoveryRollbackSpec
): Record<string, string> {
  requireTransactionId(rollback.transactionId);
  if (!Number.isSafeInteger(rollback.systemSessionId) || rollback.systemSessionId <= 0) {
    throw new Error("Recovery rollback requires the positive system session ID");
  }
  if (
    !Number.isSafeInteger(rollback.orphanInstallerUid) ||
    !USER_ZERO_APP_UID.test(String(rollback.orphanInstallerUid))
  ) {
    throw new Error("Recovery rollback requires the original user-0 application UID");
  }
  if (!Number.isSafeInteger(rollback.orphanCreatedMillis) || rollback.orphanCreatedMillis <= 0) {
    throw new Error("Recovery rollback requires the original session creation timestamp");
  }
  const priorCodePath = requireInjectorCodePath(rollback.priorCodePath);
  const possibleReplacementCodePath = requireInjectorCodePath(
    rollback.possibleReplacementCodePath
  );
  if (priorCodePath === possibleReplacementCodePath) {
    throw new Error("Recovery rollback paths must be distinct");
  }
  return {
    transaction_id: rollback.transactionId,
    recovery_system_session_id: String(rollback.systemSessionId),
    recovery_installer_uid: String(rollback.orphanInstallerUid),
    recovery_created_millis: String(rollback.orphanCreatedMillis),
    recovery_prior_code_path: priorCodePath,
    recovery_possible_replacement_code_path: possibleReplacementCodePath,
    expected_current_sha256: requireSha256(rollback.expectedPriorSha256),
  };
}

export interface BootstrapStageOperations {
  getSystemServerPid(): Promise<string>;
  sendStageBroadcast(extras: Record<string, string>): Promise<void>;
  waitForStatus(
    transactionId: string,
    expectedPhase: BootstrapPhase,
    timeoutMs: number
  ): Promise<void>;
  waitForSystemServerRestart(previousPid: string): Promise<void>;
  waitForSystemReady(): Promise<void>;
}

export function requireTransactionId(transactionId: string): string {
  if (!TRANSACTION_ID.test(transactionId)) {
    throw new Error(`Invalid bootstrap transaction ID: ${transactionId}`);
  }
  return transactionId;
}

export function requireBootstrapAppDirName(appDirName: string): string {
  if (!APP_DIR_NAME.test(appDirName)) {
    throw new Error(`Invalid bootstrap app directory name: ${appDirName}`);
  }
  return appDirName;
}

export function appDirToCodePath(appDirName: string): string {
  return `/data/app/${requireBootstrapAppDirName(appDirName)}`;
}

export function baseApkPathForCodePath(codePath: string): string {
  requireInjectorCodePath(codePath);
  return `${codePath}/base.apk`;
}

export function requireInjectorCodePath(codePath: string): string {
  if (path.posix.dirname(codePath) !== "/data/app") {
    throw new Error(`Injector code path is outside /data/app: ${codePath}`);
  }
  if (!ACTIVE_APP_DIR_NAME.test(path.posix.basename(codePath))) {
    throw new Error(`Invalid active injector app directory: ${path.posix.basename(codePath)}`);
  }
  return codePath;
}

export function parsePackageBaseApkPath(output: string): string {
  const paths = output
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/^package:(\/data\/app\/[^\s]+\/base\.apk)$/)?.[1])
    .filter((value): value is string => value !== undefined);
  if (paths.length !== 1) {
    throw new Error(`Expected one installed base.apk path, got: ${output || "no response"}`);
  }
  const codePath = path.posix.dirname(paths[0]!);
  requireInjectorCodePath(codePath);
  return paths[0]!;
}

export function parseSha256Output(output: string): string {
  const match = output.trim().match(/^([a-fA-F0-9]{64})\s+\S+$/);
  if (!match) throw new Error(`Unable to parse SHA-256 output: ${output || "no response"}`);
  return match[1]!.toLowerCase();
}

export function requireSha256(digest: string): string {
  const normalized = digest.toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(`Invalid SHA-256 digest: ${digest}`);
  return normalized;
}

export function parseBootstrapStatusMessage(message: string): BootstrapStatus | null {
  if (message === "NO_STATUS") return null;
  const match = message.match(
    /^BOOTSTRAP_STATUS:([a-f0-9]{32}):(stage1_started|stage1_ready|stage2_started|stage2_committed|rollback_committed|failed):([A-Za-z0-9_-]*)$/
  );
  if (!match) throw new Error(`Invalid bootstrap status message: ${message}`);
  const detail = match[3]
    ? Buffer.from(match[3], "base64url").toString("utf8")
    : "";
  return {
    transactionId: match[1]!,
    phase: match[2]! as BootstrapPhase,
    detail,
  };
}

interface ParsedInstallerSession {
  sessionId: number;
  userId: number;
  originalInstallerUid: number;
  originalInstallerPackageName: string;
  installerUid: number;
  installerPackageName: string;
  createdMillis: number;
  committedMillis: number;
  stageDir: string;
  mode: number;
  installFlags: number;
  committed: boolean;
  sealed: boolean;
  destroyed: boolean;
  relinquished: boolean;
  fds: number;
  bridges: number;
  finalStatus: number;
  finalMessage: string;
  multiPackage: boolean;
  staged: boolean;
  parentSessionId: number;
  childSessionIds: string;
}

function requiredSessionField(
  block: string,
  pattern: RegExp,
  label: string,
  sessionId: number
): string {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...block.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error(
      `PackageInstaller session ${sessionId} must contain exactly one ${label}; ` +
        `found ${matches.length}`
    );
  }
  return matches[0]![1]!;
}

function parseInstallerSessions(output: string): ParsedInstallerSession[] {
  const heading = output.match(/^Active install sessions:\s*$/m);
  if (!heading) throw new Error("Unable to find active PackageInstaller sessions");
  const afterHeading = output.slice(heading.index! + heading[0].length);
  const finalized = afterHeading.match(/^Finalized install sessions:\s*$/m);
  if (!finalized || finalized.index === undefined) {
    throw new Error("Unable to delimit active PackageInstaller sessions");
  }
  const active = afterHeading.slice(0, finalized.index);
  const headers = [...active.matchAll(/^\s*Session (\d+):\s*$/gm)];
  const sessions = headers.map((header, index) => {
    const sessionId = Number(header[1]);
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      throw new Error(`Invalid PackageInstaller session ID: ${header[1]}`);
    }
    const start = header.index! + header[0].length;
    const end = headers[index + 1]?.index ?? active.length;
    const block = active.slice(start, end);
    const numberField = (pattern: RegExp, label: string) => {
      const raw = requiredSessionField(block, pattern, label, sessionId);
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) {
        throw new Error(`PackageInstaller session ${sessionId} has invalid ${label}: ${raw}`);
      }
      return value;
    };
    const booleanField = (pattern: RegExp, label: string) =>
      requiredSessionField(block, pattern, label, sessionId) === "true";
    return {
      sessionId,
      userId: numberField(/\buserId=(\d+)\b/, "userId"),
      originalInstallerUid: numberField(
        /\bmOriginalInstallerUid=(\d+)\b/,
        "mOriginalInstallerUid"
      ),
      originalInstallerPackageName: requiredSessionField(
        block,
        /\bmOriginalInstallerPackageName=(\S+)/,
        "mOriginalInstallerPackageName",
        sessionId
      ),
      installerUid: numberField(/\bmInstallerUid=(\d+)\b/, "mInstallerUid"),
      installerPackageName: requiredSessionField(
        block,
        /^\s*installerPackageName=(\S+)\s+installInitiatingPackageName=/m,
        "installerPackageName",
        sessionId
      ),
      createdMillis: numberField(/\bcreatedMillis=(\d+)\b/, "createdMillis"),
      committedMillis: numberField(/\bcommittedMillis=(\d+)\b/, "committedMillis"),
      stageDir: requiredSessionField(block, /\bstageDir=(\S+)/, "stageDir", sessionId),
      mode: numberField(/\bmode=(\d+)\b/, "mode"),
      installFlags: numberField(
        /\binstallFlags=(0x[0-9a-fA-F]+|\d+)\b/,
        "installFlags"
      ),
      committed: booleanField(/\bmCommitted=(true|false)\b/, "mCommitted"),
      sealed: booleanField(/\bmSealed=(true|false)\b/, "mSealed"),
      destroyed: booleanField(/\bmDestroyed=(true|false)\b/, "mDestroyed"),
      relinquished: booleanField(/\bmRelinquished=(true|false)\b/, "mRelinquished"),
      fds: numberField(/\bmFds=(\d+)\b/, "mFds"),
      bridges: numberField(/\bmBridges=(\d+)\b/, "mBridges"),
      finalStatus: numberField(/\bmFinalStatus=(-?\d+)\b/, "mFinalStatus"),
      finalMessage: requiredSessionField(
        block,
        /\bmFinalMessage=(\S+)/,
        "mFinalMessage",
        sessionId
      ),
      multiPackage: booleanField(/\bparams\.isMultiPackage=(true|false)\b/, "isMultiPackage"),
      staged: booleanField(/\bparams\.isStaged=(true|false)\b/, "isStaged"),
      parentSessionId: numberField(/\bmParentSessionId=(-?\d+)\b/, "mParentSessionId"),
      childSessionIds: requiredSessionField(
        block,
        /\bmChildSessionIds=(\[[^\]]*\])/,
        "mChildSessionIds",
        sessionId
      ),
    };
  });
  if (new Set(sessions.map((session) => session.sessionId)).size !== sessions.length) {
    throw new Error("Active PackageInstaller dump contains duplicate session IDs");
  }
  return sessions;
}

/**
 * Find exactly one untouched exploit-owned stage-1 pair. This parser is deliberately
 * tied to `dumpsys package installs`; any missing/ambiguous field fails closed.
 */
export function parseOrphanBootstrapSessionPair(output: string): OrphanBootstrapSessionPair {
  const sessions = parseInstallerSessions(output);
  const systemStageSessions = sessions.filter((session) => session.stageDir === "/data/system");
  if (systemStageSessions.length !== 1) {
    throw new Error(
      `Recovery requires exactly one active /data/system session; found ${systemStageSessions.length}`
    );
  }
  const exploitSessions = sessions.filter(
    (session) =>
      session.originalInstallerPackageName === EXPLOIT_PACKAGE ||
      session.installerPackageName === EXPLOIT_PACKAGE
  );
  if (exploitSessions.length !== 2) {
    throw new Error(
      `Recovery requires exactly two active exploit-owned sessions; found ${exploitSessions.length}`
    );
  }
  const systemSession = systemStageSessions[0]!;
  const targetSession = sessions.find(
    (session) => session.sessionId === systemSession.sessionId + 1
  );
  if (!targetSession || !exploitSessions.includes(systemSession) || !exploitSessions.includes(targetSession)) {
    throw new Error("Recovery session pair is missing or not consecutive");
  }
  const targetPrefix = "/data/app/com.penumbraos.systeminjector-replacement-";
  if (!targetSession.stageDir.startsWith(targetPrefix)) {
    throw new Error(`Recovery target session has an uncontrolled path: ${targetSession.stageDir}`);
  }
  const targetAppDir = targetSession.stageDir.slice("/data/app/".length);
  requireBootstrapAppDirName(targetAppDir);

  const ownerUid = systemSession.installerUid;
  for (const session of [systemSession, targetSession]) {
    if (
      session.userId !== 0 ||
      session.originalInstallerUid !== ownerUid ||
      session.installerUid !== ownerUid ||
      session.originalInstallerPackageName !== EXPLOIT_PACKAGE ||
      session.installerPackageName !== EXPLOIT_PACKAGE ||
      !USER_ZERO_APP_UID.test(String(ownerUid)) ||
      session.createdMillis !== systemSession.createdMillis ||
      session.committedMillis !== 0 ||
      session.mode !== 1 ||
      session.installFlags !== 0 ||
      session.committed ||
      session.sealed ||
      session.destroyed ||
      session.relinquished ||
      session.fds !== 0 ||
      session.bridges !== 0 ||
      session.finalStatus !== 0 ||
      session.finalMessage !== "null" ||
      session.multiPackage ||
      session.staged ||
      session.parentSessionId !== -1 ||
      session.childSessionIds !== "[]"
    ) {
      throw new Error(`PackageInstaller session ${session.sessionId} is not an untouched bootstrap session`);
    }
  }
  return {
    systemSessionId: systemSession.sessionId,
    targetSessionId: targetSession.sessionId,
    installerUid: ownerUid,
    createdMillis: systemSession.createdMillis,
    targetAppDir,
    targetCodePath: targetSession.stageDir,
  };
}

export interface BootstrapStatusPollOperations {
  readStatus(transactionId: string): Promise<BootstrapStatus | null>;
  delay(milliseconds: number): Promise<void>;
  now(): number;
}

/** Poll transient provider-startup failures, while propagating a durable exploit failure. */
export async function waitForExpectedBootstrapStatus(
  operations: BootstrapStatusPollOperations,
  transactionId: string,
  expectedPhase: BootstrapPhase,
  timeoutMs: number,
  pollMs = 500
): Promise<void> {
  const start = operations.now();
  let lastError: unknown;
  while (operations.now() - start < timeoutMs) {
    try {
      const status = await operations.readStatus(transactionId);
      if (status?.phase === "failed") {
        throw new Error(`Exploit transaction failed: ${status.detail || "unknown failure"}`);
      }
      if (status?.phase === expectedPhase) return;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Exploit transaction failed:")) {
        throw error;
      }
      lastError = error;
    }
    await operations.delay(pollMs);
  }
  throw new Error(
    `Timed out waiting for exploit status ${expectedPhase}: ` +
      (lastError instanceof Error ? lastError.message : "no durable status")
  );
}

/**
 * Run one exploit stage and prove both durable stage completion and an actual
 * system_server process transition before returning.
 */
export async function runVerifiedBootstrapStage(
  operations: BootstrapStageOperations,
  transactionId: string,
  expectedPhase: BootstrapPhase,
  extras: Record<string, string>,
  statusTimeoutMs: number
): Promise<void> {
  requireTransactionId(transactionId);
  const previousPid = await operations.getSystemServerPid();
  await operations.sendStageBroadcast(extras);
  await operations.waitForStatus(transactionId, expectedPhase, statusTimeoutMs);
  await operations.waitForSystemServerRestart(previousPid);
  await operations.waitForSystemReady();
  // PackageManager can be registered before user 0 and third-party content
  // providers are ready. Reuse the durable status poll after the restart rather
  // than issuing a single provider call during that boot window.
  await operations.waitForStatus(transactionId, expectedPhase, statusTimeoutMs);
}
