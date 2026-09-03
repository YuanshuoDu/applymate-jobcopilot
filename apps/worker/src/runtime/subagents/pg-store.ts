import { randomUUID } from "node:crypto"
import type pg from "pg"

import {
  isTerminalSubagentStatus,
  SubagentLimitError,
  type PgSubagentPool,
  type SubagentExecutionResult,
  type SubagentStore,
  type SubagentTaskRecord,
  type SubagentTaskSpec,
  type SubagentPolicy,
} from "./types.js"

type Queryable = Pick<pg.PoolClient, "query">

function json(value: unknown, fallback: unknown): string {
  try { return JSON.stringify(value ?? fallback) } catch { return JSON.stringify(fallback) }
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
    maxAttempts: Number(row.maxAttempts), leaseOwner: row.leaseOwner ? String(row.leaseOwner) : null,
    leaseExpiresAt: dateValue(row.leaseExpiresAt), interruptRequestedAt: dateValue(row.interruptRequestedAt),
    budgetSnapshot: row.budgetSnapshot, toolPolicySnapshot: row.toolPolicySnapshot,
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
    return transaction(this.pool, async (client) => {
      const session = await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [input.sessionId, input.userId])
      if (!session.rows[0]) throw new Error("Session is unavailable")
      const parent = input.parentTaskId
        ? await client.query(`SELECT "id", "rootTaskId", "path", "depth", "status", "budgetSnapshot", "toolPolicySnapshot"
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
      const inheritedBudget = parentRow ? asObject(parentRow.budgetSnapshot) : asObject(input.budgetSnapshot)
      const budget = { ...inheritedBudget, subagentPolicy: input.policy }
      const toolPolicy = parentRow ? asObject(parentRow.toolPolicySnapshot) : asObject(input.toolPolicySnapshot)
      const result = await client.query(`${INSERT_TASK} RETURNING "id"`, [
        id, input.sessionId, input.turnId ?? null, rootTaskId, input.parentTaskId ?? null, path, depth,
        input.role, input.taskType, input.goal, json(input.constraints, []), json(input.successCriteria, []),
        json(input.allowedActions, []), json(input.context, {}), json(input.expectedOutputSchema, {}),
        json(input.modelProfileSnapshot, {}), json(toolPolicy, {}), json(budget, {}), input.policy.maxAttempts,
      ])
      return this.read(client, result.rows[0].id, input.sessionId)
    })
  }

  async claim(input: { taskId: string; sessionId: string; ownerId: string; policy: SubagentPolicy; now: Date }): Promise<SubagentTaskRecord | null> {
    return transaction(this.pool, async (client) => {
      const session = await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [input.sessionId])
      if (!session.rows[0]) return null
      const running = await client.query(`SELECT COUNT(*)::int AS "count" FROM "sub_agent_tasks"
        WHERE "sessionId" = $1 AND "status" = 'running' AND "leaseExpiresAt" > $2`, [input.sessionId, input.now])
      if (Number(running.rows[0]?.count ?? 0) >= input.policy.maxConcurrency) return null
      const updated = await client.query(`UPDATE "sub_agent_tasks"
        SET "status" = 'running', "leaseOwner" = $3, "leaseExpiresAt" = $4 + ($5 * INTERVAL '1 millisecond'),
            "attemptCount" = "attemptCount" + 1, "startedAt" = COALESCE("startedAt", $4), "updatedAt" = $4
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'queued' AND "interruptRequestedAt" IS NULL
          AND "attemptCount" < "maxAttempts" AND ("leaseOwner" IS NULL OR "leaseExpiresAt" <= $4)`,
      [input.taskId, input.sessionId, input.ownerId, input.now, this.leaseMs])
      if (updated.rowCount !== 1) return null
      return this.read(client, input.taskId, input.sessionId)
    })
  }

  async heartbeat(input: { taskId: string; sessionId: string; ownerId: string; now: Date }): Promise<"renewed" | "interrupted" | "lost"> {
    const client = await this.pool.connect()
    try {
      const result = await client.query(`UPDATE "sub_agent_tasks"
        SET "leaseExpiresAt" = LEAST($4 + ($5 * INTERVAL '1 millisecond'),
          COALESCE("startedAt", $4) + (300000 * INTERVAL '1 millisecond')), "updatedAt" = $4
        WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $3 AND "status" = 'running'
          AND "leaseExpiresAt" > $4 RETURNING "interruptRequestedAt"`, [input.taskId, input.sessionId, input.ownerId, input.now, this.leaseMs])
      if (result.rowCount === 1) return result.rows[0].interruptRequestedAt ? "interrupted" : "renewed"
      const state = await client.query(`SELECT "interruptRequestedAt" FROM "sub_agent_tasks"
        WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $3 AND "status" = 'running'`, [input.taskId, input.sessionId, input.ownerId])
      return state.rows[0]?.interruptRequestedAt ? "interrupted" : "lost"
    } finally { client.release() }
  }

  async finish(input: { taskId: string; sessionId: string; ownerId: string; status: SubagentExecutionResult["status"]; result?: unknown; failureReason?: string; now: Date }): Promise<"completed" | "retrying" | "failed" | "waiting" | "waiting_for_user" | "interrupted" | null> {
    return transaction(this.pool, async (client) => {
      const task = await client.query(`${SELECT_TASK} FOR UPDATE`, [input.taskId, input.sessionId])
      const row = task.rows[0] as Record<string, unknown> | undefined
      if (!row || row.status !== "running" || row.leaseOwner !== input.ownerId) return null
      const interrupted = row.interruptRequestedAt !== null && row.interruptRequestedAt !== undefined
      const retry = input.status === "failed" && !interrupted && Number(row.attemptCount) < Number(row.maxAttempts)
      const status = interrupted ? "interrupted" : retry ? "queued" : input.status
      const terminal = isTerminalSubagentStatus(status)
      const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = $3, "result" = $4::jsonb,
        "failureReason" = $5, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
        "completedAt" = CASE WHEN $6 THEN $7 ELSE NULL END, "updatedAt" = $7
        WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $8 AND "status" = 'running'`,
      [input.taskId, input.sessionId, status, json(input.result, null), input.failureReason ?? null, terminal, input.now, input.ownerId])
      if (updated.rowCount !== 1) return null
      if (interrupted) return "interrupted"
      if (retry) return "retrying"
      return status as "completed" | "failed" | "waiting" | "waiting_for_user"
    })
  }

  async close(input: { taskId: string; sessionId: string; now: Date }): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      const result = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'closed', "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL, "closedAt" = $3, "completedAt" = $3, "updatedAt" = $3
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
        "completedAt" = CASE WHEN "status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN $3 ELSE "completedAt" END,
        "updatedAt" = $3 WHERE "sessionId" = $1 AND "rootTaskId" = $2
          AND "status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')`, [input.sessionId, input.rootTaskId, input.now])
      return result.rowCount ?? 0
    } finally { client.release() }
  }

  async recoverExpired(input: { now: Date; limit: number }): Promise<SubagentTaskRecord[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) throw new RangeError("Recovery limit must be positive")
    return transaction(this.pool, async (client) => {
      const rows = await client.query(`${SELECT_RECOVERABLE} FOR UPDATE SKIP LOCKED LIMIT $2`, [input.now, input.limit])
      const recovered: SubagentTaskRecord[] = []
      for (const row of rows.rows as Array<Record<string, unknown>>) {
        const terminal = row.interruptRequestedAt !== null || Number(row.attemptCount) >= Number(row.maxAttempts)
        const status = terminal ? (row.interruptRequestedAt !== null ? "interrupted" : "failed") : "queued"
        await client.query(`UPDATE "sub_agent_tasks" SET "status" = $3, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
          "completedAt" = CASE WHEN $4 THEN $5 ELSE NULL END, "updatedAt" = $5 WHERE "id" = $1 AND "sessionId" = $2`, [row.id, row.sessionId, status, terminal, input.now])
        recovered.push({ ...rowToTask(row), status, leaseOwner: null, leaseExpiresAt: null })
      }
      return recovered
    })
  }

  private async read(client: Queryable, taskId: string, sessionId: string): Promise<SubagentTaskRecord> {
    const result = await client.query(`${SELECT_TASK}`, [taskId, sessionId])
    if (!result.rows[0]) throw new Error("Subagent task disappeared")
    return rowToTask(result.rows[0] as Record<string, unknown>)
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function dateValue(value: unknown): Date | null {
  return value instanceof Date || typeof value === "string" ? date(value) : null
}

const INSERT_TASK = `INSERT INTO "sub_agent_tasks" (
  "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status",
  "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema",
  "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts")
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $11::jsonb, $12::jsonb, $13::jsonb,
    $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb, 0, $19)`

const SELECT_RECOVERABLE = `SELECT task.*, session."userId" AS "userId"
  FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId"
  WHERE task."status" = 'running' AND (task."leaseExpiresAt" IS NULL OR task."leaseExpiresAt" <= $1)
  ORDER BY task."updatedAt" ASC, task."id" ASC`
