export const SUBAGENT_RETRY_BASE_DELAY_MS = 1_000
export const SUBAGENT_RETRY_MAX_DELAY_MS = 60_000

function assertAttemptCount(attemptCount: number): void {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new RangeError("Subagent retry attempt must be a positive safe integer")
  }
}

function assertDate(now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new RangeError("Subagent retry time must be a valid Date")
  }
}

/** Returns the deterministic server-owned delay for a failed attempt. */
export function subagentRetryDelayMs(attemptCount: number): number {
  assertAttemptCount(attemptCount)
  return Math.min(SUBAGENT_RETRY_MAX_DELAY_MS, SUBAGENT_RETRY_BASE_DELAY_MS * 2 ** (attemptCount - 1))
}

/** Computes the durable eligibility time for the supplied failed attempt. */
export function computeSubagentNextAttemptAt(attemptCount: number, now: Date): Date {
  assertDate(now)
  return new Date(now.getTime() + subagentRetryDelayMs(attemptCount))
}

/** Applies the same due gate used by the database-owned dispatch paths. */
export function isSubagentRetryDue(nextAttemptAt: Date | null | undefined, now: Date): boolean {
  assertDate(now)
  if (nextAttemptAt == null) return true
  if (!(nextAttemptAt instanceof Date) || !Number.isFinite(nextAttemptAt.getTime())) return false
  return nextAttemptAt.getTime() <= now.getTime()
}
