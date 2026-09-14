import type pg from "pg"
import { Buffer } from "node:buffer"
import { redactSensitiveText } from "@jobcopilot/shared"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import type { ContextSeedBlock } from "../context/step-context-builder.js"
import type { TurnResumeState } from "../turns/turn-engine-types.js"
import type { SubagentLease } from "./types.js"

type QueryClient = Pick<pg.PoolClient, "query" | "release">
type ResumePool = Pick<pg.Pool, "connect">
type Row = Record<string, unknown>

export type ChildAttemptResume = {
  readonly resume: TurnResumeState
  readonly observations: readonly ContextSeedBlock[]
}

export type ChildResumeLoader = (lease: SubagentLease) => Promise<ChildAttemptResume | undefined>

const TERMINAL_TURN_STATUSES = "('completed', 'failed', 'interrupted', 'cancelled')"
const TERMINAL_ROOT_STATUSES = "('completed', 'failed', 'interrupted', 'cancelled', 'closed')"
const MAX_TOOL_OUTPUT_BYTES = 6 * 1024
const MAX_TOOL_INPUT_BYTES = 1024

function text(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`child_resume_invalid_${key}`)
  return value
}

function integer(row: Row, key: string, minimum = 0): number {
  const value = typeof row[key] === "number" ? row[key] : Number(row[key])
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`child_resume_invalid_${key}`)
  return value
}

function amount(row: Row, key: string): number {
  const value = typeof row[key] === "number" ? row[key] : Number(row[key])
  if (!Number.isFinite(value) || value < 0) throw new Error(`child_resume_invalid_${key}`)
  return value
}

function sequence(row: Row, key: string): bigint {
  try {
    const value = BigInt(row[key] as string | number | bigint)
    if (value < 0n) throw new Error()
    return value
  } catch { throw new Error(`child_resume_invalid_${key}`) }
}

function ids(row: Row): readonly string[] {
  if (!Array.isArray(row.consumedInputIds)) throw new Error("child_resume_invalid_consumedInputIds")
  return row.consumedInputIds.map(value => {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error("child_resume_invalid_consumedInputIds")
    return value
  })
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function sensitiveKey(key: string): boolean {
  return /api.?key|secret|password|(?:access|refresh).?token|authorization/i.test(key)
}

function safeJson(value: unknown, path = new Set<object>(), depth = 0): RepositoryJsonValue {
  if (value === null) return null
  if (typeof value === "string") return redactSensitiveText(value)
  if (typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (!value || typeof value !== "object" || depth > 32 || path.has(value)) return "[TRUNCATED]"
  path.add(value)
  try {
    if (Array.isArray(value)) return value.map(child => safeJson(child, path, depth + 1))
    const result: { [key: string]: RepositoryJsonValue } = {}
    for (const key of Object.keys(value).sort()) if (!sensitiveKey(key)) result[key] = safeJson((value as Record<string, unknown>)[key], path, depth + 1)
    return result
  } finally { path.delete(value) }
}

function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0
  let prefix = ""
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8")
    if (bytes + characterBytes > maxBytes) break
    prefix += character
    bytes += characterBytes
  }
  return prefix
}

function boundedJson(value: unknown, maxBytes: number): RepositoryJsonValue {
  const normalized = safeJson(value)
  const encoded = JSON.stringify(normalized)
  if (Buffer.byteLength(encoded, "utf8") <= maxBytes) return normalized
  const marker: { truncated: boolean; byteLength: number; preview: string } = { truncated: true, byteLength: Buffer.byteLength(encoded, "utf8"), preview: "" }
  let previewBudget = Math.max(0, maxBytes - Buffer.byteLength(JSON.stringify(marker), "utf8") - 1)
  while (previewBudget >= 0) {
    marker.preview = utf8Prefix(encoded, previewBudget)
    if (Buffer.byteLength(JSON.stringify(marker), "utf8") <= maxBytes) return marker
    previewBudget -= 32
  }
  return { truncated: true, byteLength: marker.byteLength, preview: "" }
}

function errorCode(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("child_resume_invalid_errorCode")
  return value
}

function currentTaskSql(): string {
  return `SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."status", task."leaseOwner", task."attemptCount", task."leaseExpiresAt", task."interruptRequestedAt", session."userId" AS "userId", turn."status" AS "turnStatus", root."status" AS "rootStatus"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId" JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND session."userId" = $5 AND task."status" = 'running' AND task."leaseOwner" = $6 AND task."attemptCount" = $7 AND task."leaseExpiresAt" > CURRENT_TIMESTAMP AND task."interruptRequestedAt" IS NULL AND session."status" NOT IN ('aborted', 'archived') AND turn."status" NOT IN ${TERMINAL_TURN_STATUSES} AND root."status" NOT IN ${TERMINAL_ROOT_STATUSES} FOR SHARE`
}

function stepsSql(): string {
  return `SELECT step."id", step."sessionId", step."turnId", step."taskId", step."ordinal", step."attempt", step."status", step."inputThroughSequence", step."consumedInputIds", step."inputTokens", step."outputTokens", step."estimatedCostUsd", task."rootTaskId" AS "rootTaskId"
    FROM "agent_steps" AS step JOIN "sub_agent_tasks" AS task ON task."id" = step."taskId" AND task."sessionId" = step."sessionId" AND task."turnId" = step."turnId" JOIN "agent_sessions" AS session ON session."id" = step."sessionId" JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId" JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    WHERE step."taskId" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND session."userId" = $4 AND task."rootTaskId" = $5 AND step."attempt" >= 1 AND step."attempt" < $6 ORDER BY step."attempt" ASC, step."ordinal" ASC, step."id" ASC`
}

function itemsSql(): string {
  return `SELECT item."id", item."sessionId", item."turnId", item."taskId", item."stepId", item."type", item."status", item."content", step."attempt", step."ordinal", task."rootTaskId" AS "rootTaskId"
    FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId" JOIN "sub_agent_tasks" AS task ON task."id" = item."taskId" AND task."sessionId" = item."sessionId" AND task."turnId" = item."turnId" JOIN "agent_sessions" AS session ON session."id" = item."sessionId" JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    WHERE item."taskId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND session."userId" = $4 AND task."rootTaskId" = $5 AND step."attempt" >= 1 AND step."attempt" < $6 ORDER BY step."attempt" ASC, step."ordinal" ASC, item."createdAt" ASC, item."id" ASC`
}

function assertTask(row: Row, lease: SubagentLease, now: Date): void {
  if (text(row, "id") !== lease.id || text(row, "userId") !== lease.userId || text(row, "sessionId") !== lease.sessionId
    || text(row, "turnId") !== lease.turnId || text(row, "rootTaskId") !== lease.rootTaskId || text(row, "leaseOwner") !== lease.ownerId
    || integer(row, "attemptCount", 1) !== lease.attemptCount || row.status !== "running" || row.turnStatus === undefined
    || row.rootStatus === undefined || row.interruptRequestedAt !== null
    || typeof row.turnStatus !== "string" || TERMINAL_TURN_STATUSES.includes(`'${row.turnStatus}'`)
    || typeof row.rootStatus !== "string" || TERMINAL_ROOT_STATUSES.includes(`'${row.rootStatus}'`)) throw new Error("child_resume_owner_mismatch")
  const expires = row.leaseExpiresAt instanceof Date ? row.leaseExpiresAt : new Date(String(row.leaseExpiresAt))
  if (!Number.isFinite(expires.getTime()) || expires.getTime() <= now.getTime()) throw new Error("child_resume_lease_expired")
  if (lease.interruptRequestedAt !== null || lease.leaseExpiresAt.getTime() <= now.getTime()) throw new Error("child_resume_lease_expired")
}

type ToolCall = { readonly stepId: string; readonly toolName: string; readonly input: unknown }

function observations(rows: readonly Row[], lease: SubagentLease): readonly ContextSeedBlock[] {
  const calls = new Map<string, ToolCall>()
  const pending: Array<{ readonly id: string; readonly stepId: string; readonly callId: string; readonly output: unknown; readonly status: string }> = []
  for (const row of rows) {
    if (text(row, "sessionId") !== lease.sessionId || text(row, "turnId") !== lease.turnId || text(row, "taskId") !== lease.id
      || text(row, "rootTaskId") !== lease.rootTaskId
      || integer(row, "attempt", 1) >= lease.attemptCount) throw new Error("child_resume_item_lineage")
    const stepId = text(row, "stepId")
    const content = object(row.content)
    if (!content || (row.type !== "tool_call" && row.type !== "tool_result")) continue
    if (typeof row.status !== "string" || !["started", "streaming", "completed", "failed", "interrupted"].includes(row.status)) throw new Error("child_resume_invalid_item_status")
    const callId = typeof content.toolCallId === "string" && content.toolCallId.trim() ? content.toolCallId : null
    if (!callId) continue
    if (row.type === "tool_call") {
      const toolName = typeof content.toolName === "string" && content.toolName.trim() ? content.toolName : null
      if (!toolName) throw new Error("child_resume_invalid_tool_call")
      const previous = calls.get(callId)
      if (!previous) calls.set(callId, { stepId, toolName, input: content.input ?? {} })
      else if (previous.stepId === stepId && (previous.toolName !== toolName || JSON.stringify(previous.input) !== JSON.stringify(content.input ?? {}))) throw new Error("child_resume_tool_call_conflict")
    } else if (row.status === "completed") {
      pending.push({ id: text(row, "id"), stepId, callId, output: content.output ?? null, status: errorCode(content.errorCode) === null ? "completed" : "failed" })
    }
  }
  const seen = new Set<string>()
  return pending.flatMap(item => {
    const call = calls.get(item.callId)
    if (!call || call.stepId !== item.stepId || seen.has(item.callId)) return []
    seen.add(item.callId)
    return [{ id: `child-resume:${item.id}`, content: { toolCallId: item.callId, toolName: call.toolName, input: boundedJson(call.input, MAX_TOOL_INPUT_BYTES), status: item.status, output: boundedJson(item.output, MAX_TOOL_OUTPUT_BYTES), errorCode: item.status === "completed" ? null : "tool_execution_failed" } }]
  })
}

function countToolCalls(rows: readonly Row[], lease: SubagentLease): number {
  let count = 0
  for (const row of rows) {
    if (row.type !== "tool_call") continue
    if (text(row, "sessionId") !== lease.sessionId || text(row, "turnId") !== lease.turnId || text(row, "taskId") !== lease.id
      || text(row, "rootTaskId") !== lease.rootTaskId
      || integer(row, "attempt", 1) >= lease.attemptCount) throw new Error("child_resume_item_lineage")
    const content = object(row.content)
    if (!content || typeof content.toolCallId !== "string" || !content.toolCallId.trim()) throw new Error("child_resume_invalid_tool_call")
    count += 1
  }
  return count
}

export async function loadChildAttemptResume(pool: ResumePool, lease: SubagentLease, now = new Date()): Promise<ChildAttemptResume | undefined> {
  if (lease.attemptCount <= 1) return undefined
  const client: QueryClient = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", lease.userId])
    const current = await client.query<Row>(currentTaskSql(), [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId, lease.ownerId, lease.attemptCount])
    if (!current.rows[0]) throw new Error("child_resume_owner_mismatch")
    assertTask(current.rows[0], lease, now)
    const prior = await client.query<Row>(stepsSql(), [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.rootTaskId, lease.attemptCount])
    if (prior.rows.length === 0) {
      await client.query("COMMIT"); committed = true
      return undefined
    }
    let nextOrdinal = 0
    let stepCount = 0
    let toolCallCount = 0
    let inputThroughSequence = 0n
    let inputTokens = 0
    let outputTokens = 0
    let estimatedCostUsd = 0
    const consumedInputIds: string[] = []
    const consumed = new Set<string>()
    for (const row of prior.rows) {
      const ordinal = integer(row, "ordinal")
      const attempt = integer(row, "attempt", 1)
      if (text(row, "id") === "" || text(row, "sessionId") !== lease.sessionId || text(row, "turnId") !== lease.turnId || text(row, "taskId") !== lease.id
        || text(row, "rootTaskId") !== lease.rootTaskId || attempt >= lease.attemptCount
        || typeof row.status !== "string" || !["queued", "streaming", "completed", "failed", "interrupted", "waiting_for_tool", "waiting_for_approval", "waiting_for_user"].includes(row.status)) throw new Error("child_resume_step_lineage")
      nextOrdinal = Math.max(nextOrdinal, ordinal + 1)
      stepCount += 1
      const cursor = sequence(row, "inputThroughSequence")
      if (cursor > inputThroughSequence) inputThroughSequence = cursor
      for (const id of ids(row)) if (!consumed.has(id)) { consumed.add(id); consumedInputIds.push(id) }
      inputTokens += integer(row, "inputTokens")
      outputTokens += integer(row, "outputTokens")
      estimatedCostUsd += amount(row, "estimatedCostUsd")
      if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || !Number.isFinite(estimatedCostUsd)) throw new Error("child_resume_usage_overflow")
    }
    const itemResult = await client.query<Row>(itemsSql(), [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.rootTaskId, lease.attemptCount])
    const restoredObservations = observations(itemResult.rows, lease)
    toolCallCount = countToolCalls(itemResult.rows, lease)
    await client.query("COMMIT"); committed = true
    return {
      resume: { nextOrdinal, stepCount, toolCallCount, inputThroughSequence, consumedInputIds, usage: { inputTokens, outputTokens, estimatedCostUsd } },
      observations: restoredObservations,
    }
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
