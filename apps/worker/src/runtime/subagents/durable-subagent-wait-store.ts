import { randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"
import { redactSensitiveText } from "@jobcopilot/shared"
import type pg from "pg"
import type { SubagentLease } from "./types.js"

type Queryable = Pick<pg.PoolClient, "query">
type Pool = Pick<pg.Pool, "connect">
type Row = Record<string, unknown>
export type DurableSubagentWaitStatus = "waiting" | "ready" | "timed_out"
export type DurableSubagentWaitTask = Readonly<{ taskId: string; status: string; role: string; result: unknown; failureReason: string | null }>
export type DurableSubagentWaitResult = Readonly<{
  waitId: string; status: DurableSubagentWaitStatus; taskIds: readonly string[]; deadlineAt: string
  matchedTaskIds: readonly string[]; tasks: readonly DurableSubagentWaitTask[]
}>
export type RegisterDurableSubagentWaitInput = Readonly<{
  lease: SubagentLease; stepId: string; idempotencyKey: string; targetTaskIds: readonly string[]
  mode: "any" | "all"; timeoutMs: number; now?: Date
}>

const MAX_WAIT_MS = 24 * 60 * 60 * 1_000
const MAX_TARGETS = 8
const MAX_RESULT_BYTES = 512
const OPEN_SESSION = `session."status" NOT IN ('aborted', 'archived')`
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])

export class DurableSubagentWaitError extends Error {
  constructor(readonly code: "wait_invalid" | "wait_scope_error" | "wait_conflict", message: string) {
    super(message); this.name = "DurableSubagentWaitError"
  }
}

export function safeSubagentWaitJson(value: unknown, maxBytes = MAX_RESULT_BYTES): unknown {
  const clean = (item: unknown, seen = new Set<object>(), depth = 0): unknown => {
    if (item === null || typeof item === "boolean") return item
    if (typeof item === "string") return redactSensitiveText(item).slice(0, 2_000)
    if (typeof item === "number") return Number.isFinite(item) ? item : null
    if (!item || typeof item !== "object" || depth > 12 || seen.has(item)) return "[TRUNCATED]"
    seen.add(item)
    try {
      if (Array.isArray(item)) return item.slice(0, 64).map(child => clean(child, seen, depth + 1))
      const output: Record<string, unknown> = {}
      for (const key of Object.keys(item).sort().slice(0, 64)) {
        if (/api.?key|secret|password|(?:access|refresh).?token|authorization/i.test(key)) continue
        output[key] = clean((item as Record<string, unknown>)[key], seen, depth + 1)
      }
      return output
    } finally { seen.delete(item) }
  }
  const normalized = clean(value)
  const encoded = JSON.stringify(normalized)
  if (Buffer.byteLength(encoded, "utf8") <= maxBytes) return normalized
  const marker = { truncated: true, byteLength: Buffer.byteLength(encoded, "utf8"), preview: "" }
  let budget = Math.max(0, maxBytes - Buffer.byteLength(JSON.stringify(marker), "utf8") - 1)
  while (budget >= 0) {
    marker.preview = Array.from(encoded).reduce((result, character) => Buffer.byteLength(result + character, "utf8") <= budget ? result + character : result, "")
    if (Buffer.byteLength(JSON.stringify(marker), "utf8") <= maxBytes) return marker
    budget -= 32
  }
  return { truncated: true, byteLength: marker.byteLength, preview: "" }
}

export function projectDurableSubagentWait(row: Row, taskRows: readonly Row[], status: DurableSubagentWaitStatus, matchedTaskIds: readonly string[]): DurableSubagentWaitResult {
  const ids = parseIds(row.targetTaskIds)
  const byId = new Map(taskRows.map(task => [String(task.id), task]))
  return {
    waitId: String(row.id), status, taskIds: ids,
    deadlineAt: dateValue(row.deadlineAt, "deadlineAt").toISOString(), matchedTaskIds: [...matchedTaskIds].sort(),
    tasks: ids.map(taskId => {
      const task = byId.get(taskId)
      return {
        taskId, status: task ? safeText(task.status, 32) : "unknown", role: safeText(task?.role, 80),
        result: task?.result === null || task?.result === undefined ? null : safeSubagentWaitJson(task.result),
        failureReason: task?.failureReason === null || task?.failureReason === undefined ? null : safeText(task.failureReason, 256),
      }
    }),
  }
}

export function parseIds(value: unknown): string[] {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return [] } })() : value
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0) : []
}
export function dateValue(value: unknown, name: string): Date {
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(parsed.getTime())) throw new DurableSubagentWaitError("wait_scope_error", `${name} is invalid`)
  return parsed
}
export function waitResult(row: Row): DurableSubagentWaitResult {
  const raw = object(row.result).outcome
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const candidate = raw as Record<string, unknown>
    if (candidate.waitId === row.id && Array.isArray(candidate.tasks)) {
      const ids = parseIds(row.targetTaskIds)
      const savedTasks = candidate.tasks.filter((task): task is Record<string, unknown> => !!task && typeof task === "object" && !Array.isArray(task))
      const tasks = ids.map(taskId => {
        const task = savedTasks.find(item => item.taskId === taskId)
        return {
          taskId,
          status: safeText(task?.status, 32),
          role: safeText(task?.role, 80),
          result: task?.result === null || task?.result === undefined ? null : safeSubagentWaitJson(task.result, MAX_RESULT_BYTES),
          failureReason: task?.failureReason === null || task?.failureReason === undefined ? null : safeText(task.failureReason, 256),
        }
      })
      const status = ["waiting", "ready", "timed_out"].includes(String(row.status))
        ? String(row.status) as DurableSubagentWaitStatus : "waiting"
      return {
        waitId: String(row.id), status, taskIds: ids,
        deadlineAt: dateValue(row.deadlineAt, "deadlineAt").toISOString(),
        matchedTaskIds: parseIds(row.matchedTaskIds).sort(), tasks,
      }
    }
  }
  const status = ["waiting", "ready", "timed_out"].includes(String(row.status)) ? String(row.status) as DurableSubagentWaitStatus : "waiting"
  return projectDurableSubagentWait(row, [], status, parseIds(row.matchedTaskIds))
}
export function object(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}
export function safeText(value: unknown, max: number): string {
  return typeof value === "string" ? redactSensitiveText(value).slice(0, max) : "unknown"
}
export function required(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max) throw new DurableSubagentWaitError("wait_invalid", `${name} is invalid`)
  return value
}
export function assertLease(row: Row, lease: Pick<SubagentLease, "id" | "userId" | "sessionId" | "turnId" | "rootTaskId" | "ownerId" | "attemptCount">, now: Date): void {
  const expires = dateValue(row.leaseExpiresAt, "leaseExpiresAt")
  if (String(row.id) !== lease.id || String(row.userId) !== lease.userId || String(row.sessionId) !== lease.sessionId
    || String(row.turnId) !== lease.turnId || String(row.rootTaskId) !== lease.rootTaskId || row.status !== "running"
    || String(row.leaseOwner) !== lease.ownerId || Number(row.attemptCount) !== lease.attemptCount
    || row.interruptRequestedAt !== null && row.interruptRequestedAt !== undefined || expires <= now) {
    throw new DurableSubagentWaitError("wait_scope_error", "Child task lease is stale")
  }
}

async function transaction<T>(pool: Pool, userId: string, work: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect(); let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId])
    const result = await work(client)
    await client.query("COMMIT"); committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean { return [...left].sort().join("\u0000") === [...right].sort().join("\u0000") }
function replayMatches(row: Row, input: RegisterDurableSubagentWaitInput, ids: readonly string[]): boolean {
  const request = object(object(row.result).request)
  return String(row.userId) === input.lease.userId && String(row.sessionId) === input.lease.sessionId
    && String(row.turnId) === input.lease.turnId && String(row.parentTaskId) === input.lease.id && String(row.stepId) === input.stepId
    && String(row.idempotencyKey) === input.idempotencyKey && String(row.mode) === input.mode
    && Number(request.timeoutMs) === input.timeoutMs && sameIds(parseIds(request.targetTaskIds ?? row.targetTaskIds), ids)
}

export async function registerDurableSubagentWait(pool: Pool, input: RegisterDurableSubagentWaitInput): Promise<DurableSubagentWaitResult> {
  const lease = input.lease; const now = input.now ?? new Date()
  required(lease.id, "taskId"); required(lease.userId, "userId"); required(lease.sessionId, "sessionId")
  required(lease.turnId, "turnId"); required(lease.rootTaskId, "rootTaskId"); required(lease.ownerId, "ownerId")
  required(input.stepId, "stepId"); required(input.idempotencyKey, "idempotencyKey")
  if (!(input.mode === "any" || input.mode === "all") || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_WAIT_MS
    || !(now instanceof Date) || !Number.isFinite(now.getTime()) || !Array.isArray(input.targetTaskIds)) throw new DurableSubagentWaitError("wait_invalid", "Wait request is invalid")
  const targetIds = [...input.targetTaskIds]
  if (!targetIds.length || targetIds.length > MAX_TARGETS || targetIds.some(id => typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 256)
    || new Set(targetIds).size !== targetIds.length || targetIds.includes(lease.id)) throw new DurableSubagentWaitError("wait_invalid", "Wait targets are invalid")
  targetIds.sort()
  return transaction(pool, lease.userId, async client => {
    const session = (await client.query<Row>(`SELECT "id", "userId", "status" FROM "agent_sessions"
      WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`, [lease.sessionId, lease.userId])).rows[0]
    if (!session) throw new DurableSubagentWaitError("wait_scope_error", "Session is unavailable")
    const task = (await client.query<Row>(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."status", task."attemptCount", task."leaseOwner", task."leaseExpiresAt", task."interruptRequestedAt", session."userId" AS "userId", turn."status" AS "turnStatus", root."status" AS "rootStatus"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
      JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
      WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND session."userId" = $5
        AND ${OPEN_SESSION} FOR UPDATE OF task`, [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId])).rows[0]
    if (!task) throw new DurableSubagentWaitError("wait_scope_error", "Child task is unavailable")
    assertLease(task, lease, now)
    if (String(task.turnStatus).match(/^(completed|failed|interrupted|cancelled)$/) || String(task.rootStatus).match(/^(completed|failed|interrupted|cancelled|closed)$/)) throw new DurableSubagentWaitError("wait_scope_error", "Child task tree is closed")
    const step = (await client.query<Row>(`SELECT step."id", step."taskId", step."attempt", step."ordinal", step."status",
        (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."sessionId" = step."sessionId" AND current."turnId" = step."turnId" AND current."taskId" = step."taskId" AND current."attempt" = step."attempt") AS "latestOrdinal"
      FROM "agent_steps" AS step WHERE step."id" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND step."taskId" = $4 FOR SHARE OF step`,
    [input.stepId, lease.sessionId, lease.turnId, lease.id])).rows[0]
    if (!step || Number(step.attempt) !== lease.attemptCount || Number(step.ordinal) !== Number(step.latestOrdinal)
      || !["streaming", "waiting_for_tool"].includes(String(step.status))) throw new DurableSubagentWaitError("wait_scope_error", "Wait step is outside the current child attempt")
    const targets = (await client.query<Row>(`SELECT task."id", task."parentTaskId", task."rootTaskId", task."turnId", task."sessionId", task."status", task."role", task."result", task."failureReason", session."userId" AS "userId"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND session."userId" = $5
        AND task."parentTaskId" = $6 AND ${OPEN_SESSION} FOR SHARE OF task`, [targetIds, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId, lease.id])).rows
    if (targets.length !== targetIds.length || targets.some(target => String(target.parentTaskId) !== lease.id)) throw new DurableSubagentWaitError("wait_scope_error", "Every target must be an exact direct child")
    const existingRows = (await client.query<Row>(`SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey", "targetTaskIds", "mode", "status", "deadlineAt", "matchedTaskIds", "result", "createdAt"
      FROM "agent_wait_conditions" WHERE "parentTaskId" = $1 AND ("idempotencyKey" = $2 OR "stepId" = $3)
        AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = "agent_wait_conditions"."sessionId" AND ${OPEN_SESSION})
      ORDER BY "createdAt" DESC, "id" DESC LIMIT 2 FOR UPDATE`, [lease.id, input.idempotencyKey, input.stepId])).rows
    if (existingRows.length > 1) throw new DurableSubagentWaitError("wait_conflict", "Multiple waits already match this child step")
    const existing = existingRows[0]
    if (existing) {
      if (!replayMatches(existing, input, targetIds)) throw new DurableSubagentWaitError("wait_conflict", "Wait idempotency key has conflicting payload")
      return waitResult(existing)
    }
    const deadlineAt = new Date(now.getTime() + input.timeoutMs)
    const status: DurableSubagentWaitStatus = "waiting"
    const initial: Row = { id: randomUUID(), targetTaskIds: targetIds, deadlineAt, matchedTaskIds: [] }
    const result = { request: { targetTaskIds: targetIds, mode: input.mode, timeoutMs: input.timeoutMs }, outcome: projectDurableSubagentWait(initial, targets, status, []) }
    const inserted = await client.query<Row>(`INSERT INTO "agent_wait_conditions"
      ("id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey", "targetTaskIds", "mode", "status", "deadlineAt", "matchedTaskIds", "result", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $14)
      ON CONFLICT ("parentTaskId", "idempotencyKey") DO NOTHING
      RETURNING "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey", "targetTaskIds", "mode", "status", "deadlineAt", "matchedTaskIds", "result", "createdAt"`,
    [initial.id, lease.userId, lease.sessionId, lease.turnId, lease.id, input.stepId, input.idempotencyKey, JSON.stringify(targetIds), input.mode, status, deadlineAt, JSON.stringify([]), JSON.stringify(result), now])
    if (inserted.rows[0]) return waitResult(inserted.rows[0])
    const raced = (await client.query<Row>(`SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey", "targetTaskIds", "mode", "status", "deadlineAt", "matchedTaskIds", "result", "createdAt"
      FROM "agent_wait_conditions" WHERE "parentTaskId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`, [lease.id, input.idempotencyKey])).rows[0]
    if (!raced || !replayMatches(raced, input, targetIds)) throw new DurableSubagentWaitError("wait_conflict", "Concurrent wait registration conflicted")
    return waitResult(raced)
  })
}
