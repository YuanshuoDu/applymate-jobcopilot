import type pg from "pg"
import { computeSubagentNextAttemptAt } from "./retry-policy.js"
import { RUNNABLE_SESSION } from "../session-gate.js"
import { persistGraphTransition, prepareGraphTransition, reconcileGraphDependents } from "./task-graph-pg-lifecycle.js"
import { dateValue, rowToTask, transaction } from "./pg-store-persistence.js"
import type { PgSubagentPool, SubagentTaskRecord } from "./types.js"

type Selector = Readonly<{ sessionId: string; userId?: string; turnId?: string; rootTaskId?: string; targetPath?: string }>
type Candidate = Record<string, unknown> & Readonly<{ id: string; status: string; attemptCount: number; sessionId: string; userId: string }>

export async function interruptTree(pool: PgSubagentPool, input: { sessionId: string; rootTaskId: string; now: Date }): Promise<number> {
  return interruptMatching(pool, { sessionId: input.sessionId, rootTaskId: input.rootTaskId }, input.now)
}

export async function interruptTurn(pool: PgSubagentPool, input: { userId: string; sessionId: string; turnId: string; now: Date }): Promise<number> {
  return interruptMatching(pool, { userId: input.userId, sessionId: input.sessionId, turnId: input.turnId }, input.now)
}

export async function interruptSubtree(pool: PgSubagentPool, input: { sessionId: string; rootTaskId: string; targetPath: string; now: Date }): Promise<number> {
  return interruptMatching(pool, { sessionId: input.sessionId, rootTaskId: input.rootTaskId, targetPath: input.targetPath }, input.now)
}

async function interruptMatching(pool: PgSubagentPool, selector: Selector, now: Date): Promise<number> {
  return transaction(pool, async client => {
    const session = await client.query(`SELECT "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [selector.sessionId])
    const sessionRow = session.rows[0] as Record<string, unknown> | undefined
    if (!sessionRow || sessionRow.status === "aborted" || sessionRow.status === "archived"
      || (selector.userId && sessionRow.userId !== selector.userId)) return 0
    const userId = String(sessionRow.userId)
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId])
    const { sql, values } = selectorWhere(selector)
    const selected = await client.query(`SELECT task."id", task."status", task."attemptCount" FROM "sub_agent_tasks" AS task
      JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      WHERE ${sql} AND session."userId" = $${values.length + 1}
        AND task."status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')
      ORDER BY task."rootTaskId", task."id"`, [...values, userId])
    let changed = 0
    for (const raw of selected.rows as Candidate[]) {
      const running = raw.status === "running"
      const graph = running ? null : await prepareGraphTransition(client, {
        taskId: raw.id, sessionId: selector.sessionId, type: "task.interrupted", attemptCount: Number(raw.attemptCount),
      })
      if (graph && "blocked" in graph) continue
      const update = running
        ? `UPDATE "sub_agent_tasks" SET "interruptRequestedAt" = COALESCE("interruptRequestedAt", $3), "updatedAt" = $3
            WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running'`
        : `UPDATE "sub_agent_tasks" SET "interruptRequestedAt" = COALESCE("interruptRequestedAt", $3), "status" = 'interrupted',
            "nextAttemptAt" = NULL, "completedAt" = $3, "updatedAt" = $3
            WHERE "id" = $1 AND "sessionId" = $2 AND "status" = $4`
      const params = running ? [raw.id, selector.sessionId, now] : [raw.id, selector.sessionId, now, raw.status]
      const result = await client.query(update, params)
      if (result.rowCount !== 1) continue
      changed++
      if (!running) {
        await removePendingDispatch(client, selector.sessionId, raw.id)
        if (graph) {
          await persistGraphTransition(client, graph, now)
          await reconcileGraphDependents(client, graph.scope, now)
        }
      }
    }
    return changed
  })
}

function selectorWhere(selector: Selector): { sql: string; values: unknown[] } {
  const values: unknown[] = [selector.sessionId]
  const parts = [`task."sessionId" = $1`]
  if (selector.turnId) { values.push(selector.turnId); parts.push(`task."turnId" = $${values.length}`) }
  if (selector.rootTaskId) { values.push(selector.rootTaskId); parts.push(`task."rootTaskId" = $${values.length}`) }
  if (selector.targetPath) {
    values.push(selector.targetPath)
    parts.push(`(task."path" = $${values.length} OR task."path" LIKE $${values.length} || '/%')`)
  }
  return { sql: parts.join(" AND "), values }
}

export async function recoverExpired(pool: PgSubagentPool, input: { now: Date; limit: number }): Promise<SubagentTaskRecord[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1) throw new RangeError("Recovery limit must be positive")
  return transaction(pool, async client => {
    const candidates = await client.query(`SELECT task."id", task."sessionId", task."rootTaskId", session."userId"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      WHERE task."status" = 'running' AND (session."status" IN ('aborted', 'archived') OR ${RUNNABLE_SESSION})
        AND (task."leaseExpiresAt" IS NULL OR task."leaseExpiresAt" <= $1)
        AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP)
      ORDER BY task."sessionId", task."rootTaskId", task."id" LIMIT $2`, [input.now, input.limit])
    const recovered: SubagentTaskRecord[] = []
    for (const candidate of candidates.rows as Candidate[]) {
      const outcome = await recoverOne(client, candidate, input.now)
      if (outcome) recovered.push(outcome)
    }
    return recovered
  })
}

async function recoverOne(client: pg.PoolClient, candidate: Candidate, now: Date): Promise<SubagentTaskRecord | null> {
  const session = await client.query(`SELECT "id", "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [candidate.sessionId])
  const sessionRow = session.rows[0] as Record<string, unknown> | undefined
  if (!sessionRow || sessionRow.userId !== candidate.userId) return null
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [candidate.userId])
  const sql = `SELECT task.*, session."userId" AS "userId", session."status" AS "sessionStatus"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND session."userId" = $3 AND task."status" = 'running'
      AND (session."status" IN ('aborted', 'archived') OR task."leaseExpiresAt" IS NULL OR task."leaseExpiresAt" <= $4)
      AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP)`
  const preview = await client.query(sql, [candidate.id, candidate.sessionId, candidate.userId, now])
  const old = preview.rows[0] as Record<string, unknown> | undefined
  if (!old) return null
  const attemptCount = Number(old.attemptCount)
  const closedSession = old.sessionStatus === "aborted" || old.sessionStatus === "archived"
  const interrupted = closedSession || old.interruptRequestedAt !== null
  const terminal = interrupted || attemptCount >= Number(old.maxAttempts)
  const status = terminal ? interrupted ? "interrupted" : "failed" : "queued"
  const failureReason = status === "failed" ? "Worker lease expired after maximum attempts." : old.failureReason ?? null
  const eventType = status === "interrupted" ? "task.interrupted" : status === "failed" ? "task.failed" : "task.retrying"
  const graph = await prepareGraphTransition(client, {
    taskId: candidate.id, sessionId: candidate.sessionId, type: eventType,
    attemptCount, ...(eventType === "task.failed" ? { failureReason: String(failureReason) } : {}),
  })
  if (graph && "blocked" in graph) return null
  const locked = await client.query(`${sql} FOR UPDATE OF task`, [candidate.id, candidate.sessionId, candidate.userId, now])
  const row = locked.rows[0] as Record<string, unknown> | undefined
  if (!row || Number(row.attemptCount) !== attemptCount) return null
  const lockedSessionClosed = row.sessionStatus === "aborted" || row.sessionStatus === "archived"
  const lockedExpiry = dateValue(row.leaseExpiresAt)
  const lockedRetryAt = dateValue(row.nextAttemptAt)
  if ((!lockedSessionClosed && lockedExpiry && lockedExpiry.getTime() > now.getTime())
    || (lockedRetryAt && lockedRetryAt.getTime() > now.getTime())) return null
  const nextAttemptAt = status === "queued" ? computeSubagentNextAttemptAt(attemptCount, now) : null
  const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = $3, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
    "nextAttemptAt" = $4, "failureReason" = $5, "completedAt" = CASE WHEN $6 THEN $7::timestamp(3) ELSE NULL::timestamp(3) END, "updatedAt" = $7
    WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running'`,
  [candidate.id, candidate.sessionId, status, nextAttemptAt, failureReason, terminal, now])
  if (updated.rowCount !== 1) return null
  if (graph) {
    await persistGraphTransition(client, graph, now, { stream: !closedSession, allowClosedSession: closedSession })
    if (terminal) await reconcileGraphDependents(client, graph.scope, now, { stream: !closedSession, allowClosedSession: closedSession })
  }
  if (status === "queued") await resetDispatch(client, candidate.sessionId, candidate.id)
  else await removePendingDispatch(client, candidate.sessionId, candidate.id)
  return { ...rowToTask(row), status, nextAttemptAt, leaseOwner: null, leaseExpiresAt: null, failureReason: failureReason ? String(failureReason) : null }
}

async function removePendingDispatch(client: pg.PoolClient, sessionId: string, taskId: string): Promise<void> {
  await client.query(`DELETE FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1
    AND "idempotencyKey" = $2 AND "publishedAt" IS NULL`, [sessionId, `subagent-dispatch:${taskId}`])
}

async function resetDispatch(client: pg.PoolClient, sessionId: string, taskId: string): Promise<void> {
  await client.query(`UPDATE "agent_outbox" SET "publishedAt" = NULL, "attemptCount" = "attemptCount" + 1, "lastError" = NULL
    WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [sessionId, `subagent-dispatch:${taskId}`])
}
