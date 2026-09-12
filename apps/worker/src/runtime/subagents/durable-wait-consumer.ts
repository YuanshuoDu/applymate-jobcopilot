import { redactSensitiveText, redactSensitiveValue } from "@jobcopilot/shared"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type pg from "pg"
import type { TurnLease } from "../turns/lease.js"
type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type Projection = { readonly id: string; readonly content: RepositoryJsonValue }
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])
const MAX_RESULT_BYTES = 8 * 1024
const MAX_OUTCOME_BYTES = MAX_RESULT_BYTES
const MAX_TARGETS = 8
const MAX_ID_LENGTH = 256
const MAX_SUMMARY_BYTES = 1_000
const MAX_FAILURE_BYTES = 500
const FORBIDDEN_RESULT_KEYS = new Set([
  "id", "userid", "sessionid", "turnid", "stepid", "taskid", "parenttaskid", "roottaskid", "ownerid", "lease",
  "leaseownerid", "leaseversion", "idempotencykey", "capabilities", "permissions", "allowedcapabilities", "budgetlimit", "maxbudget",
])
type ResultInfo = { readonly value: RepositoryJsonValue; readonly bytes: number | null; readonly summary: string; readonly hasValue: boolean }
type TaskState = { readonly taskId: string; readonly status: string; readonly result: ResultInfo; readonly failureReason: string | null }
type OutcomeTask = { taskId: string; status: string; result: RepositoryJsonValue; failureReason: string | null }
type Outcome = { waitId: string; status: string; matchedTaskIds: string[]; targetTaskIds: string[]; tasks: OutcomeTask[] }
type PreparedOutcome = { readonly value: Outcome; readonly taskIds: string[]; readonly mode: "any" | "all" }
type Detail = { readonly kind: "result"; readonly index: number; readonly info: ResultInfo } | { readonly kind: "failure"; readonly index: number; readonly value: string }
export type DurableWaitConsumerInput = {
  readonly client: Queryable
  readonly lease: TurnLease
  readonly turn: Row
  readonly now: Date
}
function object(value: unknown): Row {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return {} } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {}
}
function ids(value: unknown): string[] {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return [] } })() : value
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : []
}
function date(value: unknown): Date | null { if (value === null || value === undefined) return null; const parsed = value instanceof Date ? value : new Date(String(value)); return Number.isFinite(parsed.getTime()) ? parsed : null }
function fence(input: DurableWaitConsumerInput): void {
  const { lease, turn, now } = input
  if (String(turn.id) !== lease.turnId || String(turn.userId) !== lease.userId || String(turn.sessionId) !== lease.sessionId
    || String(turn.status) !== "in_progress" || String(turn.leaseOwnerId) !== lease.ownerId
    || Number(turn.leaseVersion) !== lease.leaseVersion || (date(turn.leaseExpiresAt)?.getTime() ?? 0) <= now.getTime()) {
    throw new Error("wait_consume_turn_fenced")
  }
}
function parsed(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown } catch { return undefined } }
function record(value: unknown): Row | null { const candidate = parsed(value); return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as Row : null }
function safeText(value: unknown, fallback = ""): string { try { return typeof value === "string" ? value : String(value) } catch { return fallback } }
function encoded(value: unknown): { readonly text: string; readonly bytes: number } | null { try { const text = JSON.stringify(value); return text === undefined ? null : { text, bytes: Buffer.byteLength(text, "utf8") } } catch { return null } }
function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  const chars = Array.from(value)
  let low = 0; let high = chars.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(chars.slice(0, middle).join(""), "utf8") <= maxBytes) low = middle
    else high = middle - 1
  }
  return chars.slice(0, low).join("")
}
function stripIdentity(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (!value || typeof value !== "object") return value
  if (depth >= 8) return "[REDACTED]"
  if (seen.has(value)) throw new TypeError("circular result")
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(entry => stripIdentity(entry, depth + 1, seen))
    const result: Row = {}
    for (const [key, entry] of Object.entries(value)) if (!FORBIDDEN_RESULT_KEYS.has(key.toLowerCase())) result[key] = stripIdentity(entry, depth + 1, seen)
    return result
  } finally { seen.delete(value) }
}
function resultInfo(value: unknown): ResultInfo {
  if (value === null || value === undefined) return { value: null, bytes: 4, summary: "", hasValue: false }
  try {
    const safe = redactSensitiveValue(stripIdentity(value))
    const serialized = encoded(safe)
    if (!serialized) throw new TypeError("result is not JSON")
    return { value: safe, bytes: serialized.bytes, summary: utf8Prefix(redactSensitiveText(serialized.text), MAX_SUMMARY_BYTES), hasValue: true }
  } catch { return { value: null, bytes: null, summary: "Result unavailable", hasValue: true } }
}
function failure(value: unknown): string | null { if (value === null || value === undefined) return null; try { return utf8Prefix(redactSensitiveText(String(value)), MAX_FAILURE_BYTES) } catch { return null } }
function waitMode(value: unknown): "any" | "all" | null { return value === "any" || value === "all" ? value : null }
function waitStatus(value: unknown): "ready" | "timed_out" | null { return value === "ready" || value === "timed_out" ? value : null }
function taskStatus(value: unknown): string | null { const result = safeText(value); return result.length > 0 && result.length <= MAX_ID_LENGTH ? result : null }
function boundedIds(value: unknown, allowEmpty = false): string[] | null {
  const values = ids(value)
  if ((!allowEmpty && values.length === 0) || values.length > MAX_TARGETS || new Set(values).size !== values.length
    || values.some(id => id.trim() !== id || id.length > MAX_ID_LENGTH)) return null
  return [...values].sort()
}
function marker(info: ResultInfo, summaryBytes: number): RepositoryJsonValue {
  const result: { [key: string]: RepositoryJsonValue } = { truncated: true }
  if (info.bytes !== null) result.byteLength = info.bytes
  const summary = utf8Prefix(info.summary, summaryBytes); if (summary.length > 0) result.summary = summary
  return result
}
function preferredResult(info: ResultInfo): RepositoryJsonValue { return !info.hasValue ? null : info.bytes !== null && info.bytes <= MAX_RESULT_BYTES ? info.value : marker(info, MAX_SUMMARY_BYTES) }
function minimalResult(info: ResultInfo): RepositoryJsonValue { return info.hasValue ? { truncated: true } : null }
function taskVersion(outcome: Outcome, index: number, patch: Partial<OutcomeTask>): Outcome { return { ...outcome, tasks: outcome.tasks.map((task, taskIndex) => taskIndex === index ? { ...task, ...patch } : task) } }
function outcomeBytes(value: Outcome): number | null { return encoded(value)?.bytes ?? null }
function chooseResult(outcome: Outcome, index: number, info: ResultInfo, allowance: number): RepositoryJsonValue {
  const currentBytes = outcomeBytes(outcome) ?? MAX_OUTCOME_BYTES + 1
  const desired = preferredResult(info)
  const desiredBytes = outcomeBytes(taskVersion(outcome, index, { result: desired }))
  if (desiredBytes !== null && desiredBytes <= MAX_OUTCOME_BYTES && desiredBytes - currentBytes <= allowance) return desired
  let low = 0; let high = Math.min(MAX_SUMMARY_BYTES, Math.max(0, allowance)); let best = outcome.tasks[index]!.result
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = marker(info, middle)
    const candidateBytes = outcomeBytes(taskVersion(outcome, index, { result: candidate }))
    if (candidateBytes !== null && candidateBytes <= MAX_OUTCOME_BYTES && candidateBytes - currentBytes <= allowance) { best = candidate; low = middle + 1 }
    else high = middle - 1
  }
  return best
}
function chooseFailure(outcome: Outcome, index: number, value: string, allowance: number): string | null {
  const currentBytes = outcomeBytes(outcome) ?? MAX_OUTCOME_BYTES + 1
  const fullBytes = outcomeBytes(taskVersion(outcome, index, { failureReason: value }))
  if (fullBytes !== null && fullBytes <= MAX_OUTCOME_BYTES && fullBytes - currentBytes <= allowance) return value
  let low = 0; let high = Math.min(MAX_FAILURE_BYTES, Math.max(0, allowance)); let best: string | null = null
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = utf8Prefix(value, middle)
    const candidateBytes = outcomeBytes(taskVersion(outcome, index, { failureReason: candidate }))
    if (candidateBytes !== null && candidateBytes <= MAX_OUTCOME_BYTES && candidateBytes - currentBytes <= allowance) { best = candidate; low = middle + 1 }
    else high = middle - 1
  }
  return best
}
function makeOutcome(waitId: string, status: string, targetIds: string[], matchedIds: string[], states: readonly TaskState[], waitMode: "any" | "all"): PreparedOutcome | null {
  if (!waitId || waitId.trim() !== waitId || waitId.length > MAX_ID_LENGTH || !waitStatus(status) || targetIds.length === 0 || targetIds.length > MAX_TARGETS
    || new Set(targetIds).size !== targetIds.length || matchedIds.some(id => !targetIds.includes(id)) || (status === "ready" && matchedIds.length === 0)) return null
  const seen = new Set<string>(); const tasks: OutcomeTask[] = []
  for (const state of states) {
    if (!targetIds.includes(state.taskId) || seen.has(state.taskId) || !taskStatus(state.status)) return null
    seen.add(state.taskId); tasks.push({ taskId: state.taskId, status: state.status, result: minimalResult(state.result), failureReason: null })
  }
  let outcome: Outcome = { waitId, status, matchedTaskIds: matchedIds, targetTaskIds: targetIds, tasks }
  let size = outcomeBytes(outcome)
  if (size === null || size > MAX_OUTCOME_BYTES) return null
  const details: Detail[] = []
  states.forEach((state, index) => {
    if (state.result.hasValue) details.push({ kind: "result", index, info: state.result })
    if (state.failureReason !== null) details.push({ kind: "failure", index, value: state.failureReason })
  })
  for (let detailIndex = 0; detailIndex < details.length; detailIndex += 1) {
    const detail = details[detailIndex]!
    const allowance = Math.floor((MAX_OUTCOME_BYTES - size) / (details.length - detailIndex))
    const next = detail.kind === "result" ? taskVersion(outcome, detail.index, { result: chooseResult(outcome, detail.index, detail.info, allowance) }) : taskVersion(outcome, detail.index, { failureReason: chooseFailure(outcome, detail.index, detail.value, allowance) })
    const nextSize = outcomeBytes(next)
    if (nextSize !== null && nextSize <= MAX_OUTCOME_BYTES && nextSize >= size) { outcome = next; size = nextSize }
  }
  return size <= MAX_OUTCOME_BYTES ? { value: outcome, taskIds: targetIds, mode: waitMode } : null
}
function projection(wait: Row, prepared: PreparedOutcome): Projection {
  return {
    id: `wait-result:${safeText(wait.id)}`,
    content: {
      toolCallId: `wait:${safeText(wait.id)}`, toolName: "wait_subagents", input: { taskIds: prepared.taskIds, mode: prepared.mode },
      status: "completed", output: prepared.value, errorCode: null,
    },
  }
}
function generatedOutcome(wait: Row, targets: readonly Row[]): PreparedOutcome | null {
  const waitId = safeText(wait.id); const status = waitStatus(wait.status); const currentMode = waitMode(wait.mode)
  const targetIds = boundedIds(wait.targetTaskIds); const matchedIds = boundedIds(wait.matchedTaskIds, true)
  if (!status || !currentMode || !targetIds || !matchedIds || matchedIds.some(id => !targetIds.includes(id))) return null
  const byId = new Map(targets.map(target => [safeText(target.id), target]))
  const states: TaskState[] = targetIds.map(taskId => {
    const target = byId.get(taskId)
    return { taskId, status: taskStatus(target?.status ?? "unknown") ?? "unknown", result: resultInfo(target?.result ?? null), failureReason: failure(target?.failureReason) }
  })
  return makeOutcome(waitId, status, targetIds, matchedIds, states, currentMode)
}
function storedOutcome(wait: Row): PreparedOutcome | null {
  const raw = record(object(wait.result).outcome); const waitId = safeText(wait.id); const status = raw ? waitStatus(raw.status) : null; const currentMode = waitMode(wait.mode)
  const expectedIds = boundedIds(wait.targetTaskIds); const targetIds = raw ? boundedIds(raw.targetTaskIds) : null; const matchedIds = raw ? boundedIds(raw.matchedTaskIds, true) : null
  if (!raw || raw.waitId !== waitId || !status || status !== waitStatus(wait.status) || !currentMode || !expectedIds || !targetIds || !matchedIds
    || targetIds.length !== expectedIds.length || targetIds.some((id, index) => id !== expectedIds[index]) || matchedIds.some(id => !targetIds.includes(id))
    || (status === "ready" && matchedIds.length === 0) || !Array.isArray(raw.tasks)) return null
  const seen = new Set<string>(); const states: TaskState[] = []
  for (const value of raw.tasks) {
    const task = record(value); if (!task || typeof task.taskId !== "string" || !targetIds.includes(task.taskId) || seen.has(task.taskId)) return null
    const childStatus = taskStatus(task.status); if (!childStatus) return null
    seen.add(task.taskId)
    states.push({ taskId: task.taskId, status: childStatus, result: resultInfo(Object.prototype.hasOwnProperty.call(task, "result") ? task.result : null), failureReason: failure(task.failureReason) })
  }
  return seen.size === targetIds.length ? makeOutcome(waitId, status, targetIds, matchedIds, states, currentMode) : null
}
/** Consumes ready waits once while the newly claimed parent Turn is locked. */
export async function consumeDurableWaitOutcomes(input: DurableWaitConsumerInput): Promise<readonly Projection[]> {
  fence(input)
  if (typeof input.turn.rootTaskId !== "string" || input.turn.rootTaskId.length === 0) return []
  const waits = await input.client.query<Row>(
    `SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "targetTaskIds", "mode", "status", "matchedTaskIds", "result", "suspendedAt", "consumedAt"
     FROM "agent_wait_conditions"
     WHERE "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3
       AND "parentTaskId" = $4 AND "status" IN ('ready', 'timed_out') AND "suspendedAt" IS NOT NULL
       AND ("consumedAt" IS NULL OR ("result" ? 'outcome'))
     ORDER BY "resolvedAt" ASC NULLS LAST, "id" ASC FOR UPDATE`,
    [input.lease.userId, input.lease.sessionId, input.lease.turnId, input.turn.rootTaskId],
  )
  const projections: Projection[] = []
  for (const wait of waits.rows) {
    const prior = wait.consumedAt ? storedOutcome(wait) : null
    if (prior) { projections.push(projection(wait, prior)); continue }
    const parent = (await input.client.query<Row>(
      `SELECT task."id", task."rootTaskId", task."turnId", task."sessionId", session."userId" AS "userId"
       FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
       WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND session."userId" = $4 FOR SHARE`,
      [wait.parentTaskId, input.lease.sessionId, input.lease.turnId, input.lease.userId],
    )).rows[0]
    if (!parent || String(parent.id) !== input.turn.rootTaskId || String(parent.rootTaskId ?? parent.id) !== input.turn.rootTaskId) continue
    const step = (await input.client.query<Row>(
      `SELECT "id", "taskId", "attempt", "status" FROM "agent_steps"
       WHERE "id" = $1 AND "turnId" = $2 AND "sessionId" = $3 AND ("taskId" = $4 OR "taskId" IS NULL) FOR SHARE`,
      [wait.stepId, input.lease.turnId, input.lease.sessionId, input.turn.rootTaskId],
    )).rows[0]
    if (!step || String(step.status) !== "waiting_for_tool" || Number(step.attempt) !== 1) continue
    const targetIds = ids(wait.targetTaskIds)
    if (targetIds.length === 0 || targetIds.length > MAX_TARGETS) continue
    const targets = await input.client.query<Row>(
      `SELECT task."id", task."rootTaskId", task."turnId", task."sessionId", task."status", task."result", task."failureReason", session."userId" AS "userId"
       FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
       WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND session."userId" = $4`,
      [targetIds, input.lease.sessionId, input.lease.turnId, input.lease.userId],
    )
    if (targets.rows.length !== targetIds.length || targets.rows.some(target => String(target.rootTaskId ?? target.id) !== input.turn.rootTaskId || String(target.id) === input.turn.rootTaskId)) continue
    const value = generatedOutcome(wait, targets.rows)
    if (!value) continue
    const persisted = encoded(value.value)
    if (!persisted || persisted.bytes > MAX_OUTCOME_BYTES) continue
    const updated = await input.client.query(
      `UPDATE "agent_wait_conditions" SET "result" = jsonb_set(COALESCE("result", '{}'::jsonb), '{outcome}', $1::jsonb, true),
         "consumedAt" = $2, "updatedAt" = $2
       WHERE "id" = $3 AND "userId" = $4 AND "sessionId" = $5 AND "turnId" = $6 AND "consumedAt" IS NULL
       RETURNING "id"`,
      [persisted.text, input.now, wait.id, input.lease.userId, input.lease.sessionId, input.lease.turnId],
    )
    if (updated.rowCount === 1) projections.push(projection(wait, value))
  }
  return projections
}
