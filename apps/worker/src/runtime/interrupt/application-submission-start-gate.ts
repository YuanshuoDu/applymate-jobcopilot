import type { Pool, PoolClient } from "pg"
import { markSubmissionRequestStarted, type ApplicationSubmissionStartScope } from "../../db/application-task-state.js"
import {
  inspectApplicationSubmissionStopState,
  recordApplicationSubmissionStopStage,
} from "../../db/application-submission-stop-state.js"
import {
  readSubmissionTurnStopState, withReviewedApplicationSubmitRequestFence, withReviewedApplicationSubmitStopPollFence,
} from "../../db/reviewed-application-submit-request-fence.js"
import type { ApplicationSubmissionStartFence } from "./application-submission-probe.js"
import { appendFencedSubmitAudit } from "../../queue/application-submit-fence.js"

type OpenTransaction = { readonly client: PoolClient; open: boolean; released: boolean }
type StopTurnState = Awaited<ReturnType<typeof readSubmissionTurnStopState>>

let protocolFenceQueue: Promise<void> = Promise.resolve()

async function acquireProtocolPermit(): Promise<() => void> {
  let unlock!: () => void
  const current = new Promise<void>(resolve => { unlock = resolve })
  const previous = protocolFenceQueue
  protocolFenceQueue = previous.then(() => current)
  await previous
  let released = false
  return () => { if (!released) { released = true; unlock() } }
}

async function openTransaction(pool: Pool, userId: string): Promise<OpenTransaction> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    return { client, open: true, released: false }
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    client.release()
    throw error
  }
}

async function closeTransaction(tx: OpenTransaction, commit: boolean): Promise<boolean> {
  if (!tx.open) return true
  try {
    await tx.client.query(commit ? "COMMIT" : "ROLLBACK")
    tx.open = false
    return true
  } catch {
    await tx.client.query("ROLLBACK").catch(() => undefined)
    tx.open = false
    return false
  } finally {
    releaseTransaction(tx)
  }
}

async function rollbackTransaction(tx: OpenTransaction): Promise<void> {
  if (tx.open) await tx.client.query("ROLLBACK").catch(() => undefined)
  tx.open = false
  releaseTransaction(tx)
}

function releaseTransaction(tx: OpenTransaction): void {
  if (tx.released) return
  tx.released = true
  tx.client.release()
}

function declined(state: "stopped" | "inactive" | "uncertain", releasePermit: () => void): ApplicationSubmissionStartFence {
  releasePermit()
  return { state, release: async () => undefined }
}

function mayContinueTurn(state: StopTurnState): boolean {
  const version = state.leaseVersion
  if (state.interruptionEvidence !== false || typeof version !== "number" || !Number.isSafeInteger(version) || version < 0
    || !["running", "completed"].includes(state.sessionStatus ?? "")) return false
  if (state.turnStatus === "completed") {
    return state.leaseOwnerId === null && state.leaseStartedAt === null && state.leaseExpiresAt === null
  }
  const started = state.leaseStartedAt instanceof Date ? state.leaseStartedAt.getTime() : Number.NaN
  const expires = state.leaseExpiresAt instanceof Date ? state.leaseExpiresAt.getTime() : Number.NaN
  const now = Date.now()
  return state.turnStatus === "in_progress" && state.sessionStatus === "running"
    && typeof state.leaseOwnerId === "string" && state.leaseOwnerId.length > 0 && state.leaseOwnerId.trim() === state.leaseOwnerId
    && version > 0 && Number.isFinite(started) && Number.isFinite(expires) && started <= now && expires > now
}

/** Test composition only until the owning Web Stop action and coordinated rollout exist. */
export async function acquireApplicationSubmissionStartFenceWithStopProtocol(
  pool: Pool, scope: ApplicationSubmissionStartScope,
): Promise<ApplicationSubmissionStartFence> {
  if (scope.turnId !== scope.fillTurnId) return { state: "inactive", release: async () => undefined }
  const releasePermit = await acquireProtocolPermit()
  let marker: OpenTransaction | undefined
  let grant: OpenTransaction | undefined
  let boundary: OpenTransaction | undefined
  let markerCommitted = false
  let sourceTurnId: string | null = null
  let released = false
  try {
    marker = await openTransaction(pool, scope.userId)
    const arm = await withReviewedApplicationSubmitRequestFence(marker.client, scope, "marker", undefined, async () => {
      const state = await readSubmissionTurnStopState(marker!.client, scope)
      if (!mayContinueTurn(state)) return hasExplicitStopSignal(state) ? "stopped" as const : "inactive" as const
      if (await markSubmissionRequestStarted(marker!.client, scope) !== "started") return "inactive" as const
      const recorded = await recordApplicationSubmissionStopStage(pool, marker!.client, scope, "armed")
      return recorded === "recorded" ? "armed" as const : recorded === "stopped" ? "stopped" as const : "uncertain" as const
    })
    if (arm.kind === "invalid") { await rollbackTransaction(marker); return declined("inactive", releasePermit) }
    if (arm.kind === "superseded") {
      await appendFencedSubmitAudit(marker.client, scope, "submission_start_marker")
      await closeTransaction(marker, true)
      return declined("inactive", releasePermit)
    }
    if (arm.value !== "armed") {
      await rollbackTransaction(marker)
      return declined(arm.value, releasePermit)
    }
    sourceTurnId = arm.sourceTurnId
    if (!await closeTransaction(marker, true)) return declined("uncertain", releasePermit)
    markerCommitted = true

    grant = await openTransaction(pool, scope.userId)
    const grantAttempt = await withReviewedApplicationSubmitRequestFence(grant.client, scope, "boundary", sourceTurnId, async () => {
      const state = await readSubmissionTurnStopState(grant!.client, scope)
      if (!mayContinueTurn(state)) return hasExplicitStopSignal(state) ? "stopped" as const : "uncertain" as const
      const recorded = await recordApplicationSubmissionStopStage(pool, grant!.client, scope, "dispatch_granted")
      return recorded === "recorded" ? "granted" as const : recorded === "stopped" ? "stopped" as const : "uncertain" as const
    })
    if (grantAttempt.kind === "superseded") {
      await appendFencedSubmitAudit(grant.client, scope, "submission_dispatch_grant")
      await closeTransaction(grant, true)
      return declined("inactive", releasePermit)
    }
    if (grantAttempt.kind !== "current" || grantAttempt.value !== "granted") {
      await rollbackTransaction(grant)
      return declined(grantAttempt.kind === "current" && grantAttempt.value === "stopped" ? "stopped" : "uncertain", releasePermit)
    }
    if (!await closeTransaction(grant, true)) return declined("uncertain", releasePermit)

    boundary = await openTransaction(pool, scope.userId)
    const finalFence = await withReviewedApplicationSubmitRequestFence(boundary.client, scope, "boundary", sourceTurnId, async () => {
      const state = await readSubmissionTurnStopState(boundary!.client, scope)
      if (await inspectApplicationSubmissionStopState(pool, boundary!.client, scope) !== "granted") return "uncertain" as const
      return mayContinueTurn(state) ? "ready" as const : "uncertain" as const
    })
    if (finalFence.kind === "superseded") {
      await appendFencedSubmitAudit(boundary.client, scope, "submission_request_boundary")
      await closeTransaction(boundary, true)
      return declined("inactive", releasePermit)
    }
    if (finalFence.kind !== "current" || finalFence.value !== "ready") {
      await rollbackTransaction(boundary)
      return declined("uncertain", releasePermit)
    }
    return {
      state: "ready",
      release: async (commit: boolean): Promise<void> => {
        if (released) return
        released = true
        try {
          if (!await closeTransaction(boundary!, commit)) throw new Error("Application request boundary transaction did not commit.")
        } finally { releasePermit() }
      },
    }
  } catch (error: unknown) {
    if (boundary) await rollbackTransaction(boundary)
    if (grant) await rollbackTransaction(grant)
    if (marker) await rollbackTransaction(marker)
    releasePermit()
    if (markerCommitted) return { state: "uncertain", release: async () => undefined }
    throw error
  }
}

/** Used only by a trusted in-process probe composition; ordinary queue callers keep the legacy check. */
export async function isApplicationSubmissionStoppedWithStopProtocol(
  pool: Pool, scope: ApplicationSubmissionStartScope,
): Promise<boolean> {
  if (scope.turnId !== scope.fillTurnId) throw new Error("Application submission Turn binding is unavailable.")
  const tx = await openTransaction(pool, scope.userId)
  try {
    const task = await tx.client.query<{ checkpoint: string }>(`SELECT "checkpoint" FROM "application_tasks"
      WHERE "id"=$1 AND "userId"=$2 AND "jobId"=$3 AND "sessionId"=$4 AND "fillTurnId"=$5 AND "workerTaskId"=$6 LIMIT 2`,
    [scope.applicationTaskId, scope.userId, scope.jobId, scope.sessionId, scope.fillTurnId, scope.workerTaskId])
    if (task.rows.length !== 1) throw new Error("Application submission task binding is unavailable.")
    const phase = task.rows[0]?.checkpoint === "browser_active" ? "marker"
      : task.rows[0]?.checkpoint === "submission_request_started" ? "boundary" : null
    if (!phase) throw new Error("Application submission request phase is unavailable.")
    const work = async () => {
      const state = await readSubmissionTurnStopState(tx.client, scope)
      if (phase === "marker") {
        if (hasExplicitStopSignal(state)) return true
        if (!mayContinueTurn(state)) throw new Error("Application submission Turn state is unavailable.")
        return false
      }
      const stopState = await inspectApplicationSubmissionStopState(pool, tx.client, scope)
      if (stopState === "stopped") return true
      if (stopState === "armed") {
        if (hasExplicitStopSignal(state)) return true
        if (mayContinueTurn(state)) return false
      }
      if (stopState === "granted" && mayContinueTurn(state)) return false
      throw new Error("Application submission Stop state is unavailable.")
    }
    const fenced = phase === "marker"
      ? await withReviewedApplicationSubmitStopPollFence(tx.client, scope, work)
      : await withReviewedApplicationSubmitRequestFence(tx.client, scope, "boundary", undefined, work)
    if (fenced.kind !== "current") throw new Error("Application submission scope changed during Stop polling.")
    if (!await closeTransaction(tx, true)) throw new Error("Application submission Stop poll did not commit.")
    return fenced.value
  } catch (error: unknown) {
    await rollbackTransaction(tx)
    throw error
  }
}

function hasExplicitStopSignal(state: StopTurnState): boolean {
  return state.interruptionEvidence === true || ["aborted", "archived", "closed", "failed", "cancelled"].includes(state.sessionStatus ?? "")
    || ["interrupted", "failed", "cancelled"].includes(state.turnStatus ?? "")
}
