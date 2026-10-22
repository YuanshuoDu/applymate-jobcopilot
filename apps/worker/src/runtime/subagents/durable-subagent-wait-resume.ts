import type pg from "pg"

import type { SubagentLease } from "./types.js"
import { assertLease, dateValue, DurableSubagentWaitError, object, parseIds, safeSubagentWaitJson, waitResult, type DurableSubagentWaitResult } from "./durable-subagent-wait-store.js"

type Queryable = Pick<pg.PoolClient, "query">
type Pool = Pick<pg.Pool, "connect">
type Row = Record<string, unknown>
type ResumeLease = Pick<SubagentLease, "id" | "userId" | "sessionId" | "turnId" | "rootTaskId" | "ownerId" | "attemptCount" | "leaseExpiresAt">
const OPEN_SESSION = `session."status" NOT IN ('aborted', 'archived')`
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])

export type DurableSubagentWaitResume = Readonly<{
  waitId: string; stepId: string; attempt: number; ordinal: number; toolCallId: string; sourceItemId: string; input: unknown; output: DurableSubagentWaitResult
}>
export type DurableSubagentWaitResumeCommitInput = Readonly<{ waitId: string; stepId: string; nextStepOrdinal: number; now?: Date }>

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

function exactTargets(ids: readonly string[], rows: readonly Row[], lease: ResumeLease): boolean {
  return ids.length > 0 && ids.length <= 8 && new Set(ids).size === ids.length && !ids.includes(lease.id)
    && rows.length === ids.length && rows.every(row => ids.includes(String(row.id)) && String(row.parentTaskId) === lease.id
      && String(row.rootTaskId) === lease.rootTaskId && String(row.turnId) === lease.turnId && String(row.sessionId) === lease.sessionId)
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\u0000") === [...right].sort().join("\u0000")
}

function strictIds(value: unknown): string[] | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!Array.isArray(parsed)) return undefined
  const ids: string[] = []
  for (const id of parsed) {
    if (typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 256) return undefined
    ids.push(id)
  }
  return new Set(ids).size === ids.length ? ids : undefined
}

function resolvedOutcome(wait: Row, ids: readonly string[], currentMatched: readonly string[], now: Date): DurableSubagentWaitResult {
  const stored = object(object(wait.result).outcome)
  const rowMatched = strictIds(wait.matchedTaskIds), storedMatched = strictIds(stored.matchedTaskIds)
  const storedIds = strictIds(stored.taskIds)
  const deadline = dateValue(wait.deadlineAt, "deadlineAt")
  const outcome = waitResult(wait)
  const modeIsValid = wait.mode === "any" || wait.mode === "all"
  const matchedIsValid = !!rowMatched && !!storedMatched && sameIds(rowMatched, storedMatched)
    && rowMatched.every(id => ids.includes(id) && currentMatched.includes(id))
  const readyIsValid = wait.status !== "ready" || (!!rowMatched && (wait.mode === "any" ? rowMatched.length > 0 : rowMatched.length === ids.length))
  const timeoutIsValid = wait.status !== "timed_out" || now >= deadline
  if (stored.waitId !== wait.id || stored.status !== wait.status || !storedIds || !sameIds(storedIds, ids)
    || dateValue(stored.deadlineAt, "outcome.deadlineAt").getTime() !== deadline.getTime()
    || !modeIsValid || !matchedIsValid || !readyIsValid || !timeoutIsValid
    || outcome.status !== wait.status || !sameIds(outcome.taskIds, ids) || outcome.tasks.length !== ids.length
    || !sameIds(outcome.tasks.map(task => task.taskId), ids) || !sameIds(outcome.matchedTaskIds, rowMatched ?? [])) {
    throw new DurableSubagentWaitError("wait_scope_error", "Persisted child wait result is invalid")
  }
  return outcome
}

function validReceipt(content: unknown, wait: Row, ids: readonly string[], toolCallId: string): boolean {
  const result = object(content), receipt = object(result.output)
  if (!receipt || result.toolCallId !== toolCallId || result.errorCode !== null && result.errorCode !== undefined
    || receipt.waitId !== wait.id || receipt.status !== "waiting"
    || !Array.isArray(receipt.tasks) || receipt.tasks.length !== ids.length || !sameIds(parseIds(receipt.taskIds), ids)
    || parseIds(receipt.matchedTaskIds).length !== 0) return false
  const tasks = receipt.tasks.filter((task): task is Record<string, unknown> => !!task && typeof task === "object" && !Array.isArray(task))
  if (tasks.length !== ids.length || !sameIds(tasks.map(task => String(task.taskId)), ids)) return false
  try { return dateValue(receipt.deadlineAt, "receipt.deadlineAt").getTime() === dateValue(wait.deadlineAt, "deadlineAt").getTime() }
  catch { return false }
}

function matchingWaitCall(value: unknown, wait: Row, ids: readonly string[]): string | undefined {
  const call = object(value), input = object(call.input), request = object(object(wait.result).request)
  const toolCallId = typeof call.toolCallId === "string" ? call.toolCallId : ""
  if (!toolCallId || call.toolName !== "wait_subagents" || input.idempotencyKey !== wait.idempotencyKey
    || input.mode !== wait.mode || request.mode !== wait.mode || Number(input.timeoutMs) !== Number(request.timeoutMs)
    || !sameIds(parseIds(input.taskIds), ids) || !sameIds(parseIds(request.targetTaskIds), ids)) return undefined
  return toolCallId
}

/** Loads the persisted wait outcome only while the exact child lease and waiting step remain current. */
export async function loadDurableSubagentWaitResume(pool: Pool, lease: ResumeLease, now = new Date()): Promise<DurableSubagentWaitResume | undefined> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new DurableSubagentWaitError("wait_invalid", "Resume clock is invalid")
  return transaction(pool, lease.userId, async client => {
    const task = (await client.query<Row>(`SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."status", task."attemptCount", task."leaseOwner", task."leaseExpiresAt", task."interruptRequestedAt", turn."status" AS "turnStatus", root."status" AS "rootStatus"
      FROM "sub_agent_tasks" AS task
      JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = $2
      JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = session."userId"
      JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
      WHERE task."id" = $1 AND task."sessionId" = $3 AND task."turnId" = $4 AND task."rootTaskId" = $5 AND ${OPEN_SESSION} FOR SHARE OF task`,
    [lease.id, lease.userId, lease.sessionId, lease.turnId, lease.rootTaskId])).rows[0]
    if (!task) return undefined
    assertLease(task, lease, now)
    if (task.parentTaskId === null || task.parentTaskId === undefined
      || ["completed", "failed", "interrupted", "cancelled", "closed"].includes(String(task.turnStatus))
      || ["completed", "failed", "interrupted", "cancelled", "closed"].includes(String(task.rootStatus))) return undefined

    const candidates = (await client.query<Row>(`SELECT step."id", step."taskId", step."attempt", step."ordinal", step."status" FROM "agent_steps" AS step
      JOIN "agent_wait_conditions" AS wait ON wait."stepId" = step."id" AND wait."sessionId" = step."sessionId" AND wait."turnId" = step."turnId" AND wait."parentTaskId" = step."taskId"
      WHERE wait."userId" = $1 AND wait."sessionId" = $2 AND wait."turnId" = $3 AND wait."parentTaskId" = $4 AND wait."status" IN ('ready', 'timed_out')
        AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NULL AND step."attempt" = $5
        AND step."status" IN ('waiting_for_tool', 'completed') AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = wait."sessionId" AND ${OPEN_SESSION})
      ORDER BY step."ordinal" DESC, wait."createdAt" DESC, wait."id" DESC LIMIT 2 FOR SHARE OF step, wait`,
    [lease.userId, lease.sessionId, lease.turnId, lease.id, lease.attemptCount])).rows
    if (candidates.length === 0) return undefined
    if (candidates.length !== 1) throw new DurableSubagentWaitError("wait_conflict", "Multiple resolved waits match the current child attempt")
    const step = candidates[0]

    const waits = (await client.query<Row>(`SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey", "targetTaskIds", "mode", "status", "deadlineAt", "matchedTaskIds", "result", "suspendedAt", "consumedAt"
      FROM "agent_wait_conditions" WHERE "id" IN (
        SELECT wait."id" FROM "agent_wait_conditions" AS wait
        WHERE wait."userId" = $1 AND wait."sessionId" = $2 AND wait."turnId" = $3 AND wait."parentTaskId" = $4
          AND wait."stepId" = $5 AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NULL
        ORDER BY wait."createdAt" DESC, wait."id" DESC LIMIT 2)
        AND "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "parentTaskId" = $4 AND "stepId" = $5
        AND "suspendedAt" IS NOT NULL AND "consumedAt" IS NULL
        AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = "agent_wait_conditions"."sessionId" AND ${OPEN_SESSION})
      ORDER BY "createdAt" DESC, "id" DESC FOR SHARE`,
    [lease.userId, lease.sessionId, lease.turnId, lease.id, step.id])).rows
    if (waits.length === 0) return undefined
    if (waits.length !== 1) throw new DurableSubagentWaitError("wait_conflict", "Multiple waits match the current child step")
    const wait = waits[0]
    if (wait.consumedAt !== null && wait.consumedAt !== undefined) return undefined
    if (!(wait.mode === "any" || wait.mode === "all") || !["ready", "timed_out"].includes(String(wait.status))) {
      throw new DurableSubagentWaitError("wait_scope_error", "Child wait is unresolved or invalid")
    }
    const ids = parseIds(wait.targetTaskIds)
    const targets = (await client.query<Row>(`SELECT task."id", task."parentTaskId", task."rootTaskId", task."turnId", task."sessionId", task."status", task."role", task."result", task."failureReason"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
        AND session."userId" = $5 AND task."parentTaskId" = $6 AND ${OPEN_SESSION} FOR SHARE OF task`,
    [ids, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId, lease.id])).rows
    if (!exactTargets(ids, targets, lease)) throw new DurableSubagentWaitError("wait_scope_error", "Child wait targets changed scope")
    const currentMatched = targets.filter(target => TERMINAL.has(String(target.status))).map(target => String(target.id))
    const outcome = resolvedOutcome(wait, ids, currentMatched, now)
    const callRows = (await client.query<Row>(`SELECT "id" AS "callItemId", "content" AS "callContent", "status" AS "callStatus" FROM "agent_items"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4
        AND "type" = 'tool_call' AND "content"->>'toolName' = 'wait_subagents'
      ORDER BY "createdAt" DESC, "id" DESC LIMIT 2 FOR SHARE`,
    [lease.sessionId, lease.turnId, lease.id, step.id])).rows
    if (callRows.length !== 1 || !["started", "streaming", "completed"].includes(String(callRows[0].callStatus))) {
      throw new DurableSubagentWaitError("wait_scope_error", "Child wait tool call is unavailable")
    }
    const call = object(callRows[0].callContent); const input = object(call.input)
    const toolCallId = matchingWaitCall(call, wait, ids)
    const resultRows = toolCallId ? (await client.query<Row>(`SELECT "id", "content", "status" FROM "agent_items"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4 AND "type" = 'tool_result' AND "content"->>'toolCallId' = $5
      ORDER BY "createdAt" DESC, "id" DESC LIMIT 2 FOR SHARE`, [lease.sessionId, lease.turnId, lease.id, step.id, toolCallId])).rows : []
    if (!toolCallId || resultRows.length > 1 || resultRows.length === 1 && (callRows[0].callStatus !== "completed"
      || resultRows[0].status !== "completed" || !validReceipt(resultRows[0].content, wait, ids, toolCallId))) {
      throw new DurableSubagentWaitError("wait_scope_error", "Child wait tool call does not match the durable wait")
    }
    const ordinal = Number(step.ordinal)
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new DurableSubagentWaitError("wait_scope_error", "Child wait step ordinal is invalid")
    return { waitId: String(wait.id), stepId: String(step.id), attempt: lease.attemptCount, ordinal, toolCallId,
      sourceItemId: String(resultRows[0]?.id ?? `recovered-wait-result:${String(wait.id)}`),
      input: safeSubagentWaitJson(input, 16_384), output: safeSubagentWaitJson(outcome, 16_384) as DurableSubagentWaitResult }
  })
}

/** Acknowledges only after the resumed step and its exact durable tool result can be read back. */
export async function commitDurableSubagentWaitResume(pool: Pool, lease: ResumeLease, input: DurableSubagentWaitResumeCommitInput): Promise<boolean> {
  const now = input.now ?? new Date()
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !Number.isSafeInteger(input.nextStepOrdinal) || input.nextStepOrdinal < 1
    || !input.waitId.trim() || !input.stepId.trim()) throw new DurableSubagentWaitError("wait_invalid", "Resume acknowledgement is invalid")
  return transaction(pool, lease.userId, async client => {
    const session = (await client.query<Row>(`SELECT "id", "userId", "status" FROM "agent_sessions"
      WHERE "id" = $1 AND "userId" = $2 AND ${OPEN_SESSION} FOR UPDATE`, [lease.sessionId, lease.userId])).rows[0]
    if (!session) throw new DurableSubagentWaitError("wait_scope_error", "Session is unavailable for resume acknowledgement")
    const task = (await client.query<Row>(`SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."status", task."attemptCount", task."leaseOwner", task."leaseExpiresAt", task."interruptRequestedAt", turn."status" AS "turnStatus", root."status" AS "rootStatus"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = $2
      JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = session."userId"
      JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
      WHERE task."id" = $1 AND task."sessionId" = $3 AND task."turnId" = $4 AND task."rootTaskId" = $5 AND ${OPEN_SESSION} FOR UPDATE OF task`,
    [lease.id, lease.userId, lease.sessionId, lease.turnId, lease.rootTaskId])).rows[0]
    if (!task) throw new DurableSubagentWaitError("wait_scope_error", "Child task is unavailable for resume acknowledgement")
    assertLease(task, lease, now)
    if (!task.parentTaskId || ["completed", "failed", "interrupted", "cancelled", "closed"].includes(String(task.turnStatus))
      || ["completed", "failed", "interrupted", "cancelled", "closed"].includes(String(task.rootStatus))) throw new DurableSubagentWaitError("wait_scope_error", "Child task tree is closed")

    const source = (await client.query<Row>(`SELECT "id", "ordinal", "attempt", "status" FROM "agent_steps"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "attempt" = $5 FOR SHARE`,
    [input.stepId, lease.sessionId, lease.turnId, lease.id, lease.attemptCount])).rows[0]
    if (!source || !["waiting_for_tool", "completed"].includes(String(source.status)) || Number(source.ordinal) + 1 !== input.nextStepOrdinal) {
      throw new DurableSubagentWaitError("wait_scope_error", "Source step does not precede the acknowledged resume step")
    }
    const wait = (await client.query<Row>(`SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey", "targetTaskIds", "mode", "status", "deadlineAt", "matchedTaskIds", "result", "suspendedAt", "consumedAt"
      FROM "agent_wait_conditions" WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 AND "turnId" = $4
        AND "parentTaskId" = $5 AND "stepId" = $6 AND "suspendedAt" IS NOT NULL AND "status" IN ('ready', 'timed_out')
        AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = "agent_wait_conditions"."sessionId" AND ${OPEN_SESSION}) FOR UPDATE`,
    [input.waitId, lease.userId, lease.sessionId, lease.turnId, lease.id, input.stepId])).rows[0]
    if (!wait) throw new DurableSubagentWaitError("wait_scope_error", "Resolved child wait is unavailable")
    const ids = parseIds(wait.targetTaskIds)
    const targets = (await client.query<Row>(`SELECT task."id", task."parentTaskId", task."rootTaskId", task."turnId", task."sessionId", task."status", task."role", task."result", task."failureReason"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
        AND session."userId" = $5 AND task."parentTaskId" = $6 AND ${OPEN_SESSION} FOR SHARE OF task`,
    [ids, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId, lease.id])).rows
    if (!exactTargets(ids, targets, lease)) throw new DurableSubagentWaitError("wait_scope_error", "Child wait targets changed scope")
    const currentMatched = targets.filter(target => TERMINAL.has(String(target.status))).map(target => String(target.id))
    const outcome = resolvedOutcome(wait, ids, currentMatched, now)
    const calls = (await client.query<Row>(`SELECT call."content" AS "callContent", call."status" AS "callStatus"
      FROM "agent_items" AS call JOIN "agent_wait_conditions" AS wait ON wait."id" = $6 AND wait."stepId" = call."stepId"
      WHERE call."sessionId" = $1 AND call."turnId" = $2 AND call."taskId" = $3 AND call."stepId" = $4
        AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
        AND wait."parentTaskId" = $3 AND wait."userId" = $5
      ORDER BY call."createdAt" DESC, call."id" DESC LIMIT 2 FOR UPDATE OF call`,
    [lease.sessionId, lease.turnId, lease.id, input.stepId, lease.userId, input.waitId])).rows
    if (calls.length !== 1 || !["started", "streaming", "completed"].includes(String(calls[0].callStatus))) {
      throw new DurableSubagentWaitError("wait_scope_error", "Resolved wait tool call is unavailable")
    }
    const call = object(calls[0].callContent); const toolCallId = matchingWaitCall(call, wait, ids)
    const results = toolCallId ? (await client.query<Row>(`SELECT "content", "status" FROM "agent_items"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4 AND "type" = 'tool_result' AND "content"->>'toolCallId' = $5
      ORDER BY "createdAt" DESC, "id" DESC LIMIT 2 FOR SHARE`, [lease.sessionId, lease.turnId, lease.id, input.stepId, toolCallId])).rows : []
    if (!toolCallId || results.length > 1 || results.length === 1 && (calls[0].callStatus !== "completed"
      || results[0].status !== "completed" || !validReceipt(results[0].content, wait, ids, toolCallId))) {
      throw new DurableSubagentWaitError("wait_scope_error", "Wait tool input does not match the acknowledged condition")
    }
    const next = (await client.query<Row>(`SELECT "id", "ordinal", "attempt", "status" FROM "agent_steps"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "attempt" = $4 AND "ordinal" = $5 FOR SHARE`,
    [lease.sessionId, lease.turnId, lease.id, lease.attemptCount, input.nextStepOrdinal])).rows[0]
    if (!next) {
      if (wait.consumedAt !== null && wait.consumedAt !== undefined) throw new DurableSubagentWaitError("wait_scope_error", "Acknowledged child wait has no continuation step")
      return false
    }
    if (wait.consumedAt !== null && wait.consumedAt !== undefined) return true
    const acknowledged = await client.query(`UPDATE "agent_wait_conditions" SET "consumedAt" = $1, "updatedAt" = $1
      WHERE "id" = $2 AND "userId" = $3 AND "sessionId" = $4 AND "turnId" = $5 AND "parentTaskId" = $6
        AND "stepId" = $7 AND "status" IN ('ready', 'timed_out') AND "consumedAt" IS NULL AND "suspendedAt" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = "agent_wait_conditions"."sessionId" AND ${OPEN_SESSION})`,
    [now, input.waitId, lease.userId, lease.sessionId, lease.turnId, lease.id, input.stepId])
    if (acknowledged.rowCount !== 1) throw new DurableSubagentWaitError("wait_scope_error", "Child wait acknowledgement was fenced")
    return true
  })
}
