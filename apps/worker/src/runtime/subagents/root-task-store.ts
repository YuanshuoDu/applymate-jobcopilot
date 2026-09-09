import type pg from "pg"

import type { TurnEngineResult } from "../turns/turn-engine-types.js"
import type { TurnLease } from "../turns/lease.js"
import type { PgSubagentPool, SubagentTaskRecord, SubagentTaskStatus } from "./types.js"

export type RootTaskStore = {
  ensure(input: { lease: TurnLease; goal: string; modelProfileSnapshot?: unknown; toolPolicySnapshot?: unknown; budgetSnapshot?: unknown; allowedActions?: readonly string[]; now?: Date }): Promise<SubagentTaskRecord>
  finish(input: { lease: TurnLease; rootTaskId: string; result: TurnEngineResult; now?: Date }): Promise<void>
}

type Row = Record<string, unknown>

function json(value: unknown, fallback: unknown, field = "snapshot"): string {
  const candidate = value ?? fallback
  if (containsSecret(candidate)) throw new Error(`${field}_contains_secret`)
  let encoded: string | undefined
  try { encoded = JSON.stringify(candidate) } catch { throw new Error(`${field}_invalid`) }
  if (!encoded) throw new Error(`${field}_invalid`)
  return encoded
}

function containsSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecret)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([key, child]) => /api.?key|secret|password|(?:access|refresh).?token|authorization/i.test(key) || containsSecret(child))
}

function date(value: unknown): Date | null {
  if (!value) return null
  const result = value instanceof Date ? new Date(value) : new Date(String(value))
  return Number.isNaN(result.getTime()) ? null : result
}

function task(row: Row): SubagentTaskRecord {
  return {
    id: String(row.id), userId: String(row.userId), sessionId: String(row.sessionId), turnId: row.turnId ? String(row.turnId) : null,
    rootTaskId: String(row.rootTaskId ?? row.id), parentTaskId: row.parentTaskId ? String(row.parentTaskId) : null,
    path: String(row.path), depth: Number(row.depth), role: String(row.role), taskType: String(row.taskType), status: String(row.status) as SubagentTaskStatus,
    goal: String(row.goal), constraints: row.constraints, successCriteria: row.successCriteria, allowedActions: row.allowedActions,
    context: row.context, expectedOutputSchema: row.expectedOutputSchema, result: row.result ?? null, failureReason: row.failureReason ? String(row.failureReason) : null,
    attemptCount: Number(row.attemptCount), maxAttempts: Number(row.maxAttempts), leaseOwner: row.leaseOwner ? String(row.leaseOwner) : null,
    leaseExpiresAt: date(row.leaseExpiresAt), interruptRequestedAt: date(row.interruptRequestedAt), budgetSnapshot: row.budgetSnapshot, toolPolicySnapshot: row.toolPolicySnapshot,
  }
}

async function transaction<T>(pool: PgSubagentPool, userId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const result = await work(client)
    await client.query("COMMIT")
    committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

const SELECT_ROOT = `SELECT task.*, session."userId" AS "userId"
  FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId"
  WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3`

function status(result: TurnEngineResult): Extract<SubagentTaskStatus, "completed" | "failed" | "interrupted" | "waiting" | "waiting_for_user"> {
  if (result.status === "completed") return "completed"
  if (result.status === "interrupted") return "interrupted"
  if (result.status === "waiting_for_user" || result.status === "waiting_for_approval") return "waiting_for_user"
  if (result.status === "waiting_for_dependency") return "waiting"
  return "failed"
}

export function createPgRootTaskStore(pool: PgSubagentPool): RootTaskStore {
  return {
    async ensure(input): Promise<SubagentTaskRecord> {
      const { lease } = input
      return transaction(pool, lease.userId, async (client) => {
        const now = input.now ?? new Date()
        const turn = await client.query<{ rootTaskId: string | null }>(
          `SELECT "rootTaskId" FROM "agent_turns"
           WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3
             AND "leaseOwnerId" = $4 AND "leaseVersion" = $5 AND "leaseExpiresAt" > $6 AND "status" = 'in_progress'
           FOR UPDATE`,
          [lease.turnId, lease.sessionId, lease.userId, lease.ownerId, lease.leaseVersion, now],
        )
        if (!turn.rows[0]) throw new Error("root_turn_not_owned")
        const existingId = turn.rows[0].rootTaskId
        if (existingId) {
          const existing = await client.query<Row>(`${SELECT_ROOT} FOR UPDATE`, [existingId, lease.sessionId, lease.turnId])
          if (!existing.rows[0]) throw new Error("root_task_missing")
          const rebound = await client.query(
            `UPDATE "sub_agent_tasks" SET "status" = 'running', "leaseOwner" = $1, "leaseExpiresAt" = $2,
               "failureReason" = NULL, "completedAt" = NULL, "updatedAt" = $3,
               "allowedActions" = $4::jsonb
             WHERE "id" = $5 AND "sessionId" = $6 AND "turnId" = $7 AND "rootTaskId" = $5
               AND "status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user', 'running')`,
            [lease.ownerId, lease.leaseExpiresAt, now, json(input.allowedActions, [], "allowed_actions"), existingId, lease.sessionId, lease.turnId],
          )
          if (rebound.rowCount !== 1) throw new Error("root_task_terminal")
          const current = await client.query<Row>(SELECT_ROOT, [existingId, lease.sessionId, lease.turnId])
          if (!current.rows[0]) throw new Error("root_task_missing")
          return task(current.rows[0])
        }

        const id = `root-${lease.turnId}`
        await client.query(
          `INSERT INTO "sub_agent_tasks"
           ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
            "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
            "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "startedAt", "updatedAt")
           VALUES ($1, $2, $3, $1, NULL, $4, 0, 'orchestrator', 'root', 'running', $5, '[]'::jsonb, '[]'::jsonb,
                   $6::jsonb, '{}'::jsonb, '{}'::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, 1, 1, $10, $11, $12, $12)`,
          [id, lease.sessionId, lease.turnId, `/${id}`, input.goal, json(input.allowedActions, [], "allowed_actions"), json(input.modelProfileSnapshot, {}, "model_profile"), json(input.toolPolicySnapshot, {}, "tool_policy"), json(input.budgetSnapshot, {}, "budget"), lease.ownerId, lease.leaseExpiresAt, now],
        )
        const linked = await client.query(
          `UPDATE "agent_turns" SET "rootTaskId" = $1
           WHERE "id" = $2 AND "sessionId" = $3 AND "userId" = $4 AND "leaseOwnerId" = $5 AND "leaseVersion" = $6`,
          [id, lease.turnId, lease.sessionId, lease.userId, lease.ownerId, lease.leaseVersion],
        )
        if (linked.rowCount !== 1) throw new Error("root_turn_fenced")
        const created = await client.query<Row>(SELECT_ROOT, [id, lease.sessionId, lease.turnId])
        if (!created.rows[0]) throw new Error("root_task_missing")
        return task(created.rows[0])
      })
    },
    async finish(input): Promise<void> {
      const now = input.now ?? new Date()
      const next = status(input.result)
      // A user wait transitions the Turn before this root settlement runs.
      // Keep every other result fenced to the active in-progress state.
      const waitState = input.result.status === "waiting_for_user"
      const result = JSON.stringify({ status: input.result.status, stepCount: input.result.stepCount, toolCallCount: input.result.toolCallCount, finalItemId: input.result.finalItemId ?? null })
      await transaction(pool, input.lease.userId, async (client) => {
        const ownedTurn = await client.query(
          `SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3
             AND "leaseOwnerId" = $4 AND "leaseVersion" = $5 AND "leaseExpiresAt" > $6
             AND ${waitState ? `"status" IN ('in_progress', 'waiting_for_user')` : `"status" = 'in_progress'`} FOR UPDATE`,
          [input.lease.turnId, input.lease.sessionId, input.lease.userId, input.lease.ownerId, input.lease.leaseVersion, now],
        )
        if (!ownedTurn.rows[0]) throw new Error("root_turn_fenced")
        const updated = await client.query(
          `UPDATE "sub_agent_tasks" SET "status" = $1, "result" = $2::jsonb,
           "failureReason" = $3, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
             "completedAt" = CASE WHEN $1 IN ('completed', 'failed', 'interrupted') THEN $4 ELSE NULL END, "updatedAt" = $4
           WHERE "id" = $5 AND "sessionId" = $6 AND "turnId" = $7 AND "rootTaskId" = $5
             AND "leaseOwner" = $8 AND "attemptCount" = 1 AND "leaseExpiresAt" > CURRENT_TIMESTAMP AND "status" = 'running'`,
          [next, result, input.result.errorCode ?? null, now, input.rootTaskId, input.lease.sessionId, input.lease.turnId, input.lease.ownerId],
        )
        if (updated.rowCount !== 1) throw new Error("root_task_fenced")
      })
    },
  }
}
