import { randomUUID } from "node:crypto"
import type pg from "pg"
import { isTerminalSubagentStatus, type AtomicSubagentSpawnInput, type AtomicSubagentSpawnResult, type PgSubagentPool,
  type SubagentExecutionResult, type SubagentRetryDisposition, type SubagentStore, type SubagentTaskRecord, type SubagentTaskSpec, type SubagentPolicy } from "./types.js"
import { computeSubagentNextAttemptAt } from "./retry-policy.js"
import { persistGraphTransition, prepareGraphTransition, reconcileGraphDependents } from "./task-graph-pg-lifecycle.js"
import { RUNNABLE_SESSION } from "../session-gate.js"
import { createSubagentTask, lockSubagentSession, readSubagentTask } from "./pg-store-create.js"
import { dateValue, json, rowToTask, SELECT_TASK, spawnKey, transaction, uniqueMessageIds } from "./pg-store-persistence.js"
import { interruptSubtree as interruptStoreSubtree, interruptTree as interruptStoreTree, interruptTurn as interruptStoreTurn, prepareTaskGraphFinish, recoverExpired as recoverStoreExpired } from "./pg-store-lifecycle.js"
export class PgSubagentTaskStore implements SubagentStore {
  constructor(private readonly pool: PgSubagentPool, private readonly leaseMs = 60_000) {}
  private async leaseTimeAfterLock(client: pg.PoolClient, input: { taskId: string; sessionId: string; ownerId: string; attemptCount: number }): Promise<Date | null> {
    const lease = await client.query<{ leaseExpiresAt: Date }>(`SELECT "leaseExpiresAt" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $3 AND "attemptCount" = $4 AND "status" = 'running' FOR UPDATE`, [input.taskId, input.sessionId, input.ownerId, input.attemptCount])
    const checkedAt = (await client.query<{ checkedAt: Date }>(`SELECT clock_timestamp() AS "checkedAt"`)).rows[0]?.checkedAt
    return lease.rows[0]?.leaseExpiresAt && checkedAt && lease.rows[0].leaseExpiresAt > checkedAt ? checkedAt : null
  }
  async get(taskId: string, sessionId: string): Promise<SubagentTaskRecord | null> {
    const client = await this.pool.connect()
    try { const result = await client.query(SELECT_TASK, [taskId, sessionId]); return result.rows[0] ? rowToTask(result.rows[0] as Record<string, unknown>) : null }
    finally { client.release() }
  }
  async create(input: SubagentTaskSpec & { policy: SubagentPolicy }): Promise<SubagentTaskRecord> { return transaction(this.pool, client => createSubagentTask(client, input)) }
  async createWithSpawn(input: AtomicSubagentSpawnInput): Promise<AtomicSubagentSpawnResult> {
    try {
      return await transaction(this.pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.userId])
        await lockSubagentSession(client, input)
        const key = spawnKey(input.sessionId, input.spawnIdempotencyKey)
        const existing = await client.query(`SELECT "payload" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.spawn' AND "aggregateId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`, [input.sessionId, key])
        if (existing.rows[0]) {
          const payload = existing.rows[0].payload as Record<string, unknown> | undefined
          const taskId = payload && typeof payload.taskId === "string" ? payload.taskId : null
          if (!taskId) throw new Error("Spawn idempotency record is invalid")
          return { task: await readSubagentTask(client, taskId, input.sessionId), duplicate: true }
        }
        const task = await createSubagentTask(client, input, true)
        const operation = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.subagent.spawn', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
          [`spawn-operation-${randomUUID()}`, input.sessionId, key, JSON.stringify({ taskId: task.id })])
        if (operation.rowCount !== 1) throw new DuplicateSpawnSignal()
        await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.subagent.dispatch', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
          [`subagent-dispatch-${randomUUID()}`, input.sessionId, `subagent-dispatch:${task.id}`, JSON.stringify({ taskId: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId, ownerId: `coordination-${randomUUID()}` })])
        return { task, duplicate: false }
      })
    } catch (error: unknown) {
      if (error instanceof DuplicateSpawnSignal) return { task: null, duplicate: true }
      throw error
    }
  }
  async claim(input: { taskId: string; sessionId: string; ownerId: string; policy: SubagentPolicy; now: Date }): Promise<SubagentTaskRecord | null> {
    return transaction(this.pool, async (client) => {
      const session = await client.query<{ id: string; userId: string; status: string }>(`SELECT session."id", session."userId", session."status" FROM "agent_sessions" AS session WHERE session."id" = $1 AND ${RUNNABLE_SESSION} FOR UPDATE`, [input.sessionId])
      const sessionRow = session.rows[0]
      const sessionStatus = String(sessionRow?.status ?? "")
      if (!sessionRow || sessionStatus === "aborted" || sessionStatus === "archived") return null
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [sessionRow.userId])
      const running = await client.query(`SELECT COUNT(*)::int AS "count" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "status" = 'running' AND "leaseExpiresAt" > clock_timestamp()`, [input.sessionId])
      if (Number(running.rows[0]?.count ?? 0) >= input.policy.maxConcurrency) return null
      const graph = await prepareGraphTransition(client, { taskId: input.taskId, sessionId: input.sessionId, type: "task.started" })
      if (graph && "blocked" in graph) return null
      const updated = await client.query(`UPDATE "sub_agent_tasks"
        SET "status" = 'running', "leaseOwner" = $3, "leaseExpiresAt" = clock_timestamp() + ($4 * INTERVAL '1 millisecond'), "attemptCount" = "attemptCount" + 1, "startedAt" = COALESCE("startedAt", clock_timestamp()), "updatedAt" = clock_timestamp()
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'queued' AND "interruptRequestedAt" IS NULL
          AND "attemptCount" < "maxAttempts" AND ("leaseOwner" IS NULL OR "leaseExpiresAt" <= clock_timestamp())
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= clock_timestamp())
          AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = "sub_agent_tasks"."sessionId" AND ${RUNNABLE_SESSION})
          AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS root JOIN "agent_turns" AS turn ON turn."id" = root."turnId"
            WHERE root."id" = "sub_agent_tasks"."rootTaskId" AND root."sessionId" = "sub_agent_tasks"."sessionId"
              AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
              AND turn."id" = "sub_agent_tasks"."turnId" AND turn."sessionId" = "sub_agent_tasks"."sessionId"
              AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled'))`,
      [input.taskId, input.sessionId, input.ownerId, this.leaseMs])
      if (updated.rowCount !== 1) return null
      if (graph) await persistGraphTransition(client, graph, input.now)
      return readSubagentTask(client, input.taskId, input.sessionId)
    })
  }
  async heartbeat(input: { taskId: string; sessionId: string; ownerId: string; attemptCount: number; now: Date }): Promise<"renewed" | "interrupted" | "lost"> {
    return transaction(this.pool, async (client) => {
      const session = await client.query(`SELECT "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [input.sessionId])
      const sessionStatus = String(session.rows[0]?.status ?? "")
      if (!session.rows[0]) return "lost"
      if (sessionStatus === "aborted" || sessionStatus === "archived") return "interrupted"
      if (!await this.leaseTimeAfterLock(client, input)) return "lost"
      const result = await client.query(`UPDATE "sub_agent_tasks"
        SET "leaseExpiresAt" = LEAST(clock_timestamp() + ($4 * INTERVAL '1 millisecond'),
          COALESCE("startedAt", clock_timestamp()) + (300000 * INTERVAL '1 millisecond')), "updatedAt" = clock_timestamp()
        WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $3 AND "attemptCount" = $5 AND "status" = 'running'
          AND "leaseExpiresAt" > clock_timestamp() AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS root JOIN "agent_turns" AS turn ON turn."id" = root."turnId"
            WHERE root."id" = "sub_agent_tasks"."rootTaskId" AND root."sessionId" = "sub_agent_tasks"."sessionId"
              AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
              AND turn."id" = "sub_agent_tasks"."turnId" AND turn."sessionId" = "sub_agent_tasks"."sessionId"
              AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled'))
          AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
            WHERE session."id" = "sub_agent_tasks"."sessionId"
              AND session."status" NOT IN ('aborted', 'archived')) RETURNING "interruptRequestedAt"`, [input.taskId, input.sessionId, input.ownerId, this.leaseMs, input.attemptCount])
      if (result.rowCount === 1) return result.rows[0].interruptRequestedAt ? "interrupted" : "renewed"
      const state = await client.query(`SELECT task."interruptRequestedAt", turn."status" AS "turnStatus" FROM "sub_agent_tasks" AS task
        JOIN "agent_sessions" AS session ON session."id" = task."sessionId" JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
        JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
        WHERE task."id" = $1 AND task."sessionId" = $2 AND task."leaseOwner" = $3 AND task."attemptCount" = $4
          AND task."status" = 'running' AND task."leaseExpiresAt" > clock_timestamp() AND session."status" NOT IN ('aborted', 'archived')`, [input.taskId, input.sessionId, input.ownerId, input.attemptCount])
      return state.rows[0]?.interruptRequestedAt && state.rows[0]?.turnStatus === "interrupted" ? "interrupted" : "lost"
    })
  }
  async finish(input: { taskId: string; sessionId: string; ownerId: string; attemptCount: number; status: SubagentExecutionResult["status"]; result?: unknown; failureReason?: string; retryDisposition?: SubagentRetryDisposition; mailboxMessageIds?: readonly string[]; now: Date }): Promise<"completed" | "retrying" | "failed" | "waiting" | "waiting_for_user" | "interrupted" | null> {
    const mailboxMessageIds = uniqueMessageIds(input.mailboxMessageIds)
    try {
      return await transaction(this.pool, async (client) => {
        const session = await client.query<{ id: string; userId: string; status: string }>(`SELECT "id", "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [input.sessionId])
        const sessionRow = session.rows[0]
        if (!sessionRow || sessionRow.status === "aborted" || sessionRow.status === "archived") return null
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [sessionRow.userId])
        const taskSql = `${SELECT_TASK}
          AND task."status" = 'running' AND task."leaseOwner" = $3 AND task."attemptCount" = $4
          AND task."leaseExpiresAt" > clock_timestamp()
          AND session."status" NOT IN ('aborted', 'archived')
          AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS root JOIN "agent_turns" AS turn ON turn."id" = root."turnId"
            WHERE root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
              AND turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."rootTaskId" = root."id"
              AND (turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled')
                OR (turn."status" = 'interrupted' AND task."interruptRequestedAt" IS NOT NULL)))`
        const task = await client.query(taskSql, [input.taskId, input.sessionId, input.ownerId, input.attemptCount])
        const row = task.rows[0] as Record<string, unknown> | undefined
        if (!row || String(row.id) !== input.taskId || String(row.sessionId) !== input.sessionId
          || row.status !== "running" || row.leaseOwner !== input.ownerId || Number(row.attemptCount) !== input.attemptCount) return null
        const interrupted = row.interruptRequestedAt !== null && row.interruptRequestedAt !== undefined
        const retry = input.status === "failed" && !interrupted && input.retryDisposition !== "terminal" && Number(row.attemptCount) < Number(row.maxAttempts)
        let status = interrupted ? "interrupted" : retry ? "queued" : input.status
        let result = input.result
        let failureReason = input.failureReason
        const finish = await prepareTaskGraphFinish(client, {
          taskId: input.taskId, sessionId: input.sessionId, attemptCount: input.attemptCount,
          status, retry, failureReason, result,
        })
        status = finish.status; result = finish.result; failureReason = finish.failureReason
        const graph = finish.graph
        if (graph && "blocked" in graph) return null
        const terminal = isTerminalSubagentStatus(status)
        const lockedTask = await client.query(`${taskSql} FOR UPDATE OF task`, [input.taskId, input.sessionId, input.ownerId, input.attemptCount])
        const lockedRow = lockedTask.rows[0] as Record<string, unknown> | undefined
        if (!lockedRow || lockedRow.status !== "running" || lockedRow.leaseOwner !== input.ownerId
          || Number(lockedRow.attemptCount) !== input.attemptCount) return null
        const lockedExpiry = dateValue(lockedRow.leaseExpiresAt)
        const leaseClock = await client.query<{ checkedAt: Date }>(`SELECT clock_timestamp() AS "checkedAt"`)
        const finishAt = leaseClock.rows[0]?.checkedAt
        if (!lockedExpiry || !finishAt || lockedExpiry <= finishAt) return null
        const nextAttemptAt = retry ? computeSubagentNextAttemptAt(input.attemptCount, finishAt) : null
        const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = $3, "result" = $4::jsonb,
          "failureReason" = $5, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
          "nextAttemptAt" = $10, "completedAt" = CASE WHEN $6 THEN $7::timestamp(3) ELSE NULL::timestamp(3) END,
          "updatedAt" = $7::timestamp(3)
          WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $8 AND "status" = 'running'
            AND "attemptCount" = $9 AND "leaseExpiresAt" > clock_timestamp()
            AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
              WHERE session."id" = "sub_agent_tasks"."sessionId"
                AND session."status" NOT IN ('aborted', 'archived'))
            AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS root JOIN "agent_turns" AS turn ON turn."id" = root."turnId"
              WHERE root."id" = "sub_agent_tasks"."rootTaskId" AND root."sessionId" = "sub_agent_tasks"."sessionId" AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
                AND turn."id" = "sub_agent_tasks"."turnId" AND turn."sessionId" = "sub_agent_tasks"."sessionId"
                AND turn."rootTaskId" = root."id" AND (turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled')
                  OR (turn."status" = 'interrupted' AND "sub_agent_tasks"."interruptRequestedAt" IS NOT NULL)))`,
        [input.taskId, input.sessionId, status, json(result, null), failureReason ?? null, terminal, finishAt, input.ownerId, input.attemptCount, nextAttemptAt])
        if (updated.rowCount !== 1) throw new FinishFenceSignal()
        if (graph) {
          await persistGraphTransition(client, graph, finishAt)
          if (terminal && finish.reconcileDependents !== false) await reconcileGraphDependents(client, graph.scope, finishAt)
        }
        if (interrupted) await client.query(`DELETE FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2 AND "publishedAt" IS NULL`,
          [input.sessionId, `subagent-dispatch:${input.taskId}`])
        if (retry) {
          await client.query(`UPDATE "agent_outbox" SET "publishedAt" = NULL, "attemptCount" = "attemptCount" + 1, "lastError" = NULL
            WHERE "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $1 AND "aggregateId" = $2`,
          [`subagent-dispatch:${input.taskId}`, input.sessionId])
        }
        if (status === "completed" && mailboxMessageIds.length > 0) {
          await client.query(`UPDATE "agent_mailbox_messages" AS message
            SET "consumedAt" = CURRENT_TIMESTAMP
            WHERE message."sessionId" = $1 AND message."toTaskId" = $2
              AND message."id" = ANY($3::text[]) AND message."consumedAt" IS NULL
              AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS target
                WHERE target."id" = $2 AND target."sessionId" = $1
                  AND message."turnId" = target."turnId")`,
          [input.sessionId, input.taskId, mailboxMessageIds])
        }
        if (interrupted) return "interrupted"
        if (retry) return "retrying"
        return status as "completed" | "failed" | "waiting" | "waiting_for_user"
      })
    } catch (error: unknown) {
      if (error instanceof FinishFenceSignal) return null
      throw error
    }
  }
  async release(input: { taskId: string; sessionId: string; ownerId: string; attemptCount: number; now: Date }): Promise<boolean> {
    return transaction(this.pool, async client => {
      const session = await client.query<{ userId: string }>(`SELECT "userId" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [input.sessionId])
      const userId = session.rows[0]?.userId
      if (!userId) return false
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId])
      const releasedAt = await this.leaseTimeAfterLock(client, input); if (!releasedAt) return false
      const graph = await prepareGraphTransition(client, { taskId: input.taskId, sessionId: input.sessionId, type: "task.retrying", attemptCount: input.attemptCount })
      if (graph && "blocked" in graph) return false
      const updated = await client.query(`UPDATE "sub_agent_tasks"
        SET "status" = 'queued', "nextAttemptAt" = NULL, "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = $5
        WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $3 AND "attemptCount" = $4
          AND "interruptRequestedAt" IS NULL AND "status" = 'running' AND "leaseExpiresAt" > clock_timestamp()
          AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
            WHERE session."id" = "sub_agent_tasks"."sessionId"
              AND session."status" NOT IN ('aborted', 'archived'))`,
      [input.taskId, input.sessionId, input.ownerId, input.attemptCount, releasedAt])
      if (updated.rowCount !== 1) return false
      if (graph) await persistGraphTransition(client, graph, releasedAt)
      await client.query(`UPDATE "agent_outbox" SET "publishedAt" = NULL, "attemptCount" = "attemptCount" + 1, "lastError" = NULL
        WHERE "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $1 AND "aggregateId" = $2`,
      [`subagent-dispatch:${input.taskId}`, input.sessionId])
      return true
    })
  }
  async close(input: { taskId: string; sessionId: string; now: Date }): Promise<boolean> {
    return transaction(this.pool, async client => {
      const session = await client.query<{ userId: string }>(`SELECT "userId" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [input.sessionId])
      const userId = session.rows[0]?.userId
      if (!userId) return false
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId])
      const task = await client.query(`SELECT task."attemptCount" FROM "sub_agent_tasks" AS task
        WHERE task."id" = $1 AND task."sessionId" = $2
          AND task."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')`, [input.taskId, input.sessionId])
      if (!task.rows[0]) return false
      const graph = await prepareGraphTransition(client, { taskId: input.taskId, sessionId: input.sessionId, type: "task.closed", attemptCount: Number((task.rows[0] as Record<string, unknown>).attemptCount) })
      if (graph && "blocked" in graph) return false
      const result = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'closed', "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL, "nextAttemptAt" = NULL, "closedAt" = $3, "completedAt" = $3, "updatedAt" = $3
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')`, [input.taskId, input.sessionId, input.now])
      if (result.rowCount !== 1) return false
      if (graph) {
        await persistGraphTransition(client, graph, input.now)
        await reconcileGraphDependents(client, graph.scope, input.now)
      }
      return true
    })
  }

  async interruptTree(input: { sessionId: string; rootTaskId: string; now: Date }): Promise<number> { return interruptStoreTree(this.pool, input) }
  async interruptTurn(input: { userId: string; sessionId: string; turnId: string; now: Date }): Promise<number> { return interruptStoreTurn(this.pool, input) }
  async interruptSubtree(input: { sessionId: string; rootTaskId: string; targetPath: string; now: Date }): Promise<number> { return interruptStoreSubtree(this.pool, input) }
  async recoverExpired(input: { now: Date; limit: number }): Promise<SubagentTaskRecord[]> { return recoverStoreExpired(this.pool, input) }
}
class FinishFenceSignal extends Error {}
class DuplicateSpawnSignal extends Error {}
