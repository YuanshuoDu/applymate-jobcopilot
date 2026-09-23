import type { LeasePool, TurnLease } from "./lease.js"
import { RootAbortController } from "../interrupt/registry.js"

export const TURN_INTERRUPT_POLL_INTERVAL_MS = 250
const MAX_TURN_INTERRUPT_POLL_INTERVAL_MS = 30_000

type InterruptProbeOptions = {
  pool: LeasePool
  isInterrupted?: (lease: TurnLease) => Promise<boolean>
}

async function persistedInterrupt(pool: LeasePool, lease: TurnLease, probe?: InterruptProbeOptions["isInterrupted"]): Promise<boolean> {
  if (probe) {
    const result = await probe(lease)
    if (typeof result !== "boolean") throw new TypeError("Turn interrupt probe must return a boolean")
    return result
  }
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [lease.userId])
    const result = await client.query<{ status: string }>(
      `SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [lease.turnId, lease.sessionId, lease.userId],
    )
    await client.query("COMMIT")
    return result.rows[0]?.status === "interrupted"
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function safePersistedInterrupt(pool: LeasePool, lease: TurnLease, probe?: InterruptProbeOptions["isInterrupted"]): Promise<boolean> {
  try {
    return await persistedInterrupt(pool, lease, probe)
  } catch {
    // A final status check is advisory after ownership was already fenced.
    // Preserve the existing lease-loss recovery path when the probe is unavailable.
    return false
  }
}

export function interruptPollInterval(value: number | undefined): number {
  const intervalMs = value ?? TURN_INTERRUPT_POLL_INTERVAL_MS
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > MAX_TURN_INTERRUPT_POLL_INTERVAL_MS) {
    throw new RangeError(`Turn interrupt poll interval must be an integer between 1 and ${MAX_TURN_INTERRUPT_POLL_INTERVAL_MS}ms`)
  }
  return intervalMs
}

export function startInterruptProbe(
  options: InterruptProbeOptions,
  lease: TurnLease,
  root: RootAbortController,
  intervalMs: number,
): () => void {
  if (!options.isInterrupted) return () => undefined
  let closed = false
  let inFlight: Promise<void> | null = null
  const poll = () => {
    if (closed || inFlight || root.stopped) return
    const current = persistedInterrupt(options.pool, lease, options.isInterrupted)
      .then(interrupted => { if (interrupted && !closed && !root.stopped) root.stop("user_stop") })
      // A transient probe failure must not masquerade as a user Stop or alter
      // the heartbeat's independent lease-loss recovery path.
      .catch(() => undefined)
      .finally(() => { if (inFlight === current) inFlight = null })
    inFlight = current
  }
  poll()
  const timer = setInterval(poll, intervalMs)
  timer.unref?.()
  return () => { closed = true; clearInterval(timer) }
}
