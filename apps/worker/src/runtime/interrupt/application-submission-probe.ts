import type { Pool, PoolClient } from "pg"
import { markSubmissionRequestStarted, type ApplicationSubmissionStartScope } from "../../db/application-task-state.js"
import { readSubmissionTurnState, withReviewedApplicationSubmitRequestFence, type ReviewedSubmitSourceExpectation } from "../../db/reviewed-application-submit-request-fence.js"
import { appendFencedSubmitAudit } from "../../queue/application-submit-fence.js"
import { createObjectiveSubmissionFenceAcquisition, type ObjectiveSubmissionFenceClient } from "./objective-submission-fence-acquisition.js"

export const APPLICATION_SUBMISSION_STOP_POLL_MS = 250

export type ApplicationSubmissionStopProbe = {
  pollNow(): Promise<void>
  stop(): void
}

export type ApplicationSubmissionStartFence = {
  state: "ready" | "stopped" | "inactive" | "uncertain" | "cancelled" | "unavailable"
  markerCommitted?: true
  abort?(): void
  release(commit: boolean): Promise<void>
}

/** Commit the durable marker, then hold a fresh exact fence through request initiation. */
export async function acquireApplicationSubmissionStartFence(
  pool: Pool,
  scope: ApplicationSubmissionStartScope,
  options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {},
): Promise<ApplicationSubmissionStartFence> {
  const acquisition = createObjectiveSubmissionFenceAcquisition({ parentSignal: options.signal, timeoutMs: options.timeoutMs })
  let permitRelease: (() => void) | null = null
  let permitReleased = false
  const releasePermitOnce = (): void => {
    if (permitReleased) return
    permitReleased = true
    permitRelease?.()
    acquisition.dispose()
  }
  permitRelease = await acquisition.acquirePermit()
  if (!permitRelease) return declined(acquisition.cancellation() === "timed_out" ? "unavailable" : "cancelled", releasePermitOnce)
  let markerClient: PoolClient | undefined
  let boundaryClient: PoolClient | undefined
  let markerLease: ObjectiveSubmissionFenceClient | undefined
  let boundaryLease: ObjectiveSubmissionFenceClient | undefined
  let open = false
  let released = false
  let forceAborted = false
  let markerCommitted = false
  let markerCommitAttempted = false
  let markerExpectedSource: ReviewedSubmitSourceExpectation = undefined
  const releaseReservedMarkerClient = (): void => {
    const reserved = markerLease
    markerLease = undefined
    markerClient = undefined
    reserved?.release()
  }
  const releaseBoundaryClient = (): void => {
    const reserved = boundaryLease
    boundaryLease = undefined
    boundaryClient = undefined
    reserved?.release()
  }
  try {
    markerLease = (await acquisition.connect(pool)) ?? undefined
    markerClient = markerLease?.queryClient
    if (!markerClient) return declined(acquisition.cancellation() === "timed_out" ? "unavailable" : "cancelled", releasePermitOnce)
    const markerConnection = markerClient
    if (acquisition.signal.aborted) {
      releaseReservedMarkerClient()
      return declined(acquisition.cancellation() === "timed_out" ? "unavailable" : "cancelled", releasePermitOnce)
    }
    await markerConnection.query("BEGIN")
    open = true
    await markerConnection.query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId])
    const markerAttempt = await withReviewedApplicationSubmitRequestFence(markerConnection, scope, "marker", undefined, async () => {
      const state = await readSubmissionTurnState(markerConnection, scope)
      if (isStopped(state.sessionStatus, state.turnStatus, state.interrupted)) return "stopped" as const
      return await markSubmissionRequestStarted(markerConnection, scope)
    })
    if (markerAttempt.kind === "invalid") {
      await markerConnection.query("ROLLBACK")
      open = false
      releaseReservedMarkerClient()
      return declined("inactive", releasePermitOnce)
    }
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
    markerExpectedSource = markerAttempt.objectiveSource ? { kind: "objective", source: markerAttempt.objectiveSource } : markerAttempt.sourceTurnId
    if (acquisition.signal.aborted) return declined(acquisition.cancellation() === "timed_out" ? "unavailable" : "cancelled", releasePermitOnce)
    markerCommitAttempted = true
    await markerConnection.query("COMMIT")
    markerCommitted = true
    open = false
    releaseReservedMarkerClient()

    // A user may bind a successor between persisting the marker and sending the
    // request. Reacquire the same exact lock order and only then release the
    // paused browser route; a superseded payload never reaches the ATS.
    boundaryLease = (await acquisition.connect(pool)) ?? undefined
    boundaryClient = boundaryLease?.queryClient
    if (!boundaryClient) return declined("uncertain", releasePermitOnce)
    const boundary = boundaryClient
    await boundary.query("BEGIN")
    open = true
    await boundary.query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId])
    const boundaryAttempt = await withReviewedApplicationSubmitRequestFence(boundary, scope, "boundary", markerExpectedSource, async () => {
      const state = await readSubmissionTurnState(boundary, scope)
      return isStopped(state.sessionStatus, state.turnStatus, state.interrupted) ? "stopped" as const : "ready" as const
    })
    if (boundaryAttempt.kind === "invalid") {
      await boundary.query("ROLLBACK")
      open = false
      releaseBoundaryClient()
      releasePermitOnce()
      return { state: "uncertain", release: async () => undefined }
    }
    if (boundaryAttempt.kind === "superseded") {
      await appendFencedSubmitAudit(boundary, scope, "submission_request_boundary")
      await boundary.query("COMMIT")
      open = false
      releaseBoundaryClient()
      return declined("uncertain", releasePermitOnce, true)
    }
    if (boundaryAttempt.value === "stopped") {
      await boundary.query("ROLLBACK")
      open = false
      releaseBoundaryClient()
      return declined("uncertain", releasePermitOnce, true)
    }

    const release = async (commit: boolean): Promise<void> => {
      if (released) return
      released = true
      if (forceAborted) throw new Error("Submission fence was forcibly released.")
      try {
        if (acquisition.signal.aborted) throw new Error("Objective submission fence acquisition ended.")
        await boundary.query(commit ? "COMMIT" : "ROLLBACK")
        open = false
      } catch (error: unknown) {
        if (open && !boundaryLease?.isReleased) await boundary.query("ROLLBACK").catch(() => undefined)
        open = false
        throw error
      } finally {
        try { releaseBoundaryClient() } finally { releasePermitOnce() }
      }
    }
    if (acquisition.signal.aborted) throw new Error("Objective submission fence acquisition ended.")
    // The route gate owns the ready fence; only it may release the transaction.
    acquisition.dispose()
    const abort = (): void => {
      forceAborted = true
      const reserved = boundaryLease
      boundaryLease = undefined
      boundaryClient = undefined
      try { reserved?.release(new Error("Submission fence release timed out.")) } finally { releasePermitOnce() }
    }
    return { state: "ready", release, abort }
  } catch (error: unknown) {
    try {
      const active = boundaryClient ?? markerClient
      const activeLease = boundaryLease ?? markerLease
      if (active && open && !activeLease?.isReleased) await active.query("ROLLBACK").catch(() => undefined)
      open = false
      if (boundaryClient) { released = true; releaseBoundaryClient() }
    } finally {
      try { releaseReservedMarkerClient() } finally { releasePermitOnce() }
    }
    if (markerCommitted || markerCommitAttempted) return { state: "uncertain", release: async () => undefined }
    if (acquisition.cancellation()) return declined(acquisition.cancellation() === "timed_out" ? "unavailable" : "cancelled", releasePermitOnce)
    throw error
  }
}

async function declined(
  state: ApplicationSubmissionStartFence["state"],
  releasePermit: () => void,
  markerCommitted = false,
): Promise<ApplicationSubmissionStartFence> {
  releasePermit()
  return { state, ...(markerCommitted ? { markerCommitted: true as const } : {}), release: async () => undefined }
}


export async function isApplicationSubmissionStopped(pool: Pool, scope: ApplicationSubmissionStartScope): Promise<boolean> {
  const client = await pool.connect()
  let open = false
  try {
    await client.query("BEGIN"); open = true
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId])
    const state = await readSubmissionTurnState(client, scope)
    await client.query("COMMIT"); open = false
    return isStopped(state.sessionStatus, state.turnStatus, state.interrupted)
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
