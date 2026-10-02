/**
 * Failed password sign-ins, counted per account and per network address.
 *
 * Keycloak's own brute-force lockout answers a locked account exactly like a
 * wrong password ("Invalid user credentials"), so on its own it would tell the
 * owner nothing. Center counts the attempts it forwards, keeps the wrong
 * passwords, and, past the limit, says plainly how long to wait instead of
 * asking Keycloak again. Process-local, like every other Center limit: one
 * Center container serves one deployment.
 */

export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const ACCOUNT_FAILURE_LIMIT = 5;
export const ADDRESS_FAILURE_LIMIT = 20;
const MAX_TRACKED_KEYS = 4_096;

const failures = new Map<string, number[]>();

export type LoginThrottle =
  | { allowed: true }
  | { allowed: false; scope: "account" | "address"; retryAfterSeconds: number };

function accountKey(account: string): string {
  return `account:${account.trim().toLowerCase()}`;
}

function addressKey(address: string): string {
  return `address:${address}`;
}

function recent(key: string, now: number): number[] {
  const windowStart = now - LOGIN_WINDOW_SECONDS * 1_000;
  const kept = (failures.get(key) ?? []).filter((at) => at > windowStart);
  if (kept.length) failures.set(key, kept);
  else failures.delete(key);
  return kept;
}

function waitFor(key: string, limit: number, now: number): number | null {
  const kept = recent(key, now);
  // The attempt that tipped the count ages out first.
  const tipping = kept[kept.length - limit];
  if (kept.length < limit || tipping === undefined) return null;
  const freedAt = tipping + LOGIN_WINDOW_SECONDS * 1_000;
  return Math.max(1, Math.ceil((freedAt - now) / 1_000));
}

/** Whether a sign-in for `account` from `address` may be tried now. */
export function loginThrottle(address: string, account: string, now = Date.now()): LoginThrottle {
  const accountWait = waitFor(accountKey(account), ACCOUNT_FAILURE_LIMIT, now);
  if (accountWait !== null) return { allowed: false, scope: "account", retryAfterSeconds: accountWait };
  const addressWait = waitFor(addressKey(address), ADDRESS_FAILURE_LIMIT, now);
  if (addressWait !== null) return { allowed: false, scope: "address", retryAfterSeconds: addressWait };
  return { allowed: true };
}

export interface LoginAttempt {
  readonly address: string;
  readonly account: string;
  readonly at: number;
}

/**
 * Count one sign-in for both the account and the address before Keycloak is
 * asked. Counted only after the answer, parallel requests would all pass the
 * check while the first was still outstanding. Settle it with the answer.
 */
export function beginLoginAttempt(address: string, account: string, now = Date.now()): LoginAttempt {
  for (const key of [accountKey(account), addressKey(address)]) {
    recent(key, now);
    failures.set(key, [...(failures.get(key) ?? []), now]);
  }
  while (failures.size > MAX_TRACKED_KEYS) {
    const oldest = failures.keys().next();
    if (oldest.done) break;
    failures.delete(oldest.value);
  }
  return { address, account, at: now };
}

function forget(key: string, at: number): void {
  const kept = failures.get(key);
  const index = kept?.indexOf(at) ?? -1;
  if (!kept || index < 0) return;
  kept.splice(index, 1);
  if (!kept.length) failures.delete(key);
}

/**
 * A wrong password stays counted. Any other answer takes the attempt back: a
 * sign-in also clears the account's earlier failures, and a refusal that was
 * not about the password (Keycloak down, a pending account step) counts for
 * nothing.
 */
export function settleLoginAttempt(
  attempt: LoginAttempt,
  outcome: "wrong-password" | "signed-in" | "not-counted",
): void {
  if (outcome === "wrong-password") return;
  if (outcome === "signed-in") failures.delete(accountKey(attempt.account));
  else forget(accountKey(attempt.account), attempt.at);
  forget(addressKey(attempt.address), attempt.at);
}

/** The login route's answer to a throttled attempt. */
export function loginThrottleResponse(throttle: Extract<LoginThrottle, { allowed: false }>): {
  status: 429;
  error: string;
  retryAfterSeconds: number;
} {
  const minutes = Math.ceil(throttle.retryAfterSeconds / 60);
  const wait = minutes <= 1 ? "a minute" : `${minutes} minutes`;
  return {
    status: 429,
    error: throttle.scope === "account"
      ? `Too many wrong passwords for this account. Wait ${wait}, then try again.`
      : `Too many failed sign-ins from your network. Wait ${wait}, then try again.`,
    retryAfterSeconds: throttle.retryAfterSeconds,
  };
}
