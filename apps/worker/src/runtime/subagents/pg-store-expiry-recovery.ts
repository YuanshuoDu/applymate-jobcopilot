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

type Candidate = Record<string, unknown> & Readonly<{ id: string; sessionId: string; userId: string; rootTaskId?: string; turnId?: string | null }>

const CHILD_WAIT_RESUMABLE_SQL = `(SELECT COUNT(*) = 1
  FROM "agent_wait_conditions" AS wait
  JOIN "agent_turns" AS waitTurn ON waitTurn."id" = wait."turnId" AND waitTurn."sessionId" = wait."sessionId"
    AND waitTurn."userId" = wait."userId" AND waitTurn."userId" = $3 AND waitTurn."rootTaskId" = task."rootTaskId"
  JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId"
    AND step."turnId" = wait."turnId" AND step."taskId" = task."id"
  WHERE task."parentTaskId" IS NOT NULL AND task."status" = 'running'
    AND wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId" AND wait."turnId" = task."turnId"
    AND task."attemptCount" >= 0 AND task."maxAttempts" > 0
    AND step."attempt" = task."attemptCount"
    AND ((wait."consumedAt" IS NULL AND step."status" = 'waiting_for_tool' AND step."ordinal" = (SELECT MAX(currentStep."ordinal") FROM "agent_steps" AS currentStep
        WHERE currentStep."taskId" = task."id" AND currentStep."sessionId" = task."sessionId"
          AND currentStep."turnId" = task."turnId" AND currentStep."attempt" = task."attemptCount"))
      OR (step."status" IN ('waiting_for_tool', 'completed')
        AND (SELECT COUNT(*) FROM "agent_steps" AS continuation WHERE continuation."taskId" = task."id"
          AND continuation."sessionId" = task."sessionId" AND continuation."turnId" = task."turnId"
          AND continuation."attempt" = task."attemptCount" AND continuation."ordinal" = step."ordinal" + 1) = 1
        AND step."ordinal" + 1 = (SELECT MAX(currentStep."ordinal") FROM "agent_steps" AS currentStep
          WHERE currentStep."taskId" = task."id" AND currentStep."sessionId" = task."sessionId"
            AND currentStep."turnId" = task."turnId" AND currentStep."attempt" = task."attemptCount")))
    AND wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL
    AND wait."id" = (SELECT currentWait."id" FROM "agent_wait_conditions" AS currentWait
      WHERE currentWait."parentTaskId" = task."id" AND currentWait."sessionId" = task."sessionId"
        AND currentWait."turnId" = task."turnId" AND currentWait."stepId" = step."id"
      ORDER BY currentWait."createdAt" DESC, currentWait."id" DESC LIMIT 1)
    AND wait."mode" IN ('any', 'all') AND jsonb_typeof(wait."targetTaskIds") = 'array'
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) > 0
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) <= 8
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) = (SELECT COUNT(DISTINCT target."value")
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("value")
      WHERE jsonb_typeof(target."value") = 'string')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END
    ) AS target("id") WHERE NOT EXISTS (SELECT 1 FROM "sub_agent_tasks" AS child
      WHERE child."id" = target."id" AND child."id" <> task."id" AND child."parentTaskId" = task."id"
        AND child."sessionId" = task."sessionId" AND child."turnId" = task."turnId"
        AND child."rootTaskId" = task."rootTaskId"))) = true`

const CHILD_WAIT_CONSUMED_SQL = `(SELECT COUNT(*) = 1 FROM "agent_wait_conditions" AS wait
  JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId"
    AND source."turnId" = wait."turnId" AND source."taskId" = wait."parentTaskId"
  JOIN "agent_steps" AS continuation ON continuation."sessionId" = source."sessionId"
    AND continuation."turnId" = source."turnId" AND continuation."taskId" = source."taskId"
    AND continuation."attempt" = source."attempt" AND continuation."ordinal" = source."ordinal" + 1
  WHERE task."parentTaskId" IS NOT NULL AND task."status" = 'running' AND wait."parentTaskId" = task."id"
    AND wait."sessionId" = task."sessionId" AND wait."turnId" = task."turnId" AND wait."consumedAt" IS NOT NULL
    AND wait."suspendedAt" IS NOT NULL AND wait."status" IN ('ready', 'timed_out')
    AND source."attempt" = task."attemptCount" AND source."status" IN ('waiting_for_tool', 'completed')
    AND continuation."ordinal" = (SELECT MAX(currentStep."ordinal") FROM "agent_steps" AS currentStep
      WHERE currentStep."taskId" = task."id" AND currentStep."sessionId" = task."sessionId"
        AND currentStep."turnId" = task."turnId" AND currentStep."attempt" = task."attemptCount")
    AND wait."id" = (SELECT currentWait."id" FROM "agent_wait_conditions" AS currentWait
      WHERE currentWait."parentTaskId" = task."id" AND currentWait."sessionId" = task."sessionId"
        AND currentWait."turnId" = task."turnId" AND currentWait."stepId" = source."id"
      ORDER BY currentWait."createdAt" DESC, currentWait."id" DESC LIMIT 1)) = true`

type ExpiredWaitDispatch = { id: string; payload: unknown; attemptCount: unknown; publishedAt: unknown }

async function hasBlockingExternalCall(client: pg.PoolClient, task: Record<string, unknown>, ignoredEventId?: string): Promise<boolean> {
  const result = await client.query(`SELECT started."id" FROM "agent_events" AS started
    WHERE started."sessionId" = $1 AND started."taskId" = $2 AND started."type" IN ('tool_call.started', 'model.started')
      AND NOT EXISTS (SELECT 1 FROM "agent_events" AS settled WHERE settled."sessionId" = started."sessionId" AND settled."taskId" = started."taskId"
        AND settled."correlationId" = started."correlationId" AND ((started."type" = 'tool_call.started' AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted'))
          OR (started."type" = 'model.started' AND settled."type" IN ('model.completed', 'model.failed'))))
      AND NOT (started."type" = 'tool_call.started' AND EXISTS (
        SELECT 1 FROM "sub_agent_tasks" AS owner JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = owner."id"
        JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId" AND source."turnId" = wait."turnId" AND source."taskId" = owner."id"
        JOIN "agent_items" AS call ON call."id" = started."itemId" AND call."sessionId" = source."sessionId" AND call."turnId" = source."turnId" AND call."taskId" = source."taskId" AND call."stepId" = source."id"
        WHERE owner."id" = $2 AND owner."sessionId" = $1 AND owner."turnId" = $3 AND owner."rootTaskId" = $4 AND owner."status" = 'running'
          AND owner."leaseOwner" = $5 AND owner."attemptCount" = $6 AND owner."leaseExpiresAt" = $7 AND source."attempt" = $6
          AND wait."sessionId" = $1 AND wait."turnId" = $3 AND wait."userId" = $8
          AND ((wait."status" = 'waiting' AND wait."suspendedAt" IS NULL AND wait."consumedAt" IS NULL
              AND source."status" IN ('streaming', 'waiting_for_tool') AND source."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."taskId" = owner."id" AND current."sessionId" = $1 AND current."turnId" = $3 AND current."attempt" = $6))
            OR (wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL
              AND source."status" IN ('waiting_for_tool', 'completed') AND EXISTS (SELECT 1 FROM "agent_steps" AS next WHERE next."sessionId" = source."sessionId" AND next."turnId" = source."turnId" AND next."taskId" = source."taskId" AND next."attempt" = source."attempt" AND next."ordinal" = source."ordinal" + 1
                AND (wait."consumedAt" IS NOT NULL OR next."status" = 'streaming')
                AND next."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."taskId" = owner."id" AND current."sessionId" = $1 AND current."turnId" = $3 AND current."attempt" = $6))))
          AND wait."id" = (SELECT latest."id" FROM "agent_wait_conditions" AS latest WHERE latest."parentTaskId" = owner."id" AND latest."stepId" = source."id" ORDER BY latest."createdAt" DESC, latest."id" DESC LIMIT 1)
          AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents' AND call."content"->>'toolVersion' = '1'
          AND call."status" IN ('started', 'streaming', 'completed') AND call."content"->>'toolCallId' = started."correlationId" AND started."itemId" = call."id" AND started."turnId" = $3
          AND call."content"->'input' - 'taskIds'::text = jsonb_build_object('idempotencyKey', wait."idempotencyKey", 'mode', wait."mode", 'timeoutMs', wait."result"->'request'->'timeoutMs')
          AND (SELECT jsonb_agg(target."id" ORDER BY target."id") FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(call."content"->'input'->'taskIds') = 'array' THEN call."content"->'input'->'taskIds' ELSE '[]'::jsonb END) AS target("id")) = wait."targetTaskIds"
          AND wait."result"->'request' = jsonb_build_object('targetTaskIds', wait."targetTaskIds", 'mode', wait."mode", 'timeoutMs', wait."result"->'request'->'timeoutMs')
          AND wait."result"->'outcome'->>'waitId' = wait."id" AND wait."result"->'outcome'->>'status' = wait."status"
          AND wait."result"->'outcome'->'taskIds' = wait."targetTaskIds" AND wait."result"->'outcome'->'matchedTaskIds' = wait."matchedTaskIds"
          AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) BETWEEN 1 AND 8
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("id")
            WHERE NOT EXISTS (SELECT 1 FROM "sub_agent_tasks" AS child WHERE child."id" = target."id" AND child."parentTaskId" = owner."id" AND child."rootTaskId" = $4 AND child."sessionId" = $1 AND child."turnId" = $3))))
      AND ($9::text IS NULL OR started."id" <> $9) LIMIT 1`, [task.sessionId, task.id, task.turnId, task.rootTaskId, task.leaseOwner, task.attemptCount, task.leaseExpiresAt, task.userId, ignoredEventId ?? null])
  return result.rows.length > 0
}

export async function recoverExpired(pool: PgSubagentPool, input: { now: Date; limit: number; sessionId?: string; turnId?: string }): Promise<SubagentTaskRecord[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1) throw new RangeError("Recovery limit must be positive")
  if (input.turnId && !input.sessionId) throw new TypeError("Turn recovery filter requires a Session")
  return transaction(pool, async client => {
    const candidates = await client.query(`SELECT task."id", task."sessionId", task."rootTaskId", task."turnId", session."userId"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      WHERE task."status" = 'running' AND (session."status" IN ('aborted', 'archived') OR ${RUNNABLE_SESSION})
        AND task."leaseExpiresAt" <= clock_timestamp()
        AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= clock_timestamp())
        AND ($2::text IS NULL OR task."sessionId" = $2)
        AND ($3::text IS NULL OR task."turnId" = $3)
        AND (${rootRecoveryEligibility})
      ORDER BY task."sessionId", task."rootTaskId", task."id" LIMIT $1`, [input.limit, input.sessionId ?? null, input.turnId ?? null])
    const recovered: SubagentTaskRecord[] = []
    for (const candidate of candidates.rows as Candidate[]) {
      const outcome = await recoverOne(client, candidate, input)
      if (outcome) recovered.push(outcome)
    }
    return recovered
  })
}

async function recoverOne(client: pg.PoolClient, candidate: Candidate, filter: { sessionId?: string; turnId?: string }): Promise<SubagentTaskRecord | null> {
  const session = await client.query(`SELECT "id", "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [candidate.sessionId])
  const sessionRow = session.rows[0] as Record<string, unknown> | undefined
  if (!sessionRow || sessionRow.userId !== candidate.userId) return null
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [candidate.userId])
  if (typeof candidate.turnId === "string") {
    const turn = await client.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2
      AND "userId" = $3 AND "rootTaskId" = $4 FOR UPDATE`, [candidate.turnId, candidate.sessionId, candidate.userId, candidate.rootTaskId])
    if (!turn.rows[0]) return null
  }
  const sql = `SELECT task.*, session."userId" AS "userId", session."status" AS "sessionStatus",
      ${CHILD_WAIT_RESUMABLE_SQL} AS "childWaitResumable", ${CHILD_WAIT_CONSUMED_SQL} AS "childWaitConsumed",
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
  if (!old) return null
  const attemptCount = Number(old.attemptCount)
  const closedSession = old.sessionStatus === "aborted" || old.sessionStatus === "archived"
  const interrupted = closedSession || old.interruptRequestedAt !== null || old.rootInterruptRequestedAt != null
  const canonicalRoot = typeof old.id === "string" && old.id.startsWith("root-")
  const failedRootTurn = canonicalRoot && !interrupted ? await lockFailedRootTurn(client, old) : false
  if (canonicalRoot && !interrupted && !failedRootTurn) return null
  const atAttemptCeiling = attemptCount >= Number(old.maxAttempts)
  const childWaitResumable = old.childWaitResumable === true
  const childWaitConsumed = old.childWaitConsumed === true
  let waitContinuation = !interrupted && !failedRootTurn && childWaitResumable
  const locked = await client.query(`${sql} FOR UPDATE OF task`, values)
  const row = locked.rows[0] as Record<string, unknown> | undefined
  if (!row || Number(row.attemptCount) !== attemptCount || row.turnId !== (candidate.turnId ?? null)
    || (row.childWaitResumable === true) !== childWaitResumable || (row.childWaitConsumed === true) !== childWaitConsumed
    || (canonicalRoot && (row.taskType !== old.taskType || row.id !== old.id || row.rootTaskId !== old.rootTaskId
      || row.parentTaskId !== old.parentTaskId || row.turnId !== old.turnId))) return null
  const checkedAt = (await client.query<{ checkedAt: Date }>(`SELECT clock_timestamp() AS "checkedAt"`)).rows[0]?.checkedAt
  if (!checkedAt) return null
  const lockedExpiry = dateValue(row.leaseExpiresAt)
  const lockedRetryAt = dateValue(row.nextAttemptAt)
  if (!lockedExpiry || lockedExpiry > checkedAt || (lockedRetryAt && lockedRetryAt > checkedAt)) return null
  let rejectedWaitCallId: string | undefined
  if (!interrupted && row.parentTaskId != null && typeof row.leaseOwner === "string" && typeof row.turnId === "string") {
    const lease = { id: candidate.id, userId: candidate.userId, sessionId: candidate.sessionId, turnId: row.turnId,
      rootTaskId: String(row.rootTaskId), ownerId: row.leaseOwner, attemptCount, leaseExpiresAt: lockedExpiry }
    const registration = await recoverExpiredWaitRegistration(client, lease, checkedAt)
    if (registration && "rejectedCallId" in registration) rejectedWaitCallId = registration.rejectedCallId
    if (await hasBlockingExternalCall(client, row, rejectedWaitCallId)) return null
    const wait = await recoverExpiredDurableSubagentWaitWithGraph(client, { lease, now: checkedAt })
    if (wait && "blocked" in wait) return null
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
    if (waitDispatch && payload && waitDispatch.publishedAt != null && Number.isSafeInteger(generation)
      && generation >= 1 && generation < 2_147_483_647 && payload.taskId === candidate.id
      && payload.sessionId === candidate.sessionId && payload.rootTaskId === candidate.rootTaskId
      && typeof row.leaseOwner === "string" && payload.ownerId === row.leaseOwner) {
      nextWaitPayload = { ...payload, ownerId: `expired-child-wait-${randomUUID()}` }
    } else {
      waitContinuation = false
    }
  }
  const unsettledExternalCall = await hasBlockingExternalCall(client, row, rejectedWaitCallId)
  if (unsettledExternalCall && (!waitContinuation || childWaitConsumed)) return null
  const terminal = Boolean(rejectedWaitCallId) || interrupted || failedRootTurn || atAttemptCeiling && !waitContinuation
  const status = terminal ? interrupted ? "interrupted" : "failed" : "queued"
  let failureReason = status === "failed" ? rejectedWaitCallId ? "Persisted wait_subagents call was not admitted for the current child role." : failedRootTurn ? "Linked Turn failed before root lease recovery." : "Worker lease expired after maximum attempts." : old.failureReason ?? null
  let graph = await prepareGraphTransition(client, {
    taskId: candidate.id, sessionId: candidate.sessionId,
    type: status === "interrupted" ? "task.interrupted" : status === "failed" ? "task.failed" : "task.retrying",
    attemptCount, ...(status === "failed" ? { failureReason: String(failureReason) } : {}),
  })
  if (graph && "blocked" in graph) return null
  let persistedResult: unknown, resultUpdated = false
  if (status === "failed" && graph && !("blocked" in graph) && graph.snapshot.nodes.some(node => node.taskId === candidate.id && node.verificationDisposition === "typed" && node.verification)) {
    const finish = await prepareTaskGraphFinish(client, { taskId: candidate.id, sessionId: candidate.sessionId, attemptCount, status, retry: false, failureReason: String(failureReason), result: row.result ?? null }); if (finish.graph && "blocked" in finish.graph) return null
    graph = finish.graph; failureReason = finish.failureReason ?? failureReason; persistedResult = finish.result; resultUpdated = true
  }
  const nextAttemptAt = status === "queued" && !waitContinuation ? computeSubagentNextAttemptAt(attemptCount, checkedAt) : null
  const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = $3, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
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
    return null
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
  return { ...rowToTask(row), status, nextAttemptAt, leaseOwner: null, leaseExpiresAt: null, failureReason: failureReason ? String(failureReason) : null, ...(resultUpdated ? { result: persistedResult } : {}) }
}
