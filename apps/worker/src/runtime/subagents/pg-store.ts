import { randomUUID } from "node:crypto"
import type pg from "pg"
import { PAUSE_DEFERRED_MARKER, type AtomicSubagentSpawnInput, type AtomicSubagentSpawnResult, type PgSubagentPool,
  type SubagentStore, type SubagentTaskRecord, type SubagentTaskSpec, type SubagentPolicy } from "./types.js"
import { persistGraphTransition, prepareGraphTransition, reconcileGraphDependents } from "./task-graph-pg-lifecycle.js"
import { releaseDurableSubagentWaitWithGraph } from "./durable-subagent-wait-handoff.js"
import { assertSessionWorkAdmission, RUNNABLE_SESSION } from "../session-gate.js"
import { assertFallbackPlannerRootCanDispatch, createSubagentTask, lockSubagentSession, lockSubagentTurn, lockSubagentTurnForWork, readSubagentTask } from "./pg-store-create.js"
import { claimSubagentTask, heartbeatSubagentTask, leaseTimeAfterLock, matchesPublishedSubagentDispatch, taskGraphDeadlineLive } from "./pg-store-claim.js"
import type { SubagentDispatchIdentity } from "./dispatch-identity.js"
import { dateValue, rowToTask, SELECT_TASK, spawnKey, transaction } from "./pg-store-persistence.js"
import { interruptSubtree as interruptStoreSubtree, interruptTree as interruptStoreTree, interruptTurn as interruptStoreTurn, recoverExpired as recoverStoreExpired } from "./pg-store-lifecycle.js"
import { closeSubagentTask } from "./pg-store-close.js"
import { createSubagentWithSpawnFromLease, persistSubagentSpawnOutbox } from "./pg-store-create-execution-scoped.js"
import { recoverExpiredTaskGraphChildren } from "./pg-store-task-graph-deadline-recovery.js"
import type { AtomicSubagentSpawnFromLeaseInput } from "./types.js"
import { finishSubagentTask, type FinishSubagentTaskInput } from "./pg-store-finish.js"
import { recoverExpiredNestedScoutChildren } from "./nested-scout-deadline-recovery.js"
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
        const outbox = await persistSubagentSpawnOutbox(client, input.sessionId, key, task)
        if (!outbox.operationCreated) throw new DuplicateSpawnSignal()
        return { task, duplicate: false }
      })
    } catch (error: unknown) {
      if (error instanceof DuplicateSpawnSignal) return { task: null, duplicate: true }
      throw error
    }
  }
  createWithSpawnFromLease(input: AtomicSubagentSpawnFromLeaseInput): Promise<AtomicSubagentSpawnResult> {
    return createSubagentWithSpawnFromLease(this.pool, input)
  }
  async claim(input: { taskId: string; sessionId: string; ownerId: string; policy: SubagentPolicy; now: Date; dispatchIdentity?: SubagentDispatchIdentity }): Promise<SubagentTaskRecord | null> {
    return claimSubagentTask(this.pool, input, this.leaseMs)
  }
  matchesPublishedDispatch(input: { payload: import("./types.js").SubagentJobPayload; dispatchIdentity: SubagentDispatchIdentity }): Promise<boolean> {
    return matchesPublishedSubagentDispatch(this.pool, input)
  }
  async heartbeat(input: { taskId: string; sessionId: string; ownerId: string; attemptCount: number; now: Date }): Promise<"renewed" | "interrupted" | "lost"> { return heartbeatSubagentTask(this.pool, input, this.leaseMs) }
  finish(input: FinishSubagentTaskInput) { return finishSubagentTask(this.pool, input) }
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
    const nestedRecovered = await recoverExpiredNestedScoutChildren(this.pool, input.limit)
    const deadlineLimit = Math.max(0, input.limit - nestedRecovered.length)
    const deadlineRecovered = deadlineLimit ? await recoverExpiredTaskGraphChildren(this.pool as unknown as pg.Pool, deadlineLimit) : []
    const remaining = Math.max(0, input.limit - nestedRecovered.length - deadlineRecovered.length)
    const leaseRecovered = remaining ? await recoverStoreExpired(this.pool, { ...input, limit: remaining }) : []
    return [...nestedRecovered, ...deadlineRecovered, ...leaseRecovered].slice(0, input.limit)
  }
}
class DeadlineFenceSignal extends Error {}
class DuplicateSpawnSignal extends Error {}
