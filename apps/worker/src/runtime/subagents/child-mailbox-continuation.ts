import type pg from "pg"
import { Buffer } from "node:buffer"
import { redactSensitiveText } from "@jobcopilot/shared"

import { loadChildConsumedWaitResume, loadChildPriorAttemptResume, type ChildSameAttemptResume } from "./child-resume.js"
import { buildChildResumeObservations, countChildResumeToolCalls, mergeDurableWaitObservation, type DurableWaitResume } from "./child-resume-observations.js"
import type { SubagentLease } from "./types.js"

type Row = Record<string, unknown>
type ResumeClient = Pick<pg.PoolClient, "query" | "release">
type ResumePool = Pick<pg.Pool, "connect">
const MAX_STEPS = 256
const MAX_ITEMS = 1_024
const MAX_FINAL_TEXT_BYTES = 8 * 1024
const FINAL_TEXT_MARKER = "...[TRUNCATED]"
const TERMINAL_TURNS = new Set(["completed", "failed", "interrupted", "cancelled"])
const TERMINAL_ROOTS = new Set([...TERMINAL_TURNS, "closed"])
const UNAVAILABLE = Symbol("child_mailbox_continuation_unavailable")

function record(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null }
function string(row: Row, key: string): string | null {
  const value = row[key]
  return typeof value === "string" && value.trim() ? value : null
}
function integer(row: Row, key: string, minimum = 0): number | null {
  const value = typeof row[key] === "number" ? row[key] : Number(row[key])
  return Number.isSafeInteger(value) && value >= minimum ? value : null
}
function amount(row: Row, key: string): number | null {
  const value = typeof row[key] === "number" ? row[key] : Number(row[key])
  return Number.isFinite(value) && value >= 0 ? value : null
}
function sequence(row: Row): bigint | null {
  const value = row.inputThroughSequence
  try {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return null
    const parsed = BigInt(value as string | number | bigint)
    return parsed >= 0n ? parsed : null
  } catch { return null }
}
function inputIds(row: Row): string[] | null {
  const values = row.consumedInputIds
  if (!Array.isArray(values) || !values.every((id): id is string => typeof id === "string" && id.trim().length > 0)) return null
  return values
}
function timestamp(value: unknown): Date | null {
  const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null
}

function validLeaseRow(row: Row, lease: SubagentLease, now: Date): boolean {
  const expires = timestamp(row.leaseExpiresAt)
  return string(row, "id") === lease.id && string(row, "userId") === lease.userId
    && string(row, "sessionId") === lease.sessionId && string(row, "turnId") === lease.turnId
    && string(row, "rootTaskId") === lease.rootTaskId && string(row, "leaseOwner") === lease.ownerId
    && integer(row, "attemptCount", 1) === lease.attemptCount && row.status === "running"
    && row.interruptRequestedAt === null && expires !== null && expires > now
    && timestamp(lease.leaseExpiresAt) !== null && lease.interruptRequestedAt === null && !lease.signal.aborted
    && typeof row.turnStatus === "string" && !TERMINAL_TURNS.has(row.turnStatus)
    && typeof row.rootStatus === "string" && !TERMINAL_ROOTS.has(row.rootStatus)
}

function taskSql(): string {
  return `SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."status", task."leaseOwner", task."attemptCount", task."leaseExpiresAt", task."interruptRequestedAt", session."userId" AS "userId", turn."status" AS "turnStatus", root."status" AS "rootStatus"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId" JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND session."userId" = $5 AND task."status" = 'running' AND task."leaseOwner" = $6 AND task."attemptCount" = $7 AND task."leaseExpiresAt" > clock_timestamp() AND task."interruptRequestedAt" IS NULL AND session."status" NOT IN ('aborted', 'archived') AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled') AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')`
}
function stepsSql(): string {
  return `SELECT step."id", step."sessionId", step."turnId", step."taskId", step."ordinal", step."attempt", step."status", step."inputThroughSequence", step."consumedInputIds", step."inputTokens", step."outputTokens", step."estimatedCostUsd", task."rootTaskId" AS "rootTaskId"
    FROM "agent_steps" AS step JOIN "sub_agent_tasks" AS task ON task."id" = step."taskId" AND task."sessionId" = step."sessionId" AND task."turnId" = step."turnId" JOIN "agent_sessions" AS session ON session."id" = step."sessionId" JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId" JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    WHERE step."taskId" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND session."userId" = $4 AND task."rootTaskId" = $5 AND step."attempt" = $6 ORDER BY step."ordinal" ASC, step."id" ASC LIMIT ${MAX_STEPS + 1}`
}
function itemsSql(): string {
  return `SELECT item."id", item."sessionId", item."turnId", item."taskId", item."stepId", item."type", item."status", item."phase", item."content", item."createdAt", step."attempt", step."ordinal", task."rootTaskId" AS "rootTaskId"
    FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId" JOIN "sub_agent_tasks" AS task ON task."id" = item."taskId" AND task."sessionId" = item."sessionId" AND task."turnId" = item."turnId" JOIN "agent_sessions" AS session ON session."id" = item."sessionId" JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    WHERE item."taskId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND session."userId" = $4 AND task."rootTaskId" = $5 AND step."attempt" = $6 ORDER BY step."ordinal" ASC, item."createdAt" ASC, item."id" ASC LIMIT ${MAX_ITEMS + 1}`
}

function validateItems(rows: readonly Row[], steps: ReadonlyMap<string, number>, lastOrdinal: number, lease: SubagentLease, waits: readonly DurableWaitResume[] = []): string | null {
  const calls = new Map<string, { stepId: string; toolName: string }>()
  const results = new Map<string, string>()
  const waitByCallId = new Map(waits.map(wait => [wait.toolCallId, wait]))
  if (waitByCallId.size !== waits.length || new Set(waits.map(wait => wait.stepId)).size !== waits.length) throw UNAVAILABLE
  let final: { ordinal: number; createdAt: Date; text: string } | null = null
  const exactWaitCalls = new Set<string>()
  for (const row of rows) {
    const id = string(row, "id"), stepId = string(row, "stepId"), ordinal = integer(row, "ordinal")
    if (!id || !stepId || ordinal === null || steps.get(stepId) !== ordinal || string(row, "sessionId") !== lease.sessionId
      || string(row, "turnId") !== lease.turnId || string(row, "taskId") !== lease.id || string(row, "rootTaskId") !== lease.rootTaskId
      || integer(row, "attempt", 1) !== lease.attemptCount) throw UNAVAILABLE
    const content = record(row.content)
    if (row.type === "tool_call") {
      const callId = content && string(content, "toolCallId"), toolName = content && string(content, "toolName")
      const expectedWait = callId ? waitByCallId.get(callId) : undefined
      const exactWaitCall = !!expectedWait && stepId === expectedWait.stepId && toolName === "wait_subagents"
      if (expectedWait && !exactWaitCall) throw UNAVAILABLE
      if ((!exactWaitCall && row.status !== "completed") || (exactWaitCall && !["started", "streaming", "completed"].includes(String(row.status)))
        || !callId || !toolName || calls.has(callId)) throw UNAVAILABLE
      if (exactWaitCall) exactWaitCalls.add(callId)
      calls.set(callId, { stepId, toolName })
    } else if (row.type === "tool_result") {
      const callId = content && string(content, "toolCallId")
      if (row.status !== "completed" || !callId || results.has(callId)) throw UNAVAILABLE
      results.set(callId, stepId)
    } else if (row.type === "agent_message" && row.phase === "final_answer") {
      const text = content && string(content, "text"), createdAt = timestamp(row.createdAt)
      if (row.status !== "completed" || !text || !createdAt) throw UNAVAILABLE
      if (!final || ordinal > final.ordinal || (ordinal === final.ordinal && createdAt > final.createdAt)) final = { ordinal, createdAt, text }
    }
  }
  const unsettled = [...calls].filter(([id, call]) => results.get(id) !== call.stepId)
  if (results.size > calls.size || [...results].some(([id, stepId]) => calls.get(id)?.stepId !== stepId)
    || unsettled.some(([id]) => !waitByCallId.has(id)) || exactWaitCalls.size !== waits.length
    || !final || final.ordinal !== lastOrdinal) throw UNAVAILABLE
  return final ? final.text : null
}

export function projectChildFinalText(value: string): string {
  const redacted = redactSensitiveText(value)
  if (Buffer.byteLength(redacted, "utf8") <= MAX_FINAL_TEXT_BYTES) return redacted
  let bytes = 0, prefix = ""
  for (const character of redacted) {
    const size = Buffer.byteLength(character, "utf8")
    if (bytes + size > MAX_FINAL_TEXT_BYTES - Buffer.byteLength(FINAL_TEXT_MARKER, "utf8")) break
    prefix += character; bytes += size
  }
  return `${prefix}${FINAL_TEXT_MARKER}`
}

/** Prioritizes required mailbox context without changing the order of other messages. */
export function prioritizeMailboxMessages<T extends { readonly id: string }>(messages: readonly T[], priorityIds: readonly string[]): T[] {
  const byId = new Map(messages.map(message => [message.id, message]))
  const seen = new Set<string>()
  const prioritized: T[] = []
  for (const id of priorityIds) {
    const message = byId.get(id)
    if (message && !seen.has(id)) { prioritized.push(message); seen.add(id) }
  }
  for (const message of messages) if (!seen.has(message.id)) { prioritized.push(message); seen.add(message.id) }
  return prioritized
}

/** Restores only complete evidence from the still-current execution attempt. */
export async function loadChildSameAttemptContinuation(
  pool: ResumePool, lease: SubagentLease, now = new Date(),
): Promise<ChildSameAttemptResume | null> {
  if (!lease.turnId || lease.status !== "running" || lease.leaseOwner !== lease.ownerId
    || !Number.isSafeInteger(lease.attemptCount) || lease.attemptCount < 1 || lease.interruptRequestedAt !== null
    || !(lease.leaseExpiresAt instanceof Date) || !Number.isFinite(lease.leaseExpiresAt.getTime()) || lease.signal.aborted) return null
  const client: ResumeClient = await pool.connect()
  let closed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", lease.userId])
    const session = await client.query<Row>(`SELECT "id" FROM "agent_sessions"
      WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR SHARE`, [lease.sessionId, lease.userId])
    if (!session.rows[0]) throw UNAVAILABLE
    const current = await client.query<Row>(taskSql(), [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId, lease.ownerId, lease.attemptCount])
    const currentTask = current.rows[0]
    if (!currentTask || !validLeaseRow(currentTask, lease, now)) throw UNAVAILABLE
    const leaseExpiresAt = timestamp(currentTask.leaseExpiresAt)
    if (!leaseExpiresAt || leaseExpiresAt <= now) throw UNAVAILABLE
    const waitIdRows = await client.query<Row>(`SELECT wait."id" AS "id"
      FROM "agent_wait_conditions" AS wait JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId" AND step."taskId" = wait."parentTaskId"
      JOIN "sub_agent_tasks" AS task ON task."id" = wait."parentTaskId" AND task."sessionId" = wait."sessionId" AND task."turnId" = wait."turnId"
      JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = wait."userId"
      JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
      JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
      WHERE wait."userId" = $1 AND wait."sessionId" = $2 AND wait."turnId" = $3 AND wait."parentTaskId" = $4 AND task."rootTaskId" = $5
        AND step."attempt" = $6 AND wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NOT NULL
      ORDER BY step."ordinal" ASC, wait."createdAt" ASC, wait."id" ASC LIMIT ${MAX_STEPS + 1}`,
    [lease.userId, lease.sessionId, lease.turnId, lease.id, lease.rootTaskId, lease.attemptCount])
    if (waitIdRows.rows.length > MAX_STEPS) throw UNAVAILABLE
    const durableWaits: DurableWaitResume[] = [], waitIds = new Set<string>()
    for (const row of waitIdRows.rows) {
      const waitId = string(row, "id")
      if (!waitId || waitIds.has(waitId)) throw UNAVAILABLE
      waitIds.add(waitId)
      const wait = await loadChildConsumedWaitResume(client, lease, waitId)
      if (!wait || wait.waitId !== waitId || wait.attempt !== lease.attemptCount) throw UNAVAILABLE
      durableWaits.push(wait)
    }
    const waitsByStep = new Map(durableWaits.map(wait => [wait.stepId, wait]))
    if (waitsByStep.size !== durableWaits.length) throw UNAVAILABLE
    const stepResult = await client.query<Row>(stepsSql(), [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.rootTaskId, lease.attemptCount])
    if (stepResult.rows.length === 0 || stepResult.rows.length > MAX_STEPS) throw UNAVAILABLE
    const stepMap = new Map<string, number>()
    const consumedInputIds: string[] = [], consumed = new Set<string>()
    let inputThroughSequence = 0n, inputTokens = 0, outputTokens = 0, estimatedCostUsd = 0
    let lastOrdinal = -1
    for (let index = 0; index < stepResult.rows.length; index += 1) {
      const row = stepResult.rows[index]!
      const id = string(row, "id"), ordinal = integer(row, "ordinal"), attempt = integer(row, "attempt", 1)
      const cursor = sequence(row), ids = inputIds(row), input = integer(row, "inputTokens"), output = integer(row, "outputTokens"), cost = amount(row, "estimatedCostUsd")
      const currentWait = id ? waitsByStep.get(id) : undefined
      const exactWaitStep = !!currentWait && ordinal === currentWait.ordinal
        && ["waiting_for_tool", "completed"].includes(String(row.status))
      if (!id || ordinal === null || (index > 0 && ordinal <= lastOrdinal) || attempt !== lease.attemptCount
        || row.status !== "completed" && !exactWaitStep
        || string(row, "sessionId") !== lease.sessionId || string(row, "turnId") !== lease.turnId || string(row, "taskId") !== lease.id
        || string(row, "rootTaskId") !== lease.rootTaskId || stepMap.has(id) || cursor === null || !ids || input === null || output === null || cost === null) throw UNAVAILABLE
      stepMap.set(id, ordinal)
      lastOrdinal = ordinal
      if (cursor > inputThroughSequence) inputThroughSequence = cursor
      for (const inputId of ids) if (!consumed.has(inputId)) { consumed.add(inputId); consumedInputIds.push(inputId) }
      inputTokens += input; outputTokens += output; estimatedCostUsd += cost
      if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || !Number.isFinite(estimatedCostUsd)) throw UNAVAILABLE
    }
    const itemResult = await client.query<Row>(itemsSql(), [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.rootTaskId, lease.attemptCount])
    if (itemResult.rows.length > MAX_ITEMS) throw UNAVAILABLE
    const previousFinalText = validateItems(itemResult.rows, stepMap, lastOrdinal, lease, durableWaits)
    if (!previousFinalText) throw UNAVAILABLE
    const currentUsage = { inputTokens, outputTokens, estimatedCostUsd }
    const observations = buildChildResumeObservations(itemResult.rows, lease, lastOrdinal)
      .filter(block => record(block.content)?.status === "completed")
    const prior = await loadChildPriorAttemptResume(client, lease)
    let allObservations = [...(prior?.observations ?? []).filter(block => record(block.content)?.status === "completed"), ...observations]
    for (const wait of durableWaits) allObservations = [...mergeDurableWaitObservation(allObservations, wait)]
    if (allObservations.length > 256 || Buffer.byteLength(JSON.stringify(allObservations), "utf8") > 256 * 1024) throw UNAVAILABLE
    const stepCount = (prior?.resume.stepCount ?? 0) + stepResult.rows.length
    const toolCallCount = (prior?.resume.toolCallCount ?? 0) + countChildResumeToolCalls(itemResult.rows, lease, lastOrdinal)
    const totalInputTokens = (prior?.resume.usage.inputTokens ?? 0) + currentUsage.inputTokens
    const totalOutputTokens = (prior?.resume.usage.outputTokens ?? 0) + currentUsage.outputTokens
    const totalEstimatedCostUsd = (prior?.resume.usage.estimatedCostUsd ?? 0) + currentUsage.estimatedCostUsd
    if (!Number.isSafeInteger(stepCount) || !Number.isSafeInteger(toolCallCount) || !Number.isSafeInteger(totalInputTokens)
      || !Number.isSafeInteger(totalOutputTokens) || !Number.isFinite(totalEstimatedCostUsd)) throw UNAVAILABLE
    const priorConsumed = prior?.resume.consumedInputIds ?? []
    const allConsumedInputIds = [...new Set([...priorConsumed, ...consumedInputIds])]
    const result: ChildSameAttemptResume = {
      resume: {
        nextOrdinal: lastOrdinal + 1, stepCount, toolCallCount,
        inputThroughSequence: prior?.resume.inputThroughSequence !== undefined && prior.resume.inputThroughSequence > inputThroughSequence
          ? prior.resume.inputThroughSequence : inputThroughSequence,
        consumedInputIds: allConsumedInputIds, usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedCostUsd: totalEstimatedCostUsd },
      },
      observations: allObservations, previousFinalText: projectChildFinalText(previousFinalText), leaseExpiresAt,
    }
    await client.query("COMMIT"); closed = true
    return result
  } catch (error: unknown) {
    if (!closed) await client.query("ROLLBACK").catch(() => undefined)
    if (error === UNAVAILABLE || error instanceof Error && error.message.startsWith("child_resume_")) return null
    throw error
  } finally { client.release() }
}
