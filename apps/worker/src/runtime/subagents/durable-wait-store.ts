import { randomUUID } from "node:crypto"
import type pg from "pg"

import type { DurableWaitPort, DurableWaitResult } from "../tools/coordination-types.js"

const MAX_WAIT_MS = 24 * 60 * 60 * 1_000
const MAX_TARGETS = 8
const ACTIVE_TASK_STATUSES = ["queued", "running", "retrying", "waiting", "waiting_for_user"] as const
const ACTIVE_TURN_STATUSES = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] as const
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])
type Pool = Pick<pg.Pool, "connect">
type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>

export type DurableWaitResolveInput = { readonly userId: string; readonly sessionId: string; readonly waitId: string; readonly now?: Date }
export type DurableWaitStore = DurableWaitPort & { resolve(input: DurableWaitResolveInput): Promise<DurableWaitResult | null> }

export class DurableWaitStoreError extends Error {
  constructor(readonly code: "wait_invalid" | "wait_scope_error" | "wait_conflict" | "wait_not_found", message: string) {
    super(message)
    this.name = "DurableWaitStoreError"
  }
}

function required(value: string | null | undefined, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new DurableWaitStoreError("wait_invalid", `${name} is required`)
  return value
}
function ids(value: unknown): string[] {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return [] } })() : value
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
}
function object(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return {} } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}
function date(value: unknown, name: string): Date {
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(parsed.getTime())) throw new DurableWaitStoreError("wait_scope_error", `${name} is invalid`)
  return parsed
}
function json(value: unknown): string { return JSON.stringify(value) }
function sameIds(left: readonly string[], right: readonly string[]): boolean { return [...left].sort().join("\u0000") === [...right].sort().join("\u0000") }
function result(row: Row): DurableWaitResult {
  return { waitId: String(row.id), status: String(row.status) as DurableWaitResult["status"], deadlineAt: date(row.deadlineAt, "deadlineAt").toISOString(), matchedTaskIds: ids(row.matchedTaskIds) }
}
async function transaction<T>(pool: Pool, userId: string, work: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect(); let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId])
    const value = await work(client)
    await client.query("COMMIT"); committed = true
    return value
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

function validateInput(input: Parameters<DurableWaitPort["wait"]>[0]): { parentTaskId: string; rootTaskId: string; targetTaskIds: string[]; now: Date } {
  const parentTaskId = required(input.taskId ?? input.rootTaskId, "parentTaskId")
  const rootTaskId = required(input.rootTaskId ?? parentTaskId, "rootTaskId")
  required(input.userId, "userId"); required(input.sessionId, "sessionId"); required(input.turnId, "turnId"); required(input.stepId, "stepId"); required(input.idempotencyKey, "idempotencyKey")
  if (!["any", "all"].includes(input.mode)) throw new DurableWaitStoreError("wait_invalid", "Wait mode is invalid")
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_WAIT_MS) throw new DurableWaitStoreError("wait_invalid", "Wait timeout exceeds the 24 hour limit")
  const targetTaskIds = [...input.targetTaskIds]
  if (targetTaskIds.length === 0 || targetTaskIds.length > MAX_TARGETS) throw new DurableWaitStoreError("wait_invalid", "Wait target count is invalid")
  if (new Set(targetTaskIds).size !== targetTaskIds.length) throw new DurableWaitStoreError("wait_invalid", "Wait targets must be unique")
  if (targetTaskIds.includes(parentTaskId)) throw new DurableWaitStoreError("wait_invalid", "A task cannot wait on itself")
  return { parentTaskId, rootTaskId, targetTaskIds: targetTaskIds.sort(), now: new Date() }
}

function ensureScope(row: Row | undefined, message: string): Row {
  if (!row) throw new DurableWaitStoreError("wait_scope_error", message)
  return row
}
function active(value: unknown, allowed: readonly string[]): boolean { return allowed.includes(String(value)) }
function waitReplay(row: Row, input: Parameters<DurableWaitPort["wait"]>[0], normalized: ReturnType<typeof validateInput>): DurableWaitResult {
  const createdAt = date(row.createdAt, "createdAt")
  const deadlineAt = date(row.deadlineAt, "deadlineAt")
  const request = object(object(row.result).request)
  const timeoutMs = typeof request.timeoutMs === "number" ? request.timeoutMs : deadlineAt.getTime() - createdAt.getTime()
  const storedTargets = Array.isArray(request.targetTaskIds) ? request.targetTaskIds.filter((value): value is string => typeof value === "string") : ids(row.targetTaskIds)
  const storedMode = typeof request.mode === "string" ? request.mode : String(row.mode)
  if (String(row.userId) !== input.userId || String(row.sessionId) !== input.sessionId || String(row.turnId) !== input.turnId || String(row.stepId) !== input.stepId
    || storedMode !== input.mode || timeoutMs !== input.timeoutMs || !sameIds(storedTargets, normalized.targetTaskIds)) {
    throw new DurableWaitStoreError("wait_conflict", "Wait idempotency key has conflicting payload")
  }
  return result(row)
}

export function createPgDurableWaitPort(pool: Pool): DurableWaitStore {
  async function wait(input: Parameters<DurableWaitPort["wait"]>[0]): Promise<DurableWaitResult> {
    const normalized = validateInput(input)
    return transaction(pool, input.userId, async client => {
      const parent = ensureScope((await client.query<Row>(`SELECT task."id", task."rootTaskId", task."turnId", task."sessionId", task."status", session."userId" AS "userId"
        FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        WHERE task."id" = $1 AND task."sessionId" = $2 AND session."userId" = $3 FOR UPDATE`, [normalized.parentTaskId, input.sessionId, input.userId])).rows[0], "Parent task is unavailable")
      if (String(parent.rootTaskId ?? parent.id) !== normalized.rootTaskId || String(parent.turnId ?? "") !== input.turnId) throw new DurableWaitStoreError("wait_scope_error", "Parent task is outside the wait scope")
      const turn = ensureScope((await client.query<Row>(`SELECT turn."id", turn."sessionId", turn."userId", turn."status", turn."rootTaskId"
        FROM "agent_turns" AS turn WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 FOR SHARE`, [input.turnId, input.sessionId, input.userId])).rows[0], "Turn is unavailable")
      if (turn.rootTaskId !== null && turn.rootTaskId !== undefined && String(turn.rootTaskId) !== normalized.rootTaskId) throw new DurableWaitStoreError("wait_scope_error", "Turn root is outside the wait scope")
      const step = await client.query<Row>(`SELECT "id", "taskId" FROM "agent_steps"
        WHERE "id" = $1 AND "turnId" = $2 AND "sessionId" = $3 AND ("taskId" = $4 OR ($4 = $5 AND "taskId" IS NULL)) FOR SHARE`, [input.stepId, input.turnId, input.sessionId, normalized.parentTaskId, normalized.rootTaskId])
      if (!step.rows[0]) throw new DurableWaitStoreError("wait_scope_error", "Step is outside the parent task scope")
      const targets = await client.query<Row>(`SELECT task."id", task."rootTaskId", task."turnId", task."sessionId", task."status", session."userId" AS "userId"
        FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND session."userId" = $3`, [normalized.targetTaskIds, input.sessionId, input.userId])
      if (targets.rows.length !== normalized.targetTaskIds.length) throw new DurableWaitStoreError("wait_scope_error", "A wait target is unavailable")
      for (const target of targets.rows) if (String(target.rootTaskId ?? target.id) !== normalized.rootTaskId || String(target.turnId ?? "") !== input.turnId || String(target.id) === normalized.parentTaskId) throw new DurableWaitStoreError("wait_scope_error", "Wait target is outside the task tree")
      const existing = await client.query<Row>(`SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey", "targetTaskIds", "mode", "status", "deadlineAt", "matchedTaskIds", "result", "createdAt"
        FROM "agent_wait_conditions" WHERE "parentTaskId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`, [normalized.parentTaskId, input.idempotencyKey])
      if (existing.rows[0]) return waitReplay(existing.rows[0], input, normalized)
      if (!active(parent.status, ACTIVE_TASK_STATUSES)) throw new DurableWaitStoreError("wait_scope_error", "Parent task is not active")
      if (!active(turn.status, ACTIVE_TURN_STATUSES)) throw new DurableWaitStoreError("wait_scope_error", "Turn is not active")
      const deadlineAt = new Date(normalized.now.getTime() + input.timeoutMs)
      const matchedTaskIds = targets.rows.filter(target => TERMINAL_TASK_STATUSES.has(String(target.status))).map(target => String(target.id)).sort()
      const status = normalized.now >= deadlineAt ? "timed_out" : (input.mode === "any" ? matchedTaskIds.length > 0 : matchedTaskIds.length === targets.rows.length) ? "ready" : "waiting"
      const inserted = await client.query<Row>(`INSERT INTO "agent_wait_conditions"
        ("id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey", "targetTaskIds", "mode", "status", "deadlineAt", "matchedTaskIds", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $14)
        ON CONFLICT ("parentTaskId", "idempotencyKey") DO NOTHING
        RETURNING "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey", "targetTaskIds", "mode", "status", "deadlineAt", "matchedTaskIds", "result", "createdAt"`,
      [`wait-${randomUUID()}`, input.userId, input.sessionId, input.turnId, normalized.parentTaskId, input.stepId, input.idempotencyKey, json(normalized.targetTaskIds), input.mode, status, deadlineAt, json(matchedTaskIds), json({ request: { targetTaskIds: normalized.targetTaskIds, mode: input.mode, timeoutMs: input.timeoutMs } }), normalized.now])
      if (inserted.rows[0]) return result(inserted.rows[0])
      const replay = await client.query<Row>(`SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey", "targetTaskIds", "mode", "status", "deadlineAt", "matchedTaskIds", "result", "createdAt"
        FROM "agent_wait_conditions" WHERE "parentTaskId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`, [normalized.parentTaskId, input.idempotencyKey])
      if (!replay.rows[0]) throw new DurableWaitStoreError("wait_conflict", "Wait idempotency record was lost")
      return waitReplay(replay.rows[0], input, normalized)
    })
  }

  async function resolve(input: DurableWaitResolveInput): Promise<DurableWaitResult | null> {
    required(input.userId, "userId"); required(input.sessionId, "sessionId"); required(input.waitId, "waitId")
    const now = input.now ?? new Date()
    return transaction(pool, input.userId, async client => {
      const locked = await client.query<Row>(`SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "targetTaskIds", "mode", "status", "deadlineAt", "matchedTaskIds", "result", "createdAt"
        FROM "agent_wait_conditions" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'waiting' FOR UPDATE SKIP LOCKED`, [input.waitId, input.sessionId, input.userId])
      if (!locked.rows[0]) {
        const current = await client.query<Row>(`SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "targetTaskIds", "mode", "status", "deadlineAt", "matchedTaskIds", "result", "createdAt"
          FROM "agent_wait_conditions" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [input.waitId, input.sessionId, input.userId])
        return current.rows[0] ? result(current.rows[0]) : null
      }
      const row = locked.rows[0]; const targetIds = ids(row.targetTaskIds)
      const targets = await client.query<Row>(`SELECT task."id", task."status" FROM "sub_agent_tasks" AS task
        JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND session."userId" = $3 FOR SHARE`, [targetIds, input.sessionId, input.userId])
      if (targets.rows.length !== targetIds.length) throw new DurableWaitStoreError("wait_scope_error", "A wait target is unavailable")
      const matchedTaskIds = targets.rows.filter(target => TERMINAL_TASK_STATUSES.has(String(target.status))).map(target => String(target.id)).sort()
      const deadlineAt = date(row.deadlineAt, "deadlineAt")
      const status = now >= deadlineAt ? "timed_out" : (String(row.mode) === "any" ? matchedTaskIds.length > 0 : matchedTaskIds.length === targetIds.length) ? "ready" : "waiting"
      const updated = await client.query<Row>(`UPDATE "agent_wait_conditions" SET "status" = $1, "matchedTaskIds" = $2::jsonb,
        "resolvedAt" = CASE WHEN $1 IN ('ready', 'timed_out') THEN COALESCE("resolvedAt", $3) ELSE "resolvedAt" END, "updatedAt" = $3
        WHERE "id" = $4 AND "sessionId" = $5 AND "userId" = $6 AND "status" = 'waiting' RETURNING "id", "status", "deadlineAt", "matchedTaskIds"`,
      [status, json(matchedTaskIds), now, input.waitId, input.sessionId, input.userId])
      return updated.rows[0] ? result(updated.rows[0]) : result({ ...row, status, matchedTaskIds })
    })
  }

  async function cancel(input: { userId: string; sessionId: string; taskId: string; reason: "interrupted" | "closed" }): Promise<void> {
    required(input.userId, "userId"); required(input.sessionId, "sessionId"); required(input.taskId, "taskId")
    const status = input.reason
    await transaction(pool, input.userId, async client => {
      const task = ensureScope((await client.query<Row>(`SELECT task."id", task."rootTaskId" FROM "sub_agent_tasks" AS task
        JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        WHERE task."id" = $1 AND task."sessionId" = $2 AND session."userId" = $3 FOR SHARE`, [input.taskId, input.sessionId, input.userId])).rows[0], "Cancel task is unavailable")
      const root = String(task.rootTaskId ?? task.id) === input.taskId
      const predicate = root
        ? `"parentTaskId" IN (SELECT "id" FROM "sub_agent_tasks" WHERE "sessionId" = $3 AND "rootTaskId" = $4)`
        : `"parentTaskId" = $4`
      await client.query(`UPDATE "agent_wait_conditions" SET "status" = $1, "resolvedAt" = COALESCE("resolvedAt", $2), "updatedAt" = $2
        WHERE "userId" = $5 AND "sessionId" = $3 AND "status" IN ('waiting', 'ready') AND ${predicate}`, [status, new Date(), input.sessionId, root ? input.taskId : input.taskId, input.userId])
    })
  }

  return { wait, resolve, cancel }
}

/** Compatibility name for callers that prefer the repository terminology. */
export const createPgDurableWaitStore = createPgDurableWaitPort
