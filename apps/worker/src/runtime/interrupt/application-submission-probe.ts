import type { Pool, PoolClient } from "pg"
import { markSubmissionRequestStarted, type ApplicationSubmissionStartScope } from "../../db/application-task-state.js"
import { appendFencedSubmitAudit, withExactAttemptFence } from "../../queue/application-submit-fence.js"

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

/** Commit the durable marker, then hold a fresh exact fence through request initiation. */
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
  let markerClient: PoolClient | undefined
  let boundaryClient: PoolClient | undefined
  let open = false
  let released = false
  const releaseReservedMarkerClient = (): void => {
    const reserved = markerClient
    markerClient = undefined
    reserved?.release()
  }
  const releaseBoundaryClient = (): void => {
    const reserved = boundaryClient
    boundaryClient = undefined
    reserved?.release()
  }
  try {
    markerClient = await pool.connect()
    const markerConnection = markerClient
    if (!markerConnection) throw new Error("Submission marker connection was not reserved")
    await markerConnection.query("BEGIN")
    open = true
    await markerConnection.query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId])
    const markerAttempt = await withExactAttemptFence(markerConnection, scope, async () => {
      const state = await readSubmissionTurnState(markerConnection, scope)
      if (isStopped(state.sessionStatus, state.turnStatus, state.interrupted)) return "stopped" as const
      return await markSubmissionRequestStarted(markerConnection, scope)
    })
    if (markerAttempt.kind === "superseded") {
      await appendFencedSubmitAudit(markerConnection, scope, "submission_start_marker")
      await markerConnection.query("COMMIT")
      open = false
      releaseReservedMarkerClient()
      return declined("inactive", releasePermitOnce)
    }
    if (markerAttempt.value === "stopped" || markerAttempt.value === "inactive") {
      await markerConnection.query("ROLLBACK")
      open = false
      releaseReservedMarkerClient()
      return declined(markerAttempt.value, releasePermitOnce)
    }
    try {
      await markerConnection.query("COMMIT")
    } catch {
      // The durable marker may or may not have committed. Never release the
      // browser request in this case; the queue will persist an uncertain
      // outcome under the exact attempt fence.
      await markerConnection.query("ROLLBACK").catch(() => undefined)
      open = false
      releaseReservedMarkerClient()
      releasePermitOnce()
      return { state: "uncertain", release: async () => undefined }
    }
    open = false
    releaseReservedMarkerClient()

    // A user may bind a successor between persisting the marker and sending the
    // request. Reacquire the same exact lock order and only then release the
    // paused browser route; a superseded payload never reaches the ATS.
    boundaryClient = await pool.connect()
    const boundary = boundaryClient
    await boundary.query("BEGIN")
    open = true
    await boundary.query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId])
    const boundaryAttempt = await withExactAttemptFence(boundary, scope, async () => {
      const state = await readSubmissionTurnState(boundary, scope)
      return isStopped(state.sessionStatus, state.turnStatus, state.interrupted) ? "stopped" as const : "ready" as const
    })
    if (boundaryAttempt.kind === "superseded") {
      await appendFencedSubmitAudit(boundary, scope, "submission_request_boundary")
      await boundary.query("COMMIT")
      open = false
      releaseBoundaryClient()
      return declined("inactive", releasePermitOnce)
    }
    if (boundaryAttempt.value === "stopped") {
      await boundary.query("ROLLBACK")
      open = false
      releaseBoundaryClient()
      return declined("stopped", releasePermitOnce)
    }

    const release = async (commit: boolean): Promise<void> => {
      if (released) return
      released = true
      try {
        await boundary.query(commit ? "COMMIT" : "ROLLBACK")
        open = false
      } catch (error: unknown) {
        if (open) await boundary.query("ROLLBACK").catch(() => undefined)
        open = false
        throw error
      } finally {
        try { releaseBoundaryClient() } finally { releasePermitOnce() }
      }
    }
    return { state: "ready", release }
  } catch (error: unknown) {
    try {
      const active = boundaryClient ?? markerClient
      if (active && open) await active.query("ROLLBACK").catch(() => undefined)
      if (boundaryClient) { released = true; releaseBoundaryClient() }
    } finally {
      try { releaseReservedMarkerClient() } finally { releasePermitOnce() }
    }
    throw error
  }
}

async function readSubmissionTurnState(client: PoolClient, scope: ApplicationSubmissionStartScope): Promise<{
  readonly sessionStatus: string | undefined
  readonly turnStatus: string | undefined
  readonly interrupted: boolean | undefined
}> {
  const session = await client.query<{ status: string }>(
    `SELECT "status" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2`, [scope.sessionId, scope.userId],
  )
  const turn = await client.query<{ status: string }>(
    `SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
    [scope.turnId, scope.sessionId, scope.userId],
  )
  const interrupted = await client.query<{ stopped: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'turn.interrupted') AS "stopped"`,
    [scope.sessionId, scope.turnId],
  )
  return { sessionStatus: session.rows[0]?.status, turnStatus: turn.rows[0]?.status, interrupted: interrupted.rows[0]?.stopped }
}

async function declined(state: "stopped" | "inactive", releasePermit: () => void): Promise<ApplicationSubmissionStartFence> {
  releasePermit()
  return { state, release: async () => undefined }
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
