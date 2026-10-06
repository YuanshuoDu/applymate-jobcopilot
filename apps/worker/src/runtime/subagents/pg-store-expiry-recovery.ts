import type pg from "pg"
import { settleRecoveredTaskGraph } from "./task-graph-pg-root-failure-cleanup.js"
import { computeSubagentNextAttemptAt } from "./retry-policy.js"
import { RUNNABLE_SESSION } from "../session-gate.js"
import { lockFailedRootTurn, prepareGraphTransition, rootRecoveryEligibility } from "./task-graph-pg-lifecycle.js"
import { dateValue, json, rowToTask, transaction } from "./pg-store-persistence.js"
import type { PgSubagentPool, SubagentTaskRecord } from "./types.js"
import { hasUnsettledExternalCall } from "./external-call-state.js"
import { prepareTaskGraphFinish } from "./pg-store-lifecycle.js"

type Candidate = Record<string, unknown> & Readonly<{ id: string; sessionId: string; userId: string; rootTaskId?: string; turnId?: string | null }>

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
  const terminal = interrupted || failedRootTurn || attemptCount >= Number(old.maxAttempts)
  const status = terminal ? interrupted ? "interrupted" : "failed" : "queued"
  let failureReason = status === "failed" ? failedRootTurn ? "Linked Turn failed before root lease recovery." : "Worker lease expired after maximum attempts." : old.failureReason ?? null
  const locked = await client.query(`${sql} FOR UPDATE OF task`, values)
  const row = locked.rows[0] as Record<string, unknown> | undefined
  if (!row || Number(row.attemptCount) !== attemptCount || row.turnId !== (candidate.turnId ?? null)
    || (canonicalRoot && (row.taskType !== old.taskType || row.id !== old.id || row.rootTaskId !== old.rootTaskId
      || row.parentTaskId !== old.parentTaskId || row.turnId !== old.turnId))) return null
  const checkedAt = (await client.query<{ checkedAt: Date }>(`SELECT clock_timestamp() AS "checkedAt"`)).rows[0]?.checkedAt
  if (!checkedAt) return null
  const lockedExpiry = dateValue(row.leaseExpiresAt)
  const lockedRetryAt = dateValue(row.nextAttemptAt)
  if (!lockedExpiry || lockedExpiry > checkedAt || (lockedRetryAt && lockedRetryAt > checkedAt)) return null
  if (await hasUnsettledExternalCall(client, candidate.sessionId, candidate.id)) return null
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
  const nextAttemptAt = status === "queued" ? computeSubagentNextAttemptAt(attemptCount, checkedAt) : null
  const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = $3, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
    "nextAttemptAt" = $4, "failureReason" = $5, "completedAt" = CASE WHEN $6 THEN $7::timestamp(3) ELSE NULL::timestamp(3) END, "updatedAt" = $7,
    "result" = CASE WHEN $10 THEN $11::jsonb ELSE "result" END
    WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running'
      AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
        WHERE session."id" = "sub_agent_tasks"."sessionId" AND session."userId" = $8 AND session."status" = $9::text)
      AND "leaseExpiresAt" <= clock_timestamp()
      AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= clock_timestamp())`,
  [candidate.id, candidate.sessionId, status, nextAttemptAt, failureReason, terminal, checkedAt, candidate.userId, row.sessionStatus, resultUpdated, resultUpdated ? json(persistedResult, null, "subagent_task_result") : null])
  if (updated.rowCount !== 1) return null
  await settleRecoveredTaskGraph(client, {
    task: rowToTask(row), graph, status, terminal, closedSession, now: checkedAt,
    canonicalFailedRoot: canonicalRoot && failedRootTurn && status === "failed",
  })
  return { ...rowToTask(row), status, nextAttemptAt, leaseOwner: null, leaseExpiresAt: null, failureReason: failureReason ? String(failureReason) : null, ...(resultUpdated ? { result: persistedResult } : {}) }
}
