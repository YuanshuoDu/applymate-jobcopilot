import { randomUUID } from "node:crypto"
import type pg from "pg"
import { settleRecoveredTaskGraph } from "./task-graph-pg-root-failure-cleanup.js"
import { computeSubagentNextAttemptAt } from "./retry-policy.js"
import { RUNNABLE_SESSION } from "../session-gate.js"
import { lockFailedRootTurn, prepareGraphTransition, rootRecoveryEligibility } from "./task-graph-pg-lifecycle.js"
import { dateValue, json, rowToTask, transaction } from "./pg-store-persistence.js"
import { parseSubagentJobPayload, type PgSubagentPool, type SubagentTaskRecord } from "./types.js"
import { prepareTaskGraphFinish } from "./pg-store-lifecycle.js"
import { recoverExpiredDurableSubagentWaitWithGraph } from "./durable-subagent-wait-handoff.js"
import { recoverExpiredWaitRegistration } from "./durable-subagent-wait-store.js"
import { repairStaleWaitProjection, type WaitProjectionRejectionStage } from "./pg-store-expiry-recovery-wait-projection.js"
import { CHILD_WAIT_CONSUMED_SQL, CHILD_WAIT_RESUMABLE_SQL, hasBlockingExternalCall } from "./pg-store-expiry-recovery-predicates.js"
import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"

type RecoveryCursor = Readonly<{ sessionId: string; rootIsNull: boolean; rootKey: string; taskId: string }>
type Candidate = Record<string, unknown> & Readonly<{ id: string; sessionId: string; userId: string; rootTaskId?: string | null; turnId?: string | null;
  cursorRootIsNull: boolean; cursorRootKey: string }>
const RECOVERY_CANDIDATE_SAVEPOINT = "subagent_expiry_recovery_candidate"

type ExpiredWaitDispatch = { id: string; payload: unknown; attemptCount: unknown; publishedAt: unknown }
type RecoveryStage = "candidate_not_seen" | "candidate_seen" | "session_lock_mismatch" | "turn_lock_mismatch" | "expiry_preview_rejected" | "root_turn_not_recoverable" | "task_lock_parity_mismatch" | "recovery_clock_missing" | "lease_expiry_fence_mismatch" | "unsettled_external_call_rejected" | "durable_wait_graph_blocked" | "task_graph_transition_blocked" | "task_graph_finish_blocked" | "task_update_rejected"
type WaitProjectionDisposition = "skipped" | "repaired" | "already_current" | "rejected"
type RecoveryTrace = { taskId: string; pageCount: number; pages: Array<{ page: number; candidates: number; targetSeen: boolean; cursorUsed: boolean }>; pagesTruncated: boolean; rejectionStage: RecoveryStage; waitProjectionDisposition: WaitProjectionDisposition; waitProjectionStage?: WaitProjectionRejectionStage; childWaitResumable: boolean | null; waitRegistrationFound: boolean | null; waitRegistrationRejected: boolean | null; blockingExternalCall: boolean | null; dispatch: Record<string, boolean> | null }
function rejectRecovery(trace: RecoveryTrace | undefined, stage: RecoveryStage): null { if (trace) trace.rejectionStage = stage; return null }

export async function recoverExpired(pool: PgSubagentPool, input: { now: Date; limit: number; sessionId?: string; turnId?: string }): Promise<SubagentTaskRecord[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1) throw new RangeError("Recovery limit must be positive")
  if (input.turnId && !input.sessionId) throw new TypeError("Turn recovery filter requires a Session")
  const traceTaskId = process.env.NODE_ENV === "test" ? process.env.AGENT_RUNTIME_PG_TEST_RECOVERY_TRACE_TASK_ID : undefined
  const trace: RecoveryTrace | undefined = traceTaskId ? { taskId: traceTaskId, pageCount: 0, pages: [], pagesTruncated: false, rejectionStage: "candidate_not_seen",
    waitProjectionDisposition: "skipped", childWaitResumable: null, waitRegistrationFound: null, waitRegistrationRejected: null, blockingExternalCall: null, dispatch: null } : undefined
  const recovered = await transaction(pool, async client => {
    const scanHorizon = (await client.query<{ scanHorizon: Date }>(`SELECT clock_timestamp() AS "scanHorizon"`)).rows[0]?.scanHorizon
    if (!(scanHorizon instanceof Date) || !Number.isFinite(scanHorizon.getTime())) throw new Error("Recovery scan horizon is unavailable")
    const recovered: SubagentTaskRecord[] = []
    let cursor: RecoveryCursor | undefined
    // A blocked backlog needs extra keyset reads; successful recoveries still cap the pass at input.limit.
    while (recovered.length < input.limit) {
      const candidates = await client.query<Candidate>(`SELECT task."id", task."sessionId", task."rootTaskId", task."turnId", session."userId",
          task."rootTaskId" IS NULL AS "cursorRootIsNull", COALESCE(task."rootTaskId", '') AS "cursorRootKey"
        FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        WHERE task."status" = 'running' AND (session."status" IN ('aborted', 'archived') OR ${RUNNABLE_SESSION})
          AND task."leaseExpiresAt" <= $1 AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= $1)
          AND ($2::text IS NULL OR task."sessionId" = $2) AND ($3::text IS NULL OR task."turnId" = $3)
          AND ($4::text IS NULL OR (task."sessionId", (task."rootTaskId" IS NULL), COALESCE(task."rootTaskId", ''), task."id")
            > ($4::text, $5::boolean, $6::text, $7::text))
          AND (${rootRecoveryEligibility})
        ORDER BY task."sessionId", (task."rootTaskId" IS NULL), COALESCE(task."rootTaskId", ''), task."id" LIMIT $8`,
      [scanHorizon, input.sessionId ?? null, input.turnId ?? null, cursor?.sessionId ?? null, cursor?.rootIsNull ?? null,
        cursor?.rootKey ?? null, cursor?.taskId ?? null, input.limit])
      if (trace) {
        const page = ++trace.pageCount
        const targetSeen = candidates.rows.some(candidate => candidate.id === trace.taskId)
        const summary = { page, candidates: candidates.rows.length, targetSeen, cursorUsed: cursor !== undefined }
        if (trace.pages.length < 16) trace.pages.push(summary)
        else { trace.pagesTruncated = true; if (targetSeen) trace.pages[15] = summary }
        if (targetSeen) trace.rejectionStage = "candidate_seen"
      }
      if (candidates.rows.length === 0) break
      for (const candidate of candidates.rows) {
        await client.query(`SAVEPOINT ${RECOVERY_CANDIDATE_SAVEPOINT}`)
        const outcome = await recoverOne(client, candidate, input, candidate.id === trace?.taskId ? trace : undefined)
        if (!outcome) await client.query(`ROLLBACK TO SAVEPOINT ${RECOVERY_CANDIDATE_SAVEPOINT}`)
        await client.query(`RELEASE SAVEPOINT ${RECOVERY_CANDIDATE_SAVEPOINT}`)
        cursor = { sessionId: candidate.sessionId, rootIsNull: candidate.cursorRootIsNull,
          rootKey: candidate.cursorRootKey, taskId: candidate.id }
        if (outcome) recovered.push(outcome)
        if (recovered.length >= input.limit) break
      }
      if (recovered.length >= input.limit || candidates.rows.length < input.limit) break
    }
    return recovered
  })
  if (trace && !recovered.some(row => row.id === trace.taskId)) {
    const { taskId, ...safeTrace } = trace
    void taskId
    console.info(`WORKER_B_RECOVERY_PREDICATE_TRACE ${JSON.stringify(safeTrace)}`)
  }
  return recovered
}

async function recoverOne(client: pg.PoolClient, candidate: Candidate, filter: { sessionId?: string; turnId?: string }, trace?: RecoveryTrace): Promise<SubagentTaskRecord | null> {
  const session = await client.query(`SELECT "id", "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [candidate.sessionId])
  const sessionRow = session.rows[0] as Record<string, unknown> | undefined
  if (!sessionRow || sessionRow.userId !== candidate.userId) return rejectRecovery(trace, "session_lock_mismatch")
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [candidate.userId])
  if (typeof candidate.turnId === "string") {
    const turn = await client.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2
      AND "userId" = $3 AND "rootTaskId" = $4 FOR UPDATE`, [candidate.turnId, candidate.sessionId, candidate.userId, candidate.rootTaskId])
    if (!turn.rows[0]) return rejectRecovery(trace, "turn_lock_mismatch")
  }
  const sql = `SELECT task.*, session."userId" AS "userId", session."status" AS "sessionStatus",
      ${CHILD_WAIT_RESUMABLE_SQL} AS "childWaitResumable", ${CHILD_WAIT_CONSUMED_SQL} AS "childWaitContinuationId",
      root."status" AS "rootStatus", root."interruptRequestedAt" AS "rootInterruptRequestedAt"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
      AND root."turnId" IS NOT DISTINCT FROM task."turnId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND session."userId" = $3 AND task."status" = 'running'
      AND task."rootTaskId" = $5 AND task."turnId" IS NOT DISTINCT FROM $4::text
      AND ($6::text IS NULL OR task."sessionId" = $6)
      AND ($7::text IS NULL OR task."turnId" = $7)
      AND task."leaseExpiresAt" <= clock_timestamp()
      AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= clock_timestamp())`
  const values = [candidate.id, candidate.sessionId, candidate.userId, candidate.turnId ?? null, candidate.rootTaskId ?? candidate.id, filter.sessionId ?? null, filter.turnId ?? null]
  const preview = await client.query(sql, values)
  const old = preview.rows[0] as Record<string, unknown> | undefined
  if (!old) return rejectRecovery(trace, "expiry_preview_rejected")
  if (trace) trace.childWaitResumable = old.childWaitResumable === true
  const attemptCount = Number(old.attemptCount)
  const closedSession = old.sessionStatus === "aborted" || old.sessionStatus === "archived"
  const previewInterrupted = closedSession || old.interruptRequestedAt != null || old.rootInterruptRequestedAt != null
  const canonicalRoot = typeof old.id === "string" && old.id.startsWith("root-")
  const failedRootTurn = canonicalRoot && !previewInterrupted ? await lockFailedRootTurn(client, old) : false
  if (canonicalRoot && !previewInterrupted && !failedRootTurn) return rejectRecovery(trace, "root_turn_not_recoverable")
  const atAttemptCeiling = attemptCount >= Number(old.maxAttempts)
  const childWaitResumable = old.childWaitResumable === true
  const childWaitContinuationId = typeof old.childWaitContinuationId === "string" ? old.childWaitContinuationId : undefined
  const childWaitConsumed = childWaitContinuationId !== undefined
  const locked = await client.query(`${sql} FOR UPDATE OF task`, values)
  const row = locked.rows[0] as Record<string, unknown> | undefined
  if (!row || Number(row.attemptCount) !== attemptCount || row.turnId !== (candidate.turnId ?? null)
    || (row.childWaitResumable === true) !== childWaitResumable || (typeof row.childWaitContinuationId === "string" ? row.childWaitContinuationId : undefined) !== childWaitContinuationId
    || (old.interruptRequestedAt != null) !== (row.interruptRequestedAt != null)
    || (old.rootInterruptRequestedAt != null) !== (row.rootInterruptRequestedAt != null)
      || (canonicalRoot && (row.taskType !== old.taskType || row.id !== old.id || row.rootTaskId !== old.rootTaskId
       || row.parentTaskId !== old.parentTaskId || row.turnId !== old.turnId))) return rejectRecovery(trace, "task_lock_parity_mismatch")
  const acceptedInterrupt = row.interruptRequestedAt != null || row.rootInterruptRequestedAt != null
  const interrupted = closedSession || acceptedInterrupt
  let waitContinuation = !interrupted && !failedRootTurn && childWaitResumable
  const checkedAt = (await client.query<{ checkedAt: Date }>(`SELECT clock_timestamp() AS "checkedAt"`)).rows[0]?.checkedAt
  if (!checkedAt) return rejectRecovery(trace, "recovery_clock_missing")
  const lockedExpiry = dateValue(row.leaseExpiresAt)
  const lockedRetryAt = dateValue(row.nextAttemptAt)
  if (!lockedExpiry || lockedExpiry > checkedAt || (lockedRetryAt && lockedRetryAt > checkedAt)) return rejectRecovery(trace, "lease_expiry_fence_mismatch")
  let rejectedWaitCallId: string | undefined
  if (!interrupted && row.parentTaskId != null && typeof row.leaseOwner === "string" && typeof row.turnId === "string") {
    const lease = { id: candidate.id, userId: candidate.userId, sessionId: candidate.sessionId, turnId: row.turnId,
      rootTaskId: String(row.rootTaskId), ownerId: row.leaseOwner, attemptCount, leaseExpiresAt: lockedExpiry }
    const registration = await recoverExpiredWaitRegistration(client, lease, checkedAt)
    if (trace) { trace.waitRegistrationFound = Boolean(registration); trace.waitRegistrationRejected = Boolean(registration && "rejectedCallId" in registration) }
    if (registration && "rejectedCallId" in registration) rejectedWaitCallId = registration.rejectedCallId
    const projectionRepair = waitContinuation && !childWaitConsumed && !rejectedWaitCallId
      ? await repairStaleWaitProjection(client, lease, checkedAt) : undefined
    const projectionRejected = projectionRepair?.status === "rejected"
    if (trace) {
      trace.waitProjectionDisposition = projectionRepair?.status ?? "skipped"
      if (projectionRepair?.status === "rejected") trace.waitProjectionStage = projectionRepair.stage
    }
    const blockedByExternalCall = await hasBlockingExternalCall(client, row, rejectedWaitCallId, waitContinuation && childWaitConsumed && !rejectedWaitCallId ? childWaitContinuationId : undefined)
    if (trace) trace.blockingExternalCall = blockedByExternalCall
    if (projectionRejected || blockedByExternalCall) return rejectRecovery(trace, projectionRejected ? "durable_wait_graph_blocked" : "unsettled_external_call_rejected")
    const wait = await recoverExpiredDurableSubagentWaitWithGraph(client, { lease, now: checkedAt })
    if (wait && "blocked" in wait) return rejectRecovery(trace, "durable_wait_graph_blocked")
    if (wait) return { ...rowToTask(row), status: wait.handoff === "suspended" ? "waiting" : "queued",
      nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null }
  }
  let waitDispatch: ExpiredWaitDispatch | undefined
  let nextWaitPayload: { taskId: string; sessionId: string; rootTaskId: string; ownerId: string } | undefined
  if (waitContinuation) {
    const result = await client.query<ExpiredWaitDispatch>(`SELECT dispatch."id", dispatch."payload", dispatch."attemptCount", dispatch."publishedAt"
      FROM "agent_outbox" AS dispatch WHERE dispatch."topic" = 'agent.subagent.dispatch'
        AND dispatch."aggregateId" = $1 AND dispatch."idempotencyKey" = 'subagent-dispatch:' || $2 FOR UPDATE`,
    [candidate.sessionId, candidate.id])
    waitDispatch = result.rows[0]
    const payload = waitDispatch ? parseSubagentJobPayload(waitDispatch.payload) : null
    const generation = waitDispatch ? Number(waitDispatch.attemptCount) : Number.NaN
    if (trace) trace.dispatch = { present: Boolean(waitDispatch), payloadValid: payload !== null, task: payload?.taskId === candidate.id, session: payload?.sessionId === candidate.sessionId,
      root: payload?.rootTaskId === candidate.rootTaskId, owner: typeof row.leaseOwner === "string" && payload?.ownerId === row.leaseOwner,
      generation: Number.isSafeInteger(generation) && generation >= 1 && generation < 2_147_483_647, published: waitDispatch?.publishedAt != null }
    if (waitDispatch && payload && waitDispatch.publishedAt != null && Number.isSafeInteger(generation)
      && generation >= 1 && generation < 2_147_483_647 && payload.taskId === candidate.id
      && payload.sessionId === candidate.sessionId && payload.rootTaskId === candidate.rootTaskId
      && typeof row.leaseOwner === "string" && payload.ownerId === row.leaseOwner) {
      nextWaitPayload = { ...payload, ownerId: `expired-child-wait-${randomUUID()}` }
    } else {
      waitContinuation = false
    }
  }
  const unsettledExternalCall = await hasBlockingExternalCall(client, row, rejectedWaitCallId, waitContinuation && childWaitConsumed && !rejectedWaitCallId ? childWaitContinuationId : undefined)
  if (trace) trace.blockingExternalCall = unsettledExternalCall
  let graph: Awaited<ReturnType<typeof prepareGraphTransition>> = null
  if (unsettledExternalCall && (!waitContinuation || childWaitConsumed)) {
    const deadline = dateValue(row.absoluteDeadlineAt)
    if (!acceptedInterrupt || !deadline || deadline > checkedAt || typeof candidate.turnId !== "string"
      || typeof candidate.rootTaskId !== "string" || row.parentTaskId !== candidate.rootTaskId) return rejectRecovery(trace, "unsettled_external_call_rejected")
    const prepared = await prepareGraphTransition(client, { taskId: candidate.id, sessionId: candidate.sessionId,
      type: "task.interrupted", attemptCount })
    const node = prepared && !("blocked" in prepared) ? prepared.snapshot.nodes.find(item => item.taskId === candidate.id) : undefined
    if (!prepared || "blocked" in prepared || prepared.duplicate || !node
      || prepared.taskId !== candidate.id || prepared.scope.userId !== candidate.userId
      || prepared.scope.sessionId !== candidate.sessionId || prepared.scope.turnId !== candidate.turnId
      || prepared.scope.rootTaskId !== candidate.rootTaskId || prepared.scope.parentTaskId !== candidate.rootTaskId
      || prepared.event.type !== "task.interrupted" || prepared.event.nodeKey !== node.key
      || prepared.event.idempotencyKey !== taskGraphLifecycleKey(candidate.rootTaskId, node.key, attemptCount, "task.interrupted")) {
      return rejectRecovery(trace, "unsettled_external_call_rejected")
    }
    graph = prepared
  }
  const terminal = Boolean(rejectedWaitCallId) || interrupted || failedRootTurn || atAttemptCeiling && !waitContinuation
  const status = terminal ? interrupted ? "interrupted" : "failed" : "queued"
  let failureReason = status === "failed" ? rejectedWaitCallId ? "Persisted wait_subagents call was not admitted for the current child role." : failedRootTurn ? "Linked Turn failed before root lease recovery." : "Worker lease expired after maximum attempts." : old.failureReason ?? null
  graph ??= await prepareGraphTransition(client, {
    taskId: candidate.id, sessionId: candidate.sessionId,
    type: status === "interrupted" ? "task.interrupted" : status === "failed" ? "task.failed" : "task.retrying",
    attemptCount, ...(status === "failed" ? { failureReason: String(failureReason) } : {}),
  })
  if (graph && "blocked" in graph) return rejectRecovery(trace, "task_graph_transition_blocked")
  let persistedResult: unknown, resultUpdated = false
  if (status === "failed" && graph && !("blocked" in graph) && graph.snapshot.nodes.some(node => node.taskId === candidate.id && node.verificationDisposition === "typed" && node.verification)) {
    const finish = await prepareTaskGraphFinish(client, { taskId: candidate.id, sessionId: candidate.sessionId, attemptCount, status, retry: false, failureReason: String(failureReason), result: row.result ?? null }); if (finish.graph && "blocked" in finish.graph) return rejectRecovery(trace, "task_graph_finish_blocked")
    graph = finish.graph; failureReason = finish.failureReason ?? failureReason; persistedResult = finish.result; resultUpdated = true
  }
  const nextAttemptAt = status === "queued" && !waitContinuation ? computeSubagentNextAttemptAt(attemptCount, checkedAt) : null
  const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = $3, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
    "leaseSegmentStartedAt" = CASE WHEN $6 THEN NULL ELSE "leaseSegmentStartedAt" END,
    "nextAttemptAt" = $4, "failureReason" = $5, "completedAt" = CASE WHEN $6 THEN $7::timestamp(3) ELSE NULL::timestamp(3) END, "updatedAt" = $7,
    "result" = CASE WHEN $10 THEN $11::jsonb ELSE "result" END
    WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running'
      AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
        WHERE session."id" = "sub_agent_tasks"."sessionId" AND session."userId" = $8 AND session."status" = $9::text)
      AND "leaseExpiresAt" <= clock_timestamp()
      AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= clock_timestamp())`,
  [candidate.id, candidate.sessionId, status, nextAttemptAt, failureReason, terminal, checkedAt, candidate.userId, row.sessionStatus, resultUpdated, resultUpdated ? json(persistedResult, null, "subagent_task_result") : null])
  if (updated.rowCount !== 1) {
    if (waitContinuation) throw new Error("expired_child_wait_task_rearm_conflict")
    return rejectRecovery(trace, "task_update_rejected")
  }
  if (waitContinuation && waitDispatch && nextWaitPayload) {
    const rearmed = await client.query(`UPDATE "agent_outbox" SET "payload" = $1::jsonb, "publishedAt" = NULL, "lastError" = NULL
      WHERE "id" = $2 AND "aggregateId" = $3 AND "topic" = 'agent.subagent.dispatch'
        AND "idempotencyKey" = 'subagent-dispatch:' || $4 AND "attemptCount" = $5
        AND "publishedAt" IS NOT NULL AND "payload" = $6::jsonb`,
    [JSON.stringify(nextWaitPayload), waitDispatch.id, candidate.sessionId, candidate.id, Number(waitDispatch.attemptCount), JSON.stringify(waitDispatch.payload)])
    if (rearmed.rowCount !== 1) throw new Error("expired_child_wait_dispatch_rearm_conflict")
  }
  await settleRecoveredTaskGraph(client, {
    task: rowToTask(row), graph, status, terminal, closedSession, now: checkedAt,
    canonicalFailedRoot: canonicalRoot && failedRootTurn && status === "failed",
  })
  const recoveredTask = rowToTask(row)
  return { ...recoveredTask, status, nextAttemptAt, leaseOwner: null, leaseExpiresAt: null,
    leaseSegmentStartedAt: terminal ? null : recoveredTask.leaseSegmentStartedAt,
    failureReason: failureReason ? String(failureReason) : null, ...(resultUpdated ? { result: persistedResult } : {}) }
}
