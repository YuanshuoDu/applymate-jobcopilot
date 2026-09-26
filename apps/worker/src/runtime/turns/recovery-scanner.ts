import { randomUUID } from "node:crypto"

import { getPool } from "../../db/apply-results.js"
import type { LeasePool } from "./lease.js"
import { TURN_DISPATCH_MAX_BATCH, type TurnDispatchQueue } from "./recovery-scanner-common.js"
import { ensureQueuedTurnDispatches } from "./recovery-scanner-queue-repair.js"
import { dispatchPendingTurnOutbox } from "./recovery-scanner-delivery.js"
import {
  persistTurnDispatch,
  reclaimExpiredTurns,
  repairLegacyTurnDispatchAggregates,
} from "./recovery-scanner-storage.js"

export { TURN_DISPATCH_TOPIC, TURN_DISPATCH_MAX_BATCH, turnDispatchKey, turnJobId } from "./recovery-scanner-common.js"
export type { TurnDispatchQueue } from "./recovery-scanner-common.js"
export { dispatchPendingTurnOutbox } from "./recovery-scanner-delivery.js"
export {
  persistTurnDispatch,
  persistTurnDispatchInTransaction,
  persistWakeupTurnDispatchInTransaction,
  reclaimExpiredTurns,
  repairLegacyTurnDispatchAggregates,
} from "./recovery-scanner-storage.js"

export const TURN_DISPATCH_POLL_MS = 30_000

export interface RecoveryReport {
  reclaimed: number
  repaired: number
  dispatched: number
}

export async function recoverTurnQueue(
  pool: LeasePool,
  queue: TurnDispatchQueue,
  ownerId = `recovery-${randomUUID()}`,
  now = new Date(),
): Promise<RecoveryReport> {
  const legacyRepaired = await repairLegacyTurnDispatchAggregates(pool, TURN_DISPATCH_MAX_BATCH)
  const reclaimed = await reclaimExpiredTurns(pool, now, TURN_DISPATCH_MAX_BATCH)
  for (const turn of reclaimed) {
    await persistTurnDispatch(pool, { turnId: turn.turnId, sessionId: turn.sessionId, ownerId }, true)
  }
  const repaired = legacyRepaired + await ensureQueuedTurnDispatches(pool, queue, ownerId, TURN_DISPATCH_MAX_BATCH)
  const dispatched = await dispatchPendingTurnOutbox(pool, queue)
  return { reclaimed: reclaimed.length, repaired, dispatched }
}

export function startTurnRecoveryScanner(
  pool: LeasePool = getPool(),
  queue: TurnDispatchQueue,
  ownerId = `recovery-${randomUUID()}`,
  intervalMs = TURN_DISPATCH_POLL_MS,
) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new RangeError("Recovery interval must be positive")
  let closed = false
  let inFlight: Promise<unknown> | null = null
  const run = () => {
    if (closed || inFlight) return
    const current = recoverTurnQueue(pool, queue, ownerId).catch((error) => {
      console.error("[turn-recovery] scan failed:", error)
    }).finally(() => { if (inFlight === current) inFlight = null })
    inFlight = current
  }
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  run()
  return {
    async close() {
      closed = true
      clearInterval(timer)
      await inFlight
    },
  }
}
