import type pg from "pg"

import type { PgSubagentPool, SubagentTaskRecord } from "./types.js"

export type Queryable = Pick<pg.PoolClient, "query">

function containsSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecret)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([key, child]) => /api.?key|secret|password|(?:access|refresh).?token|authorization/i.test(key) || containsSecret(child))
}

export function json(value: unknown, fallback: unknown, field = "snapshot"): string {
  const candidate = value ?? fallback
  if (containsSecret(candidate)) throw new Error(`${field}_contains_secret`)
  try { return JSON.stringify(candidate) } catch { return JSON.stringify(fallback) }
}

function date(value: Date | string | null): Date | null {
  return value ? value instanceof Date ? value : new Date(value) : null
}

export function dateValue(value: unknown): Date | null {
  return value instanceof Date || typeof value === "string" ? date(value) : null
}

export function rowToTask(row: Record<string, unknown>): SubagentTaskRecord {
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

export async function transaction<T>(pool: PgSubagentPool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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

export const SELECT_TASK = `SELECT task.*, session."userId" AS "userId"
  FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId"
  WHERE task."id" = $1 AND task."sessionId" = $2`

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function actionList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []
}

export function uniqueMessageIds(ids: readonly string[] | undefined): string[] {
  return ids ? [...new Set(ids.filter(id => typeof id === "string" && id.length > 0))] : []
}

export function spawnKey(sessionId: string, key: string): string { return `coordination-spawn:${sessionId}:${key}` }

export const INSERT_TASK = `INSERT INTO "sub_agent_tasks" (
  "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status",
  "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema",
  "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $11::jsonb, $12::jsonb, $13::jsonb,
    $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb, 0, $19, CURRENT_TIMESTAMP)`
