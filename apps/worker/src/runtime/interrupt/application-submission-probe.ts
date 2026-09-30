import type { Pool, PoolClient } from "pg"
import { markSubmissionRequestStarted, type ApplicationSubmissionStartScope } from "../../db/application-task-state.js"

export const APPLICATION_SUBMISSION_STOP_POLL_MS = 250

export type ApplicationSubmissionStopProbe = {
  pollNow(): Promise<void>
  stop(): void
}

export type ApplicationSubmissionStartFence = {
  state: "ready" | "stopped" | "inactive" | "uncertain"
  release(commit: boolean): Promise<void>
}

let submissionFenceQueue: Promise<void> = Promise.resolve()

async function acquireSubmissionFencePermit(): Promise<() => void> {
  let releaseCurrent!: () => void
  const current = new Promise<void>((resolve) => { releaseCurrent = resolve })
  const previous = submissionFenceQueue
  submissionFenceQueue = previous.then(() => current)
  await previous

  let released = false
  return () => {
    if (released) return
    released = true
    releaseCurrent()
  }
}

/** Hold Session -> Turn locks through the durable marker and browser request boundary. */
export async function acquireApplicationSubmissionStartFence(
  pool: Pool,
  scope: ApplicationSubmissionStartScope,
): Promise<ApplicationSubmissionStartFence> {
  const releasePermit = await acquireSubmissionFencePermit()
  let permitReleased = false
  const releasePermitOnce = (): void => {
    if (permitReleased) return
    permitReleased = true
    releasePermit()
  }
  let fenceClient: PoolClient | undefined
  let markerClient: PoolClient | undefined
  let open = false
  let released = false
  const releaseReservedMarkerClient = (): void => {
    const reserved = markerClient
    markerClient = undefined
    reserved?.release()
  }
  try {
    fenceClient = await pool.connect()
    markerClient = await pool.connect()
    const lockClient = fenceClient
    const release = async (commit: boolean): Promise<void> => {
      if (released) return
      released = true
      try {
        await lockClient.query(commit ? "COMMIT" : "ROLLBACK")
        open = false
      } catch (error: unknown) {
        if (open) await lockClient.query("ROLLBACK").catch(() => undefined)
        open = false
        throw error
      } finally {
        try {
          lockClient.release()
        } finally {
          try {
            releaseReservedMarkerClient()
          } finally {
            releasePermitOnce()
          }
        }
      }
    }
    const decline = async (state: "stopped" | "inactive"): Promise<ApplicationSubmissionStartFence> => {
      await release(false)
      return { state, release: async () => undefined }
    }

    await lockClient.query("BEGIN")
    open = true
    await lockClient.query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId])
    const session = await lockClient.query<{ status: string }>(
      `SELECT "status" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`,
      [scope.sessionId, scope.userId],
    )
    const turn = await lockClient.query<{ status: string }>(
      `SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
      [scope.turnId, scope.sessionId, scope.userId],
    )
    const interrupted = await lockClient.query<{ stopped: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'turn.interrupted') AS "stopped"`,
      [scope.sessionId, scope.turnId],
    )
    if (isStopped(session.rows[0]?.status, turn.rows[0]?.status, interrupted.rows[0]?.stopped)) return decline("stopped")
    const markerConnection = markerClient
    if (!markerConnection) throw new Error("Submission marker connection was not reserved")
    markerClient = undefined
    const marker = await markSubmissionRequestStarted(markerConnection, scope)
    if (marker === "inactive") return decline("inactive")
    return { state: marker === "uncertain" ? "uncertain" : "ready", release }
  } catch (error: unknown) {
    try {
      if (fenceClient) {
        if (open) await fenceClient.query("ROLLBACK").catch(() => undefined)
        if (!released) {
          released = true
          fenceClient.release()
        }
      }
    } finally {
      try {
        releaseReservedMarkerClient()
      } finally {
        releasePermitOnce()
      }
    }
    throw error
  }
}

export async function isApplicationSubmissionStopped(pool: Pool, scope: ApplicationSubmissionStartScope): Promise<boolean> {
  const client = await pool.connect()
  let open = false
  try {
    await client.query("BEGIN"); open = true
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId])
    const session = await client.query<{ status: string }>(`SELECT "status" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2`, [scope.sessionId, scope.userId])
    const turn = await client.query<{ status: string }>(`SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [scope.turnId, scope.sessionId, scope.userId])
    const interrupted = await client.query<{ stopped: boolean }>(`SELECT EXISTS (SELECT 1 FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'turn.interrupted') AS "stopped"`, [scope.sessionId, scope.turnId])
    await client.query("COMMIT"); open = false
    return isStopped(session.rows[0]?.status, turn.rows[0]?.status, interrupted.rows[0]?.stopped)
  } catch (error: unknown) {
    if (open) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

export function startApplicationSubmissionStopProbe(options: {
  pool: Pool
  scope: ApplicationSubmissionStartScope
  closePage(): Promise<void>
  controller: AbortController
  hasSubmissionStarted(): boolean
  onUnavailable(error: unknown): void
  onStopped(): void
  intervalMs?: number
}): ApplicationSubmissionStopProbe {
  let closed = false
  let observedStop = false
  let unavailable = false
  let inFlight: Promise<void> | null = null
  const pollNow = async (): Promise<void> => {
    if (closed || observedStop || unavailable) return
    if (inFlight) return inFlight
    const current = isApplicationSubmissionStopped(options.pool, options.scope)
      .then(async stopped => {
        if (!stopped || closed || observedStop) return
        observedStop = true
        if (!options.controller.signal.aborted) options.controller.abort(new Error("Agent turn was stopped."))
        options.onStopped()
        await options.closePage().catch(() => undefined)
      })
      .catch(async error => {
        if (closed) return
        unavailable = true
        options.onUnavailable(error)
        if (!options.hasSubmissionStarted()) {
          if (!options.controller.signal.aborted) options.controller.abort(error)
          await options.closePage().catch(() => undefined)
        }
      })
      .finally(() => { if (inFlight === current) inFlight = null })
    inFlight = current
    await current
  }
  const timer = setInterval(() => { void pollNow() }, options.intervalMs ?? APPLICATION_SUBMISSION_STOP_POLL_MS)
  timer.unref?.()
  return {
    pollNow,
    stop: () => { closed = true; clearInterval(timer) },
  }
}

function isStopped(sessionStatus: string | undefined, turnStatus: string | undefined, interruptedEvent: boolean | undefined): boolean {
  return !sessionStatus || ["aborted", "archived", "closed", "completed", "failed", "cancelled"].includes(sessionStatus) ||
    !turnStatus || ["interrupted", "cancelled", "completed", "failed"].includes(turnStatus) || interruptedEvent === true
}
