import { randomUUID } from "node:crypto"
import type pg from "pg"

import {
  isTerminalSubagentStatus,
  SubagentLimitError,
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

type Queryable = Pick<pg.PoolClient, "query">

function containsSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecret)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([key, child]) => /api.?key|secret|password|(?:access|refresh).?token|authorization/i.test(key) || containsSecret(child))
}

function json(value: unknown, fallback: unknown, field = "snapshot"): string {
  const candidate = value ?? fallback
  if (containsSecret(candidate)) throw new Error(`${field}_contains_secret`)
  try { return JSON.stringify(candidate) } catch { return JSON.stringify(fallback) }
}

function date(value: Date | string | null): Date | null {
  return value ? value instanceof Date ? value : new Date(value) : null
}
function rowToTask(row: Record<string, unknown>): SubagentTaskRecord {
  return {
    id: String(row.id), userId: String(row.userId), sessionId: String(row.sessionId),
    turnId: row.turnId ? String(row.turnId) : null,
    rootTaskId: String(row.rootTaskId ?? row.id), parentTaskId: row.parentTaskId ? String(row.parentTaskId) : null,
    path: String(row.path), depth: Number(row.depth), role: String(row.role), taskType: String(row.taskType),
    status: String(row.status) as SubagentTaskRecord["status"], goal: String(row.goal),
    constraints: row.constraints, successCriteria: row.successCriteria, allowedActions: row.allowedActions,
    context: row.context, expectedOutputSchema: row.expectedOutputSchema, result: row.result ?? null,
    failureReason: row.failureReason ? String(row.failureReason) : null, attemptCount: Number(row.attemptCount),
    maxAttempts: Number(row.maxAttempts), nextAttemptAt: dateValue(row.nextAttemptAt), leaseOwner: row.leaseOwner ? String(row.leaseOwner) : null,
    leaseExpiresAt: dateValue(row.leaseExpiresAt), interruptRequestedAt: dateValue(row.interruptRequestedAt),
    modelProfileSnapshot: row.modelProfileSnapshot, budgetSnapshot: row.budgetSnapshot, toolPolicySnapshot: row.toolPolicySnapshot,
  }
}
async function transaction<T>(pool: PgSubagentPool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const value = await work(client)
    await client.query("COMMIT")
    return value
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
const SELECT_TASK = `SELECT task.*, session."userId" AS "userId"
  FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId"
  WHERE task."id" = $1 AND task."sessionId" = $2`

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
    return transaction(this.pool, client => this.createTask(client, input))
  }

  async createWithSpawn(input: AtomicSubagentSpawnInput): Promise<AtomicSubagentSpawnResult> {
    try {
      return await transaction(this.pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.userId])
        await this.lockSession(client, input)
        const existing = await client.query(`SELECT "payload" FROM "agent_outbox"
          WHERE "topic" = 'agent.subagent.spawn' AND "aggregateId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`,
        [input.sessionId, spawnKey(input.sessionId, input.spawnIdempotencyKey)])
        if (existing.rows[0]) {
          const payload = existing.rows[0].payload as Record<string, unknown> | undefined
          const taskId = payload && typeof payload.taskId === "string" ? payload.taskId : null
          if (!taskId) throw new Error("Spawn idempotency record is invalid")
          return { task: await this.read(client, taskId, input.sessionId), duplicate: true }
        }
        const task = await this.createTask(client, input, true)
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
      return this.read(client, input.taskId, input.sessionId)
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
    const client = await this.pool.connect()
    try {
      const result = await client.query(`UPDATE "sub_agent_tasks" SET
        "interruptRequestedAt" = COALESCE("interruptRequestedAt", $3),
        "status" = CASE WHEN "status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN 'interrupted' ELSE "status" END,
        "nextAttemptAt" = CASE WHEN "status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN NULL ELSE "nextAttemptAt" END,
        "completedAt" = CASE WHEN "status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN $3 ELSE "completedAt" END,
        "updatedAt" = $3 WHERE "sessionId" = $1 AND "rootTaskId" = $2
          AND "status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')`, [input.sessionId, input.rootTaskId, input.now])
      return result.rowCount ?? 0
    } finally { client.release() }
  }

  async interruptTurn(input: { userId: string; sessionId: string; turnId: string; now: Date }): Promise<number> {
    const client = await this.pool.connect()
    try {
      const result = await client.query(`UPDATE "sub_agent_tasks" AS task SET
        "interruptRequestedAt" = COALESCE(task."interruptRequestedAt", $4),
        "status" = CASE WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN 'interrupted' ELSE task."status" END,
        "nextAttemptAt" = CASE WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN NULL ELSE task."nextAttemptAt" END,
        "completedAt" = CASE WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN $4 ELSE task."completedAt" END,
        "updatedAt" = $4
        FROM "agent_sessions" AS session
        WHERE task."sessionId" = $1 AND task."turnId" = $2 AND session."id" = task."sessionId"
          AND session."userId" = $3 AND task."status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')`,
      [input.sessionId, input.turnId, input.userId, input.now])
      return result.rowCount ?? 0
    } finally { client.release() }
  }

  async interruptSubtree(input: { sessionId: string; rootTaskId: string; targetPath: string; now: Date }): Promise<number> {
    return transaction(this.pool, async client => {
      const session = await client.query(`SELECT "id", "status" FROM "agent_sessions"
        WHERE "id" = $1 AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`, [input.sessionId])
      const sessionStatus = String(session.rows[0]?.status ?? "")
      if (!session.rows[0] || sessionStatus === "aborted" || sessionStatus === "archived") return 0
      const result = await client.query(`UPDATE "sub_agent_tasks" SET
        "interruptRequestedAt" = COALESCE("interruptRequestedAt", $4),
        "status" = CASE WHEN "status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN 'interrupted' ELSE "status" END,
        "nextAttemptAt" = CASE WHEN "status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN NULL ELSE "nextAttemptAt" END,
        "completedAt" = CASE WHEN "status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN $4 ELSE "completedAt" END,
        "updatedAt" = $4 WHERE "sessionId" = $1 AND "rootTaskId" = $2
          AND ("path" = $3 OR "path" LIKE $3 || '/%')
          AND "status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')`,
      [input.sessionId, input.rootTaskId, input.targetPath, input.now])
      return result.rowCount ?? 0
    })
  }

  async recoverExpired(input: { now: Date; limit: number }): Promise<SubagentTaskRecord[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) throw new RangeError("Recovery limit must be positive")
    return transaction(this.pool, async (client) => {
      const rows = await client.query(`${SELECT_RECOVERABLE} LIMIT $2 FOR UPDATE SKIP LOCKED`, [input.now, input.limit])
      const recovered: SubagentTaskRecord[] = []
      for (const row of rows.rows as Array<Record<string, unknown>>) {
        const sessionClosed = row.sessionStatus === "aborted" || row.sessionStatus === "archived"
        const interrupted = sessionClosed || row.interruptRequestedAt !== null
        const terminal = interrupted || Number(row.attemptCount) >= Number(row.maxAttempts)
        const status = terminal ? (interrupted ? "interrupted" : "failed") : "queued"
        const nextAttemptAt = terminal ? null : computeSubagentNextAttemptAt(Number(row.attemptCount), input.now)
        await client.query(`UPDATE "sub_agent_tasks" SET "status" = $3, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
          "nextAttemptAt" = $4, "completedAt" = CASE WHEN $5 THEN $6 ELSE NULL END, "updatedAt" = $6 WHERE "id" = $1 AND "sessionId" = $2`, [row.id, row.sessionId, status, nextAttemptAt, terminal, input.now])
        recovered.push({ ...rowToTask(row), status, nextAttemptAt, leaseOwner: null, leaseExpiresAt: null })
      }
      return recovered
    })
  }

  private async read(client: Queryable, taskId: string, sessionId: string): Promise<SubagentTaskRecord> {
    const result = await client.query(`${SELECT_TASK}`, [taskId, sessionId])
    if (!result.rows[0]) throw new Error("Subagent task disappeared")
    return rowToTask(result.rows[0] as Record<string, unknown>)
  }

  private async createTask(client: Queryable, input: SubagentTaskSpec & { policy: SubagentPolicy }, sessionLocked = false): Promise<SubagentTaskRecord> {
    if (!sessionLocked) await this.lockSession(client, input)
    const parent = input.parentTaskId
      ? await client.query(`SELECT "id", "rootTaskId", "path", "depth", "status", "allowedActions", "modelProfileSnapshot", "budgetSnapshot", "toolPolicySnapshot"
           FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 FOR UPDATE`, [input.parentTaskId, input.sessionId])
      : { rows: [] }
    if (input.parentTaskId && !parent.rows[0]) throw new Error("Parent task is unavailable")
    const parentRow = parent.rows[0] as Record<string, unknown> | undefined
    if (parentRow && isTerminalSubagentStatus(String(parentRow.status))) throw new Error("Parent task is terminal")
    const depth = parentRow ? Number(parentRow.depth) + 1 : 0
    if (depth > input.policy.maxDepth) throw new SubagentLimitError("depth", "Subagent depth limit reached")
    if (input.parentTaskId) {
      const children = await client.query(`SELECT COUNT(*)::int AS "count" FROM "sub_agent_tasks"
        WHERE "sessionId" = $1 AND "parentTaskId" = $2
          AND "status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')`, [input.sessionId, input.parentTaskId])
      if (Number(children.rows[0]?.count ?? 0) >= input.policy.maxFanOut) throw new SubagentLimitError("fan_out", "Subagent fan-out limit reached")
    }
    const id = `subagent-${randomUUID()}`
    const rootTaskId = parentRow ? String(parentRow.rootTaskId ?? input.parentTaskId) : id
    const path = parentRow ? `${String(parentRow.path).replace(/\/$/, "")}/${id}` : `/${id}`
    // Tree step limits are shared through AgentTreeBudgetReservation; copying
    // the parent snapshot here would create a second spendable allowance.
    const budget = { subagentPolicy: input.policy }
    const toolPolicy = parentRow ? asObject(parentRow.toolPolicySnapshot) : asObject(input.toolPolicySnapshot)
    const inheritedModel = parentRow?.modelProfileSnapshot
    const modelProfile = parentRow ? (inheritedModel ?? input.modelProfileSnapshot ?? {}) : (input.modelProfileSnapshot ?? {})
    const parentActions = parentRow ? actionList(parentRow.allowedActions) : []
    const requestedActions = actionList(input.allowedActions)
    if (parentRow && requestedActions.some(action => !parentActions.includes(action))) throw new Error("Child allowed actions exceed parent policy")
    const allowedActions = parentRow && requestedActions.length === 0 ? parentActions : requestedActions
    const result = await client.query(`${INSERT_TASK} RETURNING "id"`, [
      id, input.sessionId, input.turnId ?? null, rootTaskId, input.parentTaskId ?? null, path, depth,
      input.role, input.taskType, input.goal, json(input.constraints, []), json(input.successCriteria, []),
      json(allowedActions, []), json(input.context, {}), json(input.expectedOutputSchema, {}),
      json(modelProfile, {}, "model_profile"), json(toolPolicy, {}, "tool_policy"), json(budget, {}, "budget"), input.policy.maxAttempts,
    ])
    if (!result.rows[0]?.id) throw new Error("Subagent task insert failed")
    return this.read(client, String(result.rows[0].id), input.sessionId)
  }

  private async lockSession(client: Queryable, input: { sessionId: string; userId: string }): Promise<void> {
    const session = await client.query(`SELECT "id", "status" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [input.sessionId, input.userId])
    const sessionStatus = String(session.rows[0]?.status ?? "")
    if (!session.rows[0] || sessionStatus === "aborted" || sessionStatus === "archived") throw new Error("Session is unavailable")
  }
}

class DuplicateSpawnSignal extends Error {}
class FinishFenceSignal extends Error {}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function actionList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []
}

function uniqueMessageIds(ids: readonly string[] | undefined): string[] {
  return ids ? [...new Set(ids.filter(id => typeof id === "string" && id.length > 0))] : []
}

function dateValue(value: unknown): Date | null {
  return value instanceof Date || typeof value === "string" ? date(value) : null
}

function spawnKey(sessionId: string, key: string): string { return `coordination-spawn:${sessionId}:${key}` }

const INSERT_TASK = `INSERT INTO "sub_agent_tasks" (
  "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status",
  "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema",
  "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $11::jsonb, $12::jsonb, $13::jsonb,
    $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb, 0, $19, CURRENT_TIMESTAMP)`

const SELECT_RECOVERABLE = `SELECT task.*, session."userId" AS "userId", session."status" AS "sessionStatus"
  FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId"
  WHERE task."status" = 'running'
    AND (session."status" IN ('aborted', 'archived') OR ${RUNNABLE_SESSION})
    AND (task."leaseExpiresAt" IS NULL OR task."leaseExpiresAt" <= $1)
    AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP)
  ORDER BY task."updatedAt" ASC, task."id" ASC`
