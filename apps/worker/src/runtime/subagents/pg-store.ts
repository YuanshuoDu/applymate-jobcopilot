import { randomUUID } from "node:crypto"
import type pg from "pg"
import { isTerminalSubagentStatus, PAUSE_DEFERRED_MARKER, type AtomicSubagentSpawnInput, type AtomicSubagentSpawnResult, type PgSubagentPool,
  type SubagentExecutionResult, type SubagentRetryDisposition, type SubagentStore, type SubagentTaskRecord, type SubagentTaskSpec, type SubagentPolicy } from "./types.js"
import { computeSubagentNextAttemptAt } from "./retry-policy.js"
import { persistGraphTransition, prepareGraphTransition, reconcileGraphDependents } from "./task-graph-pg-lifecycle.js"
import { handoffDurableSubagentWaitWithGraph, releaseDurableSubagentWaitWithGraph } from "./durable-subagent-wait-handoff.js"
import { assertSessionWorkAdmission, RUNNABLE_SESSION } from "../session-gate.js"
import { assertFallbackPlannerRootCanDispatch, createSubagentTask, lockSubagentSession, lockSubagentTurn, lockSubagentTurnForWork, readSubagentTask } from "./pg-store-create.js"
import { claimSubagentTask, heartbeatSubagentTask, leaseTimeAfterLock, matchesPublishedSubagentDispatch, taskGraphDeadlineLive } from "./pg-store-claim.js"
import type { SubagentDispatchIdentity } from "./dispatch-identity.js"
import { dateValue, json, rowToTask, SELECT_TASK, spawnKey, transaction, uniqueMessageIds } from "./pg-store-persistence.js"
import { findUnobservedMailboxMessageIds } from "./subagent-mailbox-completion.js"
import { interruptSubtree as interruptStoreSubtree, interruptTree as interruptStoreTree, interruptTurn as interruptStoreTurn, prepareTaskGraphFinish, recoverExpired as recoverStoreExpired } from "./pg-store-lifecycle.js"
import type { SubagentFinishResult } from "./types.js"
import { closeSubagentTask } from "./pg-store-close.js"
import { lockScheduledGateFinish } from "./pg-store-gate-finish.js"
import { recoverExpiredTaskGraphChildren } from "./pg-store-task-graph-deadline-recovery.js"
import { SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
export class PgSubagentTaskStore implements SubagentStore {
  constructor(private readonly pool: PgSubagentPool, private readonly leaseMs = 60_000) {}
  async get(taskId: string, sessionId: string): Promise<SubagentTaskRecord | null> {
    const client = await this.pool.connect()
    try { const result = await client.query(SELECT_TASK, [taskId, sessionId]); return result.rows[0] ? rowToTask(result.rows[0] as Record<string, unknown>) : null }
    finally { client.release() }
  }
  async create(input: SubagentTaskSpec & { policy: SubagentPolicy }): Promise<SubagentTaskRecord> {
    return transaction(this.pool, async client => {
      await lockSubagentSession(client, input)
      if (input.turnId) await lockSubagentTurnForWork(client, { sessionId: input.sessionId, userId: input.userId, turnId: input.turnId })
      else if (input.parentTaskId) throw new Error("Subagent child requires an owning Turn")
      await assertFallbackPlannerRootCanDispatch(client, input)
      return createSubagentTask(client, input, true)
    })
  }
  async createWithSpawn(input: AtomicSubagentSpawnInput): Promise<AtomicSubagentSpawnResult> {
    try {
      return await transaction(this.pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.userId])
        await lockSubagentSession(client, input)
        if (input.turnId) await lockSubagentTurn(client, { sessionId: input.sessionId, userId: input.userId, turnId: input.turnId })
        const key = spawnKey(input.sessionId, input.spawnIdempotencyKey)
        const existing = await client.query(`SELECT "payload" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.spawn' AND "aggregateId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`, [input.sessionId, key])
        if (existing.rows[0]) {
          const payload = existing.rows[0].payload as Record<string, unknown> | undefined
          const taskId = payload && typeof payload.taskId === "string" ? payload.taskId : null
          if (!taskId) throw new Error("Spawn idempotency record is invalid")
          return { task: await readSubagentTask(client, taskId, input.sessionId), duplicate: true }
        }
        if (input.turnId) await assertSessionWorkAdmission(client, { userId: input.userId, sessionId: input.sessionId, turnId: input.turnId })
        else if (input.parentTaskId) throw new Error("Subagent child requires an owning Turn")
        await assertFallbackPlannerRootCanDispatch(client, input)
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
  async claim(input: { taskId: string; sessionId: string; ownerId: string; policy: SubagentPolicy; now: Date; dispatchIdentity?: SubagentDispatchIdentity }): Promise<SubagentTaskRecord | null> {
    return claimSubagentTask(this.pool, input, this.leaseMs)
  }
  matchesPublishedDispatch(input: { payload: import("./types.js").SubagentJobPayload; dispatchIdentity: SubagentDispatchIdentity }): Promise<boolean> {
    return matchesPublishedSubagentDispatch(this.pool, input)
  }
  async heartbeat(input: { taskId: string; sessionId: string; ownerId: string; attemptCount: number; now: Date }): Promise<"renewed" | "interrupted" | "lost"> { return heartbeatSubagentTask(this.pool, input, this.leaseMs) }
  async finish(input: { taskId: string; sessionId: string; ownerId: string; attemptCount: number; status: SubagentExecutionResult["status"]; result?: unknown; failureReason?: string; retryDisposition?: SubagentRetryDisposition; mailboxMessageIds?: readonly string[]; now: Date }): Promise<SubagentFinishResult | null> {
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
          AND (task."absoluteDeadlineAt" IS NULL OR task."absoluteDeadlineAt" > clock_timestamp())
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
        if (row.taskType === SCHEDULED_GATE_TASK_TYPE && !await lockScheduledGateFinish(client, row, input)) return null
        const interrupted = row.interruptRequestedAt !== null && row.interruptRequestedAt !== undefined
        const retry = input.status === "failed" && !interrupted && input.retryDisposition !== "terminal" && Number(row.attemptCount) < Number(row.maxAttempts)
        let status = interrupted ? "interrupted" : retry ? "queued" : input.status
        let result = input.result
        let failureReason = input.failureReason
        const finish = await prepareTaskGraphFinish(client, {
          taskId: input.taskId, sessionId: input.sessionId, attemptCount: input.attemptCount,
          status, retry, failureReason, result, ownerId: input.ownerId, taskRole: String(row.role), taskType: String(row.taskType),
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
        const absoluteDeadlineAt = dateValue(lockedRow.absoluteDeadlineAt)
        if (!lockedExpiry || !finishAt || lockedExpiry <= finishAt
          || absoluteDeadlineAt && absoluteDeadlineAt <= finishAt) return null
        if (input.status === "waiting" && row.parentTaskId !== null && row.parentTaskId !== undefined) {
          const handoff = await handoffDurableSubagentWaitWithGraph(client, { lease: { id: input.taskId, userId: sessionRow.userId, sessionId: input.sessionId, turnId: String(row.turnId), rootTaskId: String(row.rootTaskId), ownerId: input.ownerId, attemptCount: input.attemptCount, leaseExpiresAt: lockedExpiry }, now: finishAt })
          if (handoff) {
            if ("blocked" in handoff) return null
            const closedSegment = await client.query(`UPDATE "sub_agent_tasks" SET "leaseSegmentStartedAt" = CASE WHEN "absoluteDeadlineAt" IS NOT NULL THEN NULL ELSE "leaseSegmentStartedAt" END
              WHERE "id" = $1 AND "sessionId" = $2 AND "attemptCount" = $3 AND "status" IN ('waiting', 'queued')
                AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL
                AND ("absoluteDeadlineAt" IS NULL OR "absoluteDeadlineAt" > clock_timestamp()) RETURNING "id"`,
            [input.taskId, input.sessionId, input.attemptCount])
            if (closedSegment.rowCount !== 1) throw new FinishFenceSignal()
            return "waiting"
          }
        }
        if (input.status === "completed" && !interrupted) {
          const missingMessageIds = await findUnobservedMailboxMessageIds(client, {
            sessionId: input.sessionId, taskId: input.taskId, attemptCount: input.attemptCount, observedMessageIds: mailboxMessageIds,
          })
          if (missingMessageIds.length > 0) return { status: "input_pending", messageIds: missingMessageIds }
        }
        const nextAttemptAt = retry ? computeSubagentNextAttemptAt(input.attemptCount, finishAt) : null
        const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = $3, "result" = $4::jsonb,
          "failureReason" = $5, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
          "leaseSegmentStartedAt" = CASE WHEN "absoluteDeadlineAt" IS NOT NULL THEN NULL ELSE "leaseSegmentStartedAt" END,
          "nextAttemptAt" = $10, "completedAt" = CASE WHEN $6 THEN $7::timestamp(3) ELSE NULL::timestamp(3) END,
          "updatedAt" = $7::timestamp(3)
          WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $8 AND "status" = 'running'
            AND "attemptCount" = $9 AND "leaseExpiresAt" > clock_timestamp()
            AND ("absoluteDeadlineAt" IS NULL OR "absoluteDeadlineAt" > clock_timestamp())
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
          await client.query(`UPDATE "agent_outbox" SET "publishedAt" = NULL, "attemptCount" = "attemptCount" + 1,
            "payload" = CASE WHEN "lastError" = $3 THEN jsonb_set("payload", '{ownerId}', to_jsonb($4::text), true) ELSE "payload" END,
            "lastError" = CASE WHEN "lastError" = $3 THEN "lastError" ELSE NULL END
            WHERE "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $1 AND "aggregateId" = $2`,
          [`subagent-dispatch:${input.taskId}`, input.sessionId, PAUSE_DEFERRED_MARKER, `retry-${randomUUID()}`])
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
        if (!await taskGraphDeadlineLive(client, input.taskId, input.sessionId)) throw new FinishFenceSignal()
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
    try {
      return await transaction(this.pool, async client => {
        const session = await client.query<{ userId: string }>(`SELECT "userId" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [input.sessionId])
        const userId = session.rows[0]?.userId
        if (!userId) return false
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId])
        const releasedAt = await leaseTimeAfterLock(client, input)
        if (!releasedAt) return false
        const waitRelease = await releaseDurableSubagentWaitWithGraph(client, { id: input.taskId, userId, sessionId: input.sessionId, ownerId: input.ownerId, attemptCount: input.attemptCount, now: releasedAt })
        if (waitRelease !== undefined) {
          if (!waitRelease) return false
          const closedSegment = await client.query(`UPDATE "sub_agent_tasks" SET "leaseSegmentStartedAt" = CASE WHEN "absoluteDeadlineAt" IS NOT NULL THEN NULL ELSE "leaseSegmentStartedAt" END
            WHERE "id" = $1 AND "sessionId" = $2 AND "attemptCount" = $3 AND "status" IN ('waiting', 'queued')
              AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL
              AND ("absoluteDeadlineAt" IS NULL OR "absoluteDeadlineAt" > clock_timestamp()) RETURNING "id"`,
          [input.taskId, input.sessionId, input.attemptCount])
          if (closedSegment.rowCount !== 1) throw new DeadlineFenceSignal()
          return true
        }
        const graph = await prepareGraphTransition(client, { taskId: input.taskId, sessionId: input.sessionId, type: "task.retrying", attemptCount: input.attemptCount })
        if (graph && "blocked" in graph) return false
        const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'queued', "nextAttemptAt" = NULL, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
            "leaseSegmentStartedAt" = CASE WHEN "absoluteDeadlineAt" IS NOT NULL THEN NULL ELSE "leaseSegmentStartedAt" END, "updatedAt" = $5
          WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $3 AND "attemptCount" = $4 AND "interruptRequestedAt" IS NULL
            AND "status" = 'running' AND "leaseExpiresAt" > clock_timestamp()
            AND ("absoluteDeadlineAt" IS NULL OR "absoluteDeadlineAt" > clock_timestamp())
            AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
              WHERE session."id" = "sub_agent_tasks"."sessionId" AND session."status" NOT IN ('aborted', 'archived'))`,
        [input.taskId, input.sessionId, input.ownerId, input.attemptCount, releasedAt])
        if (updated.rowCount !== 1) return false
        if (graph) await persistGraphTransition(client, graph, releasedAt)
        await client.query(`UPDATE "agent_outbox" SET "publishedAt" = NULL, "attemptCount" = "attemptCount" + 1,
          "payload" = CASE WHEN "lastError" = $3 THEN jsonb_set("payload", '{ownerId}', to_jsonb($4::text), true) ELSE "payload" END,
          "lastError" = CASE WHEN "lastError" = $3 THEN "lastError" ELSE NULL END WHERE "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $1 AND "aggregateId" = $2`,
        [`subagent-dispatch:${input.taskId}`, input.sessionId, PAUSE_DEFERRED_MARKER, `release-${randomUUID()}`])
        if (!await taskGraphDeadlineLive(client, input.taskId, input.sessionId)) throw new DeadlineFenceSignal()
        return true
      })
    } catch (error: unknown) {
      if (error instanceof DeadlineFenceSignal) return false
      throw error
    }
  }
  async close(input: { taskId: string; sessionId: string; now: Date }): Promise<boolean> { return closeSubagentTask(this.pool, input) }
  async interruptTree(input: { sessionId: string; rootTaskId: string; now: Date }): Promise<number> { return interruptStoreTree(this.pool, input) }
  async interruptTurn(input: { userId: string; sessionId: string; turnId: string; now: Date }): Promise<number> { return interruptStoreTurn(this.pool, input) }
  async interruptSubtree(input: { sessionId: string; rootTaskId: string; targetPath: string; now: Date }): Promise<number> { return interruptStoreSubtree(this.pool, input) }
  async recoverExpired(input: { now: Date; limit: number }): Promise<SubagentTaskRecord[]> {
    const deadlineRecovered = await recoverExpiredTaskGraphChildren(this.pool as unknown as pg.Pool, input.limit)
    const remaining = Math.max(0, input.limit - deadlineRecovered.length)
    const leaseRecovered = remaining ? await recoverStoreExpired(this.pool, { ...input, limit: remaining }) : []
    return [...deadlineRecovered, ...leaseRecovered]
  }
}
class FinishFenceSignal extends Error {}
class DeadlineFenceSignal extends Error {}
class DuplicateSpawnSignal extends Error {}
