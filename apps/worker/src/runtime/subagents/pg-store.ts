import { randomUUID } from "node:crypto"

import {
  isTerminalSubagentStatus,
  type AtomicSubagentSpawnInput,
  type AtomicSubagentSpawnResult,
  type PgSubagentPool,
  type SubagentExecutionResult,
  type SubagentRetryDisposition,
  type SubagentStore,
  type SubagentTaskRecord,
  type SubagentTaskSpec,
  type SubagentPolicy,
} from "./types.js"
import { computeSubagentNextAttemptAt } from "./retry-policy.js"
import { isSessionControlGate, RUNNABLE_SESSION } from "../session-gate.js"
import { createSubagentTask, lockSubagentSession, readSubagentTask } from "./pg-store-create.js"
import {
  dateValue,
  json,
  rowToTask,
  SELECT_TASK,
  spawnKey,
  transaction,
  uniqueMessageIds,
} from "./pg-store-persistence.js"
import {
  interruptSubtree as interruptStoreSubtree,
  interruptTree as interruptStoreTree,
  interruptTurn as interruptStoreTurn,
  recoverExpired as recoverStoreExpired,
} from "./pg-store-lifecycle.js"

export class PgSubagentTaskStore implements SubagentStore {
  constructor(private readonly pool: PgSubagentPool, private readonly leaseMs = 60_000) {}

  async get(taskId: string, sessionId: string): Promise<SubagentTaskRecord | null> {
    const client = await this.pool.connect()
    try {
      const result = await client.query(SELECT_TASK, [taskId, sessionId])
      return result.rows[0] ? rowToTask(result.rows[0] as Record<string, unknown>) : null
    } finally { client.release() }
  }

  async create(input: SubagentTaskSpec & { policy: SubagentPolicy }): Promise<SubagentTaskRecord> {
    return transaction(this.pool, client => createSubagentTask(client, input))
  }

  async createWithSpawn(input: AtomicSubagentSpawnInput): Promise<AtomicSubagentSpawnResult> {
    try {
      return await transaction(this.pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.userId])
        await lockSubagentSession(client, input)
        const existing = await client.query(`SELECT "payload" FROM "agent_outbox"
          WHERE "topic" = 'agent.subagent.spawn' AND "aggregateId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`,
        [input.sessionId, spawnKey(input.sessionId, input.spawnIdempotencyKey)])
        if (existing.rows[0]) {
          const payload = existing.rows[0].payload as Record<string, unknown> | undefined
          const taskId = payload && typeof payload.taskId === "string" ? payload.taskId : null
          if (!taskId) throw new Error("Spawn idempotency record is invalid")
          return { task: await readSubagentTask(client, taskId, input.sessionId), duplicate: true }
        }
        const task = await createSubagentTask(client, input, true)
        const operation = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
          VALUES ($1, 'agent.subagent.spawn', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
        [`spawn-operation-${randomUUID()}`, input.sessionId, spawnKey(input.sessionId, input.spawnIdempotencyKey), JSON.stringify({ taskId: task.id })])
        if (operation.rowCount !== 1) throw new DuplicateSpawnSignal()
        await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
          VALUES ($1, 'agent.subagent.dispatch', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
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
      const session = await client.query<{ id: string; status: string; controlGate: unknown }>(`SELECT session."id", session."status", session."controlGate" FROM "agent_sessions" AS session
        WHERE session."id" = $1 AND ${RUNNABLE_SESSION} FOR UPDATE`, [input.sessionId])
      const sessionRow = session.rows[0]
      const sessionStatus = String(sessionRow?.status ?? "")
      if (!sessionRow || sessionStatus === "aborted" || sessionStatus === "archived" || !isSessionControlGate(sessionRow.controlGate) || sessionRow.controlGate !== "open") return null
      const running = await client.query(`SELECT COUNT(*)::int AS "count" FROM "sub_agent_tasks"
        WHERE "sessionId" = $1 AND "status" = 'running' AND "leaseExpiresAt" > CURRENT_TIMESTAMP`, [input.sessionId])
      if (Number(running.rows[0]?.count ?? 0) >= input.policy.maxConcurrency) return null
      const updated = await client.query(`UPDATE "sub_agent_tasks"
        SET "status" = 'running', "leaseOwner" = $3, "leaseExpiresAt" = CURRENT_TIMESTAMP + ($4 * INTERVAL '1 millisecond'),
            "attemptCount" = "attemptCount" + 1, "startedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP), "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'queued' AND "interruptRequestedAt" IS NULL
          AND "attemptCount" < "maxAttempts" AND ("leaseOwner" IS NULL OR "leaseExpiresAt" <= CURRENT_TIMESTAMP)
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= CURRENT_TIMESTAMP)
          AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
            WHERE session."id" = "sub_agent_tasks"."sessionId"
              AND ${RUNNABLE_SESSION})
          AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS root JOIN "agent_turns" AS turn ON turn."id" = root."turnId"
            WHERE root."id" = "sub_agent_tasks"."rootTaskId" AND root."sessionId" = "sub_agent_tasks"."sessionId"
              AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
              AND turn."id" = "sub_agent_tasks"."turnId" AND turn."sessionId" = "sub_agent_tasks"."sessionId"
              AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled'))`,
      [input.taskId, input.sessionId, input.ownerId, this.leaseMs])
      if (updated.rowCount !== 1) return null
      return readSubagentTask(client, input.taskId, input.sessionId)
    })
  }

  async heartbeat(input: { taskId: string; sessionId: string; ownerId: string; attemptCount: number; now: Date }): Promise<"renewed" | "interrupted" | "lost"> {
    return transaction(this.pool, async (client) => {
      const session = await client.query(`SELECT "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [input.sessionId])
      const sessionStatus = String(session.rows[0]?.status ?? "")
      if (!session.rows[0]) return "lost"
      if (sessionStatus === "aborted" || sessionStatus === "archived") return "interrupted"
      const result = await client.query(`UPDATE "sub_agent_tasks"
        SET "leaseExpiresAt" = LEAST(CURRENT_TIMESTAMP + ($4 * INTERVAL '1 millisecond'),
          COALESCE("startedAt", CURRENT_TIMESTAMP) + (300000 * INTERVAL '1 millisecond')), "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $3 AND "attemptCount" = $5 AND "status" = 'running'
          AND "leaseExpiresAt" > CURRENT_TIMESTAMP AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS root JOIN "agent_turns" AS turn ON turn."id" = root."turnId"
            WHERE root."id" = "sub_agent_tasks"."rootTaskId" AND root."sessionId" = "sub_agent_tasks"."sessionId"
              AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
              AND turn."id" = "sub_agent_tasks"."turnId" AND turn."sessionId" = "sub_agent_tasks"."sessionId"
              AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled'))
          AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
            WHERE session."id" = "sub_agent_tasks"."sessionId"
              AND session."status" NOT IN ('aborted', 'archived')) RETURNING "interruptRequestedAt"`, [input.taskId, input.sessionId, input.ownerId, this.leaseMs, input.attemptCount])
      if (result.rowCount === 1) return result.rows[0].interruptRequestedAt ? "interrupted" : "renewed"
      const state = await client.query(`SELECT task."interruptRequestedAt", session."status" AS "sessionStatus"
        FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        WHERE task."id" = $1 AND task."sessionId" = $2 AND task."leaseOwner" = $3 AND task."attemptCount" = $4 AND task."status" = 'running'
          AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS root JOIN "agent_turns" AS turn ON turn."id" = root."turnId"
            WHERE root."id" = task."rootTaskId" AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled'))`, [input.taskId, input.sessionId, input.ownerId, input.attemptCount])
      const currentSessionStatus = String(state.rows[0]?.sessionStatus ?? "")
      return currentSessionStatus === "aborted" || currentSessionStatus === "archived" || state.rows[0]?.interruptRequestedAt ? "interrupted" : "lost"
    })
  }

  async finish(input: { taskId: string; sessionId: string; ownerId: string; attemptCount: number; status: SubagentExecutionResult["status"]; result?: unknown; failureReason?: string; retryDisposition?: SubagentRetryDisposition; mailboxMessageIds?: readonly string[]; now: Date }): Promise<"completed" | "retrying" | "failed" | "waiting" | "waiting_for_user" | "interrupted" | null> {
    const mailboxMessageIds = uniqueMessageIds(input.mailboxMessageIds)
    try {
      return await transaction(this.pool, async (client) => {
        const task = await client.query(`${SELECT_TASK}
          AND task."status" = 'running' AND task."leaseOwner" = $3 AND task."attemptCount" = $4
          AND task."leaseExpiresAt" > CURRENT_TIMESTAMP
          AND session."status" NOT IN ('aborted', 'archived')
          AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS root JOIN "agent_turns" AS turn ON turn."id" = root."turnId"
            WHERE root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
              AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
              AND turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
              AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled'))
          FOR UPDATE OF task`, [input.taskId, input.sessionId, input.ownerId, input.attemptCount])
        const row = task.rows[0] as Record<string, unknown> | undefined
        if (!row || String(row.id) !== input.taskId || String(row.sessionId) !== input.sessionId
          || row.status !== "running" || row.leaseOwner !== input.ownerId || Number(row.attemptCount) !== input.attemptCount) return null
        const leaseExpiresAt = dateValue(row.leaseExpiresAt)
        if (!leaseExpiresAt || !Number.isFinite(leaseExpiresAt.getTime()) || leaseExpiresAt.getTime() <= input.now.getTime()) return null
        const interrupted = row.interruptRequestedAt !== null && row.interruptRequestedAt !== undefined
        const retry = input.status === "failed" && !interrupted && input.retryDisposition !== "terminal" && Number(row.attemptCount) < Number(row.maxAttempts)
        const status = interrupted ? "interrupted" : retry ? "queued" : input.status
        const terminal = isTerminalSubagentStatus(status)
        const nextAttemptAt = retry ? computeSubagentNextAttemptAt(input.attemptCount, input.now) : null
        const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = $3, "result" = $4::jsonb,
          "failureReason" = $5, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
          "nextAttemptAt" = $10, "completedAt" = CASE WHEN $6 THEN $7::timestamp(3) ELSE NULL::timestamp(3) END,
          "updatedAt" = $7::timestamp(3)
          WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $8 AND "status" = 'running'
            AND "attemptCount" = $9 AND "leaseExpiresAt" > CURRENT_TIMESTAMP
            AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
              WHERE session."id" = "sub_agent_tasks"."sessionId"
                AND session."status" NOT IN ('aborted', 'archived'))
            AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS root JOIN "agent_turns" AS turn ON turn."id" = root."turnId"
              WHERE root."id" = "sub_agent_tasks"."rootTaskId" AND root."sessionId" = "sub_agent_tasks"."sessionId"
                AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
                AND turn."id" = "sub_agent_tasks"."turnId" AND turn."sessionId" = "sub_agent_tasks"."sessionId"
                AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled'))`,
        [input.taskId, input.sessionId, status, json(input.result, null), input.failureReason ?? null, terminal, input.now, input.ownerId, input.attemptCount, nextAttemptAt])
        if (updated.rowCount !== 1) throw new FinishFenceSignal()
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
      const updated = await client.query(`UPDATE "sub_agent_tasks"
        SET "status" = 'queued', "nextAttemptAt" = NULL, "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = $5
        WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $3 AND "attemptCount" = $4
          AND "interruptRequestedAt" IS NULL AND "status" = 'running'
          AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
            WHERE session."id" = "sub_agent_tasks"."sessionId"
              AND session."status" NOT IN ('aborted', 'archived'))`,
      [input.taskId, input.sessionId, input.ownerId, input.attemptCount, input.now])
      if (updated.rowCount !== 1) return false
      await client.query(`UPDATE "agent_outbox" SET "publishedAt" = NULL, "attemptCount" = "attemptCount" + 1, "lastError" = NULL
        WHERE "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $1 AND "aggregateId" = $2`,
      [`subagent-dispatch:${input.taskId}`, input.sessionId])
      return true
    })
  }

  async close(input: { taskId: string; sessionId: string; now: Date }): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      const result = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'closed', "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL, "nextAttemptAt" = NULL, "closedAt" = $3, "completedAt" = $3, "updatedAt" = $3
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')`, [input.taskId, input.sessionId, input.now])
      return result.rowCount === 1
    } finally { client.release() }
  }

  async interruptTree(input: { sessionId: string; rootTaskId: string; now: Date }): Promise<number> {
    return interruptStoreTree(this.pool, input)
  }

  async interruptTurn(input: { userId: string; sessionId: string; turnId: string; now: Date }): Promise<number> {
    return interruptStoreTurn(this.pool, input)
  }

  async interruptSubtree(input: { sessionId: string; rootTaskId: string; targetPath: string; now: Date }): Promise<number> {
    return interruptStoreSubtree(this.pool, input)
  }

  async recoverExpired(input: { now: Date; limit: number }): Promise<SubagentTaskRecord[]> {
    return recoverStoreExpired(this.pool, input)
  }

}

class DuplicateSpawnSignal extends Error {}
class FinishFenceSignal extends Error {}
